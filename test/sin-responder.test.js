// Chats individuales sin responder: SQL real de db.js contra SQLite en memoria
// (node:sqlite) y el filtro de Gemini con respuestas simuladas.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { DatabaseSync } = require('node:sqlite');

// Cliente con la misma forma que @libsql/client, sobre SQLite en memoria.
function clienteSqlite() {
  const sqlite = new DatabaseSync(':memory:');
  return {
    async execute(params) {
      const { sql, args = [] } = typeof params === 'string' ? { sql: params } : params;
      const stmt = sqlite.prepare(sql);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql)) return { rows: stmt.all(...args) };
      const r = stmt.run(...args);
      return { rows: [], rowsAffected: Number(r.changes) };
    },
    async executeMultiple(sql) { sqlite.exec(sql); },
  };
}

let responderGemini = async () => '[]';
const stubs = {
  '@libsql/client': { createClient: clienteSqlite },
  '@whiskeysockets/baileys': { initAuthCreds() {}, BufferJSON: {}, proto: {} },
  dotenv: { config() {} },
  '@google/generative-ai': {
    GoogleGenerativeAI: class {
      getGenerativeModel() {
        return { generateContent: async (p) => ({ response: { text: () => responderGemini(p) } }) };
      }
    },
  },
};
const cargaOriginal = Module._load;
Module._load = function (pedido, ...resto) {
  return Object.prototype.hasOwnProperty.call(stubs, pedido) ? stubs[pedido] : cargaOriginal.call(this, pedido, ...resto);
};
const db = require('../db');
const { filtrarSinResponder } = require('../gemini');
Module._load = cargaOriginal;

const H = 3600;
const ahora = () => Math.floor(Date.now() / 1000);
const PROPIO = '5491100000000@s.whatsapp.net';

async function msg(chatId, haceSegundos, cuerpo, propio = false, nombre = 'Otro') {
  await db.guardarMensaje({
    chatId,
    chatNombre: nombre,
    remitente: propio ? 'JO' : nombre,
    remitenteId: propio ? PROPIO : chatId,
    cuerpo,
    timestamp: ahora() - haceSegundos,
    esPropio: propio,
  });
}

test('detecta solo chats individuales cuyo último mensaje ajeno quedó sin respuesta', async () => {
  await db.conectar();
  await msg('ana@s.whatsapp.net', 48 * H, '¿Venís el sábado?', false, 'Ana');                // sin responder
  await msg('beto@s.whatsapp.net', 48 * H, '¿Me pasás el informe?', false, 'Beto');
  await msg('beto@s.whatsapp.net', 24 * H, 'Ahí te lo mando', true);                         // respondido
  await msg('caro@s.whatsapp.net', 1 * H, '¿Hablamos?', false, 'Caro');                      // < 3 h: charla en curso
  await msg('dani@s.whatsapp.net', 10 * 24 * H, '¿Todo bien?', false, 'Dani');               // fuera de los 7 días
  await msg('grupo@g.us', 48 * H, '¿Quién trae hielo?', false, 'Grupo');                     // grupo: no aplica
  await msg(PROPIO, 48 * H, 'nota para mí', false, 'JO');                                   // chat propio
  await msg('eli@lid', 72 * H, '¿Te sirve el jueves?', true);                                // JO escribió...
  await msg('eli@lid', 24 * H, 'Mejor el viernes, ¿puede ser?', false, 'Eli');               // ...y le contestaron

  const r = await db.obtenerChatsSinResponder({ dias: 7, horasMin: 3, excluir: [PROPIO] });
  assert.deepEqual(r.map((c) => c.chat_id).sort(), ['ana@s.whatsapp.net', 'eli@lid']);

  const eli = r.find((c) => c.chat_id === 'eli@lid');
  assert.deepEqual(eli.mensajes.map((m) => [m.es_propio, m.cuerpo]), [
    [1, '¿Te sirve el jueves?'],
    [0, 'Mejor el viernes, ¿puede ser?'],
  ]);
  assert.equal(eli.ts_ult, eli.mensajes[1].timestamp);
});

test('trae como contexto solo los últimos N mensajes del chat, en orden', async () => {
  for (let i = 1; i <= 12; i++) await msg('fede@s.whatsapp.net', (100 - i) * H, `mensaje ${i}`, false, 'Fede');
  const r = await db.obtenerChatsSinResponder({ dias: 7, horasMin: 3, maxMensajes: 8, excluir: [PROPIO] });
  const fede = r.find((c) => c.chat_id === 'fede@s.whatsapp.net');
  assert.deepEqual(fede.mensajes.map((m) => m.cuerpo), [5, 6, 7, 8, 9, 10, 11, 12].map((i) => `mensaje ${i}`));
});

test('Gemini: devuelve solo los que esperan respuesta, sin duplicados ni índices inventados', async () => {
  let prompt = '';
  responderGemini = (p) => {
    prompt = p;
    return JSON.stringify([
      { n: 0, espera_respuesta: true, que_piden: ' Pregunta si venís el sábado ' },
      { n: 1, espera_respuesta: false, que_piden: null },
      { n: 0, espera_respuesta: true, que_piden: 'duplicado' },
      { n: 9, espera_respuesta: true, que_piden: 'no existe' },
    ]);
  };
  const chats = [
    { chatId: 'ana', nombre: 'Ana', mensajes: [{ es_propio: 0, cuerpo: '¿Venís el sábado?', timestamp: ahora() }] },
    { chatId: 'banco', nombre: 'Banco', mensajes: [{ es_propio: 1, cuerpo: 'hola', timestamp: ahora() }, { es_propio: 0, cuerpo: 'Tu código es 1234', timestamp: ahora() }] },
  ];
  const r = await filtrarSinResponder(chats);
  assert.equal(JSON.stringify(r), JSON.stringify([{ chatId: 'ana', que_piden: 'Pregunta si venís el sábado' }]));
  assert.match(prompt, /"autor":"JO"/);
  assert.match(prompt, /Nunca escribas "el dueño"/);
});

test('Gemini: si falla o responde basura devuelve null; sin chats no llama', async () => {
  const chats = [{ chatId: 'ana', nombre: 'Ana', mensajes: [] }];
  responderGemini = () => { throw new Error('caído'); };
  assert.equal(await filtrarSinResponder(chats), null);
  responderGemini = () => 'no sé';
  assert.equal(await filtrarSinResponder(chats), null);
  let llamadas = 0;
  responderGemini = () => { llamadas++; return '[]'; };
  assert.deepEqual(await filtrarSinResponder([]), []);
  assert.equal(llamadas, 0);
});
