global.crypto = require('crypto').webcrypto;

require('dotenv').config();

const REQUIRED_ENV = ['GEMINI_API_KEY', 'TURSO_URL', 'TURSO_TOKEN', 'MY_WHATSAPP_ID', 'NTFY_TOPIC'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`[Bot] Faltan variables de entorno: ${missing.join(', ')}`);
  process.exit(1);
}

const http = require('http');
const https = require('https');
const cron = require('node-cron');
const QRCode = require('qrcode');
const { conectar, obtenerMensajesSinProcesar, marcarProcesados, guardarMensaje } = require('./db');
const { iniciarCliente, enviarResumen } = require('./whatsapp');
const { analizarMensajes, analizarIndividuales } = require('./gemini');
const config = require('./config.json');

const PORT = process.env.PORT || 3000;

function postNtfy(title, body) {
  if (!process.env.NTFY_TOPIC) return;
  const buf = Buffer.from(body);
  const req = https.request({
    hostname: 'ntfy.sh',
    path: `/${process.env.NTFY_TOPIC}`,
    method: 'POST',
    headers: {
      'Title': title,
      'Priority': 'high',
      'Content-Type': 'text/plain',
      'Content-Length': buf.length,
    },
  });
  req.on('error', (err) => console.error(`[ntfy] Error:`, err.message));
  req.write(buf);
  req.end();
}

function notificarNtfy(temas) {
  if (!temas.length) return;
  const resumen = temas.map((t) => `- ${t.tema}: ${t.resumen}`).join('\n');
  postNtfy(`Resumen grupos - ${temas.length} tema${temas.length > 1 ? 's' : ''}`, resumen);
}

function notificarCalendario(eventos, asuntos) {
  if (!eventos.length && !asuntos.length) return;
  const lineas = [];
  if (eventos.length) {
    lineas.push('EVENTOS:');
    eventos.forEach((e) => {
      lineas.push(`- ${e.fecha} | ${e.titulo} (${e.chat})`);
      if (e.detalle) lineas.push(`  ${e.detalle}`);
    });
  }
  if (asuntos.length) {
    if (lineas.length) lineas.push('');
    lineas.push('ASUNTOS:');
    asuntos.forEach((a) => {
      lineas.push(`- ${a.tema} (${a.chat})`);
      lineas.push(`  ${a.resumen}`);
    });
  }
  postNtfy(`Resumen diario - ${eventos.length} eventos, ${asuntos.length} asuntos`, lineas.join('\n'));
}

let estadoWA = 'arrancando';
let qrActual = null;
let tsAutenticando = null;

function iniciarServidor() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    if (req.url === '/test' && req.method === 'GET') {
      if (estadoWA !== 'conectado') {
        res.end('<p>El bot no esta conectado aun. Escanea el QR primero.</p>');
        return;
      }
      try {
        await guardarMensaje({
          chatId: 'test@c.us',
          chatNombre: 'Chat de prueba',
          remitente: 'Tester',
          remitenteId: 'test@c.us',
          cuerpo: 'Mensaje de prueba URGENTE - verifica que el bot funciona.',
          timestamp: Math.floor(Date.now() / 1000),
          esVip: false,
          tieneKeyword: true,
        });
        await procesarMensajes();
        res.end('<p>Prueba ejecutada. Revisa ntfy y WhatsApp.</p><a href="/">Volver</a>');
      } catch (err) {
        res.end(`<p>Error: ${err.message}</p>`);
      }
      return;
    }

    if (req.url === '/procesar' && req.method === 'GET') {
      if (estadoWA !== 'conectado') {
        res.end('<p>El bot no esta conectado aun.</p>');
        return;
      }
      try {
        await procesarMensajes();
        res.end('<p>Procesamiento ejecutado. Revisa ntfy.</p><a href="/">Volver</a>');
      } catch (err) {
        res.end(`<p>Error: ${err.message}</p>`);
      }
      return;
    }

    if (estadoWA === 'conectado') {
      res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h2>WhatsApp conectado</h2>
        <p>Bot activo y escuchando mensajes.</p>
        <p><a href="/test" style="display:inline-block;margin:8px;padding:10px 24px;background:#075e54;color:#fff;border-radius:6px;text-decoration:none">Mensaje de prueba</a></p>
        <p><a href="/procesar" style="display:inline-block;margin:8px;padding:10px 24px;background:#1d6fa4;color:#fff;border-radius:6px;text-decoration:none">Procesar ahora</a></p>
      </body></html>`);
      return;
    }

    if (estadoWA === 'autenticando') {
      res.end('<html><head><meta http-equiv="refresh" content="3"></head><body><p>Conectando con WhatsApp...</p></body></html>');
      return;
    }

    if (estadoWA === 'qr' && qrActual) {
      try {
        const imgDataUrl = await QRCode.toDataURL(qrActual, { width: 280, margin: 2 });
        res.end(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="30"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="text-align:center;font-family:sans-serif;padding:40px"><h2>Escanea este QR desde WhatsApp</h2><img src="${imgDataUrl}" width="280"/></body></html>`);
      } catch (err) {
        res.end(`<p>Error generando QR: ${err.message}</p>`);
      }
      return;
    }

    res.end('<html><head><meta http-equiv="refresh" content="2"></head><body><p>Arrancando bot...</p></body></html>');
  });

  server.listen(PORT, () => {
    console.log(`[Server] Escuchando en puerto ${PORT}`);
  });
}

async function procesarMensajesGrupos() {
  const hora = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  console.log(`\n[Cron grupos] Iniciando - ${hora}`);

  try {
    const todos = await obtenerMensajesSinProcesar();
    const grupales = todos.filter((m) => m.chat_id?.endsWith('@g.us'));
    console.log(`[Cron grupos] ${grupales.length} mensajes grupales sin procesar`);

    if (!grupales.length) {
      console.log(`[Cron grupos] Nada que analizar`);
      return;
    }

    const resultados = await analizarMensajes(grupales);
    await enviarResumen(grupales, resultados);
    notificarNtfy(resultados);

    const ids = grupales.map((m) => m.id);
    await marcarProcesados(ids);

    console.log(`[Cron grupos] Completo - ${resultados.length} temas, ${ids.length} mensajes procesados`);
  } catch (err) {
    console.error(`[Cron grupos] Error:`, err.message);
  }
}

async function procesarMensajesIndividuales() {
  const hora = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  console.log(`\n[Cron individuales] Iniciando - ${hora}`);

  try {
    const todos = await obtenerMensajesSinProcesar();
    const individuales = todos.filter((m) => !m.chat_id?.endsWith('@g.us'));
    console.log(`[Cron individuales] ${individuales.length} mensajes individuales sin procesar`);

    if (!individuales.length) {
      console.log(`[Cron individuales] Nada que analizar`);
      return;
    }

    const { eventos, asuntos } = await analizarIndividuales(individuales);
    notificarCalendario(eventos, asuntos);

    const ids = individuales.map((m) => m.id);
    await marcarProcesados(ids);

    console.log(`[Cron individuales] Completo - ${eventos.length} eventos, ${asuntos.length} asuntos, ${ids.length} mensajes procesados`);
  } catch (err) {
    console.error(`[Cron individuales] Error:`, err.message);
  }
}

async function procesarMensajes() {
  await procesarMensajesGrupos();
  await procesarMensajesIndividuales();
}

async function main() {
  console.log(`[Bot] Arrancando...`);

  iniciarServidor();

  try {
    await conectar();
  } catch (err) {
    console.error(`[Bot] No se pudo conectar a Turso:`, err.message);
    process.exit(1);
  }

  try {
    await iniciarCliente({
      onQR: (qr) => {
        estadoWA = 'qr';
        qrActual = qr;
        tsAutenticando = null;
        console.log(`[WA] QR listo`);
      },
      onAutenticando: () => {
        estadoWA = 'autenticando';
        qrActual = null;
        tsAutenticando = Date.now();
        console.log(`[WA] Autenticando...`);
      },
      onListo: () => {
        const segs = tsAutenticando ? Math.round((Date.now() - tsAutenticando) / 1000) : '?';
        estadoWA = 'conectado';
        qrActual = null;
        console.log(`[WA] Listo en ${segs}s`);
      },
    });
  } catch (err) {
    console.error(`[Bot] No se pudo inicializar WhatsApp:`, err.message);
    process.exit(1);
  }

  cron.schedule(config.resumen.hora_cron_grupos, procesarMensajesGrupos, {
    timezone: 'America/Argentina/Buenos_Aires',
  });
  cron.schedule(config.resumen.hora_cron_individuales, procesarMensajesIndividuales, {
    timezone: 'America/Argentina/Buenos_Aires',
  });

  console.log(`[Bot] Crones activos - grupos "${config.resumen.hora_cron_grupos}", individuales "${config.resumen.hora_cron_individuales}"`);
}

main();
