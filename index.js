const http = require('http');
const cron = require('node-cron');
const QRCode = require('qrcode');
const { conectar, obtenerMensajesSinProcesar, marcarProcesados } = require('./db');
const { iniciarCliente, enviarResumen } = require('./whatsapp');
const { analizarMensajes } = require('./gemini');
const config = require('./config.json');

const PORT = process.env.PORT || 3000;

let estadoWA = 'arrancando'; // 'arrancando' | 'qr' | 'conectado'
let qrActual = null;

function iniciarServidor() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    if (estadoWA === 'conectado') {
      res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h2>✅ WhatsApp conectado</h2><p>El bot está activo y escuchando mensajes.</p>
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
  <title>Vincular WhatsApp — botwp</title>
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
    <h2>📱 Vincular WhatsApp al bot</h2>
    <div class="warning">
      ⚠️ <strong>No uses la cámara del teléfono ni Google Lens</strong> para escanear este QR — eso no funciona con WhatsApp.<br>
      Debés escanearlo desde <strong>adentro de la app de WhatsApp</strong>.
    </div>

    <img src="${imgDataUrl}" class="qr-img" width="280" height="280" alt="QR WhatsApp"/>

    <div class="steps">
      <strong>Android:</strong>
      <ol>
        <li>Abrí <strong>WhatsApp</strong></li>
        <li>Tocá los <strong>tres puntos ⋮</strong> (arriba a la derecha)</li>
        <li>Tocá <strong>Dispositivos vinculados</strong></li>
        <li>Tocá <strong>Vincular dispositivo</strong></li>
        <li>Apuntá la cámara <em>de WhatsApp</em> al QR de arriba</li>
      </ol>
    </div>

    <details class="platform">
      <summary>¿Usás iPhone? Ver pasos para iOS</summary>
      <ol>
        <li>Abrí <strong>WhatsApp</strong></li>
        <li>Tocá <strong>Configuración</strong> (abajo a la derecha)</li>
        <li>Tocá <strong>Dispositivos vinculados</strong></li>
        <li>Tocá <strong>Vincular dispositivo</strong></li>
        <li>Apuntá la cámara <em>de WhatsApp</em> al QR de arriba</li>
      </ol>
    </details>

    <p class="refresh-note">Esta página se actualiza sola cada 30 segundos. El QR expira en ~60 seg.</p>
  </div>
</body>
</html>`);
      } catch (err) {
        res.end(`<p>Error generando QR: ${err.message}</p>`);
      }
      return;
    }

    res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px">
      <h2>⏳ Arrancando bot...</h2><meta http-equiv="refresh" content="5">
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
    const cliente = await iniciarCliente({
      onQR: (qr) => {
        estadoWA = 'qr';
        qrActual = qr;
        console.log(`[WA] QR listo — visitá https://botwp-ikbb.onrender.com para escanearlo`);
      },
      onListo: () => {
        estadoWA = 'conectado';
        qrActual = null;
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
