const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const { guardarMensaje, useTursoAuthState, limpiarAuth, guardarContacto, obtenerNombreChatConocido } = require('./db');
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

// Cuenta de reconexiones seguidas sin llegar a 'open'. Se usa para backoff
// exponencial: si WhatsApp corta apenas conectamos (ej. 428 en bucle), NO hay
// que martillar cada 3s — eso puede hacer que WhatsApp limite el número. Se
// resetea a 0 cuando la conexión llega a 'open'.
let intentosReconexion = 0;

// Últimos mensajes salientes (id → contenido proto). Cuando el teléfono no puede
// descifrar un digest ("Esperando el mensaje...") pide un reintento, y Baileys
// necesita getMessage() para reenviarlo — sin esto el mensaje queda ilegible
// para siempre en el teléfono.
const mensajesEnviados = new Map();

function recordarMensajeEnviado(msg) {
  if (!msg?.key?.id || !msg.message) return;
  mensajesEnviados.set(msg.key.id, msg.message);
  if (mensajesEnviados.size > 100) {
    mensajesEnviados.delete(mensajesEnviados.keys().next().value);
  }
}

// Mapa chatId → subject de TODOS los grupos donde participa el dueño.
// groupFetchAllParticipating incluye también los grupos ARCHIVADOS, que no
// siempre vienen en el history sync ni tienen metadata cacheada. Persiste
// entre reconexiones (modo ahorro) para no depender de groupMetadata en
// plena ráfaga de mensajes offline.
const nombresGrupos = new Map();

async function cargarNombresGrupos() {
  try {
    const grupos = await sock.groupFetchAllParticipating();
    for (const [jid, g] of Object.entries(grupos)) {
      if (g?.subject) nombresGrupos.set(jid, g.subject);
    }
    console.log(`[WA] Nombres de ${Object.keys(grupos).length} grupos precargados (incluye archivados)`);
  } catch (err) {
    console.warn(`[WA] No se pudieron precargar nombres de grupos:`, err.message);
  }
}

/**
 * Resuelve el nombre (subject) de un grupo con varios fallbacks:
 * precarga → cache de la ráfaga → groupMetadata → último nombre en la DB.
 * NUNCA cachea un fallo: antes, un solo error de groupMetadata (típico recién
 * reconectado, y habitual en grupos archivados) guardaba null para toda la
 * ráfaga y el filtro descartaba en silencio todos los mensajes de ese grupo.
 */
async function nombreDeGrupo(chatId, metaCache) {
  if (nombresGrupos.has(chatId)) return nombresGrupos.get(chatId);
  if (metaCache.has(chatId)) return metaCache.get(chatId);
  let nombre = null;
  try {
    const meta = await sock.groupMetadata(chatId);
    nombre = meta?.subject || null;
  } catch (err) {
    console.warn(`[WA] groupMetadata falló para ${chatId}: ${err.message} — probando nombre conocido en DB`);
  }
  if (!nombre) nombre = await obtenerNombreChatConocido(chatId);
  if (nombre) {
    metaCache.set(chatId, nombre);
    nombresGrupos.set(chatId, nombre);
  }
  return nombre;
}

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
    // syncFullHistory: con true pide el historial completo al vincular (traería
    // el backlog de los grupos archivados), PERO en cuentas con mucho historial
    // WhatsApp corta la conexión con 428 antes de terminar de conectar y el bot
    // queda en un bucle de reconexión infinito. Por eso queda en FALSE por
    // default. Configurable (`conexion.historial_completo`) — no lo pongas en
    // true a menos que la cuenta tenga poco historial. Para recuperar backlog de
    // archivados sin romper la conexión, la vía correcta es el history sync
    // on-demand (fetchMessageHistory), no este flag.
    syncFullHistory: config.conexion?.historial_completo === true,
    markOnlineOnConnect: false,
    // Servir reintentos de descifrado: si el teléfono no pudo leer un mensaje
    // nuestro, lo reenviamos desde este cache en vez de dejarlo "Esperando...".
    getMessage: async (key) => mensajesEnviados.get(key?.id),
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

  // Backfill: cuando WhatsApp sincroniza historial (incluye chats archivados),
  // guardamos los mensajes recientes para el digest. También extraemos contactos.
  sock.ev.on('messaging-history.set', async ({ chats, messages, contacts }) => {
    ultimaActividadMensajes = Date.now();
    if (contacts?.length) await procesarContactos(contacts);

    // El history sync trae la lista de chats con su nombre real (el subject del
    // grupo, no el pushName del remitente). Antes se guardaba el pushName como
    // chatNombre y el filtro de grupos monitoreados NUNCA matcheaba → todos los
    // mensajes grupales del historial (archivados incluidos) se descartaban.
    const nombresChats = new Map();
    for (const c of chats || []) {
      if (c.id && c.name) nombresChats.set(c.id, c.name);
    }

    if (!messages?.length) {
      if (nombresChats.size) console.log(`[WA] History sync: ${nombresChats.size} chats, sin mensajes en este lote`);
      return;
    }
    const dias = config.dias_historial ?? 15;
    const limiteTimestamp = Math.floor(Date.now() / 1000) - dias * 86400;
    const metaCache = new Map(); // grupos sin nombre en el sync → una sola consulta de metadata
    let guardados = 0;
    let filtrados = 0;
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

        let chatNombre = nombresChats.get(chatId) || null;
        if (!chatNombre && chatId.endsWith('@g.us')) {
          chatNombre = await nombreDeGrupo(chatId, metaCache);
        }
        if (!chatNombre && !chatId.endsWith('@g.us')) chatNombre = remitente;

        const msgData = {
          chatId,
          chatNombre,
          remitente,
          remitenteId,
          cuerpo,
          timestamp: ts,
        };

        if (!debeAnalizarse(msgData)) { filtrados++; continue; }

        const { esVip, tieneKeyword } = obtenerFlags(msgData);
        const insertado = await guardarMensaje({ ...msgData, esVip, tieneKeyword });
        if (insertado) guardados++;
      } catch (err) {
        console.error(`[WA] Error en backfill:`, err.message);
      }
    }
    console.log(`[WA] History sync: ${messages.length} mensajes recibidos, ${guardados} guardados, ${filtrados} fuera de los chats monitoreados (ventana ${dias} días)`);
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
      intentosReconexion = 0; // conexión sana — resetea el backoff
      ultimaActividadMensajes = Date.now();
      // Presencia "unavailable": le dice a WhatsApp que este dispositivo está
      // inactivo, así las push siguen llegando al teléfono aunque el bot esté conectado.
      try { await sock.sendPresenceUpdate('unavailable'); } catch {}
      console.log(`[WA] Cliente listo — escuchando mensajes (presencia: unavailable)`);
      // Precargar los nombres de todos los grupos (archivados incluidos) para
      // que la ráfaga de mensajes offline no dependa de groupMetadata.
      cargarNombresGrupos().catch(() => {});
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

      // Backoff exponencial real para reintentos genéricos (incluye el 428
      // "Connection Terminated" en bucle): 3s, 6s, 12s, 24s, 48s, tope 60s.
      // Antes era 3s fijo y un corte persistente martillaba a WhatsApp sin
      // parar, arriesgando que limiten el número.
      intentosReconexion++;
      const base = code === DisconnectReason.connectionReplaced ? 30000 : 3000;
      const delay = Math.min(base * 2 ** (intentosReconexion - 1), 60000);
      console.log(`[WA] Reintentando conexión en ${delay / 1000}s... (intento ${intentosReconexion})`);
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
    const descartadosPorChat = new Map(); // grupos filtrados en esta ráfaga, para el log
    let recuperados = 0;
    let sinContenido = 0;

    for (const msg of messages) {
      try {
        if (msg.key.fromMe) continue;
        if (!msg.message) {
          // Mensaje sin contenido: casi siempre es un fallo de descifrado
          // (sesión Signal corrupta) o un stub de sistema. Antes se descartaba
          // en silencio y el digest salía "todo tranquilo" sin explicación.
          sinContenido++;
          continue;
        }

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
          chatNombre = await nombreDeGrupo(chatId, metaCache);
        }

        const msgData = { chatId, chatNombre, remitente, remitenteId, cuerpo, timestamp: ts };

        if (!debeAnalizarse(msgData)) {
          // Dejar rastro de lo que se descarta: sin esto era imposible ver en
          // los logs que un grupo entero (ej. mal matcheado) se estaba filtrando.
          if (chatId.endsWith('@g.us')) {
            const k = chatNombre || chatId;
            descartadosPorChat.set(k, (descartadosPorChat.get(k) || 0) + 1);
          }
          continue;
        }

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
    if (descartadosPorChat.size > 0) {
      const detalle = [...descartadosPorChat].map(([n, c]) => `"${n}" ×${c}`).join(', ');
      console.log(`[WA] Grupos NO monitoreados descartados (${type}): ${detalle} — si alguno debería estar en el digest, agregalo en /configurar`);
    }
    if (sinContenido > 0) {
      console.warn(`[WA] ⚠️ ${sinContenido} mensaje(s) llegaron sin contenido descifrable (${type}). Si esto se repite en cada conexión, la sesión está corrupta: usar /limpiar-sesion y re-escanear el QR.`);
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
    const enviado = await sock.sendMessage(destino, { text: texto });
    recordarMensajeEnviado(enviado);
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
    const enviado = await sock.sendMessage(destino, { text: texto });
    recordarMensajeEnviado(enviado);
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
 *
 * La ventana se agrandó a propósito (default 20s de silencio, tope 240s): con
 * modo ahorro, al reconectar puede haber cientos de mensajes acumulados (grupos
 * archivados incluidos) y encima Baileys reintenta los que fallan al descifrar
 * ("Bad MAC") pidiéndolos de nuevo — esos reenvíos llegan segundos después y
 * mantienen viva la actividad, así que esperar más deja que el backlog COMPLETO
 * y los reintentos terminen antes de analizar. Antes, con 90s, el digest se
 * armaba con la cola a medio bajar y salía casi vacío.
 */
async function esperarSincronizacion(quietMs, maxMs) {
  const quiet = quietMs ?? (config.conexion?.sync_quiet_segundos ?? 20) * 1000;
  const max = maxMs ?? (config.conexion?.sync_max_segundos ?? 240) * 1000;
  const inicio = Date.now();
  while (Date.now() - inicio < max) {
    if (Date.now() - ultimaActividadMensajes >= quiet) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.warn(`[WA] esperarSincronizacion: tope de ${max / 1000}s alcanzado — sigo con lo que haya`);
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
