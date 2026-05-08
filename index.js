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
const { analizarMensajes } = require('./gemini');
const config = require('./config.json');

const PORT = process.env.PORT || 3000;

function notificarNtfy(temas) {
  if (!process.env.NTFY_TOPIC || !temas.length) return;
  const resumen = temas.map((t) => `• ${t.tema}: ${t.resumen}`).join('\n');
  const body = Buffer.from(resumen);
  const req = https.request({
    hostname: 'ntfy.sh',
    path: `/${process.env.NTFY_TOPIC}`,
    method: 'POST',
    headers: {
      'Title': `Resumen WhatsApp - ${temas.length} tema${temas.length > 1 ? 's' : ''}`,
      'Priority': 'high',
      'Content-Type': 'text/plain',
      'Content-Length': body.length,
    },
  });
  req.on('error', (err) => console.error(`[ntfy] Error enviando notificación:`, err.message));
  req.write(body);
  req.end();
}

let estadoWA = 'arrancando';
let qrActual = null;
let tsAutenticando = null;

function iniciarServidor() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    if (req.url === '/test' && req.method === 'GET') {
      if (estadoWA !== 'conectado') {
        res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px">
          <h2>&#9888;&#65039; El bot no est&#225; conectado a&#250;n</h2>
          <p>Primero escane&#225; el QR para vincular WhatsApp.</p>
          <a href="/">&#8592; Volver</a>
        </body></html>`);
        return;
      }
      try {
        await guardarMensaje({
          chatId: 'test@c.us',
          chatNombre: 'Chat de prueba',
          remitente: 'Tester',
          remitenteId: 'test@c.us',
          cuerpo: 'Este es un mensaje de prueba URGENTE - verifica que el bot funciona correctamente.',
          timestamp: Math.floor(Date.now() / 1000),
          esVip: false,
          tieneKeyword: true,
        });
        await procesarMensajes();
        res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px">
          <h2>&#9989; Prueba ejecutada</h2>
          <p>Se insert&#243; un mensaje de prueba y se dispar&#243; el an&#225;lisis.<br>
          Revis&#225; tu WhatsApp &#8212; deber&#237;as recibir el resumen en unos segundos.</p>
          <p style="color:#888;font-size:.85rem">Tambi&#233;n revis&#225; los logs en Render para ver si hubo alg&#250;n error.</p>
          <a href="/">&#8592; Volver</a>
        </body></html>`);
      } catch (err) {
        res.end(`<p>Error en prueba: ${err.message}</p>`);
      }
      return;
    }

    if (req.url === '/procesar' && req.method === 'GET') {
      if (estadoWA !== 'conectado') {
        res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px">
          <h2>&#9888;&#65039; El bot no est&#225; conectado a&#250;n</h2>
          <p>Primero escane&#225; el QR para vincular WhatsApp.</p>
          <a href="/">&#8592; Volver</a>
        </body></html>`);
        return;
      }
      try {
        await procesarMensajes();
        res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px">
          <h2>&#9989; An&#225;lisis ejecutado</h2>
          <p>Se procesaron los mensajes reales acumulados.<br>
          Si hab&#237;a mensajes pendientes, deber&#237;as recibir el resumen en WhatsApp en unos segundos.</p>
          <p style="color:#888;font-size:.85rem">Si no llega nada, es que no hab&#237;a mensajes nuevos para analizar.</p>
          <a href="/">&#8592; Volver</a>
        </body></html>`);
      } catch (err) {
        res.end(`<p>Error: ${err.message}</p>`);
      }
      return;
    }

    if (estadoWA === 'conectado') {
      res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h2>&#9989; WhatsApp conectado</h2>
        <p>El bot est&#225; activo y escuchando mensajes.</p>
        <p><a href="/test" style="display:inline-block;margin-top:16px;padding:10px 24px;background:#075e54;color:#fff;border-radius:6px;text-decoration:none;font-size:.95rem">Enviar mensaje de prueba</a></p>
        <p><a href="/procesar" style="display:inline-block;margin-top:8px;padding:10px 24px;background:#1d6fa4;color:#fff;border-radius:6px;text-decoration:none;font-size:.95rem">Procesar mensajes reales ahora</a></p>
      </body></html>`);
      return;
    }

    if (estadoWA === 'autenticando') {
      const segs = tsAutenticando ? Math.round((Date.now() - tsAutenticando) / 1000) : 0;
      res.end(`<!DOCTYPE html><html><head>
        <meta http-equiv="refresh" content="3">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Conectando...</title>
      </head><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0f2f5">
        <div style="background:#fff;border-radius:12px;max-width:400px;margin:0 auto;padding:40px 24px;box-shadow:0 2px 12px rgba(0,0,0,.08)">
          <div style="font-size:3rem;margin-bottom:16px">&#128260;</div>
          <h2 style="margin:0 0 12px">Conectando con WhatsApp...</h2>
          <p style="color:#555;margin:0 0 8px">Estableciendo conexi&#243;n con los servidores de WhatsApp.</p>
          <p style="color:#888;font-size:.85rem">Tiempo esperando: ${segs}s &#8212; esta p&#225;gina se actualiza sola cada 3 segundos.</p>
          ${segs > 30 ? `<p style="color:#c0392b;font-size:.85rem;margin-top:16px">&#9888;&#65039; Est&#225; tardando m&#225;s de lo normal. Revis&#225; los logs en Render.</p>` : ''}
        </div>
      </body></html>`);
      return;
    }

    if (estadoWA === 'qr' && qrActual) {
      try {
        const imgDataUrl = await QRCode.toDataURL(qrActual, { width: 280, margin: 2 });
        res.end(`<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="refresh" content="30">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Vincular WhatsApp - botwp</title>
</head>
<body><img src="${imgDataUrl}" width="280" alt="QR WhatsApp"/></body>
</html>`);
      } catch (err) {
        res.end(`<p>Error generando QR: ${err.message}</p>`);
      }
      return;
    }

    res.end(`<!DOCTYPE html><html><head>
      <meta http-equiv="refresh" content="2">
      <meta name="viewport" content="width=device-width,initial-scale=1">
    </head><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0f2f5">
      <div style="background:#fff;border-radius:12px;max-width:400px;margin:0 auto;padding:40px 24px;box-shadow:0 2px 12px rgba(0,0,0,.08)">
        <div style="font-size:3rem;margin-bottom:16px">&#9203;</div>
        <h2 style="margin:0 0 12px">Arrancando bot...</h2>
        <p style="color:#888;font-size:.85rem">Esta p&#225;gina se actualiza sola cada 2 segundos.</p>
      </div>
    </body></html>`);
  });

  server.listen(PORT, () => {
    console.log(`[Server] Escuchando en puerto ${PORT}`);
  });
}

async function procesarMensajes() {
  const hora = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  console.log(`\n[Cron] Iniciando ciclo de análisis - ${hora}`);

  try {
    const mensajes = await obtenerMensajesSinProcesar();
    console.log(`[Cron] ${mensajes.length} mensajes sin procesar`);

    if (!mensajes.length) {
      console.log(`[Cron] Nada que analizar - fin del ciclo`);
      return;
    }

    const resultados = await analizarMensajes(mensajes);
    await enviarResumen(mensajes, resultados);
    notificarNtfy(resultados);

    const ids = mensajes.map((m) => m.id);
    await marcarProcesados(ids);

    console.log(`[Cron] Ciclo completo - ${resultados.length} temas, ${ids.length} mensajes procesados`);
  } catch (err) {
    console.error(`[Cron] Error en ciclo de análisis:`, err.message);
  }
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
        console.log(`[WA] QR listo - visita la URL para escanearlo`);
      },
      onAutenticando: () => {
        estadoWA = 'autenticando';
        qrActual = null;
        tsAutenticando = Date.now();
        console.log(`[WA] QR escaneado - autenticando...`);
      },
      onListo: () => {
        const segs = tsAutenticando ? Math.round((Date.now() - tsAutenticando) / 1000) : '?';
        estadoWA = 'conectado';
        qrActual = null;
        console.log(`[WA] Listo! Conectado en ${segs}s desde el escaneo`);
      },
    });
  } catch (err) {
    console.error(`[Bot] No se pudo inicializar WhatsApp:`, err.message);
    process.exit(1);
  }

  cron.schedule(config.resumen.hora_cron, procesarMensajes, {
    timezone: 'America/Argentina/Buenos_Aires',
  });

  console.log(`[Bot] Cron activo - proximo analisis segun "${config.resumen.hora_cron}"`);
}

main();
