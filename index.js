global.crypto = require('crypto').webcrypto;

const http = require('http');
const cron = require('node-cron');
const QRCode = require('qrcode');
const { conectar, obtenerMensajesSinProcesar, marcarProcesados, guardarMensaje } = require('./db');
const { iniciarCliente, enviarResumen } = require('./whatsapp');
const { analizarMensajes } = require('./gemini');
const config = require('./config.json');

const PORT = process.env.PORT || 3000;

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
          cuerpo: 'Este es un mensaje de prueba URGENTE — verific&#225; que el bot funciona correctamente.',
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

    if (estadoWA === 'conectado') {
      res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h2>&#9989; WhatsApp conectado</h2>
        <p>El bot est&#225; activo y escuchando mensajes.</p>
        <p><a href="/test" style="display:inline-block;margin-top:16px;padding:10px 24px;background:#075e54;color:#fff;border-radius:6px;text-decoration:none;font-size:.95rem">Enviar mensaje de prueba</a></p>
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
  <title>Vincular WhatsApp &#8212; botwp</title>
  <style>
    body { font-family: sans-serif; background: #f0f2f5; margin: 0; padding: 32px 16px; color: #111; }
    .card { background: #fff; border-radius: 12px; max-width: 480px; margin: 0 auto; padding: 32px 24px; box-shadow: 0 2px 12px rgba(0,0,0,.08); text-align: center; }
    h2 { margin: 0 0 8px; font-size: 1.3rem; }
    .warning { background: #fff3cd; border-left: 4px solid #f0a500; border-radius: 4px; padding: 12px 16px; margin: 20px 0; text-align: left; font-size: .9rem; }
    .steps { text-align: left; background: #f0f2f5; border-radius: 8px; padding: 16px 16px 16px 32px; margin: 20px 0; font-size: .92rem; line-height: 1.8; }
    .steps li { margin-bottom: 4px; }
    .steps strong { color: #075e54; }
    .qr-img { border: 3px solid #075e54; border-radius: 8px; padding: 8px; margin: 20px auto; display: block; }
    .refresh-note { color: #888; font-size: .8rem; margin-top: 16px; }
    .platform { margin-top: 16px; }
    .platform summary { cursor: pointer; font-size: .85rem; color: #555; }
    .platform ol { margin: 8px 0 0; font-size: .85rem; line-height: 1.7; padding-left: 20px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>&#128241; Vincular WhatsApp al bot</h2>
    <div class="warning">
      &#9888;&#65039; <strong>No uses la c&#225;mara del tel&#233;fono ni Google Lens</strong> para escanear este QR &#8212; eso no funciona con WhatsApp.<br>
      Deb&#233;s escanearlo desde <strong>adentro de la app de WhatsApp</strong>.
    </div>
    <img src="${imgDataUrl}" class="qr-img" width="280" height="280" alt="QR WhatsApp"/>
    <div class="steps">
      <strong>Android:</strong>
      <ol>
        <li>Abr&#237; <strong>WhatsApp</strong></li>
        <li>Toc&#225; los <strong>tres puntos &#8942;</strong> (arriba a la derecha)</li>
        <li>Toc&#225; <strong>Dispositivos vinculados</strong></li>
        <li>Toc&#225; <strong>Vincular dispositivo</strong></li>
        <li>Apunt&#225; la c&#225;mara <em>de WhatsApp</em> al QR de arriba</li>
      </ol>
    </div>
    <details class="platform">
      <summary>&#191;Us&#225;s iPhone? Ver pasos para iOS</summary>
      <ol>
        <li>Abr&#237; <strong>WhatsApp</strong></li>
        <li>Toc&#225; <strong>Configuraci&#243;n</strong> (abajo a la derecha)</li>
        <li>Toc&#225; <strong>Dispositivos vinculados</strong></li>
        <li>Toc&#225; <strong>Vincular dispositivo</strong></li>
        <li>Apunt&#225; la c&#225;mara <em>de WhatsApp</em> al QR de arriba</li>
      </ol>
    </details>
    <p class="refresh-note">Esta p&#225;gina se actualiza sola cada 30 segundos. El QR expira en ~60 seg.</p>
  </div>
</body>
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
  console.log(`\n[Cron] Iniciando ciclo de análisis — ${hora}`);

  try {
    const mensajes = await obtenerMensajesSinProcesar();
    console.log(`[Cron] ${mensajes.length} mensajes sin procesar`);

    if (!mensajes.length) {
      console.log(`[Cron] Nada que analizar — fin del ciclo`);
      return;
    }

    const resultados = await analizarMensajes(mensajes);
    await enviarResumen(mensajes, resultados);

    const ids = mensajes.map((m) => m.id);
    await marcarProcesados(ids);

    const urgentes = resultados.filter((r) => r.clasificacion === 'urgente').length;
    const importantes = resultados.filter((r) => r.clasificacion === 'importante').length;
    console.log(`[Cron] Ciclo completo — ${urgentes} urgentes, ${importantes} importantes, ${ids.length} marcados como procesados`);
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
        console.log(`[WA] QR listo — visitá https://botwp-ikbb.onrender.com para escanearlo`);
      },
      onAutenticando: () => {
        estadoWA = 'autenticando';
        qrActual = null;
        tsAutenticando = Date.now();
        console.log(`[WA] QR escaneado — autenticando con los servidores de WhatsApp...`);
      },
      onListo: () => {
        const segs = tsAutenticando ? Math.round((Date.now() - tsAutenticando) / 1000) : '?';
        estadoWA = 'conectado';
        qrActual = null;
        console.log(`[WA] ¡Listo! Conectado en ${segs}s desde el escaneo`);
      },
    });
  } catch (err) {
    console.error(`[Bot] No se pudo inicializar WhatsApp:`, err.message);
    process.exit(1);
  }

  cron.schedule(config.resumen.hora_cron, procesarMensajes, {
    timezone: 'America/Argentina/Buenos_Aires',
  });

  console.log(`[Bot] Cron activo — próximo análisis según "${config.resumen.hora_cron}"`);
}

main();
