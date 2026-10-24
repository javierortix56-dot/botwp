global.crypto = require('crypto').webcrypto;

require('dotenv').config();

const REQUIRED_ENV = ['GEMINI_API_KEY', 'TURSO_URL', 'TURSO_TOKEN', 'MY_WHATSAPP_ID'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`[Bot] Faltan variables de entorno: ${missing.join(', ')}`);
  process.exit(1);
}

// Red de seguridad: un error transitorio (ej. un 502 de Turso en un handler
// async de Baileys) NO debe tumbar el proceso. Preferimos un bot vivo que
// logea y sigue, antes que un crash-loop que deja de mandar digests.
process.on('unhandledRejection', (reason) => {
  console.error(`[Bot] unhandledRejection (no fatal):`, reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error(`[Bot] uncaughtException (no fatal):`, err?.message || err);
});

const http = require('http');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const QRCode = require('qrcode');
const nodeCrypto = require('crypto');
const panel = require('./panel');
const {
  conectar,
  obtenerMensajesSinProcesar,
  obtenerMensajesDesde,
  obtenerChatsSinResponder,
  marcarProcesados,
  guardarMensaje,
  limpiarAuth,
  obtenerChatsDistintos,
  obtenerContactos,
  guardarReporte,
  obtenerReportes,
  obtenerReporte,
  registrarFallos,
  contarPendientes,
  obtenerAjuste,
  guardarAjuste,
  ultimoReporte,
} = require('./db');
const {
  iniciarCliente,
  enviarTextoLibre,
  estaConectado,
  conectarBajoDemanda,
  desconectar: desconectarWA,
  esperarSincronizacion,
} = require('./whatsapp');
const { analizarChat, analizarIndividuales, generarTitular, filtrarSinResponder, usoGemini, cargarUsoGuardado } = require('./gemini');
const { recargar: recargarFiltros, obtenerOpcionesGrupo, detalleDefecto, buscarIntereses, esTrivial } = require('./filtros');

let config = require('./config.json');

const https = require('https');

const PORT = process.env.PORT || 3000;

// Recarga config.json sobre el MISMO objeto: whatsapp.js y gemini.js guardan
// una referencia a él y tienen que ver los cambios sin reiniciar.
function recargarConfig() {
  try {
    const nuevo = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    for (const k of Object.keys(config)) delete config[k];
    Object.assign(config, nuevo);
    recargarFiltros(); // que el filtro de captura use los grupos/VIPs nuevos sin reiniciar
    console.log(`[Config] Recargada`);
  } catch (err) {
    console.error(`[Config] Error recargando:`, err.message);
  }
}

// Texto de WhatsApp (*negrita*, _cursiva_, ~tachado~) a texto plano para ntfy.
function textoPlano(texto) {
  return String(texto || '').replace(/(^|[\s(])[*_~]([^*_~\n]+)[*_~](?=$|[\s).,;:!?])/gm, '$1$2');
}

/**
 * Notificación push por ntfy. opciones: prioridad (min|low|default|high|urgent),
 * tags (emojis de ntfy), click (URL al tocar la notificación).
 * El título va codificado (RFC 2047) para admitir acentos y emojis, y el
 * cuerpo se recorta a ~3.8 KB: más largo, ntfy lo manda como archivo adjunto.
 */
function postNtfy(title, body, { prioridad = 'default', tags = [], click } = {}) {
  if (!process.env.NTFY_TOPIC) {
    console.warn(`[ntfy] NTFY_TOPIC no configurado — notificación "${title}" omitida`);
    return;
  }
  let texto = textoPlano(body);
  if (Buffer.byteLength(texto) > 3800) {
    while (Buffer.byteLength(texto) > 3700) texto = texto.slice(0, Math.floor(texto.length * 0.95));
    texto = `${texto.trimEnd()}\n\n… (sigue en el panel)`;
  }
  const buf = Buffer.from(texto);
  const headers = {
    'Title': `=?UTF-8?B?${Buffer.from(String(title)).toString('base64')}?=`,
    'Priority': prioridad,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': buf.length,
  };
  if (tags.length) headers.Tags = tags.join(',');
  if (click) headers.Click = click;
  const req = https.request({ hostname: 'ntfy.sh', path: `/${process.env.NTFY_TOPIC}`, method: 'POST', headers }, (res) => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      console.log(`[ntfy] Notificación "${title}" enviada (${res.statusCode})`);
    } else {
      console.error(`[ntfy] ntfy.sh respondió ${res.statusCode} para "${title}"`);
    }
    res.resume();
  });
  req.on('error', (err) => console.error(`[ntfy] Error:`, err.message));
  req.write(buf);
  req.end();
}

// Alertas proactivas por ntfy (sesión caída, cuota agotada...), como mucho una
// cada `horas` por tipo para no saturar.
const ultimasAlertas = new Map();
function alertar(tipo, titulo, texto, horas = 6) {
  const antes = ultimasAlertas.get(tipo) || 0;
  if (Date.now() - antes < horas * 3600 * 1000) return;
  ultimasAlertas.set(tipo, Date.now());
  postNtfy(titulo, texto, { prioridad: 'urgent', tags: ['warning'], click: urlPublica() });
}

// Prioridad de la notificación según lo que trae el resumen.
function opcionesNtfy(meta = {}) {
  if (meta.urgentes > 0) return { prioridad: 'high', tags: ['rotating_light'], click: urlPublica() };
  if (meta.pendientes > 0) return { prioridad: 'default', tags: ['pushpin'], click: urlPublica() };
  return { prioridad: 'low', tags: ['white_check_mark'], click: urlPublica() };
}

async function enviarPrueba() {
  const hora = new Date().toLocaleTimeString('es-AR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const texto = `🔔 *Prueba de BotWP* — ${hora}\nSi leés esto, el bot puede escribirte. Los resúmenes llegan a las ${(config.resumen?.horas_digest || []).map((e) => { const m = /^(\d+)\s+(\d+)/.exec(e); return m ? `${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}` : e; }).join(' y ')}.`;
  try {
    await enviarTextoLibre(texto);
  } catch (err) {
    console.error('[Prueba] No se pudo enviar por WhatsApp:', err.message);
  }
  postNtfy('Prueba de BotWP', texto, { prioridad: 'default', tags: ['bell'], click: urlPublica() });
}

function resolverNombreIndiv(raw, contactos) {
  if (!raw) return 'Desconocido';
  if (raw.includes('@')) {
    const desdeAgenda = contactos.get(raw);
    if (desdeAgenda) return desdeAgenda;
    const num = raw.split('@')[0];
    return num.match(/^\d+$/) ? `+${num}` : raw;
  }
  return raw;
}

function normalizarClave(s) {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const TZ = 'America/Argentina/Buenos_Aires';

function hoyISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}

function horaActual() {
  return Number(new Date().toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }));
}

// Acepta "YYYY-MM-DD" o "YYYY-MM-DD HH:MM" (también con T). Devuelve {iso, hora} o null.
function parseFecha(s) {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/.exec(String(s || '').trim());
  return m ? { iso: m[1], hora: m[2] || null } : null;
}

// "2026-07-15" → "mar 15/7" (+ hora si hay)
function fechaLegible(f) {
  if (!f) return '';
  const d = new Date(`${f.iso}T12:00:00`);
  if (isNaN(d)) return f.iso;
  const dia = d.toLocaleDateString('es-AR', { weekday: 'short' }).replace(/[.,]/g, '');
  const txt = `${dia} ${d.getDate()}/${d.getMonth() + 1}`;
  return f.hora ? `${txt} ${f.hora}` : txt;
}

// Días desde hoy hasta la fecha (negativo = vencida). null si no hay fecha.
function diasHasta(f) {
  if (!f) return null;
  const dias = Math.round((new Date(`${f.iso}T00:00:00Z`) - new Date(`${hoyISO()}T00:00:00Z`)) / 86400000);
  return isNaN(dias) ? null : dias;
}

// Prefijo de urgencia y peso para ordenar (menor = más urgente).
function urgencia(f) {
  const dias = diasHasta(f);
  if (dias === null) return { tag: '', peso: 50 };
  if (dias < 0) return { tag: '⚠️ *YA VENCIÓ* — ', peso: 0 };
  if (dias === 0) return { tag: '⚠️ *HOY* — ', peso: 1 };
  if (dias === 1) return { tag: '*MAÑANA* — ', peso: 2 };
  return { tag: '', peso: 2 + dias };
}

/**
 * Junta todo lo accionable de grupos + individuales, deduplicado:
 *  - pendientes: acciones y pagos, con fecha límite si Gemini la detectó
 *  - agenda: eventos con fecha, para ordenar cronológicamente
 */
function extraerAccionables(resumenesChats, resIndiv, contactos) {
  const pendientes = []; // { emoji, texto, origen, fecha }
  const agenda = [];     // { texto, origen, fecha, fechaRaw }
  const vistos = new Set();
  const nuevo = (clave) => {
    const k = normalizarClave(clave);
    if (k && vistos.has(k)) return false;
    if (k) vistos.add(k);
    return true;
  };

  for (const { chatNombre, temas } of resumenesChats) {
    for (const t of temas) {
      if (!t.para_mi || t.estado !== 'pendiente') continue;
      const fecha = parseFecha(t.fecha_limite);
      if (t.tipo === 'accion') {
        const q = t.accion || t.resumen;
        if (nuevo(`${chatNombre}|${t.tema}|${q}`)) pendientes.push({ emoji: '🔴', texto: q, origen: `${chatNombre}${t.de ? ` · ${t.de}` : ''}`, fecha });
      } else if (t.tipo === 'pago') {
        if (nuevo(`${chatNombre}|${t.tema}|${t.resumen}`)) pendientes.push({ emoji: '💰', texto: t.resumen, origen: chatNombre, fecha });
      } else if (t.tipo === 'evento') {
        if (nuevo(`${chatNombre}|${t.tema}|${t.resumen}`)) agenda.push({ texto: t.resumen, origen: chatNombre, fecha, fechaRaw: t.fecha_limite });
      }
    }
  }

  (resIndiv.pedidos || []).forEach((p) => {
    if (!nuevo(`${p.de}${p.pedido}`)) return;
    pendientes.push({ emoji: '🔴', texto: p.pedido, origen: resolverNombreIndiv(p.chat || p.de, contactos), fecha: parseFecha(p.fecha_limite) });
  });
  (resIndiv.compromisos || []).forEach((c) => {
    if (!nuevo(`${c.tema}${c.resumen}`)) return;
    pendientes.push({ emoji: '🔴', texto: `${c.tema}: ${c.resumen}`, origen: resolverNombreIndiv(c.chat, contactos), fecha: null });
  });
  (resIndiv.eventos || []).forEach((e) => {
    if (!nuevo(`${e.titulo}${e.fecha}`)) return;
    agenda.push({ texto: e.titulo, origen: resolverNombreIndiv(e.chat, contactos), fecha: parseFecha(e.fecha), fechaRaw: e.fecha });
  });

  return { pendientes, agenda };
}

/**
 * Arma UN solo mensaje consolidado (digest) en tono de asistente personal:
 *  - Saludo según la hora + titular del día (generado por Gemini)
 *  - "📌 Para resolver": acciones y pagos ordenados por urgencia (HOY/MAÑANA primero)
 *  - "📅 Se viene": eventos ordenados cronológicamente con fecha legible
 *  - "👥 De los grupos": info útil, máximo 3 ítems por grupo para no hacer ruido
 */
function formatearDigest(accionables, resumenesChats, meta = {}) {
  const { etiqueta, totalMensajes = 0, titular = '', seccionSinResponder = '', seccionIntereses = '', seccionConversaciones: convs = '' } = meta;
  const { pendientes, agenda } = accionables;

  const nombre = (config.nombre_dueno || '').trim();
  const h = horaActual();
  const saludo = h < 13 ? '☀️ *Buen día' : h < 20 ? '🌤️ *Buenas tardes' : '🌙 *Buenas noches';
  const diaSemana = new Date().toLocaleDateString('es-AR', { timeZone: TZ, weekday: 'long' });
  const [, mm, dd] = hoyISO().split('-');
  const fecha = `${diaSemana} ${Number(dd)}/${Number(mm)}`;
  const hora = new Date().toLocaleTimeString('es-AR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });

  const out = [`${saludo}${nombre ? `, ${nombre}` : ''}* — ${fecha} ${hora}${etiqueta ? ` · ${etiqueta}` : ''}`];
  if (titular) out.push(`_${titular}_`);

  out.push('', SEPARADOR);
  out.push('📌 *Para resolver*');
  if (pendientes.length) {
    const ordenados = [...pendientes].sort((a, b) => urgencia(a.fecha).peso - urgencia(b.fecha).peso);
    ordenados.forEach((p) => {
      out.push(`${p.emoji} ${urgencia(p.fecha).tag}${p.texto} _(${p.origen})_`);
    });
  } else if (seccionSinResponder) {
    out.push('✅ Nada nuevo, salvo los chats sin responder de abajo.');
  } else {
    out.push('✅ Nada pendiente — no te piden nada por ahora.');
  }

  if (seccionSinResponder) {
    out.push('', SEPARADOR);
    out.push(seccionSinResponder);
  }

  if (seccionIntereses) {
    out.push('', SEPARADOR);
    out.push(seccionIntereses);
  }

  if (agenda.length) {
    const ordenada = [...agenda].sort((a, b) => {
      const ka = a.fecha ? `${a.fecha.iso} ${a.fecha.hora || ''}` : '9999';
      const kb = b.fecha ? `${b.fecha.iso} ${b.fecha.hora || ''}` : '9999';
      return ka.localeCompare(kb);
    });
    out.push('', SEPARADOR);
    out.push('📅 *Se viene*');
    ordenada.forEach((e) => {
      const cuando = e.fecha ? fechaLegible(e.fecha) : (e.fechaRaw || 's/f');
      const dias = diasHasta(e.fecha);
      const conHora = e.fecha?.hora ? ` ${e.fecha.hora}` : '';
      const marca = dias === 0 ? `*HOY${conHora}*` : dias === 1 ? `*mañana${conHora}*` : `*${cuando}*`;
      out.push(`• ${marca} — ${e.texto} _(${e.origen})_`);
    });
  }

  // Novedades de los grupos (versión resumida; la completa va al detalle web)
  const grupos = seccionGrupos(resumenesChats);
  if (grupos.texto) {
    out.push('', SEPARADOR);
    out.push('📢 *Novedades de tus grupos*');
    out.push('');
    out.push(grupos.texto);
  }

  if (convs) {
    out.push('', SEPARADOR);
    out.push(convs);
  }

  out.push('', SEPARADOR);
  out.push(`_${totalMensajes} mensajes revisados_`);

  return out.join('\n').trim();
}

// Formato de la sección de grupos, intereses y detalle: ver formato.js
const formato = require('./formato');
const { MAX_INTERESES_WA, SEPARADOR, formatearIntereses, htmlDesdeTexto } = formato;
const seccionGrupos = (resumenesChats, opciones) => formato.seccionGrupos(resumenesChats, { ...opciones, limites: config.resumen });
const seccionConversaciones = (conversaciones, opciones) => formato.seccionConversaciones(conversaciones, { ...opciones, limites: config.resumen });
const formatearDetalle = (resumenesChats, coincidencias, etiqueta, conversaciones) => formato.formatearDetalle(resumenesChats, coincidencias, etiqueta, config.resumen, conversaciones);

function urlPublica() {
  return (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || 'https://botwp-nivv.onrender.com').replace(/\/$/, '');
}

/**
 * Guarda el detalle completo como reporte y devuelve el texto de WhatsApp con el
 * link al final. Si no hay detalle (o no se pudo guardar) devuelve el texto tal cual.
 */
async function adjuntarDetalle(texto, detalle, nMensajes, nTemas) {
  if (!detalle) return texto;
  const id = await guardarReporte('detalle', detalle, nMensajes, nTemas);
  if (!id) return texto;
  return `${texto}\n\n🔎 *Detalle completo de los grupos:*\n${urlPublica()}/reporte?id=${id}`;
}

// "hace 5 h" / "hace 1 día" / "hace 3 días"
function haceCuanto(ts) {
  const horas = Math.floor((Date.now() / 1000 - ts) / 3600);
  if (horas < 24) return `hace ${Math.max(horas, 1)} h`;
  const dias = Math.floor(horas / 24);
  return dias === 1 ? 'hace 1 día' : `hace ${dias} días`;
}

function recortar(texto, max = 80) {
  const t = String(texto || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Chats individuales donde te escribieron y no respondiste (config.sin_responder).
 * Se calcula en cada digest sin marcar nada: un chat sigue apareciendo hasta que
 * JO contesta. Gemini descarta los que no esperan respuesta ("gracias", avisos
 * automáticos, etc.). Si Gemini falla, se muestran todos avisando, en vez de
 * callar. Devuelve { items: [{ nombre, texto, ts }], sinFiltro, error }.
 */
async function revisarSinResponder({ forzar = false } = {}) {
  const cfg = config.sin_responder || {};
  if (cfg.activado === false && !forzar) return { items: [] };
  const propio = (process.env.MY_WHATSAPP_ID || '').replace('@c.us', '@s.whatsapp.net');
  const candidatos = await obtenerChatsSinResponder({
    dias: cfg.dias ?? 7,
    horasMin: cfg.horas_minimas ?? 3,
    maxChats: cfg.max_chats ?? 30,
    excluir: [propio],
  });
  if (candidatos === null) return { items: [], error: true };
  if (!candidatos.length) {
    console.log(`[Sin responder] No hay chats individuales sin respuesta`);
    return { items: [] };
  }

  const contactos = await obtenerContactos().catch(() => new Map());
  const chats = candidatos.map((c) => {
    const ultimoAjeno = [...c.mensajes].reverse().find((m) => !m.es_propio);
    return {
      chatId: c.chat_id,
      nombre: contactos.get(c.chat_id) || ultimoAjeno?.remitente || resolverNombreIndiv(c.chat_id, contactos),
      mensajes: c.mensajes,
      ts: c.ts_ult,
      ultimo: ultimoAjeno?.cuerpo || '',
    };
  });

  const filtrados = await filtrarSinResponder(chats);
  let items;
  let sinFiltro = false;
  if (filtrados === null) {
    sinFiltro = true;
    items = chats.map((c) => ({ nombre: c.nombre, texto: `"${recortar(c.ultimo)}"`, ts: c.ts }));
  } else {
    const porId = new Map(chats.map((c) => [c.chatId, c]));
    items = filtrados.map((f) => {
      const c = porId.get(f.chatId);
      return { nombre: c.nombre, texto: f.que_piden || `"${recortar(c.ultimo)}"`, ts: c.ts };
    });
  }
  items.sort((a, b) => a.ts - b.ts); // lo que hace más tiempo espera, primero
  console.log(`[Sin responder] ${chats.length} chats sin respuesta, ${items.length} esperan algo de vos${sinFiltro ? ' (sin filtro: falló Gemini)' : ''}`);
  return { items, sinFiltro };
}

function formatearSinResponder({ items = [], sinFiltro = false } = {}) {
  if (!items.length) return '';
  const lineas = ['💬 *Te escribieron y no respondiste*'];
  if (sinFiltro) lineas.push('_(no pude filtrarlos con la IA, te muestro todos)_');
  items.forEach((i) => lineas.push(`• *${i.nombre}* (${haceCuanto(i.ts)}): ${i.texto}`));
  return lineas.join('\n');
}

let estadoWA = 'arrancando';
let qrActual = null;
let tsAutenticando = null;

// ── Modo ahorro de notificaciones ──────────────────────────────────────────
// El bot se desconecta de WhatsApp entre tareas para que el teléfono quede como
// único dispositivo activo y las push lleguen siempre. Se conecta solo para los
// digests programados y los pedidos manuales; lo que llega mientras está
// desconectado lo entrega WhatsApp al reconectar ('append') — no se pierde nada.

function modoAhorro() {
  return config.conexion?.modo_ahorro_notificaciones !== false;
}

let timerDesconexion = null;
let tareasActivas = 0;

function programarDesconexion(minutos) {
  if (!modoAhorro()) return;
  const min = minutos ?? config.conexion?.minutos_conectado_tras_tarea ?? 2;
  if (timerDesconexion) clearTimeout(timerDesconexion);
  timerDesconexion = setTimeout(async () => {
    timerDesconexion = null;
    if (tareasActivas > 0) return; // hay una tarea corriendo — reprograma al terminar
    try {
      await desconectarWA();
    } catch (err) {
      console.error(`[Conexión] Error al desconectar:`, err.message);
    }
  }, min * 60 * 1000);
  console.log(`[Conexión] Desconexión programada en ${min} min (modo ahorro de notificaciones)`);
}

/**
 * Ejecuta una tarea que necesita WhatsApp: conecta si hace falta, espera a que
 * baje la cola de mensajes offline (para que el digest no salga incompleto),
 * corre la tarea y programa la desconexión al terminar.
 */
async function conTareaConectada(nombre, fn) {
  tareasActivas++;
  if (timerDesconexion) { clearTimeout(timerDesconexion); timerDesconexion = null; }
  try {
    if (!estaConectado()) {
      console.log(`[Conexión] Conectando para: ${nombre}`);
      await conectarBajoDemanda();
      console.log(`[Conexión] Conectado — esperando mensajes pendientes de WhatsApp...`);
      await esperarSincronizacion();
    }
    return await fn();
  } finally {
    tareasActivas--;
    if (tareasActivas === 0) programarDesconexion();
  }
}

// El bot está operativo (vinculado) tanto conectado como en standby: en standby
// las tareas conectan solas bajo demanda.
function botOperativo() {
  return estadoWA === 'conectado' || estadoWA === 'standby';
}

function leerBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', () => resolve(new URLSearchParams(body)));
    req.on('error', reject);
  });
}

function nombreParaChat(chatId, chatNombreDB, contactos) {
  // Para grupos, usar el nombre que ya viene de la metadata del grupo
  if (chatId && chatId.endsWith('@g.us')) {
    return chatNombreDB || chatId;
  }
  // Para individuales/newsletters: priorizar el nombre de la agenda
  const desdeAgenda = contactos.get(chatId);
  if (desdeAgenda) return desdeAgenda;
  if (chatNombreDB && !chatNombreDB.includes('@')) return chatNombreDB;
  // Fallback: si es un JID raw, mostrar solo el número (más legible)
  if (chatId && chatId.includes('@')) {
    const numero = chatId.split('@')[0];
    return numero.match(/^\d+$/) ? `+${numero}` : (chatNombreDB || chatId);
  }
  return chatNombreDB || chatId;
}

// Arma la lista de chats para la página de configuración: los de la base de
// los últimos 30 días más los configurados que no tuvieron mensajes.
function armarChatsConfig(chatsDB, configActual, contactos) {
  const configurados = new Map();
  (configActual.grupos || []).forEach((g) => {
    const nombre = typeof g === 'string' ? g : g.nombre;
    configurados.set(nombre.toLowerCase().trim(), typeof g === 'string'
      ? { nombre, frecuencia: 0 }
      : { nombre, frecuencia: g.frecuencia_horas || 0, modo: g.modo, detalle: g.detalle });
  });
  const vistos = new Set();
  const chats = [];
  for (const row of chatsDB) {
    const nombre = nombreParaChat(row.chat_id, row.chat_nombre, contactos);
    const key = nombre.toLowerCase().trim();
    if (!key || vistos.has(key)) continue;
    vistos.add(key);
    const conf = configurados.get(key);
    chats.push({ chat_nombre: nombre, cantidad: row.cantidad || 0, frecuencia: conf?.frecuencia || 0, modo: conf?.modo, detalle: conf?.detalle, esGrupo: row.chat_id ? row.chat_id.endsWith('@g.us') : true });
  }
  for (const [key, conf] of configurados) {
    if (!vistos.has(key)) chats.push({ chat_nombre: conf.nombre, cantidad: 0, frecuencia: conf.frecuencia, modo: conf.modo, detalle: conf.detalle, esGrupo: true });
  }
  return chats;
}

// ── Acceso al panel ─────────────────────────────────────────────────────────
// El panel muestra chats privados y puede borrar la sesión: se protege con una
// clave larga (env PANEL_KEY, o una generada y guardada en Turso). El link con
// la clave llega al final de cada resumen de WhatsApp; al abrirlo queda una
// cookie por un año. Sin clave, el panel ofrece mandar el link al WhatsApp del
// dueño (nunca a otro número).

let clavePanel = null;
const COOKIE_PANEL = 'botwp_k';

async function prepararClavePanel() {
  if (process.env.PANEL_KEY) {
    clavePanel = process.env.PANEL_KEY;
    return;
  }
  let clave = await obtenerAjuste('panel_key');
  if (!clave) {
    clave = nodeCrypto.randomBytes(18).toString('base64url');
    if (await guardarAjuste('panel_key', clave)) {
      console.log(`[Panel] Clave de acceso creada. Link del panel: ${linkPanel('/', clave)}`);
    }
  }
  clavePanel = clave;
}

function linkPanel(ruta = '/', clave = clavePanel) {
  return `${urlPublica()}${ruta}${ruta.includes('?') ? '&' : '?'}k=${encodeURIComponent(clave || '')}`;
}

function claveValida(dada) {
  if (!clavePanel || typeof dada !== 'string') return false;
  const a = Buffer.from(dada);
  const b = Buffer.from(clavePanel);
  return a.length === b.length && nodeCrypto.timingSafeEqual(a, b);
}

function leerCookie(req, nombre) {
  const m = new RegExp(`(?:^|;\\s*)${nombre}=([^;]+)`).exec(req.headers?.cookie || '');
  return m ? decodeURIComponent(m[1]) : null;
}

// Versión del texto para WhatsApp: los links al detalle llevan la clave (el chat
// con uno mismo es privado) y se agrega el acceso al panel. ntfy y el historial
// guardan la versión sin clave.
function textoParaWhatsApp(texto) {
  if (!clavePanel) return texto;
  const base = urlPublica().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return texto.replace(new RegExp(`${base}/reporte\\?id=(\\d+)`, 'g'), (_, id) => linkPanel(`/reporte?id=${id}`));
}

/**
 * Manda un resumen a WhatsApp y, justo después, el link del panel en un mensaje
 * corto aparte: pegado al final de un resumen largo queda escondido bajo "Leer
 * más". Devuelve si el resumen llegó; que falle el link no cambia eso.
 */
async function enviarResumen(texto) {
  const ok = await enviarTextoLibre(textoParaWhatsApp(texto));
  if (ok && clavePanel) {
    try {
      await enviarTextoLibre(`⚙️ *Tu panel:* ${linkPanel('/')}`);
    } catch (err) {
      console.error(`[Panel] No se pudo mandar el link tras el resumen:`, err.message);
    }
  }
  return ok;
}

let ultimoEnvioLink = 0;

async function enviarLinkPanel() {
  if (!clavePanel || Date.now() - ultimoEnvioLink < 10 * 60 * 1000) return 'espera';
  ultimoEnvioLink = Date.now();
  const texto = `🔑 *Tu acceso al panel de BotWP*\n${linkPanel('/')}\n\n_Abrilo desde el teléfono o la compu que vas a usar: queda guardado por un año._`;
  let porWhatsApp = false;
  if (estaConectado()) {
    try { porWhatsApp = await enviarTextoLibre(texto); } catch (err) { console.error(`[Panel] No se pudo mandar el link por WhatsApp:`, err.message); }
  }
  // ntfy solo como respaldo, cuando WhatsApp no está disponible.
  if (!porWhatsApp) postNtfy('Acceso al panel de BotWP', texto.replace(/[*_]/g, ''), { prioridad: 'high', click: linkPanel('/') });
  console.log(`[Panel] Link de acceso enviado por ${porWhatsApp ? 'WhatsApp' : 'ntfy'}`);
  return 'enviado';
}

// ── Estado para el inicio del panel ─────────────────────────────────────────

function haceCuantoCorto(ts) {
  const min = Math.max(0, Math.floor((Date.now() / 1000 - Number(ts)) / 60));
  if (min < 60) return `hace ${Math.max(min, 1)} min`;
  const h = Math.floor(min / 60);
  return h < 24 ? `hace ${h} h` : `hace ${Math.floor(h / 24)} d`;
}

// Próximo disparo de los crons "M H * * *" en hora de Argentina.
function proximoDigest() {
  const exprs = config.resumen?.horas_digest || ['0 11 * * *', '0 21 * * *'];
  const horarios = exprs
    .map((e) => /^(\d+)\s+(\d+)\s+\*\s+\*\s+\*$/.exec(String(e).trim()))
    .filter(Boolean)
    .map((m) => ({ h: Number(m[2]), m: Number(m[1]) }))
    .sort((a, b) => a.h - b.h || a.m - b.m);
  if (!horarios.length) return null;
  const ahora = horaActual() * 60 + Number(new Date().toLocaleString('en-US', { timeZone: TZ, minute: 'numeric' }));
  const hoy = horarios.find((x) => x.h * 60 + x.m > ahora);
  const x = hoy || horarios[0];
  return `${hoy ? 'hoy' : 'mañana'} ${String(x.h).padStart(2, '0')}:${String(x.m).padStart(2, '0')}`;
}

async function estadoPanel() {
  const [ultimo, pendientes] = await Promise.all([ultimoReporte('digest'), contarPendientes()]);
  return {
    nombre: (config.nombre_dueno || '').trim(),
    conexion: estadoWA === 'conectado' ? 'conectado' : estadoWA === 'standby' ? 'standby' : 'reconectando',
    ultimoDigest: ultimo ? {
      hace: haceCuantoCorto(ultimo.creado_en),
      cuando: new Date(Number(ultimo.creado_en) * 1000).toLocaleString('es-AR', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit' }),
    } : null,
    proximoDigest: proximoDigest(),
    pendientes,
    gemini: usoGemini(),
    grupos: (config.grupos || []).length,
  };
}

// ── Configuración persistente ───────────────────────────────────────────────
// config.json vive en el disco efímero de Render: lo que se cambiaba desde el
// panel se perdía en cada deploy. Ahora lo editable se guarda también en Turso
// y se vuelve a aplicar al arrancar.

const RUTA_CONFIG = path.join(__dirname, 'config.json');

function aplicarConfigUsuario(cu) {
  if (!cu || typeof cu !== 'object') return;
  const actual = JSON.parse(fs.readFileSync(RUTA_CONFIG, 'utf8'));
  if (typeof cu.nombre_dueno === 'string') actual.nombre_dueno = cu.nombre_dueno;
  if (Array.isArray(cu.grupos)) actual.grupos = cu.grupos;
  if (Array.isArray(cu.intereses)) {
    actual.resumen = actual.resumen || {};
    actual.resumen.intereses = cu.intereses;
  }
  fs.writeFileSync(RUTA_CONFIG, JSON.stringify(actual, null, 2), 'utf8');
  recargarConfig();
}

// ── Servidor ────────────────────────────────────────────────────────────────

let callbacksWA = null;

async function reiniciarVinculacion() {
  await limpiarAuth();
  try { await desconectarWA(); } catch {}
  estadoWA = 'arrancando';
  // Pausa para que el socket viejo termine de cerrarse antes de abrir uno nuevo.
  setTimeout(() => {
    iniciarCliente(callbacksWA || {}).catch((err) => console.error(`[WA] Error al re-vincular:`, err.message));
  }, 3000);
}

function enviarHTML(res, html, status = 200) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(html);
}

function redirigir(res, destino, cookie) {
  if (cookie) res.setHeader('Set-Cookie', cookie);
  res.setHeader('Location', destino);
  res.writeHead(302);
  res.end();
}

// Páginas de estado que no muestran datos: se ven sin clave, así siempre se
// puede escanear el QR aunque no haya forma de recibir el link.
async function paginaSegunEstado() {
  if (estadoWA === 'qr' && qrActual) {
    return panel.paginaQR(await QRCode.toDataURL(qrActual, { width: 280, margin: 2 }));
  }
  if (estadoWA === 'autenticando') {
    const segs = tsAutenticando ? Math.round((Date.now() - tsAutenticando) / 1000) : 0;
    return panel.paginaEstado({ icono: '🔄', titulo: 'Conectando con WhatsApp…', texto: `Esperando hace ${segs} s.${segs > 45 ? ' Está tardando más de lo normal; si sigue así, revisá los logs en Render.' : ''}`, refresco: 3 });
  }
  if (estadoWA === 'error_db') return panel.paginaEstado({ icono: '🗄️', titulo: 'Sin conexión a la base', texto: 'No pude conectar con Turso. Reintento solo; si dura mucho, revisá TURSO_URL y TURSO_TOKEN en Render.', refresco: 10, tono: 'error' });
  if (estadoWA === 'error_wa') return panel.paginaEstado({ icono: '⚠️', titulo: 'WhatsApp no arrancó', texto: 'No pude iniciar el cliente de WhatsApp. Revisá los logs en Render.', refresco: 10, tono: 'error' });
  return panel.paginaEstado({ icono: '⏳', titulo: 'Arrancando…', texto: 'El bot se está iniciando.', refresco: 3 });
}

function iniciarServidor() {
  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      enviarHTML(res, panel.paginaNoEncontrado(), 400);
      return;
    }
    const ruta = url.pathname;
    const metodo = req.method;

    try {
      if (ruta === '/health') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, whatsapp: estadoWA }));
        return;
      }

      // Link con clave: guarda la cookie y redirige a la misma página sin la
      // clave en la URL (no queda en el historial ni se comparte por error).
      const dada = url.searchParams.get('k');
      if (dada && claveValida(dada)) {
        url.searchParams.delete('k');
        const cookie = `${COOKIE_PANEL}=${encodeURIComponent(clavePanel)}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax; Secure`;
        redirigir(res, `${ruta}${url.search}`, cookie);
        return;
      }

      if (ruta === '/enviar-link' && metodo === 'POST') {
        const r = await enviarLinkPanel();
        enviarHTML(res, panel.paginaAcceso({ enviado: r === 'enviado', espera: r === 'espera' }));
        return;
      }

      if (!botOperativo() && !['/reportes', '/reporte', '/configurar', '/sesion'].includes(ruta)) {
        enviarHTML(res, await paginaSegunEstado());
        return;
      }

      if (!claveValida(leerCookie(req, COOKIE_PANEL))) {
        // En "/" el candado responde 200: un monitor de disponibilidad que
        // pinguee la raíz no lo toma como caída. No muestra ningún dato.
        const status = clavePanel && ruta !== '/' ? 401 : 200;
        enviarHTML(res, clavePanel ? panel.paginaAcceso() : await paginaSegunEstado(), status);
        return;
      }

      if (ruta === '/' && metodo === 'GET') {
        enviarHTML(res, panel.paginaInicio(await estadoPanel()));
        return;
      }

      const sinConexion = () => enviarHTML(res, panel.paginaAccion({ icono: '📵', titulo: 'WhatsApp no está conectado', texto: 'Esperá a que reconecte o vinculalo de nuevo desde el inicio.' }));

      if (ruta === '/procesar' || ruta === '/historial') {
        if (!botOperativo()) return sinConexion();
        procesarMensajes().catch((err) => console.error('[Digest manual]', err.message));
        enviarHTML(res, panel.paginaAccion({ icono: '📋', titulo: 'Preparando tu resumen', texto: 'Analizo los mensajes nuevos y te lo mando por WhatsApp en uno o dos minutos.', detalle: 'Si no hubo nada nuevo, te llega un "todo tranquilo".' }));
        return;
      }

      if (ruta === '/resumen') {
        if (!botOperativo()) return sinConexion();
        const horas = Number(url.searchParams.get('h')) || 24;
        if (![24, 72, 168].includes(horas)) {
          enviarHTML(res, panel.paginaAccion({ icono: '🤔', titulo: 'Período inválido', texto: 'Elegí 24 horas, 3 días o 7 días.' }), 400);
          return;
        }
        resumenPeriodo(horas).catch((err) => console.error(`[Resumen ${horas}h]`, err.message));
        const label = horas === 24 ? 'las últimas 24 horas' : horas === 72 ? 'los últimos 3 días' : 'la última semana';
        enviarHTML(res, panel.paginaAccion({ icono: '🗂️', titulo: 'Generando resumen', texto: `Reviso todo lo de ${label}, leído o no, y te lo mando por WhatsApp.`, detalle: 'Puede tardar un par de minutos si hay muchos chats.' }));
        return;
      }

      if (ruta === '/sin-responder') {
        if (!botOperativo()) return sinConexion();
        enviarSinResponder().catch((err) => console.error(`[Sin responder]`, err.message));
        enviarHTML(res, panel.paginaAccion({ icono: '💬', titulo: 'Revisando tus chats', texto: 'Busco conversaciones de la última semana donde te escribieron y no contestaste. Te mando la lista por WhatsApp.' }));
        return;
      }

      if (ruta === '/test') {
        if (!botOperativo()) return sinConexion();
        enviarPrueba().catch((err) => console.error('[Prueba]', err.message));
        enviarHTML(res, panel.paginaAccion({ icono: '🔔', titulo: 'Prueba enviada', texto: 'Te mandé un mensaje de prueba por WhatsApp y por ntfy. Si te llegan los dos, todo funciona.' }));
        return;
      }

      if (ruta === '/sesion' || ruta === '/limpiar-sesion') {
        if (metodo === 'POST') {
          await reiniciarVinculacion();
          enviarHTML(res, panel.paginaSesion({ hecho: true }));
        } else {
          enviarHTML(res, panel.paginaSesion());
        }
        return;
      }

      if (ruta === '/reportes') {
        enviarHTML(res, panel.paginaReportes(await obtenerReportes(30), { tz: TZ }));
        return;
      }

      if (ruta === '/reporte') {
        const id = Number(url.searchParams.get('id'));
        const r = Number.isInteger(id) && id > 0 ? await obtenerReporte(id) : null;
        if (!r) {
          enviarHTML(res, panel.paginaNoEncontrado(), 404);
          return;
        }
        enviarHTML(res, panel.paginaReporte(r, htmlDesdeTexto(r.contenido), { tz: TZ }));
        return;
      }

      if (ruta === '/configurar' && metodo === 'GET') {
        const [chatsDB, contactos] = await Promise.all([obtenerChatsDistintos(30), obtenerContactos()]);
        enviarHTML(res, panel.paginaConfigurar({
          chats: armarChatsConfig(chatsDB, config, contactos),
          nombreDueno: config.nombre_dueno || '',
          intereses: config.resumen?.intereses || [],
          detalleDefecto: detalleDefecto(),
          mensaje: url.searchParams.get('ok') ? 'Configuración guardada.' : '',
        }));
        return;
      }

      if (ruta === '/configurar' && metodo === 'POST') {
        const params = await leerBody(req);
        const grupos = [];
        for (const [key, value] of params.entries()) {
          if (!key.startsWith('freq_')) continue;
          const frecuencia = parseInt(value, 10);
          if (isNaN(frecuencia) || frecuencia <= 0) continue;
          const sufijo = key.slice(5);
          grupos.push({
            nombre: decodeURIComponent(sufijo),
            frecuencia_horas: frecuencia,
            ...(params.get(`modo_${sufijo}`) === 'catalogo' ? { modo: 'catalogo' } : {}),
            ...(['alto', 'normal'].includes(params.get(`det_${sufijo}`)) ? { detalle: params.get(`det_${sufijo}`) } : {}),
          });
        }
        const cu = { nombre_dueno: (params.get('nombre_dueno') || '').trim(), grupos };
        if (params.has('intereses')) cu.intereses = params.get('intereses').split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
        aplicarConfigUsuario(cu);
        const guardada = await guardarAjuste('config_usuario', cu);
        console.log(`[Config] Guardada — nombre="${cu.nombre_dueno}", ${grupos.length} grupos${guardada ? '' : ' (OJO: no se pudo guardar en Turso, se pierde en el próximo deploy)'}`);
        redirigir(res, '/configurar?ok=1');
        return;
      }

      enviarHTML(res, panel.paginaNoEncontrado(), 404);
    } catch (err) {
      console.error(`[Server] Error en ${ruta}:`, err.message);
      if (!res.headersSent) enviarHTML(res, panel.paginaAccion({ icono: '⚠️', titulo: 'Algo falló', texto: err.message }), 500);
    }
  });

  server.on('error', (err) => {
    console.error(`[Server] Error al iniciar en puerto ${PORT}:`, err.message);
  });

  server.listen(PORT, () => {
    console.log(`[Server] Escuchando en puerto ${PORT}`);
  });
}

/**
 * Analiza un conjunto de mensajes (grupales + individuales) y arma el digest.
 * Devuelve { texto, resumenesChats, resIndiv, idsProcesados, totalTemas, meta }.
 * No envía ni marca nada — eso lo deciden los callers (digest vs período).
 */
async function analizarLote(todos, etiqueta, sinResponder = null) {
  const grupales = todos.filter((m) => m.chat_id?.endsWith('@g.us'));
  const individuales = todos.filter((m) => !m.chat_id?.endsWith('@g.us'));

  const contactos = await obtenerContactos().catch(() => new Map());

  // Grupos: agrupar por chat y analizar cada uno
  const porChat = new Map();
  for (const m of grupales) {
    if (!porChat.has(m.chat_id)) porChat.set(m.chat_id, []);
    porChat.get(m.chat_id).push(m);
  }
  const resumenesChats = [];
  const idsProcesados = [];
  let erroresAnalisis = 0;
  let triviales = 0;
  // Un chat cuyos mensajes nuevos son todos "ok", "gracias", risas o emojis no
  // aporta nada: se da por leído sin gastar una llamada a Gemini.
  const soloTrivial = (lista) => {
    const nuevos = lista.filter((m) => !m.solo_contexto);
    if (!nuevos.length || !nuevos.every((m) => esTrivial(m.cuerpo))) return false;
    idsProcesados.push(...nuevos.map((m) => m.id));
    triviales++;
    return true;
  };
  for (const [chatId, mensajesChat] of porChat) {
    const chatNombre = mensajesChat[0].chat_nombre || chatId;
    if (soloTrivial(mensajesChat)) continue;
    console.log(`[Análisis${etiqueta ? ' ' + etiqueta : ''}] "${chatNombre}" (${mensajesChat.length} mensajes)`);
    try {
      const opciones = obtenerOpcionesGrupo(chatNombre);
      const { temas, menores = [], idsProcesados: ids, errores } = await analizarChat(chatNombre, mensajesChat, { ...opciones, intereses: config.resumen?.intereses });
      idsProcesados.push(...ids);
      erroresAnalisis += errores || 0;
      if (temas.length || menores.length) resumenesChats.push({ chatNombre, temas, menores, ...opciones });
    } catch (err) {
      erroresAnalisis++;
      console.error(`[Análisis] Error analizando "${chatNombre}":`, err.message);
    }
  }

  // Individuales
  let resIndiv = { eventos: [], compromisos: [], pedidos: [] };
  const porChatIndiv = new Map();
  for (const m of individuales) {
    if (!porChatIndiv.has(m.chat_id)) porChatIndiv.set(m.chat_id, []);
    porChatIndiv.get(m.chat_id).push(m);
  }
  const individualesUtiles = [...porChatIndiv.values()].filter((lista) => !soloTrivial(lista)).flat();
  if (triviales) console.log(`[Análisis] ${triviales} chat(s) con solo saludos, "ok" o emojis: se omiten sin usar Gemini`);
  if (individualesUtiles.length) {
    try {
      const r = await analizarIndividuales(individualesUtiles, contactos, { detalle: detalleDefecto() });
      resIndiv = r;
      idsProcesados.push(...(r.idsProcesados || []));
      erroresAnalisis += r.errores || 0;
    } catch (err) {
      erroresAnalisis++;
      console.error(`[Análisis] Error analizando individuales:`, err.message);
    }
  }

  // Titular del día: una frase de Gemini con lo más importante de los pendientes
  const accionables = extraerAccionables(resumenesChats, resIndiv, contactos);
  let titular = '';
  const itemsTitular = [
    ...accionables.pendientes.map((p) => `${p.texto} (${p.origen}${p.fecha ? `, fecha ${p.fecha.iso}` : ''})`),
    ...accionables.agenda.map((e) => `${e.texto} (${e.origen}, ${e.fechaRaw || 'sin fecha'})`),
    ...(sinResponder?.items || []).map((i) => `Sin responder a ${i.nombre}: ${i.texto}`),
  ];
  if (itemsTitular.length) {
    titular = await generarTitular(itemsTitular);
  }

  const coincidencias = buscarIntereses(todos, config.resumen?.intereses);
  const conversaciones = resIndiv.conversaciones || [];
  const convs = seccionConversaciones(conversaciones);
  const meta = {
    etiqueta,
    totalMensajes: todos.filter(m => !m.solo_contexto).length,
    titular,
    seccionSinResponder: formatearSinResponder(sinResponder || {}),
    seccionIntereses: formatearIntereses(coincidencias),
    seccionConversaciones: convs.texto,
    pendientes: accionables.pendientes.length,
    urgentes: accionables.pendientes.filter((p) => urgencia(p.fecha).peso <= 1).length,
  };
  const texto = formatearDigest(accionables, resumenesChats, meta);
  // Saludos y charla de cortesía (relevancia 1) de las conversaciones no cuentan:
  // un digest solo con eso sale como "todo tranquilo".
  const totalTemas = resumenesChats.reduce((a, r) => a + r.temas.length, 0)
    + conversaciones.reduce((n, c) => n + (c.temas || []).filter((t) => t.relevancia >= 2).length, 0)
    + coincidencias.length;

  // Detalle completo (página web): solo si el resumen de WhatsApp dejó cosas afuera.
  const necesitaDetalle = seccionGrupos(resumenesChats).ocultos > 0 || convs.ocultos > 0 || coincidencias.length > MAX_INTERESES_WA;
  const detalle = necesitaDetalle ? formatearDetalle(resumenesChats, coincidencias, etiqueta, conversaciones) : null;

  return { texto, idsProcesados, totalTemas, meta, erroresAnalisis, detalle };
}

/**
 * Resumen a demanda por ventana de tiempo (endpoint /resumen).
 * Lee TODOS los mensajes del período (leídos y no leídos), no marca procesados.
 */
async function resumenPeriodo(horas) {
  const labelHoras = horas === 168 ? '7 días' : `${horas}h`;
  console.log(`\n[Resumen ${labelHoras}] Iniciando...`);
  try {
    await conTareaConectada(`resumen ${labelHoras}`, async () => {
      const desde = Math.floor(Date.now() / 1000) - horas * 3600;
      const todos = await obtenerMensajesDesde(desde);
      if (!todos.length) {
        console.log(`[Resumen ${labelHoras}] Sin mensajes en el período`);
        const txt = `📋 *Resumen últimas ${labelHoras}*\n\nNo hay mensajes en este período.`;
        postNtfy(`Resumen ${labelHoras}`, txt, opcionesNtfy());
        try { await enviarResumen(txt); } catch (err) { console.error(`[Resumen ${labelHoras}] Error enviando WA:`, err.message); }
        return;
      }

      const analisis = await analizarLote(todos, `últimas ${labelHoras}`);
      const { totalTemas } = analisis;
      const texto = await adjuntarDetalle(analisis.texto, analisis.detalle, todos.length, totalTemas);
      try {
        await enviarResumen(texto);
        console.log(`[Resumen ${labelHoras}] Enviado — ${totalTemas} temas`);
      } catch (err) {
        console.error(`[Resumen ${labelHoras}] Error enviando WA:`, err.message);
      }
      postNtfy(`Resumen ${labelHoras}`, texto, opcionesNtfy(analisis.meta));
      await guardarReporte(`periodo_${horas}h`, texto, todos.length, totalTemas);
    });
  } catch (err) {
    console.error(`[Resumen ${labelHoras}] Error general:`, err.message);
  }
}

/**
 * Revisión a demanda (endpoint /sin-responder): manda por WhatsApp solo la lista
 * de chats individuales sin responder de los últimos `sin_responder.dias` días.
 * No marca nada ni toca el digest.
 */
async function enviarSinResponder() {
  const dias = config.sin_responder?.dias ?? 7;
  console.log(`\n[Sin responder] Revisión manual (últimos ${dias} días)`);
  try {
    await conTareaConectada('sin responder', async () => {
      const r = await revisarSinResponder({ forzar: true });
      const texto = r.error
        ? `⚠️ No pude revisar los chats sin responder (falló la base de datos). Probá de nuevo en un rato.`
        : r.items.length
          ? `${formatearSinResponder(r)}\n\n_Últimos ${dias} días · chats individuales_`
          : `✅ No tenés chats individuales sin responder en los últimos ${dias} días.`;
      try {
        await enviarResumen(texto);
      } catch (err) {
        console.error(`[Sin responder] Error enviando WA:`, err.message);
      }
      postNtfy('Chats sin responder', texto, { prioridad: r.items.length ? 'default' : 'low', tags: ['speech_balloon'], click: urlPublica() });
      await guardarReporte('sin_responder', texto, 0, r.items.length);
    });
  } catch (err) {
    console.error(`[Sin responder] Error general:`, err.message);
  }
}

/**
 * Digest programado (11:00 y 21:00): barre TODOS los mensajes sin procesar
 * —grupos e individuales juntos—, arma un único mensaje consolidado, lo envía,
 * lo persiste y marca los mensajes como procesados.
 */
async function generarDigest(etiqueta) {
  const hora = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  console.log(`\n[Digest${etiqueta ? ' ' + etiqueta : ''}] Iniciando — ${hora}`);
  try {
    await conTareaConectada(`digest${etiqueta ? ' ' + etiqueta : ''}`, async () => {
      // Chats donde te escribieron y no respondiste: se revisan SIEMPRE, aunque no
      // haya mensajes nuevos, porque justo esos chats quedan en silencio.
      const sinResp = await revisarSinResponder().catch((err) => {
        console.error(`[Digest] Error revisando chats sin responder:`, err.message);
        return { items: [] };
      });
      const seccionSinResp = formatearSinResponder(sinResp);

      const todos = await obtenerMensajesSinProcesar({ contexto: config.resumen?.mensajes_contexto ?? 12 });
      if (!todos.length) {
        // Mensaje corto igual: JO sabe que el bot está vivo y no se perdió nada
        console.log(`[Digest] Sin mensajes nuevos — enviando mensaje corto${seccionSinResp ? ' con chats sin responder' : ' "todo tranquilo"'}`);
        const txt = seccionSinResp
          ? `📭 No hubo mensajes nuevos desde el último resumen.\n\n${seccionSinResp}`
          : `✅ *Todo tranquilo* — no hubo mensajes nuevos desde el último resumen.`;
        // ntfy SIEMPRE, aunque no haya nada: antes este camino hacía return sin
        // notificar y ntfy quedaba mudo justo cuando WA fallaba en descifrar.
        postNtfy(`Resumen ${etiqueta || ''}`.trim() || 'Resumen', txt, opcionesNtfy());
        try {
          const ok = await enviarResumen(txt);
          if (ok) await guardarReporte('digest', txt, 0, sinResp.items.length);
        } catch (err) {
          console.error(`[Digest] No se pudo enviar (WA no conectado):`, err.message);
        }
        return;
      }

      let { texto, idsProcesados, totalTemas, erroresAnalisis, detalle, meta } = await analizarLote(todos, etiqueta, sinResp);
      const gem = usoGemini();
      const sinCuota = gem.total >= gem.limite;

      // Hubo mensajes pero nada relevante: mensaje corto en vez del esqueleto del digest.
      // Si además hubo errores de análisis, decirlo — antes un fallo total de Gemini
      // salía disfrazado de "todo tranquilo" y era imposible enterarse.
      if (totalTemas === 0) {
        texto = sinCuota
          ? `⚠️ *Ojo* — llegué al tope diario gratuito de Gemini (${gem.total} consultas), así que no pude analizar ${todos.length} mensajes nuevos. Quedan guardados y entran en el próximo resumen.`
          : erroresAnalisis > 0
          ? `⚠️ *Ojo* — había ${todos.length} mensajes nuevos pero falló el análisis (${erroresAnalisis} error/es con Gemini). Lo pendiente se reintenta en el próximo resumen.`
          : seccionSinResp
            ? `✅ Revisé ${todos.length} mensajes nuevos y no hay novedades para vos.`
            : `✅ *Todo tranquilo* — revisé ${todos.length} mensajes y no hay nada pendiente para vos. Solo charla.`;
        if (seccionSinResp) texto += `\n\n${seccionSinResp}`;
      } else {
        texto = await adjuntarDetalle(texto, detalle, todos.length, totalTemas);
      }

      let enviado = false;
      try {
        enviado = await enviarResumen(texto);
      } catch (err) {
        console.error(`[Digest] No se pudo enviar (WA no conectado):`, err.message);
      }
      postNtfy(`Resumen ${etiqueta || ''}`.trim() || 'Resumen', texto, opcionesNtfy(meta));
      if (!enviado) alertar('envio', 'No pude mandarte el resumen por WhatsApp', 'El resumen de arriba no llegó por WhatsApp. Revisá el panel: puede que haya que vincular de nuevo.', 3);
      await guardarReporte('digest', texto, todos.length, totalTemas);

      // Solo marcamos procesados si el envío salió bien; si falló, los mensajes
      // quedan pendientes y el contenido se reintenta en el próximo digest (no se pierde).
      if (enviado) {
        await marcarProcesados(idsProcesados);
        // Mensajes cuyo análisis falló: se reintentan en el próximo digest, pero
        // tras varios intentos se abandonan para no gastar Gemini para siempre.
        // Si el problema fue la cuota, no es culpa de los mensajes: no cuenta.
        const hechos = new Set(idsProcesados);
        const fallidos = todos.filter((m) => !m.solo_contexto && !hechos.has(m.id)).map((m) => m.id);
        const abandonados = fallidos.length && !sinCuota ? await registrarFallos(fallidos, config.resumen?.max_intentos ?? 3) : 0;
        console.log(`[Digest] Enviado — ${totalTemas} temas, ${idsProcesados.length} mensajes procesados${fallidos.length ? `, ${fallidos.length - abandonados} pendientes para el próximo digest` : ''}${abandonados ? `, ${abandonados} abandonados tras varios intentos fallidos` : ''}`);
      } else {
        console.warn(`[Digest] Envío fallido — no se marcan procesados, se reintenta en el próximo digest`);
      }
    });
  } catch (err) {
    console.error(`[Digest] Error general:`, err.message);
  }
}

// Alias para los endpoints de mantenimiento que disparan un digest manual.
async function procesarMensajes() {
  await generarDigest('manual');
}

async function main() {
  console.log(`[Bot] Arrancando...`);
  iniciarServidor();
  // Conectar a Turso con reintentos indefinidos: si la base está teniendo un
  // hipo (502/503) al arrancar, NO nos rendimos ni dejamos el bot inerte —
  // seguimos intentando con backoff hasta que Turso vuelva. Antes, un solo
  // fallo acá dejaba el proceso vivo pero sin WhatsApp ni cron para siempre.
  let intentoDB = 0;
  for (;;) {
    try {
      await conectar();
      break;
    } catch (err) {
      intentoDB++;
      estadoWA = 'error_db';
      const espera = Math.min(5000 * intentoDB, 60000);
      console.error(`[Bot] No se pudo conectar a Turso (intento ${intentoDB}): ${err.message} — reintento en ${espera / 1000}s`);
      await new Promise((r) => setTimeout(r, espera));
    }
  }
  try {
    aplicarConfigUsuario(await obtenerAjuste('config_usuario'));
  } catch (err) {
    console.error(`[Config] No se pudo aplicar la configuración guardada:`, err.message);
  }
  await prepararClavePanel().catch((err) => console.error(`[Panel] No se pudo preparar la clave:`, err.message));
  await cargarUsoGuardado();
  try {
    await iniciarCliente(callbacksWA = {
      onQR: (qr) => {
        estadoWA = 'qr'; qrActual = qr; tsAutenticando = null;
        console.log(`[WA] QR listo — abrí ${urlPublica()} para escanearlo`);
        alertar('qr', 'WhatsApp se desvinculó del bot', 'Para seguir recibiendo resúmenes, abrí el panel y escaneá el código QR desde WhatsApp → Dispositivos vinculados.');
      },
      onAutenticando: () => { estadoWA = 'autenticando'; qrActual = null; tsAutenticando = Date.now(); console.log(`[WA] QR escaneado — autenticando...`); },
      onListo: () => {
        const segs = tsAutenticando ? Math.round((Date.now() - tsAutenticando) / 1000) : '?';
        estadoWA = 'conectado';
        qrActual = null;
        console.log(`[WA] ¡Listo! Conectado en ${segs}s`);
        // Gracia inicial: dejar que bajen mensajes offline y contactos, y después
        // pasar a standby para que el teléfono reciba todas las notificaciones.
        programarDesconexion(config.conexion?.minutos_gracia_arranque ?? 3);
      },
      onStandby: () => { estadoWA = 'standby'; },
      onDesconectado: (code) => {
        if (code === 401 || code === 403) { estadoWA = 'qr'; qrActual = null; return; }
        if (estadoWA === 'conectado') estadoWA = 'autenticando';
      },
    });
  } catch (err) {
    console.error(`[Bot] No se pudo inicializar WhatsApp:`, err.message);
    estadoWA = 'error_wa';
    return;
  }

  // Digest a horas fijas (default 11:00 y 21:00). Cada disparo barre TODOS los
  // mensajes sin procesar (grupos + individuales) en un único mensaje consolidado.
  const horasDigest = config.resumen?.horas_digest || ['0 11 * * *', '0 21 * * *'];
  horasDigest.forEach((expr) => {
    cron.schedule(expr, () => generarDigest(), { timezone: 'America/Argentina/Buenos_Aires' });
  });
  console.log(`[Bot] Digest programado (America/Argentina/Buenos_Aires): ${horasDigest.join(' , ')}`);
}

main();
