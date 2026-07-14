const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const { guardarMensaje, useTursoAuthState, limpiarAuth, guardarContacto } = require('./db');
const { debeAnalizarse, obtenerFlags } = require('./filtros');
const config = require('./config.json');
require('dotenv').config();

const logger = pino({ level: 'silent' });

let sock;
let listo = false;
// Modo ahorro de notificaciones: cuando el bot se desconecta a propósito
// (entre digests), este flag evita que el handler de 'close' reintente.
let desconexionVoluntaria = false;
let callbacksGuardados = {};
// Timestamp del último lote de mensajes recibido — lo usa esperarSincronizacion()
// para saber cuándo terminó de bajar la cola offline tras reconectar.
let ultimaActividadMensajes = 0;

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
  callbacksGuardados = callbacks;
  desconexionVoluntaria = false;
  const { state, saveCreds } = await useTursoAuthState();
  const { version } = await fetchLatestBaileysVersion();
  console.log(`[WA] Usando WhatsApp Web v${version.join('.')}`);

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    // Identificarse como Safari/macOS reduce la supresión de notificaciones push
    // en iOS: WhatsApp prioriza el push al teléfono cuando asume que el linked
    // device es un desktop ocioso en vez de un navegador activo.
    browser: ['Mac OS', 'Safari', '15.0'],
    // syncFullHistory:false hace que el bot parezca un cliente "pasivo" para WA,
    // reduciendo aún más la supresión de notificaciones. Los mensajes que llegan
    // mientras el bot está desconectado (modo ahorro) los entrega WhatsApp igual
    // al reconectar, como 'append' — no dependemos del history sync completo.
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  // Sincronización de contactos: capturamos los nombres de la agenda
  // (verifiedName / name / notify) para mostrarlos en /configurar y en los
  // resúmenes en lugar del JID raw.
  async function procesarContactos(contactos) {
    if (!contactos?.length) return;
    let guardados = 0;
    for (const c of contactos) {
      const nombre = c.verifiedName || c.name || c.notify;
      if (!c.id || !nombre) continue;
      await guardarContacto(c.id, nombre);
      guardados++;
    }
    if (guardados > 0) console.log(`[WA] ${guardados} contactos sincronizados`);
  }
  sock.ev.on('contacts.upsert', procesarContactos);
  sock.ev.on('contacts.update', procesarContactos);

  // Backfill: cuando WhatsApp sincroniza historial, guardamos mensajes recientes
  // de chats individuales para el resumen diario. También extraemos contactos.
  sock.ev.on('messaging-history.set', async ({ messages, contacts }) => {
    ultimaActividadMensajes = Date.now();
    if (contacts?.length) await procesarContactos(contacts);
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
        const insertado = await guardarMensaje({ ...msgData, esVip, tieneKeyword });
        if (insertado) guardados++;
      } catch (err) {
        console.error(`[WA] Error en backfill:`, err.message);
      }
    }
    if (guardados > 0) {
      console.log(`[WA] Backfill: ${guardados} mensajes nuevos guardados (últimos ${dias} días, duplicados ignorados)`);
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
      ultimaActividadMensajes = Date.now();
      // Presencia "unavailable": le dice a WhatsApp que este dispositivo está
      // inactivo, así las push siguen llegando al teléfono aunque el bot esté conectado.
      try { await sock.sendPresenceUpdate('unavailable'); } catch {}
      console.log(`[WA] Cliente listo — escuchando mensajes (presencia: unavailable)`);
      if (callbacks.onListo) callbacks.onListo();
    }

    if (connection === 'close') {
      listo = false;
      if (desconexionVoluntaria) {
        console.log(`[WA] Desconexión voluntaria (modo ahorro) — el teléfono queda como único dispositivo activo`);
        if (callbacks.onStandby) callbacks.onStandby();
        return;
      }
      const code = lastDisconnect?.error?.output?.statusCode;
      const motivo = lastDisconnect?.error?.message ?? 'desconocido';
      console.warn(`[WA] Desconectado (${code}): ${motivo}`);
      if (callbacks.onDesconectado) callbacks.onDesconectado(code, motivo);

      if (code === DisconnectReason.loggedOut) {
        console.error(`[WA] Sesión cerrada por WhatsApp — borrando creds inválidas y pidiendo QR nuevo`);
        try { await limpiarAuth(); } catch (err) { console.error(`[WA] Error limpiando auth:`, err.message); }
        setTimeout(() => {
          iniciarCliente(callbacks).catch((err) => console.error(`[WA] Error reintentando tras loggedOut:`, err.message));
        }, 3000);
        return;
      }

      // 440 = otra instancia tomó la sesión (típicamente deploy solapado en Render).
      // En vez de retirarse para siempre, esperar 60s y reintentar — para entonces
      // la otra instancia ya debería haber muerto y esta puede retomar la sesión.
      if (code === 440) {
        console.warn(`[WA] Conflicto de sesión (440) — otra instancia activa, esperando 60s para reintentar`);
        setTimeout(() => {
          iniciarCliente(callbacks).catch((err) => console.error(`[WA] Error reintentando tras 440:`, err.message));
        }, 60000);
        return;
      }

      // Backoff exponencial para reintentos genéricos: 3s, 10s, 30s, luego cada 60s
      const delay = code === DisconnectReason.connectionReplaced ? 30000 : 3000;
      console.log(`[WA] Reintentando conexión en ${delay / 1000}s...`);
      setTimeout(() => {
        iniciarCliente(callbacks).catch((err) =>
          console.error(`[WA] Error reintentando:`, err.message)
        );
      }, delay);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    ultimaActividadMensajes = Date.now();
    // 'notify' = mensajes en vivo. 'append' = mensajes que WhatsApp entrega al
    // reconectar — típicamente los que llegaron mientras el bot estaba caído por
    // un redeploy/reinicio de Render. Capturamos ambos para cerrar esas ventanas
    // ciegas; el índice único de la DB (chat_id, remitente_id, timestamp, cuerpo)
    // evita duplicados. No tocamos syncFullHistory para no suprimir las push.
    if (type !== 'notify' && type !== 'append') return;

    const dias = config.dias_historial ?? 15;
    const limiteTimestamp = Math.floor(Date.now() / 1000) - dias * 86400;
    const metaCache = new Map(); // evita pedir groupMetadata por cada mensaje en una ráfaga
    let recuperados = 0;

    for (const msg of messages) {
      try {
        if (msg.key.fromMe || !msg.message) continue;

        const cuerpo = extraerCuerpo(msg.message);
        if (!cuerpo) continue;

        const ts = Number(msg.messageTimestamp);
        // En el catch-up (append) ignoramos lo más viejo que la ventana de historial
        // para no arrastrar mensajes antiguos a un digest.
        if (type === 'append' && ts < limiteTimestamp) continue;

        const chatId = msg.key.remoteJid;
        const remitenteId = msg.key.participant || chatId;
        const remitente = msg.pushName ?? null;

        let chatNombre = remitente;
        if (chatId.endsWith('@g.us')) {
          if (metaCache.has(chatId)) {
            chatNombre = metaCache.get(chatId);
          } else {
            try {
              const meta = await sock.groupMetadata(chatId);
              chatNombre = meta.subject;
            } catch {
              chatNombre = null;
            }
            metaCache.set(chatId, chatNombre);
          }
        }

        const msgData = { chatId, chatNombre, remitente, remitenteId, cuerpo, timestamp: ts };

        if (!debeAnalizarse(msgData)) continue;

        const { esVip, tieneKeyword } = obtenerFlags(msgData);
        const insertado = await guardarMensaje({ ...msgData, esVip, tieneKeyword });

        if (type === 'notify') {
          console.log(
            `[WA] Mensaje guardado — Chat: ${chatNombre ?? chatId} | VIP: ${esVip} | Keyword: ${tieneKeyword}`
          );
        } else if (insertado) {
          recuperados++;
        }
      } catch (err) {
        console.error(`[WA] Error procesando mensaje entrante:`, err.message);
      }
    }

    if (type === 'append' && recuperados > 0) {
      console.log(`[WA] Catch-up al reconectar: ${recuperados} mensajes recuperados (duplicados ignorados)`);
    }
  });

  return sock;
}

async function resolverDestino() {
  const nombreGrupo = config.grupo_resumen;
  if (nombreGrupo && sock) {
    try {
      const grupos = await sock.groupFetchAllParticipating();
      const nombresDisponibles = Object.values(grupos).map((g) => g.subject);
      console.log(`[WA] Grupos disponibles: ${nombresDisponibles.join(', ') || '(ninguno)'}`);
      const entrada = Object.entries(grupos).find(
        ([, g]) => g.subject?.toLowerCase().trim() === nombreGrupo.toLowerCase().trim()
      );
      if (entrada) {
        console.log(`[WA] Destino resumen: grupo "${nombreGrupo}" (${entrada[0]})`);
        return entrada[0];
      }
      console.warn(`[WA] Grupo "${nombreGrupo}" no encontrado — usando MY_WHATSAPP_ID`);
    } catch (err) {
      console.warn(`[WA] Error buscando grupo destino:`, err.message);
    }
  }
  const destino = normalizarJid(process.env.MY_WHATSAPP_ID);
  console.log(`[WA] Destino resumen: ${destino}`);
  return destino;
}

const TIPO_EMOJI = { accion: '\u{1F534}', pago: '\u{1F4B0}', evento: '\u{1F4C5}', info: 'ℹ️' };

async function enviarResumen(mensajes, temas) {
  if (!sock || !listo) throw new Error('Cliente WA no inicializado');
  if (!temas.length) {
    console.log(`[WA] Sin temas relevantes — resumen omitido`);
    return;
  }

  const hora = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  const lineas = [`\u{1F4CB} *Resumen grupos ${hora}*\n`];

  // Ordenar: primero accion y pago, luego evento, luego info
  const orden = { accion: 0, pago: 1, evento: 2, info: 3 };
  const ordenados = [...temas].sort((a, b) => (orden[a.tipo] ?? 3) - (orden[b.tipo] ?? 3));

  ordenados.forEach((t) => {
    const emoji = TIPO_EMOJI[t.tipo] || '•';
    lineas.push(`${emoji} *${t.tema}* — ${t.chat}`);
    lineas.push(`  ${t.resumen}`);
    if (t.accion) lineas.push(`  _→ ${t.accion}_`);
  });

  const texto = lineas.join('\n');
  const destino = await resolverDestino();

  // Para grupos, obtener metadata antes de enviar fuerza la distribución de claves de cifrado
  if (destino.endsWith('@g.us')) {
    try {
      await sock.groupMetadata(destino);
    } catch {
      // ignorar — el send igual puede funcionar
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  try {
    await sock.sendMessage(destino, { text: texto });
    console.log(`[WA] Resumen enviado a ${destino} — ${temas.length} temas`);
  } catch (err) {
    console.error(`[WA] Error enviando resumen:`, err.message);
  }
}

async function enviarTextoLibre(texto) {
  if (!sock || !listo) throw new Error('Cliente WA no inicializado');
  const destino = await resolverDestino();
  if (destino.endsWith('@g.us')) {
    try { await sock.groupMetadata(destino); } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  try {
    await sock.sendMessage(destino, { text: texto });
    // Re-marcar unavailable: enviar un mensaje puede hacer que WhatsApp considere
    // "activo" a este dispositivo y suprima las push del teléfono.
    try { await sock.sendPresenceUpdate('unavailable'); } catch {}
    console.log(`[WA] Texto enviado a ${destino}`);
    return true;
  } catch (err) {
    console.error(`[WA] Error enviando texto:`, err.message);
    return false;
  }
}

function estaConectado() {
  return listo;
}

/**
 * Conecta bajo demanda (modo ahorro): si ya está conectado no hace nada;
 * si está desconectado a propósito, re-inicia el cliente y espera el 'open'.
 */
async function conectarBajoDemanda(timeoutMs = 60000) {
  if (listo) return;
  if (!sock || desconexionVoluntaria) {
    await iniciarCliente(callbacksGuardados);
  }
  const inicio = Date.now();
  while (!listo) {
    if (Date.now() - inicio > timeoutMs) {
      throw new Error(`Timeout (${timeoutMs / 1000}s) esperando conexión con WhatsApp`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Cierra el socket a propósito (modo ahorro de notificaciones). El handler de
 * 'close' detecta el flag y NO reintenta: el teléfono queda como único
 * dispositivo activo y recibe todas las push. Los mensajes que lleguen
 * mientras tanto se recuperan al reconectar (los entrega WhatsApp como 'append').
 */
async function desconectar() {
  if (!sock) return;
  desconexionVoluntaria = true;
  listo = false;
  try {
    sock.end(undefined);
  } catch (err) {
    console.error(`[WA] Error cerrando socket:`, err.message);
  }
}

/**
 * Espera a que termine de bajar la cola de mensajes offline tras conectar:
 * resuelve cuando pasan quietMs sin recibir mensajes nuevos, con tope maxMs.
 */
async function esperarSincronizacion(quietMs = 15000, maxMs = 90000) {
  const inicio = Date.now();
  while (Date.now() - inicio < maxMs) {
    if (Date.now() - ultimaActividadMensajes >= quietMs) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.warn(`[WA] esperarSincronizacion: tope de ${maxMs / 1000}s alcanzado — sigo con lo que haya`);
}

module.exports = {
  iniciarCliente,
  enviarResumen,
  enviarTextoLibre,
  estaConectado,
  conectarBajoDemanda,
  desconectar,
  esperarSincronizacion,
};
