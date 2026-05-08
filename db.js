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
  `);

  console.log(`[DB] Conectado a Turso y tablas listas`);
}

async function guardarMensaje({ chatId, chatNombre, remitente, remitenteId, cuerpo, timestamp, esVip, tieneKeyword }) {
  try {
    await db.execute({
      sql: `INSERT INTO mensajes (chat_id, chat_nombre, remitente, remitente_id, cuerpo, timestamp, es_vip, tiene_keyword)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [chatId, chatNombre ?? null, remitente ?? null, remitenteId ?? null, cuerpo, timestamp, esVip ? 1 : 0, tieneKeyword ? 1 : 0],
    });
  } catch (err) {
    console.error(`[DB] Error al guardar mensaje de ${chatId}:`, err.message);
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
  marcarProcesados,
  useTursoAuthState,
  limpiarAuth,
};
