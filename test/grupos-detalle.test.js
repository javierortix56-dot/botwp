// Detalle de grupos: modo catálogo, nivel de detalle, intereses, detalle completo
// y reportes con id. Todo con datos simulados, sin WhatsApp ni Gemini reales.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { DatabaseSync } = require('node:sqlite');

const { analizarConversacion } = require('../analisis');
const { obtenerOpcionesGrupo, detalleDefecto, buscarIntereses } = require('../filtros');
const { seccionGrupos, seccionConversaciones, formatearIntereses, formatearDetalle, htmlDesdeTexto, resaltarPrecios, marcaFecha, MAX_INTERESES_WA } = require('../formato');

const config = { nombre_dueno: 'JO', max_mensajes_por_batch: 25 };
const mensaje = (id, extra = {}) => ({ id, chat_id: 'g@g.us', remitente: 'Cintia', cuerpo: 'Vendo bici', timestamp: 1789470000 + id, ...extra });
const tema = (ids, extra = {}) => ({ tema: 'Bici', resumen: 'Bici de nena usada, $30.000', tipo: 'info', estado: 'informativo', relevancia: 2, para_mi: false, de: 'Cintia', ids, ...extra });

// ── analisis: modo y detalle ────────────────────────────────────────────────

test('modo catálogo: el prompt pide un ítem por artículo con clase y rubro', async () => {
  let prompt = '';
  const r = await analizarConversacion('Roperito', [mensaje(1)], async (p) => {
    prompt = p;
    return JSON.stringify([tema([1], { clase: 'ofrecimiento', rubro: 'Bicis' })]);
  }, config, false, { modo: 'catalogo', detalle: 'alto' });
  assert.match(prompt, /MODO CATÁLOGO/);
  assert.match(prompt, /"clase":"aviso","rubro":null/);
  assert.match(prompt, /"ofrecimiento" \(alguien vende/);
  assert.match(prompt, /JO/);
  assert.equal(r.errores, 0);
  assert.equal(r.temas[0].clase, 'ofrecimiento');
  assert.equal(r.temas[0].rubro, 'Bicis');
});

test('una clase desconocida se descarta sin invalidar el chat', async () => {
  const ok = await analizarConversacion('G', [mensaje(1)], async () => JSON.stringify([tema([1], { clase: 'inventada' })]), config);
  assert.equal(ok.errores, 0);
  assert.equal(ok.temas[0].clase, null);
});

test('individuales: el prompt explica esperando_respuesta y que los saludos son relevancia 1', async () => {
  let prompt = '';
  const r = await analizarConversacion('Carmen', [mensaje(1, { chat_id: 'c@s.whatsapp.net', es_propio: 1, cuerpo: '¿Se anima tu mamá a viajar?' })], async (p) => {
    prompt = p;
    return JSON.stringify([tema([1], { resumen: 'Preguntaste si la mamá se anima a viajar', esperando_respuesta: true })]);
  }, config, true, { detalle: 'alto' });
  assert.match(prompt, /esperando_respuesta=true solo si el último mensaje sobre ese tema es de JO/);
  assert.match(prompt, /Saludos, agradecimientos.*relevancia 1/);
  assert.doesNotMatch(prompt, /"clase":"aviso"/);
  assert.equal(r.temas[0].esperando_respuesta, true);
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

test('campos de presentación con formato raro se ignoran sin perder el chat', async () => {
  const r = await analizarConversacion('Roperito', [mensaje(1)], async () => JSON.stringify([tema([1], { categoria: 5, rubro: ['x'], clase: 3, esperando_respuesta: 'si' })]), config, false, { modo: 'catalogo' });
  assert.equal(r.errores, 0);
  assert.deepEqual([r.temas[0].categoria, r.temas[0].rubro, r.temas[0].clase, r.temas[0].esperando_respuesta], [null, null, null, false]);
});

test('una respuesta inválida se reintenta una vez; si vuelve a fallar, el error dice el motivo', async () => {
  let n = 0;
  const ok = await analizarConversacion('G', [mensaje(1)], async () => (++n === 1 ? 'no es json' : JSON.stringify([tema([1])])), config);
  assert.equal(n, 2);
  assert.equal(ok.errores, 0);
  assert.equal(ok.temas.length, 1);

  const errores = [];
  const original = console.error;
  console.error = (...a) => errores.push(a.join(' '));
  try {
    const mal = await analizarConversacion('G', [mensaje(1)], async () => JSON.stringify([tema([99])]), config);
    assert.equal(mal.errores, 1);
  } finally {
    console.error = original;
  }
  assert.match(errores.join('\n'), /tema 1: ningún id está en los mensajes \(99\)/);
});

test('un id de más (rango inventado) se descarta y el tema se conserva con los ids reales', async () => {
  const r = await analizarConversacion('SX Papis', [mensaje(1), mensaje(3)], async () => JSON.stringify([tema([1, 2, 3])]), config);
  assert.equal(r.errores, 0);
  assert.deepEqual(r.temas[0].ids, [1, 3]);
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

test('catálogo: agrupa por clase y rubro, con autor por línea, precios en negrita y sin vendidos en WhatsApp', () => {
  const r = seccionGrupos([catalogo([
    tema([1], { de: 'Raquel', resumen: 'Aire acondicionado 3200W, $350.000', clase: 'ofrecimiento', rubro: 'Hogar' }),
    tema([2], { de: 'Marian', resumen: 'Marian comparte dúplex 4 ambientes en Las Cañitas', clase: 'ofrecimiento', rubro: 'Alquileres' }),
    tema([3], { de: 'Paola', resumen: 'Casa con pileta en Canning, USD 5.500 enero', clase: 'ofrecimiento', rubro: 'alquileres' }),
    tema([4], { de: 'Lau', resumen: 'Service de aire acondicionado confiable', clase: 'solicitud', rubro: 'Servicios' }),
    tema([5], { de: 'Marta', resumen: 'Botas talle 30', clase: 'ofrecimiento', rubro: 'Ropa', estado: 'resuelto' }),
  ])], { hoy: '2026-10-24' });
  const t = r.texto;
  assert.match(t, /^🛍️ \*Roperito\* · 4 publicaciones/);
  assert.ok(t.indexOf('🙋 *Piden o buscan*') < t.indexOf('🎁 *Ofrecen*'), 'pedidos antes que ofrecimientos');
  assert.match(t, /🏠 _Alquileres_\n• Comparte dúplex 4 ambientes en Las Cañitas — \*Marian\*\n• Casa con pileta en Canning, \*USD 5\.500\* enero — \*Paola\*/);
  assert.match(t, /🛋️ _Hogar_\n• Aire acondicionado 3200W, \*\$350\.000\* — \*Raquel\*/);
  assert.match(t, /🛠️ _Servicios_\n• Service de aire acondicionado confiable — \*Lau\*/);
  assert.doesNotMatch(t, /Botas/);
  assert.equal(r.ocultos, 0);
});

test('catálogo completo: incluye lo que ya no está, tachado, y no tiene topes', () => {
  const items = [tema([1], { de: 'A', resumen: 'Uno', clase: 'ofrecimiento' }), tema([2], { de: 'A', resumen: 'Dos', clase: 'ofrecimiento' }), tema([3], { de: 'B', resumen: 'Tres', clase: 'ofrecimiento', estado: 'resuelto' })];
  const corto = seccionGrupos([catalogo(items)], { limites: { max_items_catalogo: 1 } });
  assert.equal(corto.ocultos, 1);
  assert.match(corto.texto, /…y 1 publicación\(es\) más en el detalle completo/);
  const completo = seccionGrupos([catalogo(items)], { completo: true, limites: { max_items_catalogo: 1 } });
  assert.equal(completo.ocultos, 0);
  assert.match(completo.texto, /• Uno — \*A\*/);
  assert.match(completo.texto, /• Dos — \*A\*/);
  assert.match(completo.texto, /• ~Tres~ _\(ya no está\)_ — \*B\*/);
});

test('grupo normal: secciones por clase, ❗ en lo importante y marcas de fecha', () => {
  const g = { chatNombre: '5° Grado', modo: 'normal', detalle: 'alto', menores: [], temas: [
    tema([1], { resumen: 'Se suspende el bingo por el temporal', clase: 'aviso', relevancia: 3 }),
    tema([2], { resumen: 'Acto del día de la familia', clase: 'evento', tipo: 'evento', fecha_limite: '2026-10-25 09:00' }),
    tema([3], { resumen: 'Excursión al zoo', clase: 'evento', tipo: 'evento', fecha_limite: '2026-10-24' }),
    tema([4], { resumen: 'Reunión de padres', clase: 'evento', tipo: 'evento', fecha_limite: '2026-10-29' }),
    tema([5], { resumen: 'Cumpleaños de Pepe', clase: 'social', relevancia: 1 }),
  ] };
  const t = seccionGrupos([g], { hoy: '2026-10-24' }).texto;
  assert.match(t, /^👥 \*5° Grado\*/);
  assert.match(t, /📢 \*Avisos\*\n• ❗ Se suspende el bingo por el temporal/);
  assert.match(t, /• ⏰ \*MAÑANA 09:00\* · Acto del día de la familia/);
  assert.match(t, /• ⚠️ \*HOY\* · Excursión al zoo/);
  assert.match(t, /• 🗓️ \*\w+ 29\/10\* · Reunión de padres/);
  assert.match(t, /🎉 \*Social\*\n• Cumpleaños de Pepe/);
  assert.ok(t.indexOf('Avisos') < t.indexOf('Fechas y eventos') && t.indexOf('Fechas y eventos') < t.indexOf('Social'));
});

test('un chat con una sola clase no lleva encabezado de clase', () => {
  const t = seccionGrupos([{ chatNombre: 'Rosario', modo: 'normal', detalle: 'alto', menores: [], temas: [tema([1], { resumen: 'Salió el boletín', clase: 'aviso' })] }]).texto;
  assert.equal(t, '👥 *Rosario*\n• Salió el boletín');
});

test('compatibilidad: la categoria vieja venta/busca se ubica como ofrecimiento/solicitud', () => {
  const t = seccionGrupos([catalogo([tema([1], { de: 'A', resumen: 'Bici', categoria: 'venta' }), tema([2], { de: 'B', resumen: 'Cochecito', categoria: 'busca' })])]).texto;
  assert.match(t, /🙋 \*Piden o buscan\*\n• Cochecito — \*B\*/);
  assert.match(t, /🎁 \*Ofrecen\*\n• Bici — \*A\*/);
});

test('resaltarPrecios y marcaFecha', () => {
  assert.equal(resaltarPrecios('Bici a $30.000 o USD 50'), 'Bici a *$30.000* o *USD 50*');
  assert.equal(resaltarPrecios('ya *tiene* formato $10'), 'ya *tiene* formato $10');
  assert.equal(resaltarPrecios('enero USD 5.500, febrero $5.000.'), 'enero *USD 5.500*, febrero *$5.000*.');
  assert.equal(resaltarPrecios('a $20 mil'), 'a *$20 mil*');
  assert.equal(marcaFecha('2026-10-23', '2026-10-24'), '', 'una fecha pasada no se marca');
  assert.equal(marcaFecha(null, '2026-10-24'), '');
  assert.equal(marcaFecha('2026-10-24 18:30', '2026-10-24'), '⚠️ *HOY 18:30* · ');
});

test('conversaciones: lo que esperás primero con ⏳; los saludos solo en el detalle', () => {
  const convs = [{ chatNombre: 'Carmen Perez', temas: [
    tema([1], { resumen: 'Le comentaste del regalo', relevancia: 2 }),
    tema([2], { resumen: 'Preguntaste por pasajes al 20/12 a USD 600', relevancia: 2, esperando_respuesta: true }),
    tema([3], { resumen: 'Le mandaste un saludo', relevancia: 1 }),
  ], menores: [] }, { chatNombre: 'Solo hola', temas: [tema([4], { resumen: 'Hola, ¿cómo andás?', relevancia: 1 })], menores: [] }];
  const wa = seccionConversaciones(convs);
  assert.match(wa.texto, /^💬 \*Tus conversaciones\*\n\n👤 \*Carmen Perez\*\n• ⏳ _Esperás respuesta:_ Preguntaste por pasajes al 20\/12 a \*USD 600\*\n• Le comentaste del regalo$/);
  assert.doesNotMatch(wa.texto, /saludo|Solo hola/);
  assert.equal(wa.ocultos, 0, 'los saludos no fuerzan el link al detalle');
  const completo = seccionConversaciones(convs, { completo: true });
  assert.match(completo.texto, /◦ Le mandaste un saludo/);
  assert.match(completo.texto, /👤 \*Solo hola\*\n_Charla menor:_\n◦ Hola, ¿cómo andás\?/);
});

test('conversaciones: sin temas sustanciales no hay sección; los pendientes personales no se repiten', () => {
  assert.equal(seccionConversaciones([{ chatNombre: 'X', temas: [tema([1], { relevancia: 1 })] }]).texto, '');
  const t = seccionConversaciones([{ chatNombre: 'Y', temas: [tema([1], { tipo: 'accion', estado: 'pendiente', para_mi: true, resumen: 'Mandar el comprobante' }), tema([2], { resumen: 'Te contó que se muda' })] }]).texto;
  assert.doesNotMatch(t, /comprobante/);
  assert.match(t, /Te contó que se muda/);
  assert.equal((seccionConversaciones([{ chatNombre: 'Z', temas: Array.from({ length: 10 }, (_, i) => tema([i + 1], { resumen: `T${i}` })) }], { limites: { max_temas_conversacion: 3 } })).ocultos, 7);
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
