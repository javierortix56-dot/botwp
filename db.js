const { createClient } = require('@libsql/client');
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

    CREATE TABLE IF NOT EXISTS sesion_wa (
      id             TEXT PRIMARY KEY,
      data           TEXT NOT NULL,
      actualizado_en INTEGER DEFAULT (unixepoch())
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

async function guardarSesion(id, data) {
  try {
    await db.execute({
      sql: `INSERT INTO sesion_wa (id, data, actualizado_en)
            VALUES (?, ?, unixepoch())
            ON CONFLICT(id) DO UPDATE SET data = excluded.data, actualizado_en = unixepoch()`,
      args: [id, data],
    });
  } catch (err) {
    console.error(`[DB] Error al guardar sesión WA:`, err.message);
  }
}

async function obtenerSesion(id) {
  try {
    const result = await db.execute({
      sql: `SELECT data FROM sesion_wa WHERE id = ?`,
      args: [id],
    });
    return result.rows[0]?.data ?? null;
  } catch (err) {
    console.error(`[DB] Error al leer sesión WA:`, err.message);
    return null;
  }
}

async function eliminarSesion(id) {
  try {
    await db.execute({ sql: `DELETE FROM sesion_wa WHERE id = ?`, args: [id] });
  } catch (err) {
    console.error(`[DB] Error al eliminar sesión WA:`, err.message);
  }
}

module.exports = { conectar, guardarMensaje, obtenerMensajesSinProcesar, marcarProcesados, guardarSesion, obtenerSesion, eliminarSesion };
