const { createClient } = require('@libsql/client');
const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
require('dotenv').config();

let db;

/**
 * Detecta errores de Turso que valen la pena reintentar: caídas transitorias
 * del servidor (5xx), cortes de stream, timeouts y fallos de red. Un 502/503
 * casi siempre es un hipo momentáneo de Turso — no un problema de datos.
 */
function esErrorTransitorio(err) {
  const msg = err?.message || '';
  const status = err?.cause?.status ?? err?.status;
  return (
    [500, 502, 503, 504].includes(Number(status)) ||
    /\b50[0234]\b/.test(msg) ||
    /SERVER_ERROR|stream|timed? ?out|ECONN|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network/i.test(msg)
  );
}

/**
 * Ejecuta una operación contra Turso reintentando ante errores transitorios,
 * con backoff exponencial (1s, 2s, 4s, 8s). Si el error no es transitorio, o se
 * agotan los intentos, re-lanza. Los errores "de datos" no se reintentan.
 */
async function conReintentoTurso(fn, etiqueta = 'Turso', intentos = 4) {
  let ultimoError;
  for (let i = 1; i <= intentos; i++) {
    try {
      return await fn();
    } catch (err) {
      ultimoError = err;
      if (!esErrorTransitorio(err) || i === intentos) throw err;
      const espera = Math.min(1000 * 2 ** (i - 1), 8000);
      console.warn(`[DB] ${etiqueta}: error transitorio (intento ${i}/${intentos}), reintento en ${espera / 1000}s — ${err.message}`);
      await new Promise((r) => setTimeout(r, espera));
    }
  }
  throw ultimoError;
}

/** Wrapper de db.execute con reintentos ante hipos de Turso. */
function dbExecute(params, etiqueta = 'execute') {
  return conReintentoTurso(() => db.execute(params), etiqueta);
}

async function conectar() {
  db = createClient({
    url: process.env.TURSO_URL,
    authToken: process.env.TURSO_TOKEN,
  });

  await conReintentoTurso(() => db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS mensajes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id     TEXT    NOT NULL,
      chat_nombre TEXT,
      remitente   TEXT,
      remitente_id TEXT,
      cuerpo      TEXT    NOT NULL,
      timestamp   INTEGER NOT NULL,
      es_vip      INTEGER DEFAULT 0,
      tiene_keyword INTEGER DEFAULT 0,
      procesado   INTEGER DEFAULT 0,
      creado_en   INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS wa_auth (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS chat_seguimiento (
      chat_nombre_key TEXT PRIMARY KEY,
      ultimo_procesado INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS contactos (
      jid          TEXT PRIMARY KEY,
      nombre       TEXT,
      updated_at   INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS reportes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo        TEXT,
      contenido   TEXT NOT NULL,
      n_mensajes  INTEGER DEFAULT 0,
      n_temas     INTEGER DEFAULT 0,
      creado_en   INTEGER DEFAULT (unixepoch())
    );
  `), 'schema');

  // Crear índice único para deduplicación. Si ya hay duplicados de antes
  // del fix, borramos los repetidos (conservando el de menor id) y luego
  // creamos el índice. Idempotente: si el índice ya existe, no hace nada.
  try {
    await dbExecute(`
      DELETE FROM mensajes
      WHERE id NOT IN (
        SELECT MIN(id) FROM mensajes
        GROUP BY chat_id, COALESCE(remitente_id, ''), timestamp, cuerpo
      )
    `, 'dedup-delete');
    await dbExecute(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mensajes_dedup
        ON mensajes (chat_id, remitente_id, timestamp, cuerpo)
    `, 'dedup-index');
  } catch (err) {
    console.warn(`[DB] No se pudo crear índice de deduplicación:`, err.message);
  }

  console.log(`[DB] Conectado a Turso y tablas listas`);
}

async function guardarMensaje({ chatId, chatNombre, remitente, remitenteId, cuerpo, timestamp, esVip, tieneKeyword }) {
  try {
    const result = await dbExecute({
      sql: `INSERT OR IGNORE INTO mensajes (chat_id, chat_nombre, remitente, remitente_id, cuerpo, timestamp, es_vip, tiene_keyword)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [chatId, chatNombre ?? null, remitente ?? null, remitenteId ?? null, cuerpo, timestamp, esVip ? 1 : 0, tieneKeyword ? 1 : 0],
    }, 'guardarMensaje');
    return result.rowsAffected > 0;
  } catch (err) {
    console.error(`[DB] Error al guardar mensaje de ${chatId}:`, err.message);
    return false;
  }
}

async function obtenerMensajesSinProcesar() {
  try {
    const result = await db.execute(
      `SELECT * FROM mensajes WHERE procesado = 0 ORDER BY timestamp ASC`
    );
    return result.rows;
  } catch (err) {
    console.error(`[DB] Error al leer mensajes sin procesar:`, err.message);
    return [];
  }
}

async function obtenerMensajesDesde(timestampDesde) {
  try {
    const result = await db.execute({
      sql: `SELECT * FROM mensajes WHERE timestamp >= ? ORDER BY timestamp ASC`,
      args: [timestampDesde],
    });
    return result.rows;
  } catch (err) {
    console.error(`[DB] Error al leer mensajes desde ${timestampDesde}:`, err.message);
    return [];
  }
}

async function marcarProcesados(ids) {
  if (!ids.length) return;
  try {
    const placeholders = ids.map(() => '?').join(', ');
    await db.execute({
      sql: `UPDATE mensajes SET procesado = 1 WHERE id IN (${placeholders})`,
      args: ids,
    });
  } catch (err) {
    console.error(`[DB] Error al marcar mensajes como procesados:`, err.message);
  }
}

/**
 * Devuelve chats distintos con mensajes en los últimos `dias` días,
 * ordenados por cantidad DESC. Array de { chat_id, chat_nombre, cantidad }.
 */
async function obtenerChatsDistintos(dias = 30) {
  try {
    const desde = Math.floor(Date.now() / 1000) - dias * 86400;
    const result = await db.execute({
      sql: `SELECT chat_id, chat_nombre, COUNT(*) as cantidad
            FROM mensajes
            WHERE timestamp >= ?
            GROUP BY chat_id, chat_nombre
            ORDER BY cantidad DESC`,
      args: [desde],
    });
    return result.rows;
  } catch (err) {
    console.error(`[DB] Error al obtener chats distintos:`, err.message);
    return [];
  }
}

/**
 * Último nombre conocido de un chat, sacado de los mensajes ya guardados.
 * Se usa como fallback cuando groupMetadata falla al reconectar: sin nombre,
 * el filtro de grupos monitoreados descartaba el mensaje en silencio.
 */
async function obtenerNombreChatConocido(chatId) {
  try {
    const result = await db.execute({
      sql: `SELECT chat_nombre FROM mensajes
            WHERE chat_id = ? AND chat_nombre IS NOT NULL
            ORDER BY id DESC LIMIT 1`,
      args: [chatId],
    });
    return result.rows[0]?.chat_nombre || null;
  } catch (err) {
    console.error(`[DB] Error buscando nombre conocido de ${chatId}:`, err.message);
    return null;
  }
}

/**
 * Devuelve mensajes sin procesar de un chat específico, ordenados por timestamp ASC.
 */
async function obtenerMensajesChatSinProcesar(chatId) {
  try {
    const result = await db.execute({
      sql: `SELECT * FROM mensajes WHERE procesado = 0 AND chat_id = ? ORDER BY timestamp ASC`,
      args: [chatId],
    });
    return result.rows;
  } catch (err) {
    console.error(`[DB] Error al leer mensajes sin procesar de ${chatId}:`, err.message);
    return [];
  }
}

/**
 * Lee el ultimo_procesado de chat_seguimiento para la clave dada.
 * Devuelve el integer o 0 si no existe.
 */
async function obtenerUltimoProcesado(chatNombreKey) {
  try {
    const result = await db.execute({
      sql: `SELECT ultimo_procesado FROM chat_seguimiento WHERE chat_nombre_key = ?`,
      args: [chatNombreKey],
    });
    if (!result.rows[0]) return 0;
    return result.rows[0].ultimo_procesado || 0;
  } catch (err) {
    console.error(`[DB] Error al obtener ultimo_procesado de "${chatNombreKey}":`, err.message);
    return 0;
  }
}

/**
 * Actualiza (o inserta) el ultimo_procesado para la clave dada con el timestamp actual.
 */
async function actualizarUltimoProcesado(chatNombreKey) {
  try {
    await db.execute({
      sql: `INSERT OR REPLACE INTO chat_seguimiento (chat_nombre_key, ultimo_procesado) VALUES (?, unixepoch())`,
      args: [chatNombreKey],
    });
  } catch (err) {
    console.error(`[DB] Error al actualizar ultimo_procesado de "${chatNombreKey}":`, err.message);
  }
}

/**
 * Guarda o actualiza un contacto (jid → nombre amigable).
 * Solo actualiza si el nuevo nombre no es vacío.
 */
async function guardarContacto(jid, nombre) {
  if (!jid || !nombre) return;
  try {
    await db.execute({
      sql: `INSERT INTO contactos (jid, nombre, updated_at) VALUES (?, ?, unixepoch())
            ON CONFLICT(jid) DO UPDATE SET nombre = excluded.nombre, updated_at = unixepoch()`,
      args: [jid, nombre],
    });
  } catch (err) {
    console.error(`[DB] Error guardando contacto ${jid}:`, err.message);
  }
}

/**
 * Devuelve un Map<jid, nombre> con todos los contactos guardados.
 */
async function obtenerContactos() {
  try {
    const result = await db.execute(`SELECT jid, nombre FROM contactos`);
    const mapa = new Map();
    for (const row of result.rows) mapa.set(row.jid, row.nombre);
    return mapa;
  } catch (err) {
    console.error(`[DB] Error leyendo contactos:`, err.message);
    return new Map();
  }
}

/**
 * Guarda un reporte enviado (digest o resumen a demanda) para poder auditarlo
 * después desde /reportes. No falla el flujo si la inserción falla.
 */
async function guardarReporte(tipo, contenido, nMensajes = 0, nTemas = 0) {
  try {
    await db.execute({
      sql: `INSERT INTO reportes (tipo, contenido, n_mensajes, n_temas) VALUES (?, ?, ?, ?)`,
      args: [tipo ?? null, contenido, nMensajes, nTemas],
    });
  } catch (err) {
    console.error(`[DB] Error guardando reporte:`, err.message);
  }
}

/**
 * Devuelve los últimos `limite` reportes, más recientes primero.
 */
async function obtenerReportes(limite = 20) {
  try {
    const result = await db.execute({
      sql: `SELECT id, tipo, contenido, n_mensajes, n_temas, creado_en
            FROM reportes ORDER BY creado_en DESC LIMIT ?`,
      args: [limite],
    });
    return result.rows;
  } catch (err) {
    console.error(`[DB] Error leyendo reportes:`, err.message);
    return [];
  }
}

// Auth state para Baileys persistido en Turso.
// Permite que la sesión sobreviva reinicios del contenedor sin re-escanear QR.
async function useTursoAuthState() {
  const writeData = async (key, value) => {
    await dbExecute({
      sql: `INSERT INTO wa_auth (key, value, updated_at) VALUES (?, ?, unixepoch())
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`,
      args: [key, JSON.stringify(value, BufferJSON.replacer)],
    }, `writeData ${key}`);
  };

  const readData = async (key) => {
    const result = await dbExecute({
      sql: `SELECT value FROM wa_auth WHERE key = ?`,
      args: [key],
    }, `readData ${key}`);
    if (!result.rows[0]) return null;
    return JSON.parse(result.rows[0].value, BufferJSON.reviver);
  };

  const removeData = async (key) => {
    await dbExecute({ sql: `DELETE FROM wa_auth WHERE key = ?`, args: [key] }, `removeData ${key}`);
  };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          try {
            await Promise.all(ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (value && type === 'app-state-sync-key') {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              if (value) data[id] = value;
            }));
          } catch (err) {
            // Nunca dejar que un hipo de Turso propague desde un handler de
            // Baileys y crashee el proceso. Devolvemos lo que se pudo leer.
            console.error(`[DB] Error leyendo keys (${type}):`, err.message);
          }
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(key, value) : removeData(key));
            }
          }
          try {
            await Promise.all(tasks);
          } catch (err) {
            console.error(`[DB] Error guardando keys (se reintentará en el próximo update):`, err.message);
          }
        },
      },
    },
    // saveCreds jamás debe tirar: se dispara desde el evento 'creds.update' de
    // Baileys, y una excepción sin capturar ahí mataba el proceso entero cuando
    // Turso devolvía 502. Si falla, se logea y se reintenta en el próximo update.
    saveCreds: async () => {
      try {
        await writeData('creds', creds);
      } catch (err) {
        console.error(`[DB] No se pudieron guardar creds (se reintentará en el próximo update):`, err.message);
      }
    },
  };
}

async function limpiarAuth() {
  try {
    await db.execute(`DELETE FROM wa_auth`);
    console.log(`[DB] Auth state borrado — próximo arranque pedirá QR`);
  } catch (err) {
    console.error(`[DB] Error al limpiar auth:`, err.message);
  }
}

module.exports = {
  conectar,
  guardarMensaje,
  obtenerMensajesSinProcesar,
  obtenerMensajesDesde,
  marcarProcesados,
  useTursoAuthState,
  limpiarAuth,
  obtenerChatsDistintos,
  obtenerNombreChatConocido,
  obtenerMensajesChatSinProcesar,
  obtenerUltimoProcesado,
  actualizarUltimoProcesado,
  guardarContacto,
  obtenerContactos,
  guardarReporte,
  obtenerReportes,
};
