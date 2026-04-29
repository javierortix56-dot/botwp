const cron = require('node-cron');
const { conectar, obtenerMensajesSinProcesar, marcarProcesados } = require('./db');
const { iniciarCliente, enviarResumen } = require('./whatsapp');
const { analizarMensajes } = require('./gemini');
const config = require('./config.json');

let clienteWA;

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

  try {
    await conectar();
  } catch (err) {
    console.error(`[Bot] No se pudo conectar a Turso:`, err.message);
    process.exit(1);
  }

  try {
    clienteWA = await iniciarCliente();
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
