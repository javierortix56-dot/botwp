const { createClient } = require('@libsql/client');
const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
require('dotenv').config();

let db;

async function conectar() {
  db = createClient({
    url: process.env.TURSO_URL,
    authToken: process.env.TURSO_TOKEN,
  });

  await db.executeMultiple(`
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
  `);

  // Crear índice único para deduplicación. Si ya hay duplicados de antes
  // del fix, borramos los repetidos (conservando el de menor id) y luego
  // creamos el índice. Idempotente: si el índice ya existe, no hace nada.
  try {
    await db.execute(`
      DELETE FROM mensajes
      WHERE id NOT IN (
        SELECT MIN(id) FROM mensajes
        GROUP BY chat_id, COALESCE(remitente_id, ''), timestamp, cuerpo
      )
    `);
    await db.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mensajes_dedup
        ON mensajes (chat_id, remitente_id, timestamp, cuerpo)
    `);
  } catch (err) {
    console.warn(`[DB] No se pudo crear índice de deduplicación:`, err.message);
  }

  console.log(`[DB] Conectado a Turso y tablas listas`);
}

async function guardarMensaje({ chatId, chatNombre, remitente, remitenteId, cuerpo, timestamp, esVip, tieneKeyword }) {
  try {
    const result = await db.execute({
      sql: `INSERT OR IGNORE INTO mensajes (chat_id, chat_nombre, remitente, remitente_id, cuerpo, timestamp, es_vip, tiene_keyword)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [chatId, chatNombre ?? null, remitente ?? null, remitenteId ?? null, cuerpo, timestamp, esVip ? 1 : 0, tieneKeyword ? 1 : 0],
    });
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

// Auth state para Baileys persistido en Turso.
// Permite que la sesión sobreviva reinicios del contenedor sin re-escanear QR.
async function useTursoAuthState() {
  const writeData = async (key, value) => {
    await db.execute({
      sql: `INSERT INTO wa_auth (key, value, updated_at) VALUES (?, ?, unixepoch())
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`,
      args: [key, JSON.stringify(value, BufferJSON.replacer)],
    });
  };

  const readData = async (key) => {
    const result = await db.execute({
      sql: `SELECT value FROM wa_auth WHERE key = ?`,
      args: [key],
    });
    if (!result.rows[0]) return null;
    return JSON.parse(result.rows[0].value, BufferJSON.reviver);
  };

  const removeData = async (key) => {
    await db.execute({ sql: `DELETE FROM wa_auth WHERE key = ?`, args: [key] });
  };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            let value = await readData(`${type}-${id}`);
            if (value && type === 'app-state-sync-key') {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            if (value) data[id] = value;
          }));
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
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => {
      await writeData('creds', creds);
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
  obtenerMensajesChatSinProcesar,
  obtenerUltimoProcesado,
  actualizarUltimoProcesado,
};
