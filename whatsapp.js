const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
const { guardarMensaje, guardarSesion, obtenerSesion, eliminarSesion } = require('./db');
const { debeAnalizarse, obtenerFlags } = require('./filtros');
require('dotenv').config();

const AUTH_DIR = '/tmp/baileys_auth';

// Logger silencioso para no ensuciar los logs con internals de Baileys
const logger = { level: 'silent', trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: function() { return this; } };

let sock = null;
let sockCallbacks = {};
let qrEmitido = false;

async function restaurarSesion() {
  const data = await obtenerSesion('baileys');
  if (!data) return false;
  try {
    const archivos = JSON.parse(data);
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    for (const [nombre, contenido] of Object.entries(archivos)) {
      fs.writeFileSync(path.join(AUTH_DIR, nombre), contenido);
    }
    console.log(`[WA] Sesión restaurada desde Turso`);
    return true;
  } catch (err) {
    console.error(`[WA] Error restaurando sesión:`, err.message);
    return false;
  }
}

async function guardarSesionEnTurso() {
  try {
    if (!fs.existsSync(AUTH_DIR)) return;
    const archivos = {};
    for (const nombre of fs.readdirSync(AUTH_DIR)) {
      archivos[nombre] = fs.readFileSync(path.join(AUTH_DIR, nombre), 'utf8');
    }
    await guardarSesion('baileys', JSON.stringify(archivos));
  } catch (err) {
    console.error(`[WA] Error guardando sesión en Turso:`, err.message);
  }
}

async function conectar(callbacks = {}) {
  sockCallbacks = callbacks;

  await restaurarSesion();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    version = [2, 3000, 1015901307];
  }

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['botwp', 'Chrome', '120.0'],
    connectTimeoutMs: 60000,
    retryRequestDelayMs: 2000,
  });

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    await guardarSesionEnTurso();
  });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrEmitido = true;
      console.log(`[WA] QR generado`);
      if (sockCallbacks.onQR) sockCallbacks.onQR(qr);
    }

    if (connection === 'connecting') {
      // Si ya mostramos un QR y ahora estamos "connecting" sin QR nuevo, el usuario lo escaneó
      if (qrEmitido && !qr) {
        console.log(`[WA] QR escaneado — autenticando con WhatsApp...`);
        if (sockCallbacks.onAutenticando) sockCallbacks.onAutenticando();
      } else {
        console.log(`[WA] Estableciendo conexión con WhatsApp...`);
      }
    }

    if (connection === 'open') {
      qrEmitido = false;
      console.log(`[WA] Cliente listo — escuchando mensajes`);
      if (sockCallbacks.onListo) sockCallbacks.onListo();
    }

    if (connection === 'close') {
      const codigo = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode
        : null;

      const sesiónCerrada = codigo === DisconnectReason.loggedOut;

      if (sesiónCerrada) {
        console.warn(`[WA] Sesión cerrada por WhatsApp — borrando y esperando nuevo QR`);
        await eliminarSesion('baileys');
        if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      } else {
        console.warn(`[WA] Conexión perdida (código ${codigo}) — reconectando en 5s...`);
        setTimeout(() => conectar(sockCallbacks), 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (msg.key.fromMe || !msg.message) continue;

        const body =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          '';

        if (!body) continue;

        const chatId = msg.key.remoteJid;
        const msgData = {
          chatId,
          chatNombre: chatId,
          remitente: msg.pushName ?? null,
          remitenteId: chatId,
          cuerpo: body,
          timestamp: Number(msg.messageTimestamp),
        };

        if (!debeAnalizarse(msgData)) continue;

        const { esVip, tieneKeyword } = obtenerFlags(msgData);
        await guardarMensaje({ ...msgData, esVip, tieneKeyword });

        console.log(`[WA] Mensaje guardado — Chat: ${chatId} | VIP: ${esVip} | Keyword: ${tieneKeyword}`);
      } catch (err) {
        console.error(`[WA] Error procesando mensaje:`, err.message);
      }
    }
  });

  return sock;
}

// Normaliza el ID de WhatsApp al formato JID de Baileys (XXXXXX@s.whatsapp.net)
function normalizarJid(id) {
  if (!id) return id;
  if (id.includes('@')) return id.replace('@c.us', '@s.whatsapp.net');
  return `${id}@s.whatsapp.net`;
}

async function iniciarCliente(callbacks = {}) {
  await conectar(callbacks);
  return sock;
}

async function enviarResumen(mensajes, resultados) {
  if (!sock) throw new Error('Cliente WA no inicializado');
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
  const jid = normalizarJid(process.env.MY_WHATSAPP_ID);

  try {
    await sock.sendMessage(jid, { text: texto });
    console.log(`[WA] Resumen enviado — ${urgentes.length} urgentes, ${importantes.length} importantes`);
  } catch (err) {
    console.error(`[WA] Error enviando resumen:`, err.message);
  }
}

module.exports = { iniciarCliente, enviarResumen };
