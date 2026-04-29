const { Client, RemoteAuth } = require('whatsapp-web.js');
const fs = require('fs');
const { guardarMensaje, guardarSesion, obtenerSesion, eliminarSesion } = require('./db');
const { debeAnalizarse, obtenerFlags } = require('./filtros');
require('dotenv').config();

let client;

class TursoStore {
  async sessionExists({ session }) {
    const data = await obtenerSesion(session);
    return !!data;
  }

  async save({ session, path }) {
    const zipData = fs.readFileSync(path).toString('base64');
    await guardarSesion(session, zipData);
    console.log(`[WA] Sesión guardada en Turso`);
  }

  async extract({ session, path }) {
    const data = await obtenerSesion(session);
    if (!data) throw new Error(`Sin sesión guardada para: ${session}`);
    fs.writeFileSync(path, Buffer.from(data, 'base64'));
    console.log(`[WA] Sesión restaurada desde Turso`);
  }

  async delete({ session }) {
    await eliminarSesion(session);
  }
}

function crearCliente(callbacks = {}) {
  client = new Client({
    authStrategy: new RemoteAuth({
      store: new TursoStore(),
      backupSyncIntervalMs: 300000,
    }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    },
  });

  client.on('qr', (qr) => {
    console.log(`[WA] QR generado`);
    if (callbacks.onQR) callbacks.onQR(qr);
  });

  client.on('remote_session_saved', () => {
    console.log(`[WA] Sesión sincronizada con Turso`);
  });

  client.on('auth_failure', (msg) => {
    console.error(`[WA] Fallo de autenticación:`, msg);
  });

  client.on('ready', () => {
    console.log(`[WA] Cliente listo — escuchando mensajes`);
    if (callbacks.onListo) callbacks.onListo();
  });

  client.on('disconnected', (reason) => {
    console.warn(`[WA] Desconectado: ${reason}`);
  });

  client.on('message', async (msg) => {
    try {
      // Ignorar mensajes propios, estados y sin texto
      if (msg.fromMe || msg.isStatus || !msg.body) return;

      const chat = await msg.getChat();
      const contact = await msg.getContact();

      const msgData = {
        chatId: msg.from,
        chatNombre: chat.name ?? null,
        remitente: contact.pushname ?? contact.name ?? null,
        remitenteId: msg.from,
        cuerpo: msg.body,
        timestamp: msg.timestamp,
      };

      if (!debeAnalizarse(msgData)) return;

      const { esVip, tieneKeyword } = obtenerFlags(msgData);
      await guardarMensaje({ ...msgData, esVip, tieneKeyword });

      console.log(`[WA] Mensaje guardado — Chat: ${msgData.chatNombre ?? msgData.chatId} | VIP: ${esVip} | Keyword: ${tieneKeyword}`);
    } catch (err) {
      console.error(`[WA] Error procesando mensaje entrante:`, err.message);
    }
  });

  return client;
}

async function iniciarCliente(callbacks = {}) {
  crearCliente(callbacks);
  await client.initialize();
  return client;
}

async function enviarResumen(mensajes, resultados) {
  if (!client) throw new Error('Cliente WA no inicializado');
  if (!resultados.length) return;

  const urgentes = resultados.filter((r) => r.clasificacion === 'urgente');
  const importantes = resultados.filter((r) => r.clasificacion === 'importante');

  if (!urgentes.length && !importantes.length) {
    console.log(`[WA] Sin mensajes urgentes o importantes — resumen omitido`);
    return;
  }

  const hora = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  const lineas = [`*Resumen ${hora}* — ${resultados.length} mensajes analizados\n`];

  if (urgentes.length) {
    lineas.push(`🔴 *URGENTES (${urgentes.length})*`);
    urgentes.forEach((r) => {
      const msg = mensajes.find((m) => m.id === r.id);
      if (msg) lineas.push(`• [${msg.chat_nombre ?? msg.chat_id}] ${msg.remitente ?? ''}: ${msg.cuerpo.slice(0, 80)} — _${r.razon}_`);
    });
    lineas.push('');
  }

  if (importantes.length) {
    lineas.push(`🟡 *IMPORTANTES (${importantes.length})*`);
    importantes.forEach((r) => {
      const msg = mensajes.find((m) => m.id === r.id);
      if (msg) lineas.push(`• [${msg.chat_nombre ?? msg.chat_id}] ${msg.remitente ?? ''}: ${msg.cuerpo.slice(0, 80)} — _${r.razon}_`);
    });
  }

  const texto = lineas.join('\n');

  try {
    await client.sendMessage(process.env.MY_WHATSAPP_ID, texto);
    console.log(`[WA] Resumen enviado — ${urgentes.length} urgentes, ${importantes.length} importantes`);
  } catch (err) {
    console.error(`[WA] Error enviando resumen:`, err.message);
  }
}

module.exports = { iniciarCliente, enviarResumen };
