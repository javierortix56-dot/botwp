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
        const imgDataUrl = await QRCode.toDataURL(qrActual, { width: 300 });
        res.end(`<!DOCTYPE html><html><head>
          <meta http-equiv="refresh" content="5">
          <title>Escanear QR — botwp</title>
        </head><body style="font-family:sans-serif;text-align:center;padding:60px">
          <h2>Escanea este QR con WhatsApp</h2>
          <p>Abrí WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
          <img src="${imgDataUrl}" style="margin:20px auto;display:block"/>
          <p style="color:#888;font-size:13px">Esta página se actualiza sola cada 30 segundos</p>
        </body></html>`);
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
