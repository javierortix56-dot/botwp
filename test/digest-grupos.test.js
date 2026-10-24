// Punta a punta: corre el digest real de index.js con WhatsApp, base de datos y
// Gemini simulados, y verifica el mensaje que se enviaría, el detalle guardado
// y las páginas /reporte y /configurar.
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
delete process.env.NTFY_TOPIC;
process.env.PUBLIC_URL = 'https://bot.ejemplo.com';

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

const capturas = { opciones: {}, enviados: [], reportes: [], procesados: null };
const item = (n, extra = {}) => ({ tema: `Art ${n}`, resumen: `Artículo ${n}, $${n}.000`, tipo: 'info', estado: 'informativo', relevancia: 2, para_mi: false, de: n % 2 ? 'Cintia' : 'Marta', ids: [1], categoria: 'venta', ...extra });
const stubs = {
  dotenv: { config() {} },
  'node-cron': { schedule() {} },
  qrcode: {},
  http: { createServer(h) { capturas.handler = h; return { on() {}, listen(_p, cb) { cb && cb(); } }; } },
  './db': {
    conectar: async () => {},
    obtenerMensajesSinProcesar: async () => mensajes,
    obtenerMensajesDesde: async () => mensajes,
    obtenerChatsSinResponder: async () => [],
    marcarProcesados: async (ids) => { capturas.procesados = ids; },
    guardarMensaje: async () => true,
    limpiarAuth: async () => {},
    obtenerChatsDistintos: async () => [{ chat_id: 'r@g.us', chat_nombre: NOMBRE_ROPERITO, cantidad: 2 }, { chat_id: 'e@g.us', chat_nombre: '5° GRADO MIXTO', cantidad: 1 }],
    obtenerContactos: async () => new Map(),
    guardarReporte: async (tipo, contenido) => { capturas.reportes.push({ tipo, contenido }); return 40 + capturas.reportes.length; },
    obtenerReportes: async () => [],
    obtenerReporte: async (n) => capturas.reportes.map((r, i) => ({ ...r, id: 41 + i, n_mensajes: 0, n_temas: 0, creado_en: 1789470000 })).find((r) => r.id === n) || null,
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
    analizarIndividuales: async (msgs, _contactos, opciones) => { capturas.opcionesIndividuales = opciones; return { eventos: [], compromisos: [], pedidos: [], conversaciones: [], idsProcesados: msgs.map((m) => m.id), errores: 0 }; },
    generarTitular: async () => 'Hay novedades en los grupos.',
    filtrarSinResponder: async () => [],
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

function llamar(url, method = 'GET', cuerpo = null) {
  const req = new EventEmitter();
  req.url = url;
  req.method = method;
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, writeHead(c) { this.statusCode = c; }, end(b) { this.body = b; } };
  const hecho = Promise.resolve(capturas.handler(req, res));
  if (cuerpo !== null) setImmediate(() => { req.emit('data', Buffer.from(cuerpo)); req.emit('end'); });
  return hecho.then(() => res);
}

test('el digest manda catálogo por vendedor, intereses y un link al detalle completo', async () => {
  await new Promise((r) => setTimeout(r, 50)); // main(): estado conectado
  await llamar('/procesar');
  assert.equal(capturas.enviados.length, 1);
  const texto = capturas.enviados[0];

  assert.deepEqual(capturas.opciones[NOMBRE_ROPERITO], { modo: 'catalogo', detalle: 'alto', intereses: ['cochecito'] });
  assert.deepEqual(capturas.opciones['5° GRADO MIXTO'], { modo: 'normal', detalle: 'alto', intereses: ['cochecito'] });
  assert.deepEqual(capturas.opcionesIndividuales, { detalle: 'alto' }, 'los chats individuales también van con detalle alto');

  assert.match(texto, /📢 \*Novedades de tus grupos\*/);
  assert.match(texto, /🛍️ \*Roperito St\. Xavier\.[^*]*\* — 24 publicaciones/);
  assert.equal((texto.match(/\*Cintia\*/g) || []).length, 1, 'Cintia aparece una sola vez');
  assert.equal((texto.match(/^• Artículo/gm) || []).length, 20, 'WhatsApp muestra hasta 20 artículos');
  assert.match(texto, /4 publicación\(es\) más en el detalle completo/);
  assert.match(texto, /Acto escolar mañana a las 9/);
  assert.doesNotMatch(texto, /Saludos varios/);

  assert.match(texto, /🔔 \*Coincidencias con tus intereses\*/);
  assert.match(texto, /\*cochecito\* — Laura en Roperito/);

  assert.match(texto, /🔎 \*Detalle completo de los grupos:\*\nhttps:\/\/bot\.ejemplo\.com\/reporte\?id=41$/);
  const detalle = capturas.reportes.find((r) => r.tipo === 'detalle');
  assert.ok(detalle, 'se guardó el detalle completo');
  assert.equal((detalle.contenido.match(/^• Artículo/gm) || []).length, 24, 'el detalle tiene los 24 artículos');
  assert.match(detalle.contenido, /Saludos varios/);
  assert.ok(capturas.reportes.some((r) => r.tipo === 'digest' && r.contenido === texto), 'el digest enviado también se audita');
  assert.deepEqual(capturas.procesados.sort((a, b) => a - b), [1, 2, 3, 4]);
});

test('/reporte?id=N muestra el detalle con formato y es seguro; un id inexistente da 404', async () => {
  const ok = await llamar('/reporte?id=41');
  assert.equal(ok.statusCode, 200);
  assert.match(ok.body, /<b>Detalle completo<\/b>/);
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
  } finally {
    fs.writeFileSync(RUTA_CONFIG, configOriginal);
  }
});
