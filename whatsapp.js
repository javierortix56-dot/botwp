const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const { guardarMensaje, useTursoAuthState } = require('./db');
const { debeAnalizarse, obtenerFlags } = require('./filtros');
require('dotenv').config();

const logger = pino({ level: 'silent' });

let sock;
let listo = false;

function normalizarJid(jid) {
  if (!jid) return jid;
  // whatsapp-web.js usa @c.us, Baileys usa @s.whatsapp.net
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
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

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

      // 440 = otra instancia tomó la sesión (deploy solapado). Ceder sin pelear.
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

async function enviarResumen(mensajes, resultados) {
  if (!sock || !listo) throw new Error('Cliente WA no inicializado');
  if (!resultados.length) return;

  const urgentes = resultados.filter((r) => r.clasificacion === 'urgente');
  const importantes = resultados.filter((r) => r.clasificacion === 'importante');

  if (!urgentes.length && !importantes.length) {
    console.log(`[WA] Sin mensajes urgentes o importantes — resumen omitido`);
    return;
  }

  const hora = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  const lineas = [`*Resumen ${hora}*\n`];

  function agruparPorTema(lista) {
    const temas = {};
    lista.forEach((r) => {
      const tema = r.tema ?? 'General';
      if (!temas[tema]) temas[tema] = [];
      temas[tema].push(r);
    });
    return temas;
  }

  function renderTemas(lista) {
    const temas = agruparPorTema(lista);
    Object.entries(temas).forEach(([tema, items]) => {
      const sufijo = items.length > 1 ? ` _(${items.length} mensajes)_` : '';
      lineas.push(`• *${tema}*${sufijo}: ${items[0].razon}`);
    });
  }

  if (urgentes.length) {
    lineas.push(`🔴 *URGENTE*`);
    renderTemas(urgentes);
    lineas.push('');
  }

  if (importantes.length) {
    lineas.push(`🟡 *IMPORTANTE*`);
    renderTemas(importantes);
  }

  const texto = lineas.join('\n');
  const destino = normalizarJid(process.env.MY_WHATSAPP_ID);

  try {
    await sock.sendMessage(destino, { text: texto });
    console.log(`[WA] Resumen enviado — ${urgentes.length} urgentes, ${importantes.length} importantes`);
  } catch (err) {
    console.error(`[WA] Error enviando resumen:`, err.message);
  }
}

module.exports = { iniciarCliente, enviarResumen };
