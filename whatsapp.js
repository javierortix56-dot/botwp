const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const { guardarMensaje, useTursoAuthState } = require('./db');
const { debeAnalizarse, obtenerFlags } = require('./filtros');
const config = require('./config.json');
require('dotenv').config();

const logger = pino({ level: 'silent' });

let sock;
let listo = false;

function normalizarJid(jid) {
  if (!jid) return jid;
  return jid.replace('@c.us', '@s.whatsapp.net');
}

function extraerCuerpo(message) {
  if (!message) return '';
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    ''
  );
}

async function iniciarCliente(callbacks = {}) {
  const { state, saveCreds } = await useTursoAuthState();
  const { version } = await fetchLatestBaileysVersion();
  console.log(`[WA] Usando WhatsApp Web v${version.join('.')}`);

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['BotWP', 'Chrome', '1.0'],
    syncFullHistory: true,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  // Backfill: cuando WhatsApp sincroniza historial, guardamos mensajes recientes
  // para el resumen diario.
  sock.ev.on('messaging-history.set', async ({ messages }) => {
    if (!messages?.length) return;
    const dias = config.dias_historial ?? 15;
    const limiteTimestamp = Math.floor(Date.now() / 1000) - dias * 86400;
    let guardados = 0;
    for (const msg of messages) {
      try {
        if (msg.key.fromMe || !msg.message) continue;
        const ts = Number(msg.messageTimestamp);
        if (ts < limiteTimestamp) continue;

        const cuerpo = extraerCuerpo(msg.message);
        if (!cuerpo) continue;

        const chatId = msg.key.remoteJid;
        const remitenteId = msg.key.participant || chatId;
        const remitente = msg.pushName ?? null;

        const msgData = {
          chatId,
          chatNombre: remitente,
          remitente,
          remitenteId,
          cuerpo,
          timestamp: ts,
        };

        if (!debeAnalizarse(msgData)) continue;

        const { esVip, tieneKeyword } = obtenerFlags(msgData);
        await guardarMensaje({ ...msgData, esVip, tieneKeyword });
        guardados++;
      } catch (err) {
        console.error(`[WA] Error en backfill:`, err.message);
      }
    }
    if (guardados > 0) {
      console.log(`[WA] Backfill: ${guardados} mensajes históricos guardados (últimos ${dias} días)`);
    }
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log(`[WA] QR generado`);
      if (callbacks.onQR) callbacks.onQR(qr);
    }

    if (connection === 'connecting') {
      console.log(`[WA] Conectando con WhatsApp...`);
      if (callbacks.onAutenticando) callbacks.onAutenticando();
    }

    if (connection === 'open') {
      listo = true;
      console.log(`[WA] Cliente listo — escuchando mensajes`);
      if (callbacks.onListo) callbacks.onListo();
    }

    if (connection === 'close') {
      listo = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const motivo = lastDisconnect?.error?.message ?? 'desconocido';
      console.warn(`[WA] Desconectado (${code}): ${motivo}`);

      if (code === DisconnectReason.loggedOut) {
        console.error(`[WA] Sesión cerrada — necesitás escanear QR de nuevo`);
        try {
          await iniciarCliente(callbacks);
        } catch (err) {
          console.error(`[WA] Error reintentando:`, err.message);
        }
        return;
      }

      if (code === 440) {
        console.warn(`[WA] Conflicto de sesión — otra instancia activa, esta se retira`);
        return;
      }

      console.log(`[WA] Reintentando conexión en 3s...`);
      setTimeout(() => {
        iniciarCliente(callbacks).catch((err) =>
          console.error(`[WA] Error reintentando:`, err.message)
        );
      }, 3000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        if (msg.key.fromMe || !msg.message) continue;

        const cuerpo = extraerCuerpo(msg.message);
        if (!cuerpo) continue;

        const chatId = msg.key.remoteJid;
        const remitenteId = msg.key.participant || chatId;
        const remitente = msg.pushName ?? null;

        let chatNombre = remitente;
        if (chatId.endsWith('@g.us')) {
          try {
            const meta = await sock.groupMetadata(chatId);
            chatNombre = meta.subject;
          } catch {
            chatNombre = null;
          }
        }

        const msgData = {
          chatId,
          chatNombre,
          remitente,
          remitenteId,
          cuerpo,
          timestamp: Number(msg.messageTimestamp),
        };

        if (!debeAnalizarse(msgData)) continue;

        const { esVip, tieneKeyword } = obtenerFlags(msgData);
        await guardarMensaje({ ...msgData, esVip, tieneKeyword });

        console.log(
          `[WA] Mensaje guardado — Chat: ${chatNombre ?? chatId} | VIP: ${esVip} | Keyword: ${tieneKeyword}`
        );
      } catch (err) {
        console.error(`[WA] Error procesando mensaje entrante:`, err.message);
      }
    }
  });

  return sock;
}

async function resolverDestino() {
  const nombreGrupo = config.grupo_resumen;
  if (nombreGrupo && sock) {
    try {
      const grupos = await sock.groupFetchAllParticipating();
      const entrada = Object.entries(grupos).find(
        ([, g]) => g.subject?.toLowerCase().trim() === nombreGrupo.toLowerCase().trim()
      );
      if (entrada) return entrada[0];
    } catch (err) {
      console.warn(`[WA] Error buscando grupo destino:`, err.message);
    }
  }
  return normalizarJid(process.env.MY_WHATSAPP_ID);
}

async function enviarResumen(mensajes, temas) {
  if (!sock || !listo) throw new Error('Cliente WA no inicializado');
  if (!temas.length) {
    console.log(`[WA] Sin temas relevantes — resumen omitido`);
    return;
  }

  const hora = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  const lineas = [`📋 *Resumen ${hora}*\n`];

  temas.forEach((t) => {
    const cantMensajes = t.ids?.length > 1 ? ` _(${t.ids.length} mensajes)_` : '';
    lineas.push(`• *${t.tema}*${cantMensajes} — ${t.chat}`);
    lineas.push(`  ${t.resumen}`);
  });

  const texto = lineas.join('\n');
  const destino = await resolverDestino();

  if (destino.endsWith('@g.us')) {
    try {
      await sock.groupMetadata(destino);
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }

  try {
    await sock.sendMessage(destino, { text: texto });
    console.log(`[WA] Resumen enviado a ${destino} — ${temas.length} temas`);
  } catch (err) {
    console.error(`[WA] Error enviando resumen:`, err.message);
  }
}

module.exports = { iniciarCliente, enviarResumen };
