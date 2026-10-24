// Punta a punta: corre el digest real de index.js con WhatsApp, base de datos y
// Gemini simulados, y verifica el mensaje que se enviaría, el detalle guardado
// y las páginas del panel (acceso con clave, inicio, /reporte, /configurar).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

process.env.GEMINI_API_KEY = 'x';
process.env.TURSO_URL = 'x';
process.env.TURSO_TOKEN = 'x';
process.env.MY_WHATSAPP_ID = '5491100000000@c.us';
process.env.NTFY_TOPIC = 'tema-de-prueba';
process.env.PUBLIC_URL = 'https://bot.ejemplo.com';
process.env.PANEL_KEY = 'clave-de-prueba';

const RUTA_CONFIG = path.join(__dirname, '../config.json');
const configOriginal = fs.readFileSync(RUTA_CONFIG, 'utf8');

const NOMBRE_ROPERITO = 'Roperito St. Xavier. (PÁG. Amarillas )';
const mensajes = [];
let id = 0;
const agregar = (chat_id, chat_nombre, remitente, cuerpo) => mensajes.push({ id: ++id, chat_id, chat_nombre, remitente, remitente_id: `${remitente}@x`, cuerpo, timestamp: 1789470000 + id, es_propio: 0 });
agregar('r@g.us', NOMBRE_ROPERITO, 'Cintia', 'Vendo bici de nena usada $30.000');
agregar('r@g.us', NOMBRE_ROPERITO, 'Laura', 'Alguien tiene un cochecito para vender?');
agregar('e@g.us', '5° GRADO MIXTO', 'Seño', 'Mañana acto a las 9');
agregar('p@s.whatsapp.net', 'Pedro', 'Pedro', 'Hola, venís el sábado?');

const capturas = { ntfy: [], opciones: {}, enviados: [], reportes: [], procesados: null, ajustes: {}, guardados: 0, limpiezas: 0, fallos: [] };
const item = (n, extra = {}) => ({ tema: `Art ${n}`, resumen: `Artículo ${n}, $${n}.000`, tipo: 'info', estado: 'informativo', relevancia: 2, para_mi: false, de: n % 2 ? 'Cintia' : 'Marta', ids: [1], clase: 'ofrecimiento', rubro: n % 2 ? 'Ropa' : 'Hogar', ...extra });
const stubs = {
  dotenv: { config() {} },
  'node-cron': { schedule() {} },
  qrcode: {},
  https: { request(opciones, cb) { const envio = { headers: opciones.headers, cuerpo: '' }; capturas.ntfy.push(envio); return { on() {}, write(b) { envio.cuerpo += b; }, end() { cb && cb({ statusCode: 200, resume() {} }); } }; } },
  http: { createServer(h) { capturas.handler = h; return { on() {}, listen(_p, cb) { cb && cb(); } }; } },
  './db': {
    conectar: async () => {},
    obtenerMensajesSinProcesar: async () => mensajes,
    obtenerMensajesDesde: async () => mensajes,
    obtenerChatsSinResponder: async () => [],
    marcarProcesados: async (ids) => { capturas.procesados = ids; },
    guardarMensaje: async () => { capturas.guardados++; return true; },
    limpiarAuth: async () => { capturas.limpiezas++; },
    obtenerChatsDistintos: async () => [{ chat_id: 'r@g.us', chat_nombre: NOMBRE_ROPERITO, cantidad: 2 }, { chat_id: 'e@g.us', chat_nombre: '5° GRADO MIXTO', cantidad: 1 }],
    obtenerContactos: async () => new Map(),
    guardarReporte: async (tipo, contenido) => { capturas.reportes.push({ tipo, contenido }); return 40 + capturas.reportes.length; },
    obtenerReportes: async () => [],
    obtenerReporte: async (n) => capturas.reportes.map((r, i) => ({ ...r, id: 41 + i, n_mensajes: 0, n_temas: 0, creado_en: 1789470000 })).find((r) => r.id === n) || null,
    registrarFallos: async (ids) => { capturas.fallos.push(...ids); return 0; },
    contarPendientes: async () => 7,
    obtenerAjuste: async (k) => capturas.ajustes[k] ?? null,
    guardarAjuste: async (k, v) => { capturas.ajustes[k] = v; return true; },
    ultimoReporte: async () => ({ id: 1, tipo: 'digest', creado_en: Math.floor(Date.now() / 1000) - 7200 }),
  },
  './whatsapp': {
    iniciarCliente: async (cb) => { cb.onListo && cb.onListo(); },
    enviarTextoLibre: async (t) => { capturas.enviados.push(t); return true; },
    estaConectado: () => true,
    conectarBajoDemanda: async () => {},
    desconectar: async () => {},
    esperarSincronizacion: async () => {},
  },
  './gemini': {
    analizarChat: async (nombre, msgs, opciones) => {
      capturas.opciones[nombre] = opciones;
      if (nombre === NOMBRE_ROPERITO) return { temas: Array.from({ length: 24 }, (_, i) => item(i + 1)), menores: [], idsProcesados: msgs.map((m) => m.id), errores: 0 };
      return { temas: [item(1, { tema: 'Acto', resumen: 'Acto escolar mañana a las 9', de: 'Seño' })], menores: [{ ...item(2), relevancia: 1, resumen: 'Saludos varios' }], idsProcesados: msgs.map((m) => m.id), errores: 0 };
    },
    analizarIndividuales: async (msgs, _contactos, opciones) => { capturas.opcionesIndividuales = opciones; return { eventos: [], compromisos: [], pedidos: [], conversaciones: [{ chatNombre: 'Pedro', temas: [{ ...item(1), clase: null, rubro: null, resumen: 'Preguntaste si viene el sábado', esperando_respuesta: true }, { ...item(2), clase: null, rubro: null, relevancia: 1, resumen: 'Te saludó' }], menores: [] }], idsProcesados: msgs.map((m) => m.id), errores: 0 }; },
    generarTitular: async () => 'Hay novedades en los grupos.',
    filtrarSinResponder: async () => [],
    usoGemini: () => ({ dia: '2026-10-24', total: 3, limite: 900, por_tipo: { analisis: 3 } }),
    cargarUsoGuardado: async () => {},
  },
};
const original = Module._load;
Module._load = function (pedido, ...resto) {
  return Object.prototype.hasOwnProperty.call(stubs, pedido) ? stubs[pedido] : original.call(this, pedido, ...resto);
};
require('../index.js');
Module._load = original;
// filtros.js recarga config.json al cargarse: hay que tocar el objeto que usa index.js (el que quedó en caché).
const cfgEnUso = require('../config.json');
cfgEnUso.resumen.intereses = ['cochecito'];
cfgEnUso.resumen.max_items_catalogo = 20; // en producción el tope es más alto; acá probamos el link de overflow

const COOKIE = 'botwp_k=clave-de-prueba';
function llamar(url, method = 'GET', cuerpo = null, { cookie = COOKIE } = {}) {
  const req = new EventEmitter();
  req.url = url;
  req.method = method;
  req.headers = cookie ? { cookie } : {};
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, writeHead(c) { this.statusCode = c; }, end(b) { this.body = b; } };
  const hecho = Promise.resolve(capturas.handler(req, res));
  if (cuerpo !== null) setImmediate(() => { req.emit('data', Buffer.from(cuerpo)); req.emit('end'); });
  return hecho.then(() => res);
}

async function esperar(cond, ms = 3000) {
  const fin = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > fin) throw new Error('timeout esperando condición');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('el digest manda catálogo por clase y rubro, conversaciones, intereses y un link al detalle completo', async () => {
  await new Promise((r) => setTimeout(r, 50)); // main(): estado conectado
  const pagina = await llamar('/procesar');
  assert.match(pagina.body, /Preparando tu resumen/, 'responde al toque y trabaja en segundo plano');
  await esperar(() => capturas.procesados);
  assert.equal(capturas.enviados.length, 2, 'el resumen y, aparte, el link del panel');
  const texto = capturas.enviados[0];

  assert.deepEqual(capturas.opciones[NOMBRE_ROPERITO], { modo: 'catalogo', detalle: 'alto', intereses: ['cochecito'] });
  assert.deepEqual(capturas.opciones['5° GRADO MIXTO'], { modo: 'normal', detalle: 'alto', intereses: ['cochecito'] });
  assert.deepEqual(capturas.opcionesIndividuales, { detalle: 'alto' }, 'los chats individuales también van con detalle alto');

  assert.match(texto, /📢 \*Novedades de tus grupos\*/);
  assert.match(texto, /🛍️ \*Roperito St\. Xavier\.[^*]*\* · 24 publicaciones/);
  assert.match(texto, /   👕 _Ropa_\n• Artículo 1, \*\$1\.000\* — \*Cintia\*/);
  assert.match(texto, /   🛋️ _Hogar_\n• Artículo 2, \*\$2\.000\* — \*Marta\*/);
  assert.equal((texto.match(/ — \*Cintia\*$/gm) || []).length, 10, 'cada artículo lleva su vendedor');
  assert.equal((texto.match(/^• Artículo/gm) || []).length, 20, 'WhatsApp muestra hasta 20 artículos');
  assert.match(texto, /4 publicación\(es\) más en el detalle completo/);
  assert.match(texto, /Acto escolar mañana a las 9/);
  assert.doesNotMatch(texto, /Saludos varios/);

  assert.match(texto, /🔔 \*Coincidencias con tus intereses\*/);
  assert.match(texto, /\*cochecito\* — Laura en Roperito/);

  assert.match(texto, /💬 \*Tus conversaciones\*\n\n👤 \*Pedro\*\n• ⏳ _Esperás respuesta:_ Preguntaste si viene el sábado/);
  assert.doesNotMatch(texto, /Te saludó/);
  assert.ok(texto.indexOf('Tus conversaciones') < texto.indexOf('mensajes revisados'), 'las conversaciones van antes del pie');
  assert.ok((texto.match(/━━━━━━━━━━━━━━/g) || []).length >= 4, 'secciones separadas');

  assert.match(texto, /🔎 \*Detalle completo de los grupos:\*\nhttps:\/\/bot\.ejemplo\.com\/reporte\?id=41&k=clave-de-prueba$/, 'en WhatsApp el link al detalle lleva la clave');
  assert.doesNotMatch(texto, /Tu panel/, 'el link del panel ya no va pegado al resumen');
  assert.equal(capturas.enviados[1], '⚙️ *Tu panel:* https://bot.ejemplo.com/?k=clave-de-prueba', 'va en un mensaje corto justo después');
  const detalle = capturas.reportes.find((r) => r.tipo === 'detalle');
  assert.ok(detalle, 'se guardó el detalle completo');
  assert.equal((detalle.contenido.match(/^• Artículo/gm) || []).length, 24, 'el detalle tiene los 24 artículos');
  assert.match(detalle.contenido, /Saludos varios/);
  assert.match(detalle.contenido, /◦ Te saludó/, 'el saludo queda en el detalle');
  const auditado = capturas.reportes.find((r) => r.tipo === 'digest');
  assert.ok(auditado && auditado.contenido.includes('Novedades de tus grupos'), 'el digest enviado también se audita');
  assert.ok(!auditado.contenido.includes('clave-de-prueba'), 'el historial guarda la versión sin clave');
  assert.deepEqual(capturas.procesados.sort((a, b) => a - b), [1, 2, 3, 4]);

  // ntfy: aviso corto con botón al resumen, no el texto entero
  const aviso = capturas.ntfy.find((n) => /Resumen/.test(Buffer.from(n.headers.Title.slice(10, -2), 'base64').toString()));
  assert.ok(aviso, 'se mandó una notificación de resumen');
  const titulo = Buffer.from(aviso.headers.Title.slice(10, -2), 'base64').toString();
  assert.match(titulo, /^(📌|🚨|✅) Resumen/);
  assert.ok(aviso.cuerpo.length < 600, `el aviso es corto (${aviso.cuerpo.length} caracteres)`);
  assert.doesNotMatch(aviso.cuerpo, /Artículo 1/);
  assert.match(aviso.cuerpo, /📢 2 grupos con novedades/);
  const id = capturas.reportes.findIndex((r) => r.tipo === 'digest') + 41;
  assert.equal(aviso.headers.Actions, `view, Ver resumen, https://bot.ejemplo.com/reporte?id=${id}`);
  assert.equal(aviso.headers.Click, `https://bot.ejemplo.com/reporte?id=${id}`);
  assert.doesNotMatch(JSON.stringify(aviso), /clave-de-prueba/, 'ntfy nunca lleva la clave del panel');
});

test('/reporte?id=N muestra el detalle con formato y es seguro; un id inexistente da 404', async () => {
  const ok = await llamar('/reporte?id=41');
  assert.equal(ok.statusCode, 200);
  assert.match(ok.body, /<b>Detalle completo<\/b>/);
  assert.ok((ok.body.match(/class="card contenido/g) || []).length >= 2, 'el resumen se ve como tarjetas por sección');
  assert.match(ok.body, /Artículo 24/);
  assert.doesNotMatch(ok.body, /<script>/);
  assert.equal((await llamar('/reporte?id=9999')).statusCode, 404);
  assert.equal((await llamar('/reporte?id=abc')).statusCode, 404);
});

test('/configurar muestra modo y detalle, y guardar no los pierde', async () => {
  try {
    const pagina = await llamar('/configurar');
    assert.match(pagina.body, /name="modo_Roperito/);
    assert.match(pagina.body, /<option value="catalogo" selected>/);
    assert.match(pagina.body, /<option value="alto" selected>/);
    assert.match(pagina.body, /name="intereses"[^>]*>cochecito</);

    const clave = encodeURIComponent(NOMBRE_ROPERITO);
    const claveGrado = encodeURIComponent('5° GRADO MIXTO');
    const form = new URLSearchParams({
      nombre_dueno: 'JO', intereses: 'cochecito, bici\ntalle 10',
      [`freq_${clave}`]: '8', [`modo_${clave}`]: 'catalogo', [`det_${clave}`]: 'alto',
      [`freq_${claveGrado}`]: '8', [`modo_${claveGrado}`]: 'normal', [`det_${claveGrado}`]: 'normal',
    }).toString();
    const guardado = await llamar('/configurar', 'POST', form);
    assert.equal(guardado.statusCode, 302);

    const nueva = JSON.parse(fs.readFileSync(RUTA_CONFIG, 'utf8'));
    assert.deepEqual(nueva.grupos, [
      { nombre: NOMBRE_ROPERITO, frecuencia_horas: 8, modo: 'catalogo', detalle: 'alto' },
      { nombre: '5° GRADO MIXTO', frecuencia_horas: 8, detalle: 'normal' },
    ]);
    assert.deepEqual(nueva.resumen.intereses, ['cochecito', 'bici', 'talle 10']);
    assert.equal(nueva.resumen.max_temas_grupo_alto, 40, 'el resto de la config se conserva');
    assert.deepEqual(capturas.ajustes.config_usuario, {
      nombre_dueno: 'JO',
      grupos: nueva.grupos,
      intereses: ['cochecito', 'bici', 'talle 10'],
    }, 'se guarda en Turso para sobrevivir a los deploys');
  } finally {
    fs.writeFileSync(RUTA_CONFIG, configOriginal);
  }
});

test('sin la clave el panel no muestra nada privado', async () => {
  for (const ruta of ['/', '/reportes', '/reporte?id=41', '/configurar', '/procesar']) {
    const r = await llamar(ruta, 'GET', null, { cookie: null });
    assert.equal(r.statusCode, ruta === '/' ? 200 : 401, ruta);
    assert.match(r.body, /Panel privado/);
    assert.doesNotMatch(r.body, /Artículo|Roperito/);
  }
  const otra = await llamar('/reportes', 'GET', null, { cookie: 'botwp_k=otra-clave' });
  assert.equal(otra.statusCode, 401, 'una clave equivocada tampoco entra');
});

test('el link con la clave guarda la cookie por un año y la saca de la URL', async () => {
  const r = await llamar('/reporte?id=41&k=clave-de-prueba', 'GET', null, { cookie: null });
  assert.equal(r.statusCode, 302);
  assert.equal(r.headers.Location, '/reporte?id=41');
  assert.match(r.headers['Set-Cookie'], /^botwp_k=clave-de-prueba; Max-Age=31536000; Path=\/; HttpOnly; SameSite=Lax; Secure$/);
  const mala = await llamar('/reportes?k=adivinando', 'GET', null, { cookie: null });
  assert.equal(mala.statusCode, 401);
});

test('"mandame el link" lo envía solo al WhatsApp del dueño, como mucho uno cada 10 minutos', async () => {
  const antes = capturas.enviados.length;
  const r = await llamar('/enviar-link', 'POST', '', { cookie: null });
  assert.match(r.body, /te mandé el link/);
  assert.equal(capturas.enviados.length, antes + 1);
  assert.match(capturas.enviados.at(-1), /Tu acceso al panel de BotWP\*\nhttps:\/\/bot\.ejemplo\.com\/\?k=clave-de-prueba/);
  const otra = await llamar('/enviar-link', 'POST', '', { cookie: null });
  assert.match(otra.body, /Ya te mandé un link/);
  assert.equal(capturas.enviados.length, antes + 1);
});

test('el inicio muestra el estado real del bot', async () => {
  const r = await llamar('/');
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /Hola, JO/);
  assert.match(r.body, /WhatsApp conectado/);
  assert.match(r.body, /hace 2 h/);
  assert.match(r.body, /<b>7<\/b>/, 'mensajes en espera');
  assert.match(r.body, /<b>3 <small[^>]*>\/ 900<\/small><\/b>/, 'uso de Gemini');
  assert.match(r.body, /(hoy|mañana) \d\d:\d\d/, 'próximo resumen');
});

test('la prueba manda un mensaje real y ya no ensucia la base con un chat falso', async () => {
  const antes = capturas.enviados.length;
  const r = await llamar('/test');
  assert.match(r.body, /Prueba enviada/);
  await esperar(() => capturas.enviados.length > antes);
  assert.match(capturas.enviados.at(-1), /Prueba de BotWP/);
  assert.equal(capturas.guardados, 0);
});

test('re-vincular pide confirmación y solo borra la sesión con POST', async () => {
  const pagina = await llamar('/sesion');
  assert.match(pagina.body, /method="POST" action="\/sesion"/);
  assert.equal(capturas.limpiezas, 0);
  const hecho = await llamar('/sesion', 'POST', '');
  assert.match(hecho.body, /Sesión reiniciada/);
  assert.equal(capturas.limpiezas, 1);
});
