// Detalle de grupos: modo catálogo, nivel de detalle, intereses, detalle completo
// y reportes con id. Todo con datos simulados, sin WhatsApp ni Gemini reales.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { DatabaseSync } = require('node:sqlite');

const { analizarConversacion } = require('../analisis');
const { obtenerOpcionesGrupo, detalleDefecto, buscarIntereses } = require('../filtros');
const { seccionGrupos, formatearIntereses, formatearDetalle, htmlDesdeTexto, MAX_INTERESES_WA } = require('../formato');

const config = { nombre_dueno: 'JO', max_mensajes_por_batch: 25 };
const mensaje = (id, extra = {}) => ({ id, chat_id: 'g@g.us', remitente: 'Cintia', cuerpo: 'Vendo bici', timestamp: 1789470000 + id, ...extra });
const tema = (ids, extra = {}) => ({ tema: 'Bici', resumen: 'Bici de nena usada, $30.000', tipo: 'info', estado: 'informativo', relevancia: 2, para_mi: false, de: 'Cintia', ids, ...extra });

// ── analisis: modo y detalle ────────────────────────────────────────────────

test('modo catálogo: el prompt pide un ítem por artículo y acepta categoría', async () => {
  let prompt = '';
  const r = await analizarConversacion('Roperito', [mensaje(1)], async (p) => {
    prompt = p;
    return JSON.stringify([tema([1], { categoria: 'venta' })]);
  }, config, false, { modo: 'catalogo', detalle: 'alto' });
  assert.match(prompt, /MODO CATÁLOGO/);
  assert.match(prompt, /"categoria":"venta\|busca\|otro"/);
  assert.match(prompt, /JO/);
  assert.equal(r.errores, 0);
  assert.equal(r.temas[0].categoria, 'venta');
});

test('modo normal: no incluye reglas de catálogo y conserva la regla estricta', async () => {
  let prompt = '';
  await analizarConversacion('Grupo', [mensaje(1)], async (p) => { prompt = p; return '[]'; }, config);
  assert.doesNotMatch(prompt, /MODO CATÁLOGO/);
  assert.match(prompt, /Omite cumpleaños, felicitaciones/);
});

test('detalle alto: no omite ofertas y conserva los temas de relevancia 1', async () => {
  let prompt = '';
  const r = await analizarConversacion('Grupo', [mensaje(1)], async (p) => {
    prompt = p;
    return JSON.stringify([tema([1], { relevancia: 1, resumen: 'Cumpleaños de Marta' })]);
  }, config, false, { detalle: 'alto' });
  assert.match(prompt, /NO omitas ofertas/);
  assert.equal(r.temas.length, 1);
  assert.deepEqual(r.menores, []);
});

test('detalle normal: la charla de relevancia 1 va a "menores", no a temas', async () => {
  const r = await analizarConversacion('Grupo', [mensaje(1)], async () => JSON.stringify([
    tema([1], { relevancia: 1, resumen: 'Charla menor' }),
    tema([1], { relevancia: 2, resumen: 'Novedad útil' }),
  ]), config);
  assert.deepEqual(r.temas.map((t) => t.resumen), ['Novedad útil']);
  assert.deepEqual(r.menores.map((t) => t.resumen), ['Charla menor']);
});

test('una categoría que no es texto invalida la respuesta', async () => {
  const r = await analizarConversacion('Roperito', [mensaje(1)], async () => JSON.stringify([tema([1], { categoria: 5 })]), config, false, { modo: 'catalogo' });
  assert.equal(r.errores, 1);
});

test('los intereses pasados por opciones llegan al prompt', async () => {
  let prompt = '';
  await analizarConversacion('Grupo', [mensaje(1)], async (p) => { prompt = p; return '[]'; }, config, false, { intereses: ['cochecito'] });
  assert.match(prompt, /\["cochecito"\]/);
});

// ── filtros: opciones por grupo e intereses ─────────────────────────────────

test('el Roperito es catálogo; el detalle es alto por defecto y se puede bajar por grupo', () => {
  assert.deepEqual(obtenerOpcionesGrupo('Roperito St. Xavier. (PÁG. Amarillas )'), { modo: 'catalogo', detalle: 'alto' });
  assert.deepEqual(obtenerOpcionesGrupo('5° GRADO MIXTO'), { modo: 'normal', detalle: 'alto' });
  assert.deepEqual(obtenerOpcionesGrupo('Grupo que no existe'), { modo: 'normal', detalle: 'alto' });
  assert.deepEqual(obtenerOpcionesGrupo(null), { modo: 'normal', detalle: 'alto' });
  assert.equal(detalleDefecto(), 'alto');
});

test('un grupo con detalle "normal" explícito lo conserva; sin detalle_defecto todo es normal', () => {
  const original = Module._load;
  const filtrosPath = require.resolve('../filtros');
  const cargarConConfig = (cfg) => {
    Module._load = function (pedido, ...resto) {
      return pedido === './config.json' ? cfg : original.call(this, pedido, ...resto);
    };
    delete require.cache[filtrosPath];
    return require('../filtros');
  };
  const base = { vips: [], keywords: [], grupos: [{ nombre: 'Grupo callado', detalle: 'normal' }, { nombre: 'Otro' }] };
  try {
    const conAlto = cargarConConfig({ ...base, resumen: { detalle_defecto: 'alto' } });
    assert.equal(conAlto.obtenerOpcionesGrupo('Grupo callado').detalle, 'normal');
    assert.equal(conAlto.obtenerOpcionesGrupo('Otro').detalle, 'alto');
    const sinDefecto = cargarConConfig({ ...base, resumen: {} });
    assert.equal(sinDefecto.obtenerOpcionesGrupo('Otro').detalle, 'normal');
    assert.equal(sinDefecto.detalleDefecto(), 'normal');
  } finally {
    Module._load = original;
    delete require.cache[filtrosPath];
  }
});

test('el prompt de detalle alto pide no filtrar por interés', async () => {
  let prompt = '';
  await analizarConversacion('Grupo', [mensaje(1)], async (p) => { prompt = p; return '[]'; }, config, false, { detalle: 'alto' });
  assert.match(prompt, /No filtres por interés ni por relevancia personal de JO/);
  assert.doesNotMatch(prompt, /\{YO\}/);
});

test('chats individuales con detalle alto también conservan la relevancia 1', async () => {
  const r = await analizarConversacion('Ana', [mensaje(1, { chat_id: 'a@s.whatsapp.net' })], async () => JSON.stringify([tema([1], { relevancia: 1, resumen: 'Charla menor' })]), config, true, { detalle: 'alto' });
  assert.equal(r.temas.length, 1);
});

test('intereses: sin acentos ni mayúsculas, desde inicio de palabra, sin falsos positivos', () => {
  const msgs = [
    { chat_id: 'g', chat_nombre: 'Roperito', remitente: 'Laura', remitente_id: 'a', timestamp: 1, cuerpo: 'Vendo BICICLETA rodado 20' },
    { chat_id: 'g', chat_nombre: 'Roperito', remitente: 'Ana', remitente_id: 'b', timestamp: 2, cuerpo: 'Se vende una escuna' },
    { chat_id: 'g', chat_nombre: 'Roperito', remitente: 'Eva', remitente_id: 'c', timestamp: 3, cuerpo: 'Cochecíto en buen estado' },
    { chat_id: 'g', chat_nombre: 'Roperito', remitente: 'Yo', remitente_id: 'd', timestamp: 4, cuerpo: 'busco bici', es_propio: 1 },
    { chat_id: 'g', chat_nombre: 'Roperito', remitente: 'Eva', remitente_id: 'c', timestamp: 5, cuerpo: 'bici vieja', solo_contexto: 1 },
  ];
  const r = buscarIntereses(msgs, ['bici', 'cuna', 'cochecito']);
  assert.deepEqual(r.map((c) => [c.interes, c.de]), [['bici', 'Laura'], ['cochecito', 'Eva']]);
  assert.deepEqual(buscarIntereses(msgs, []), []);
  assert.deepEqual(buscarIntereses(msgs, undefined), []);
});

test('intereses con caracteres especiales no rompen la búsqueda', () => {
  const msgs = [{ chat_id: 'g', remitente: 'A', remitente_id: 'a', timestamp: 1, cuerpo: 'talle (10) disponible' }];
  assert.doesNotThrow(() => buscarIntereses(msgs, ['talle (10', '[x', 'a+b']));
});

// ── formato: sección de grupos ──────────────────────────────────────────────

const catalogo = (items, extra = {}) => ({ chatNombre: 'Roperito', modo: 'catalogo', detalle: 'alto', menores: [], temas: items, ...extra });

test('catálogo: agrupa por vendedor, marca búsquedas y oculta vendidos en WhatsApp', () => {
  const r = seccionGrupos([catalogo([
    tema([1], { de: 'Cintia', resumen: 'Bici de nena, $30.000' }),
    tema([2], { de: 'Marta', resumen: 'Campera talle 8, $12.000' }),
    tema([3], { de: 'Cintia', resumen: 'Casco, $5.000' }),
    tema([4], { de: 'Laura', resumen: 'Cochecito', categoria: 'busca' }),
    tema([5], { de: 'Marta', resumen: 'Botas talle 30', estado: 'resuelto' }),
  ])]);
  assert.match(r.texto, /🛍️ \*Roperito\* — 4 publicaciones/);
  assert.ok(r.texto.indexOf('*Cintia*') < r.texto.indexOf('Casco'), 'Casco debe estar bajo Cintia');
  assert.equal(r.texto.match(/\*Cintia\*/g).length, 1, 'cada vendedor aparece una sola vez');
  assert.match(r.texto, /• 🔎 Cochecito/);
  assert.doesNotMatch(r.texto, /Botas/);
  assert.equal(r.ocultos, 0);
});

test('catálogo completo: incluye vendidos tachados y no tiene topes', () => {
  const items = [tema([1], { de: 'A', resumen: 'Uno' }), tema([2], { de: 'A', resumen: 'Dos' }), tema([3], { de: 'B', resumen: 'Tres', estado: 'resuelto' })];
  const corto = seccionGrupos([catalogo(items)], { limites: { max_items_catalogo: 1 } });
  assert.equal(corto.ocultos, 1);
  assert.match(corto.texto, /1 publicación\(es\) más en el detalle completo|más en el detalle completo/);
  const completo = seccionGrupos([catalogo(items)], { completo: true, limites: { max_items_catalogo: 1 } });
  assert.equal(completo.ocultos, 0);
  assert.match(completo.texto, /Uno/);
  assert.match(completo.texto, /Dos/);
  assert.match(completo.texto, /~Tres~ \(vendido\)/);
});

const grupo = (n, extra = {}) => ({
  chatNombre: 'Grupo', modo: 'normal', detalle: 'normal', menores: [],
  temas: Array.from({ length: n }, (_, i) => tema([i + 1], { tema: `T${i}`, resumen: `Tema número ${i}`, relevancia: 2 })),
  ...extra,
});

test('grupo normal: tope de 5 temas; detalle alto: tope de 12', () => {
  const normal = seccionGrupos([grupo(14)]);
  assert.equal((normal.texto.match(/^• /gm) || []).length, 5);
  assert.equal(normal.ocultos, 9);
  assert.match(normal.texto, /y 9 tema\(s\) más/);
  const alto = seccionGrupos([grupo(14, { detalle: 'alto' })]);
  assert.equal((alto.texto.match(/^• /gm) || []).length, 12);
  assert.equal(alto.ocultos, 2);
});

test('el tope de los grupos normales nunca pasa de 5 aunque la config diga más', () => {
  assert.equal((seccionGrupos([grupo(14)], { limites: { max_temas_grupo: 8 } }).texto.match(/^• /gm) || []).length, 5);
});

test('versión completa: todos los temas y la charla menor', () => {
  const r = seccionGrupos([grupo(14, { menores: [tema([99], { resumen: 'Saludaron a Marta' })] })], { completo: true });
  assert.equal((r.texto.match(/^• /gm) || []).length, 14);
  assert.match(r.texto, /Charla menor/);
  assert.match(r.texto, /◦ Saludaron a Marta/);
  assert.equal(r.ocultos, 0);
});

test('un grupo solo con charla menor no aparece en WhatsApp pero sí en el detalle', () => {
  const g = grupo(0, { menores: [tema([1], { resumen: 'Chismes' })] });
  assert.equal(seccionGrupos([g]).texto, '');
  assert.match(seccionGrupos([g], { completo: true }).texto, /Chismes/);
});

test('los pendientes personales no se repiten en las novedades del grupo', () => {
  const g = grupo(0, { temas: [tema([1], { tipo: 'accion', estado: 'pendiente', para_mi: true, resumen: 'Firmar autorización' }), tema([2], { resumen: 'Cambio de horario' })] });
  const r = seccionGrupos([g]);
  assert.doesNotMatch(r.texto, /Firmar/);
  assert.match(r.texto, /Cambio de horario/);
});

// ── formato: intereses, detalle y HTML ──────────────────────────────────────

test('intereses: WhatsApp muestra pocos y avisa cuántos más hay', () => {
  const c = Array.from({ length: MAX_INTERESES_WA + 2 }, (_, i) => ({ interes: 'bici', chat: 'Roperito', de: `V${i}`, texto: `Vendo bici ${i}`, ts: i }));
  const txt = formatearIntereses(c);
  assert.equal((txt.match(/^• /gm) || []).length, MAX_INTERESES_WA);
  assert.match(txt, /y 2 más en el detalle completo/);
  assert.equal((formatearIntereses(c, { max: Infinity }).match(/^• /gm) || []).length, MAX_INTERESES_WA + 2);
  assert.equal(formatearIntereses([]), '');
});

test('el detalle completo junta grupos e intereses', () => {
  const d = formatearDetalle([catalogo([tema([1], { de: 'Cintia', resumen: 'Bici de nena' })])],
    [{ interes: 'bici', chat: 'Roperito', de: 'Cintia', texto: 'Vendo bici de nena', ts: 1 }], 'manual', {});
  assert.match(d, /Detalle completo\* · manual/);
  assert.match(d, /Novedades de tus grupos/);
  assert.match(d, /Coincidencias con tus intereses/);
});

test('htmlDesdeTexto escapa HTML, da formato y linkea', () => {
  const html = htmlDesdeTexto('*Hola* <script>alert(1)</script> _cursiva_ ~viejo~ https://x.com/reporte?id=3');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /<b>Hola<\/b>/);
  assert.match(html, /<i>cursiva<\/i>/);
  assert.match(html, /<s>viejo<\/s>/);
  assert.match(html, /<a href="https:\/\/x\.com\/reporte\?id=3">/);
});

// ── db: reportes con id ─────────────────────────────────────────────────────

test('guardarReporte devuelve el id y obtenerReporte lo recupera', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const cliente = {
    async execute(params) {
      const { sql, args = [] } = typeof params === 'string' ? { sql: params } : params;
      const stmt = sqlite.prepare(sql);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql)) return { rows: stmt.all(...args) };
      const r = stmt.run(...args);
      return { rows: [], rowsAffected: Number(r.changes), lastInsertRowid: BigInt(r.lastInsertRowid) };
    },
    async executeMultiple(sql) { sqlite.exec(sql); },
  };
  const stubs = {
    '@libsql/client': { createClient: () => cliente },
    '@whiskeysockets/baileys': { initAuthCreds() {}, BufferJSON: {}, proto: {} },
    dotenv: { config() {} },
  };
  const original = Module._load;
  Module._load = function (pedido, ...resto) {
    return Object.prototype.hasOwnProperty.call(stubs, pedido) ? stubs[pedido] : original.call(this, pedido, ...resto);
  };
  try {
    delete require.cache[require.resolve('../db')];
    const db = require('../db');
    await db.conectar();
    const id1 = await db.guardarReporte('detalle', 'contenido uno', 3, 2);
    const id2 = await db.guardarReporte('digest', 'contenido dos');
    assert.equal(typeof id1, 'number');
    assert.equal(id2, id1 + 1);
    const r = await db.obtenerReporte(id1);
    assert.equal(r.contenido, 'contenido uno');
    assert.equal(r.tipo, 'detalle');
    assert.equal(await db.obtenerReporte(9999), null);
  } finally {
    Module._load = original;
  }
});
