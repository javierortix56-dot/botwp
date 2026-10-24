// Economía de Gemini y confiabilidad: filtro de mensajes triviales, contexto
// acotado, abandono tras varios fallos, ajustes persistentes, cola/cuota de
// Gemini, logs sin claves de Signal y escapado del panel.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { DatabaseSync } = require('node:sqlite');

const config = require('../config.json');
config.gemini = { min_ms_entre_llamadas: 0, max_llamadas_dia: 4 };

// ── Stubs compartidos ───────────────────────────────────────────────────────
function clienteSqlite() {
  const sqlite = new DatabaseSync(':memory:');
  return {
    async execute(params) {
      const { sql, args = [] } = typeof params === 'string' ? { sql: params } : params;
      const stmt = sqlite.prepare(sql);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql)) return { rows: stmt.all(...args) };
      const r = stmt.run(...args);
      return { rows: [], rowsAffected: Number(r.changes), lastInsertRowid: BigInt(r.lastInsertRowid) };
    },
    async executeMultiple(sql) { sqlite.exec(sql); },
  };
}

const gemini = { respuestas: [], modelos: [] };
const stubs = {
  '@libsql/client': { createClient: clienteSqlite },
  '@whiskeysockets/baileys': { default() {}, DisconnectReason: {}, fetchLatestBaileysVersion() {}, downloadMediaMessage() {}, initAuthCreds() {}, BufferJSON: {}, proto: {} },
  dotenv: { config() {} },
  pino: () => ({}),
  '@google/generative-ai': {
    GoogleGenerativeAI: class {
      getGenerativeModel(opciones) {
        const modelo = {
          opciones,
          generateContent: async () => {
            const r = gemini.respuestas.shift();
            if (r instanceof Error) throw r;
            return { response: { text: () => r ?? '[]' } };
          },
        };
        gemini.modelos.push(modelo);
        return modelo;
      }
    },
  },
};
const original = Module._load;
Module._load = function (pedido, ...resto) {
  return Object.prototype.hasOwnProperty.call(stubs, pedido) ? stubs[pedido] : original.call(this, pedido, ...resto);
};

const { esTrivial } = require('../filtros');
const db = require('../db');
const gem = require('../gemini');
const panel = require('../panel');

// ── Filtro de mensajes triviales ────────────────────────────────────────────
test('esTrivial: saludos, "ok", risas y emojis no gastan Gemini; lo que tiene contenido sí', () => {
  for (const t of ['ok', 'Gracias!!', 'Buen día a todos ☀️', 'jajajaja', '👍👍', '[sticker]', 'dale, listo', '', 'Muchas gracias']) {
    assert.equal(esTrivial(t), true, JSON.stringify(t));
  }
  for (const t of ['Muchas gracias Marta', 'Mañana no hay clases', 'Vendo bici $30.000', '[imagen]', 'Sí, confirmo', 'Hola, ¿cómo estás?', 'feliz cumple Pepe!!']) {
    assert.equal(esTrivial(t), false, JSON.stringify(t));
  }
});

// ── Base de datos ───────────────────────────────────────────────────────────
test('db: el contexto de mensajes viejos se limita y los fallos repetidos se abandonan', async () => {
  await db.conectar();
  const ahora = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 30; i++) {
    await db.guardarMensaje({ chatId: 'g@g.us', chatNombre: 'G', remitente: 'A', remitenteId: 'a', cuerpo: `viejo ${i}`, timestamp: ahora - 3600 + i });
  }
  const viejos = (await db.obtenerMensajesSinProcesar({ contexto: 0 })).map((m) => m.id);
  await db.marcarProcesados(viejos);
  await db.guardarMensaje({ chatId: 'g@g.us', chatNombre: 'G', remitente: 'A', remitenteId: 'a', cuerpo: 'nuevo', timestamp: ahora });

  const conContexto = await db.obtenerMensajesSinProcesar({ contexto: 5 });
  assert.equal(conContexto.filter((m) => m.solo_contexto).length, 5);
  assert.equal(conContexto.filter((m) => !m.solo_contexto).length, 1);
  assert.equal(await db.contarPendientes(), 1);

  const nuevo = conContexto.find((m) => !m.solo_contexto).id;
  assert.equal(await db.registrarFallos([nuevo], 3), 0);
  assert.equal(await db.registrarFallos([nuevo], 3), 0);
  assert.equal(await db.registrarFallos([nuevo], 3), 1, 'al tercer fallo se abandona');
  assert.equal(await db.contarPendientes(), 0);
});

test('db: ajustes persistentes y limpieza de los mensajes de prueba viejos', async () => {
  assert.equal(await db.obtenerAjuste('no-existe'), null);
  assert.equal(await db.guardarAjuste('config_usuario', { nombre_dueno: 'JO', grupos: [{ nombre: 'X' }] }), true);
  assert.deepEqual(await db.obtenerAjuste('config_usuario'), { nombre_dueno: 'JO', grupos: [{ nombre: 'X' }] });
  await db.guardarAjuste('config_usuario', { nombre_dueno: 'Otro' });
  assert.deepEqual(await db.obtenerAjuste('config_usuario'), { nombre_dueno: 'Otro' });

  await db.guardarMensaje({ chatId: 'test@c.us', chatNombre: 'Chat de prueba', remitente: 'Tester', remitenteId: 'test@c.us', cuerpo: 'URGENTE', timestamp: 1 });
  await db.conectar();
  const quedan = (await db.obtenerMensajesDesde(0)).filter((m) => m.chat_id === 'test@c.us');
  assert.equal(quedan.length, 0);

  const id = await db.guardarReporte('digest', 'hola', 1, 1);
  assert.equal((await db.ultimoReporte('digest')).id, id);
});

// ── Gemini: modo JSON, cola, 429 y tope diario ──────────────────────────────
test('gemini: análisis y filtros usan el modelo JSON; titular el de texto', async () => {
  const json = gemini.modelos.find((m) => m.opciones?.generationConfig?.responseMimeType === 'application/json');
  const texto = gemini.modelos.find((m) => !m.opciones?.generationConfig?.responseMimeType);
  assert.ok(json && texto);
  assert.equal(json.opciones.model, 'gemini-2.5-flash-lite');
  assert.ok(json.opciones.generationConfig.temperature <= 0.3);

  gemini.respuestas.push('Tenés que confirmar la reunión del jueves.');
  assert.equal(await gem.generarTitular(['Confirmar reunión']), 'Tenés que confirmar la reunión del jueves.');
  assert.equal(gem.usoGemini().por_tipo.titular, 1);
});

test('gemini: un 429 por minuto se reintenta solo; uno por cuota diaria corta y no reintenta', async () => {
  gemini.respuestas.push(new Error('[429 Too Many Requests] Resource has been exhausted. Please retry in 0s.'), 'Frase final.');
  assert.equal(await gem.generarTitular(['x']), 'Frase final.');
  assert.ok(gem.usoGemini().limitados >= 1);

  gemini.respuestas.push(new Error('[429 Too Many Requests] quota exceeded: GenerateRequestsPerDayPerProjectPerModel-FreeTier'));
  assert.equal(await gem.generarTitular(['x']), '', 'el titular nunca rompe el resumen');
  assert.ok(gem.usoGemini().total >= gem.usoGemini().limite, 'queda marcado como cuota agotada');
  gemini.respuestas.push('no debería usarse');
  assert.equal(await gem.filtrarSinResponder([{ chatId: 'a', nombre: 'A', mensajes: [] }]), null, 'con la cuota agotada no se llama más');
  assert.equal(gemini.respuestas.length, 1);
  gemini.respuestas.length = 0;
});

test('un chat individual sin nombre no muestra el id interno de WhatsApp', () => {
  assert.equal(gem.nombreDeJid('246402324136096@lid'), 'Chat sin nombre guardado');
  assert.equal(gem.nombreDeJid('5491164049863@s.whatsapp.net'), '+5491164049863');
});

// ── Logs sin claves de Signal ───────────────────────────────────────────────
test('los volcados de sesiones de Signal (con claves privadas) no llegan a los logs', () => {
  const impreso = [];
  const consolaOriginal = { info: console.info, log: console.log, warn: console.warn };
  console.info = (...a) => impreso.push(a);
  console.log = (...a) => impreso.push(a);
  console.warn = (...a) => impreso.push(a);
  try {
    delete require.cache[require.resolve('../whatsapp')];
    require('../whatsapp');
    console.info('Closing session:', { privKey: Buffer.from('secreto') });
    console.info('Removing old closed session:', { rootKey: Buffer.from('secreto') });
    console.warn('Closing open session in favor of incoming prekey bundle');
    console.log('[WA] Cliente listo');
  } finally {
    Object.assign(console, consolaOriginal);
  }
  const todo = JSON.stringify(impreso);
  assert.doesNotMatch(todo, /privKey|rootKey|secreto/);
  assert.match(todo, /\[Signal\] Closing open session/);
  assert.match(todo, /\[WA\] Cliente listo/);
});

// ── Panel ───────────────────────────────────────────────────────────────────
test('panel: los nombres de chats y reportes se escapan (sin inyección de HTML)', () => {
  const malicioso = '<script>alert(1)</script>';
  const conf = panel.paginaConfigurar({ chats: [{ chat_nombre: malicioso, cantidad: 1, frecuencia: 8, esGrupo: true }], nombreDueno: '"><img src=x>', intereses: [malicioso] });
  assert.doesNotMatch(conf, /<script>alert/);
  assert.doesNotMatch(conf, /"><img/);
  const reps = panel.paginaReportes([{ id: 1, tipo: malicioso, n_mensajes: 2, n_temas: 1, creado_en: 1789470000 }]);
  assert.doesNotMatch(reps, /<script>alert/);
  const inicio = panel.paginaInicio({ nombre: malicioso, conexion: 'conectado', gemini: { total: 10, limite: 900 } });
  assert.doesNotMatch(inicio, /<script>alert/);
  assert.match(inicio, /WhatsApp conectado/);
});
