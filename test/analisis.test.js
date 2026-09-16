const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { analizarConversacion, agrupar } = require('../analisis');
const config = { nombre_dueno: 'Javier', max_mensajes_por_batch: 1 };
const mensaje = (id, extra = {}) => ({ id, chat_id: 'a@s.whatsapp.net', remitente: 'Ana', cuerpo: 'Confirma la reserva', timestamp: 1789470000 + id, ...extra });
const tema = (ids, extra = {}) => ({ tema: 'Reserva', resumen: 'Confirmar reserva', tipo: 'accion', estado: 'pendiente', relevancia: 3, para_mi: true, ids, ...extra });

test('una respuesta propia posterior resuelve el pedido entre bloques', async () => {
  let n = 0;
  const result = await analizarConversacion('Ana', [mensaje(1), mensaje(2, { es_propio: 1, cuerpo: 'Ya confirmé' })], async prompt => {
    n++;
    if (n === 2) {
      assert.match(prompt, /ESTADO ANTERIOR:.*Confirmar reserva/);
      assert.match(prompt, /"autor":"DUEÑO"/);
    }
    return JSON.stringify([tema(n === 1 ? [1] : [1, 2], n === 1 ? {} : { tipo: 'info', estado: 'resuelto', resumen: 'Reserva confirmada' })]);
  }, config);
  assert.equal(result.temas.length, 1);
  assert.equal(result.temas[0].estado, 'resuelto');
  assert.deepEqual(result.idsProcesados, [1, 2]);
});

test('un fallo posterior no publica un pendiente parcial', async () => {
  let n = 0;
  const result = await analizarConversacion('Ana', [mensaje(1), mensaje(2)], async () => ++n === 1 ? JSON.stringify([tema([1])]) : 'error', config);
  assert.equal(result.errores, 1);
  assert.deepEqual(result.temas, []);
  assert.deepEqual(result.idsProcesados, []);
});

test('rechaza ids inventados y respuestas de esquema inválido', async () => {
  for (const respuesta of [[tema([99])], [{ resumen: 'sin evidencia' }], {}]) {
    const result = await analizarConversacion('Ana', [mensaje(1)], async () => JSON.stringify(respuesta), config);
    assert.equal(result.errores, 1);
  }
});

test('contexto antiguo no se vuelve a publicar ni marcar', async () => {
  const result = await analizarConversacion('Ana', [mensaje(1, { solo_contexto: 1 }), mensaje(2)], async () => JSON.stringify([tema([1])]), config);
  assert.deepEqual(result.temas, []);
  assert.deepEqual(result.idsProcesados, [2]);
});

test('mensajes llevan su fecha local y los chats se mantienen separados', async () => {
  const a = mensaje(1, { timestamp: Date.parse('2026-09-15T01:30:00Z') / 1000 });
  const b = mensaje(2, { chat_id: 'b@s.whatsapp.net' });
  assert.equal(agrupar([a, b]).size, 2);
  await analizarConversacion('Ana', [a], async prompt => {
    assert.match(prompt, /2026-09-14 22:30:00/);
    return '[]';
  }, config);
});

test('integración individuales: llamadas aisladas, fecha y resumen conservados', async () => {
  const prompts = [];
  const mockModel = { generateContent: async prompt => {
    prompts.push(prompt);
    const datos = JSON.parse(prompt.split('MENSAJES: ')[1]);
    return { response: { text: () => JSON.stringify([tema(datos.map(d => d.id), { fecha_limite: '2026-09-20' })]) } };
  } };
  const sandbox = { module: { exports: {} }, console, process: { env: {} }, setTimeout,
    require: name => {
      if (name === '@google/generative-ai') return { GoogleGenerativeAI: class { getGenerativeModel() { return mockModel; } } };
      if (name === 'dotenv') return { config() {} };
      if (name === './config.json') return config;
      if (name === './analisis') return require('../analisis');
      throw new Error(name);
    } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../gemini.js'), 'utf8'), sandbox);
  const result = await sandbox.module.exports.analizarIndividuales([mensaje(1), mensaje(2, { chat_id: 'b@s.whatsapp.net', remitente: 'Luis' })]);
  assert.equal(prompts.length, 2);
  assert.equal(result.conversaciones.length, 2);
  assert.equal(result.pedidos[0].fecha_limite, '2026-09-20');
  assert.ok(!prompts[0].includes('"autor":"Luis"'));
  assert.ok(!prompts[1].includes('"autor":"Ana"'));
});
