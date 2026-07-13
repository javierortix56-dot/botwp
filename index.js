global.crypto = require('crypto').webcrypto;

require('dotenv').config();

const REQUIRED_ENV = ['GEMINI_API_KEY', 'TURSO_URL', 'TURSO_TOKEN', 'MY_WHATSAPP_ID'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`[Bot] Faltan variables de entorno: ${missing.join(', ')}`);
  process.exit(1);
}

const http = require('http');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const QRCode = require('qrcode');
const {
  conectar,
  obtenerMensajesSinProcesar,
  obtenerMensajesDesde,
  marcarProcesados,
  guardarMensaje,
  limpiarAuth,
  obtenerChatsDistintos,
  obtenerContactos,
  guardarReporte,
  obtenerReportes,
} = require('./db');
const {
  iniciarCliente,
  enviarTextoLibre,
  estaConectado,
  conectarBajoDemanda,
  desconectar: desconectarWA,
  esperarSincronizacion,
} = require('./whatsapp');
const { analizarChat, analizarIndividuales, generarTitular } = require('./gemini');
const { recargar: recargarFiltros } = require('./filtros');

let config = require('./config.json');

const https = require('https');

const PORT = process.env.PORT || 3000;

function recargarConfig() {
  try {
    delete require.cache[require.resolve('./config.json')];
    config = require('./config.json');
    recargarFiltros(); // que el filtro de captura use los grupos/VIPs nuevos sin reiniciar
    console.log(`[Config] Recargada`);
  } catch (err) {
    console.error(`[Config] Error recargando:`, err.message);
  }
}

function postNtfy(title, body) {
  if (!process.env.NTFY_TOPIC) return;
  const buf = Buffer.from(body);
  const req = https.request({
    hostname: 'ntfy.sh',
    path: `/${process.env.NTFY_TOPIC}`,
    method: 'POST',
    headers: {
      'Title': title,
      'Priority': 'high',
      'Content-Type': 'text/plain',
      'Content-Length': buf.length,
    },
  });
  req.on('error', (err) => console.error(`[ntfy] Error:`, err.message));
  req.write(buf);
  req.end();
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
      const fecha = parseFecha(t.fecha_limite);
      if (t.me_piden || t.tipo === 'accion') {
        const q = t.accion || t.resumen;
        if (nuevo(`${t.tema}${q}`)) pendientes.push({ emoji: '🔴', texto: q, origen: `${chatNombre}${t.de ? ` · ${t.de}` : ''}`, fecha });
      } else if (t.tipo === 'pago') {
        if (nuevo(`${t.tema}${t.resumen}`)) pendientes.push({ emoji: '💰', texto: t.resumen, origen: chatNombre, fecha });
      } else if (t.tipo === 'evento') {
        if (nuevo(`${t.tema}${t.resumen}`)) agenda.push({ texto: t.resumen, origen: chatNombre, fecha, fechaRaw: t.fecha_limite });
      }
    }
  }

  (resIndiv.pedidos || []).forEach((p) => {
    if (!nuevo(`${p.de}${p.pedido}`)) return;
    pendientes.push({ emoji: '🔴', texto: p.pedido, origen: resolverNombreIndiv(p.chat || p.de, contactos), fecha: null });
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
  const { etiqueta, totalMensajes = 0, titular = '' } = meta;
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

  out.push('');
  out.push('📌 *Para resolver*');
  if (pendientes.length) {
    const ordenados = [...pendientes].sort((a, b) => urgencia(a.fecha).peso - urgencia(b.fecha).peso);
    ordenados.forEach((p) => {
      out.push(`${p.emoji} ${urgencia(p.fecha).tag}${p.texto} _(${p.origen})_`);
    });
  } else {
    out.push('✅ Nada pendiente — no te piden nada por ahora.');
  }

  if (agenda.length) {
    const ordenada = [...agenda].sort((a, b) => {
      const ka = a.fecha ? `${a.fecha.iso} ${a.fecha.hora || ''}` : '9999';
      const kb = b.fecha ? `${b.fecha.iso} ${b.fecha.hora || ''}` : '9999';
      return ka.localeCompare(kb);
    });
    out.push('');
    out.push('📅 *Se viene*');
    ordenada.forEach((e) => {
      const cuando = e.fecha ? fechaLegible(e.fecha) : (e.fechaRaw || 's/f');
      const dias = diasHasta(e.fecha);
      const conHora = e.fecha?.hora ? ` ${e.fecha.hora}` : '';
      const marca = dias === 0 ? `*HOY${conHora}*` : dias === 1 ? `*mañana${conHora}*` : `*${cuando}*`;
      out.push(`• ${marca} — ${e.texto} _(${e.origen})_`);
    });
  }

  // Info de grupos: solo lo útil, con tope por grupo para no inflar el mensaje
  const bloquesInfo = [];
  for (const { chatNombre, temas } of resumenesChats) {
    const vistosInfo = new Set();
    const infos = temas
      .filter((t) => t.tipo === 'info' && !t.me_piden)
      .filter((t) => {
        const k = normalizarClave(t.resumen);
        if (k && vistosInfo.has(k)) return false;
        if (k) vistosInfo.add(k);
        return true;
      })
      .slice(0, 3);
    infos.forEach((t) => bloquesInfo.push(`• *${chatNombre}:* ${t.resumen}`));
  }
  if (bloquesInfo.length) {
    out.push('');
    out.push('👥 *De los grupos*');
    bloquesInfo.forEach((l) => out.push(l));
  }

  out.push('');
  out.push(`_${totalMensajes} mensajes revisados_`);

  return out.join('\n').trim();
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

function generarPaginaConfiguracion(chatsDB, configActual, contactos, mensaje) {
  const gruposConfigurados = new Map();
  (configActual.grupos || []).forEach((g) => {
    const nombre = typeof g === 'string' ? g : g.nombre;
    const frecuencia = typeof g === 'string' ? 0 : (g.frecuencia_horas || 0);
    gruposConfigurados.set(nombre.toLowerCase().trim(), { nombre, frecuencia });
  });

  // Unir chats de DB con los ya configurados
  const chatKeys = new Set();
  const chats = [];

  for (const row of chatsDB) {
    const nombreLegible = nombreParaChat(row.chat_id, row.chat_nombre, contactos);
    const key = nombreLegible.toLowerCase().trim();
    if (!key || chatKeys.has(key)) continue;
    chatKeys.add(key);
    const conf = gruposConfigurados.get(key);
    chats.push({
      chat_id: row.chat_id,
      chat_nombre: nombreLegible,
      cantidad: row.cantidad || 0,
      frecuencia: conf ? conf.frecuencia : 0,
    });
  }

  // Agregar chats configurados que no tienen mensajes recientes
  for (const [key, conf] of gruposConfigurados) {
    if (!chatKeys.has(key)) {
      chats.push({
        chat_id: null,
        chat_nombre: conf.nombre,
        cantidad: 0,
        frecuencia: conf.frecuencia,
      });
    }
  }

  const opcionesFrecuencia = [
    { valor: 0, label: 'Desactivado' },
    { valor: 1, label: 'Cada hora' },
    { valor: 8, label: 'Cada 8 horas' },
    { valor: 12, label: 'Dos veces al día' },
    { valor: 24, label: 'Diario' },
  ];

  function selectFrecuencia(chatNombre, frecuenciaActual) {
    const key = encodeURIComponent(chatNombre);
    const opts = opcionesFrecuencia.map((o) => {
      const sel = o.valor === frecuenciaActual ? ' selected' : '';
      return `<option value="${o.valor}"${sel}>${o.label}</option>`;
    }).join('');
    return `<select name="freq_${key}" style="padding:4px 8px;border-radius:4px;border:1px solid #ccc">${opts}</select>`;
  }

  const filas = chats.map((c) => {
    const esGrupo = c.chat_id ? c.chat_id.endsWith('@g.us') : true;
    const tipoTag = esGrupo ? '<span style="font-size:.75rem;background:#e8f4fd;color:#1a73e8;padding:2px 6px;border-radius:10px;margin-left:6px">Grupo</span>' : '<span style="font-size:.75rem;background:#f0fdf4;color:#16a34a;padding:2px 6px;border-radius:10px;margin-left:6px">Individual</span>';
    return `<tr>
      <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0">${c.chat_nombre}${tipoTag}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:center;color:#888">${c.cantidad}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0">${selectFrecuencia(c.chat_nombre, c.frecuencia)}</td>
    </tr>`;
  }).join('');

  const mensajeHtml = mensaje
    ? `<div style="background:#d4edda;border:1px solid #c3e6cb;color:#155724;padding:12px 16px;border-radius:6px;margin-bottom:20px">${mensaje}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Configurar chats monitoreados</title>
  <style>
    body { font-family: sans-serif; background: #f0f2f5; margin: 0; padding: 24px 16px; color: #111; }
    .card { background: #fff; border-radius: 12px; max-width: 700px; margin: 0 auto; padding: 32px 24px; box-shadow: 0 2px 12px rgba(0,0,0,.08); }
    h2 { margin: 0 0 8px; font-size: 1.4rem; }
    .subtitle { color: #888; font-size: .9rem; margin-bottom: 24px; }
    label { font-weight: 600; display: block; margin-bottom: 6px; }
    input[type=text] { width: 100%; box-sizing: border-box; padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; font-size: 1rem; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th { text-align: left; padding: 10px 12px; background: #f8f9fa; font-size: .85rem; color: #555; border-bottom: 2px solid #e0e0e0; }
    .btn { display: inline-block; padding: 10px 28px; background: #075e54; color: #fff; border: none; border-radius: 6px; font-size: 1rem; cursor: pointer; margin-top: 20px; }
    .btn:hover { background: #064c44; }
    .back { display: inline-block; margin-bottom: 20px; color: #075e54; text-decoration: none; font-size: .9rem; }
  </style>
</head>
<body>
  <div class="card">
    <a href="/" class="back">← Volver al inicio</a>
    <h2>⚙️ Configurar chats monitoreados</h2>
    <p class="subtitle">Elegí con qué frecuencia querés recibir resúmenes de cada chat.</p>
    ${mensajeHtml}
    <form method="POST" action="/configurar">
      <label for="nombre_dueno">Tu nombre (opcional — para personalizar los resúmenes)</label>
      <input type="text" id="nombre_dueno" name="nombre_dueno" value="${(configActual.nombre_dueno || '').replace(/"/g, '&quot;')}" placeholder="Ej: Martín">
      <label>Chats con mensajes recientes (últimos 30 días)</label>
      <table>
        <thead>
          <tr>
            <th>Chat</th>
            <th style="text-align:center">Mensajes</th>
            <th>Frecuencia</th>
          </tr>
        </thead>
        <tbody>
          ${filas || '<tr><td colspan="3" style="padding:20px;text-align:center;color:#888">No hay mensajes recientes en la base de datos.</td></tr>'}
        </tbody>
      </table>
      <button type="submit" class="btn">💾 Guardar configuración</button>
    </form>
  </div>
</body>
</html>`;
}

function iniciarServidor() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    if (req.url === '/test' && req.method === 'GET') {
      if (!botOperativo()) {
        res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>&#9888;&#65039; El bot no est&#225; conectado a&#250;n</h2><p>Primero escane&#225; el QR para vincular WhatsApp.</p><a href="/">&#8592; Volver</a></body></html>`);
        return;
      }
      try {
        await guardarMensaje({ chatId: 'test@c.us', chatNombre: 'Chat de prueba', remitente: 'Tester', remitenteId: 'test@c.us', cuerpo: 'Este es un mensaje de prueba URGENTE.', timestamp: Math.floor(Date.now() / 1000), esVip: false, tieneKeyword: true });
        await procesarMensajes();
        res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>&#9989; Prueba ejecutada</h2><p>Revis&#225; tu WhatsApp.</p><a href="/">&#8592; Volver</a></body></html>`);
      } catch (err) {
        res.end(`<p>Error en prueba: ${err.message}</p>`);
      }
      return;
    }

    if (req.url === '/procesar' && req.method === 'GET') {
      if (!botOperativo()) { res.end(`<p>El bot no est&#225; conectado.</p>`); return; }
      try {
        await procesarMensajes();
        res.end(`<p>An&#225;lisis ejecutado. Revis&#225; ntfy.</p><a href="/">Volver</a>`);
      } catch (err) {
        res.end(`<p>Error: ${err.message}</p>`);
      }
      return;
    }

    if (req.url?.startsWith('/resumen') && req.method === 'GET') {
      if (!botOperativo()) { res.end(`<p>El bot no est&#225; conectado.</p>`); return; }
      const params = new URL(req.url, `http://localhost`).searchParams;
      const horas = Number(params.get('h')) || 24;
      if (![24, 72, 168].includes(horas)) {
        res.end(`<p>Per&#237;odo inv&#225;lido. Us&#225; h=24, h=72 o h=168.</p>`);
        return;
      }
      resumenPeriodo(horas).catch((err) => console.error(`[Resumen ${horas}h]`, err.message));
      const label = horas === 24 ? '24 horas' : horas === 72 ? '72 horas' : '7 d&#237;as';
      res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Resumen ${label}</title></head><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0f2f5"><div style="background:#fff;border-radius:12px;max-width:420px;margin:0 auto;padding:40px 24px;box-shadow:0 2px 12px rgba(0,0,0,.08)"><div style="font-size:3rem;margin-bottom:16px">&#128203;</div><h2 style="margin:0 0 12px">Generando resumen de las &#250;ltimas ${label}...</h2><p style="color:#555">Analizando mensajes (le&#237;dos y no le&#237;dos) con Gemini.</p><p style="color:#888;font-size:.85rem;margin-top:16px">Recib&#237;s el resultado por WhatsApp en cuanto termine.</p><a href="/" style="display:inline-block;margin-top:24px;padding:10px 24px;background:#075e54;color:#fff;border-radius:6px;text-decoration:none">Volver al inicio</a></div></body></html>`);
      return;
    }

    if (req.url === '/limpiar-sesion' && req.method === 'GET') {
      try {
        await limpiarAuth();
        res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>Sesi&#243;n borrada</h2><p>Reinici&#225; el servicio en Render → al arrancar te va a pedir el QR de nuevo.</p><p style="color:#888;font-size:.85rem">Despu&#233;s de re-escanear, WhatsApp va a re-sincronizar el historial.</p></body></html>`);
      } catch (err) {
        res.end(`<p>Error: ${err.message}</p>`);
      }
      return;
    }

    if (req.url === '/historial' && req.method === 'GET') {
      if (!botOperativo()) { res.end(`<p>El bot no est&#225; conectado.</p>`); return; }
      try {
        const todos = await obtenerMensajesSinProcesar();
        const grupales = todos.filter((m) => m.chat_id?.endsWith('@g.us')).length;
        const individuales = todos.length - grupales;
        procesarMensajes().catch((err) => console.error('[Historial]', err.message));
        res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>Procesando historial</h2><p>${todos.length} mensajes pendientes (${grupales} grupales, ${individuales} individuales)</p><p style="color:#888;font-size:.85rem">Vas a recibir las notificaciones en ntfy.</p><a href="/">Volver</a></body></html>`);
      } catch (err) {
        res.end(`<p>Error: ${err.message}</p>`);
      }
      return;
    }

    // GET /reportes — historial de digests enviados (auditoría)
    if (req.url === '/reportes' && req.method === 'GET') {
      try {
        const reportes = await obtenerReportes(20);
        const items = reportes.length
          ? reportes.map((r) => {
              const fecha = new Date(r.creado_en * 1000).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
              const cuerpo = String(r.contenido).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
              return `<details style="background:#fff;border-radius:8px;margin:10px 0;padding:14px 18px;box-shadow:0 1px 6px rgba(0,0,0,.06)"><summary style="cursor:pointer;font-weight:600">${fecha} · <span style="color:#888;font-weight:400">${r.tipo || 'digest'} — ${r.n_mensajes} msgs, ${r.n_temas} temas</span></summary><pre style="white-space:pre-wrap;font-family:inherit;margin:12px 0 0;color:#333">${cuerpo}</pre></details>`;
            }).join('')
          : '<p style="color:#888">Todavía no hay reportes guardados.</p>';
        res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reportes</title></head><body style="font-family:sans-serif;background:#f0f2f5;margin:0;padding:24px 16px"><div style="max-width:700px;margin:0 auto"><a href="/" style="color:#075e54;text-decoration:none;font-size:.9rem">← Volver</a><h2>📜 Últimos reportes enviados</h2>${items}</div></body></html>`);
      } catch (err) {
        res.end(`<p>Error: ${err.message}</p>`);
      }
      return;
    }

    // GET /configurar — página de configuración de chats
    if (req.url === '/configurar' && req.method === 'GET') {
      try {
        const params = new URL(req.url, `http://localhost`).searchParams;
        const mensaje = params.get('ok') ? '✅ Configuración guardada correctamente.' : '';
        const [chatsDB, contactos] = await Promise.all([obtenerChatsDistintos(30), obtenerContactos()]);
        const html = generarPaginaConfiguracion(chatsDB, config, contactos, mensaje);
        res.end(html);
      } catch (err) {
        console.error(`[Config] Error generando página:`, err.message);
        res.end(`<p>Error: ${err.message}</p>`);
      }
      return;
    }

    // POST /configurar — guardar configuración
    if (req.url === '/configurar' && req.method === 'POST') {
      try {
        const params = await leerBody(req);
        const nombreDueno = (params.get('nombre_dueno') || '').trim();

        // Reconstruir array de grupos a partir de los campos freq_CHATKEY
        const nuevosGrupos = [];
        for (const [key, value] of params.entries()) {
          if (!key.startsWith('freq_')) continue;
          const frecuencia = parseInt(value, 10);
          if (isNaN(frecuencia) || frecuencia <= 0) continue; // Desactivado o inválido
          const chatNombre = decodeURIComponent(key.slice(5)); // quitar prefijo "freq_"
          nuevosGrupos.push({ nombre: chatNombre, frecuencia_horas: frecuencia });
        }

        // Leer config actual y actualizarla
        const configPath = path.join(__dirname, 'config.json');
        const configActual = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        configActual.nombre_dueno = nombreDueno;
        configActual.grupos = nuevosGrupos;

        fs.writeFileSync(configPath, JSON.stringify(configActual, null, 2), 'utf8');
        recargarConfig();

        console.log(`[Config] Guardada — nombre_dueno="${nombreDueno}", ${nuevosGrupos.length} grupos`);

        res.setHeader('Location', '/configurar?ok=1');
        res.writeHead(302);
        res.end();
      } catch (err) {
        console.error(`[Config] Error guardando:`, err.message);
        res.end(`<p>Error guardando configuraci&#243;n: ${err.message}</p>`);
      }
      return;
    }

    if (botOperativo()) {
      const encabezado = estadoWA === 'standby'
        ? `<h2>&#128277; Modo ahorro de notificaciones</h2><p>El bot est&#225; vinculado pero <strong>desconectado a prop&#243;sito</strong> para que las notificaciones lleguen siempre a tu tel&#233;fono.<br>Se conecta solo autom&#225;ticamente en los horarios del resumen o cuando ped&#237;s uno manual.</p>`
        : `<h2>&#9989; WhatsApp conectado</h2><p>El bot est&#225; activo y escuchando mensajes.</p>`;
      res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px">${encabezado}<h3 style="margin-top:32px;color:#555">Res&#250;menes por per&#237;odo</h3><p style="color:#888;font-size:.85rem;margin:0 0 12px">Analiza todos los mensajes (le&#237;dos y no le&#237;dos) del per&#237;odo elegido</p><p><a href="/resumen?h=24" style="display:inline-block;margin:6px;padding:10px 24px;background:#27ae60;color:#fff;border-radius:6px;text-decoration:none;font-size:.95rem">&#128203; &#218;ltimas 24 horas</a></p><p><a href="/resumen?h=72" style="display:inline-block;margin:6px;padding:10px 24px;background:#16a085;color:#fff;border-radius:6px;text-decoration:none;font-size:.95rem">&#128203; &#218;ltimas 72 horas</a></p><p><a href="/resumen?h=168" style="display:inline-block;margin:6px;padding:10px 24px;background:#117a65;color:#fff;border-radius:6px;text-decoration:none;font-size:.95rem">&#128203; &#218;ltima semana</a></p><h3 style="margin-top:32px;color:#555">Configuraci&#243;n</h3><p><a href="/configurar" style="display:inline-block;margin:6px;padding:10px 24px;background:#6c3483;color:#fff;border-radius:6px;text-decoration:none;font-size:.95rem">&#9881;&#65039; Configurar chats</a></p><p><a href="/reportes" style="display:inline-block;margin:6px;padding:10px 24px;background:#34495e;color:#fff;border-radius:6px;text-decoration:none;font-size:.95rem">&#128220; Ver reportes enviados</a></p><h3 style="margin-top:32px;color:#555">Mantenimiento</h3><p><a href="/test" style="display:inline-block;margin:6px;padding:10px 24px;background:#075e54;color:#fff;border-radius:6px;text-decoration:none;font-size:.95rem">Enviar mensaje de prueba</a></p><p><a href="/procesar" style="display:inline-block;margin:6px;padding:10px 24px;background:#1d6fa4;color:#fff;border-radius:6px;text-decoration:none;font-size:.95rem">Procesar mensajes nuevos (cron manual)</a></p><p><a href="/historial" style="display:inline-block;margin:6px;padding:10px 24px;background:#7d3c98;color:#fff;border-radius:6px;text-decoration:none;font-size:.95rem">Revisar historial completo</a></p><p style="margin-top:24px"><a href="/limpiar-sesion" style="display:inline-block;margin:6px;padding:8px 20px;background:#c0392b;color:#fff;border-radius:6px;text-decoration:none;font-size:.85rem" onclick="return confirm('Borrar sesi&#243;n?')">Limpiar sesi&#243;n y re-sincronizar</a></p></body></html>`);
      return;
    }

    if (estadoWA === 'autenticando') {
      const segs = tsAutenticando ? Math.round((Date.now() - tsAutenticando) / 1000) : 0;
      res.end(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="3"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conectando...</title></head><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0f2f5"><div style="background:#fff;border-radius:12px;max-width:400px;margin:0 auto;padding:40px 24px;box-shadow:0 2px 12px rgba(0,0,0,.08)"><div style="font-size:3rem;margin-bottom:16px">&#128260;</div><h2 style="margin:0 0 12px">Conectando con WhatsApp...</h2><p style="color:#555;margin:0 0 8px">Estableciendo conexi&#243;n con los servidores de WhatsApp.</p><p style="color:#888;font-size:.85rem">Tiempo esperando: ${segs}s &#8212; esta p&#225;gina se actualiza sola cada 3 segundos.</p>${segs > 30 ? '<p style="color:#c0392b;font-size:.85rem;margin-top:16px">&#9888;&#65039; Est&#225; tardando m&#225;s de lo normal. Revis&#225; los logs en Render.</p>' : ''}</div></body></html>`);
      return;
    }

    if (estadoWA === 'qr' && qrActual) {
      try {
        const imgDataUrl = await QRCode.toDataURL(qrActual, { width: 280, margin: 2 });
        res.end(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="30"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vincular WhatsApp</title><style>body{font-family:sans-serif;background:#f0f2f5;margin:0;padding:32px 16px;color:#111}.card{background:#fff;border-radius:12px;max-width:480px;margin:0 auto;padding:32px 24px;box-shadow:0 2px 12px rgba(0,0,0,.08);text-align:center}h2{margin:0 0 8px;font-size:1.3rem}.warning{background:#fff3cd;border-left:4px solid #f0a500;border-radius:4px;padding:12px 16px;margin:20px 0;text-align:left;font-size:.9rem}.steps{text-align:left;background:#f0f2f5;border-radius:8px;padding:16px 16px 16px 32px;margin:20px 0;font-size:.92rem;line-height:1.8}.steps li{margin-bottom:4px}.steps strong{color:#075e54}.qr-img{border:3px solid #075e54;border-radius:8px;padding:8px;margin:20px auto;display:block}.refresh-note{color:#888;font-size:.8rem;margin-top:16px}.platform{margin-top:16px}.platform summary{cursor:pointer;font-size:.85rem;color:#555}.platform ol{margin:8px 0 0;font-size:.85rem;line-height:1.7;padding-left:20px}</style></head><body><div class="card"><h2>&#128241; Vincular WhatsApp al bot</h2><div class="warning">&#9888;&#65039; <strong>No uses la c&#225;mara del tel&#233;fono ni Google Lens</strong> para escanear este QR &#8212; eso no funciona con WhatsApp.<br>Deb&#233;s escanearlo desde <strong>adentro de la app de WhatsApp</strong>.</div><img src="${imgDataUrl}" class="qr-img" width="280" height="280" alt="QR WhatsApp"/><div class="steps"><strong>Android:</strong><ol><li>Abr&#237; <strong>WhatsApp</strong></li><li>Toc&#225; los <strong>tres puntos &#8942;</strong> (arriba a la derecha)</li><li>Toc&#225; <strong>Dispositivos vinculados</strong></li><li>Toc&#225; <strong>Vincular dispositivo</strong></li><li>Apunt&#225; la c&#225;mara <em>de WhatsApp</em> al QR de arriba</li></ol></div><details class="platform"><summary>&#191;Us&#225;s iPhone? Ver pasos para iOS</summary><ol><li>Abr&#237; <strong>WhatsApp</strong></li><li>Toc&#225; <strong>Configuraci&#243;n</strong> (abajo a la derecha)</li><li>Toc&#225; <strong>Dispositivos vinculados</strong></li><li>Toc&#225; <strong>Vincular dispositivo</strong></li><li>Apunt&#225; la c&#225;mara <em>de WhatsApp</em> al QR de arriba</li></ol></details><p class="refresh-note">Esta p&#225;gina se actualiza sola cada 30 segundos. El QR expira en ~60 seg.</p></div></body></html>`);
      } catch (err) {
        res.end(`<p>Error generando QR: ${err.message}</p>`);
      }
      return;
    }

    if (estadoWA === 'error_db') {
      res.end(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="10"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0f2f5"><div style="background:#fff;border-radius:12px;max-width:400px;margin:0 auto;padding:40px 24px;box-shadow:0 2px 12px rgba(0,0,0,.08)"><div style="font-size:3rem;margin-bottom:16px">&#10060;</div><h2 style="margin:0 0 12px;color:#c0392b">Error de base de datos</h2><p style="color:#555">No se pudo conectar a Turso. Revis&#225; las variables TURSO_URL y TURSO_TOKEN en Render.</p><p style="color:#888;font-size:.85rem">Esta p&#225;gina se actualiza cada 10 segundos.</p></div></body></html>`);
      return;
    }

    if (estadoWA === 'error_wa') {
      res.end(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="10"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0f2f5"><div style="background:#fff;border-radius:12px;max-width:400px;margin:0 auto;padding:40px 24px;box-shadow:0 2px 12px rgba(0,0,0,.08)"><div style="font-size:3rem;margin-bottom:16px">&#10060;</div><h2 style="margin:0 0 12px;color:#c0392b">Error de WhatsApp</h2><p style="color:#555">No se pudo inicializar el cliente de WhatsApp. Revis&#225; los logs en Render para m&#225;s detalles.</p><p style="color:#888;font-size:.85rem">Esta p&#225;gina se actualiza cada 10 segundos.</p></div></body></html>`);
      return;
    }

    res.end(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="2"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0f2f5"><div style="background:#fff;border-radius:12px;max-width:400px;margin:0 auto;padding:40px 24px;box-shadow:0 2px 12px rgba(0,0,0,.08)"><div style="font-size:3rem;margin-bottom:16px">&#9203;</div><h2 style="margin:0 0 12px">Arrancando bot...</h2><p style="color:#888;font-size:.85rem">Esta p&#225;gina se actualiza sola cada 2 segundos.</p></div></body></html>`);
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
async function analizarLote(todos, etiqueta) {
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
  for (const [chatId, mensajesChat] of porChat) {
    const chatNombre = mensajesChat[0].chat_nombre || chatId;
    console.log(`[Análisis${etiqueta ? ' ' + etiqueta : ''}] "${chatNombre}" (${mensajesChat.length} mensajes)`);
    try {
      const { temas, idsProcesados: ids } = await analizarChat(chatNombre, mensajesChat);
      idsProcesados.push(...ids);
      if (temas.length) resumenesChats.push({ chatNombre, temas });
    } catch (err) {
      console.error(`[Análisis] Error analizando "${chatNombre}":`, err.message);
    }
  }

  // Individuales
  let resIndiv = { eventos: [], compromisos: [], pedidos: [] };
  if (individuales.length) {
    try {
      const r = await analizarIndividuales(individuales, contactos);
      resIndiv = r;
      idsProcesados.push(...(r.idsProcesados || []));
    } catch (err) {
      console.error(`[Análisis] Error analizando individuales:`, err.message);
    }
  }

  // Titular del día: una frase de Gemini con lo más importante de los pendientes
  const accionables = extraerAccionables(resumenesChats, resIndiv, contactos);
  let titular = '';
  const itemsTitular = [
    ...accionables.pendientes.map((p) => `${p.texto} (${p.origen}${p.fecha ? `, fecha ${p.fecha.iso}` : ''})`),
    ...accionables.agenda.map((e) => `${e.texto} (${e.origen}, ${e.fechaRaw || 'sin fecha'})`),
  ];
  if (itemsTitular.length) {
    titular = await generarTitular(itemsTitular);
  }

  const meta = { etiqueta, totalMensajes: todos.length, titular };
  const texto = formatearDigest(accionables, resumenesChats, meta);
  const totalTemas = resumenesChats.reduce((a, r) => a + r.temas.length, 0)
    + (resIndiv.eventos?.length || 0) + (resIndiv.compromisos?.length || 0) + (resIndiv.pedidos?.length || 0);

  return { texto, idsProcesados, totalTemas, meta };
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
        try { await enviarTextoLibre(`📋 *Resumen últimas ${labelHoras}*\n\nNo hay mensajes en este período.`); } catch (err) { console.error(`[Resumen ${labelHoras}] Error enviando WA:`, err.message); }
        return;
      }

      const { texto, totalTemas } = await analizarLote(todos, `últimas ${labelHoras}`);
      try {
        await enviarTextoLibre(texto);
        console.log(`[Resumen ${labelHoras}] Enviado — ${totalTemas} temas`);
        postNtfy(`Resumen ${labelHoras}`, texto.replace(/\*/g, '').replace(/_/g, ''));
        await guardarReporte(`periodo_${horas}h`, texto, todos.length, totalTemas);
      } catch (err) {
        console.error(`[Resumen ${labelHoras}] Error enviando WA:`, err.message);
      }
    });
  } catch (err) {
    console.error(`[Resumen ${labelHoras}] Error general:`, err.message);
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
      const todos = await obtenerMensajesSinProcesar();
      if (!todos.length) {
        // Mensaje corto igual: el dueño sabe que el bot está vivo y no se perdió nada
        console.log(`[Digest] Sin mensajes pendientes — enviando "todo tranquilo"`);
        const txt = `✅ *Todo tranquilo* — no hubo mensajes nuevos desde el último resumen.`;
        try {
          const ok = await enviarTextoLibre(txt);
          if (ok) await guardarReporte('digest', txt, 0, 0);
        } catch (err) {
          console.error(`[Digest] No se pudo enviar (WA no conectado):`, err.message);
        }
        return;
      }

      let { texto, idsProcesados, totalTemas } = await analizarLote(todos, etiqueta);

      // Hubo mensajes pero nada relevante: mensaje corto en vez del esqueleto del digest
      if (totalTemas === 0) {
        texto = `✅ *Todo tranquilo* — revisé ${todos.length} mensajes y no hay nada pendiente para vos. Solo charla.`;
      }

      let enviado = false;
      try {
        enviado = await enviarTextoLibre(texto);
      } catch (err) {
        console.error(`[Digest] No se pudo enviar (WA no conectado):`, err.message);
      }
      postNtfy(`Resumen ${etiqueta || ''}`.trim(), texto.replace(/\*/g, '').replace(/_/g, ''));
      await guardarReporte('digest', texto, todos.length, totalTemas);

      // Solo marcamos procesados si el envío salió bien; si falló, los mensajes
      // quedan pendientes y el contenido se reintenta en el próximo digest (no se pierde).
      if (enviado) {
        await marcarProcesados(idsProcesados);
        const fallidos = todos.length - idsProcesados.length;
        console.log(`[Digest] Enviado — ${totalTemas} temas, ${idsProcesados.length} mensajes procesados${fallidos > 0 ? `, ${fallidos} pendientes para el próximo digest` : ''}`);
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
  try {
    await conectar();
  } catch (err) {
    console.error(`[Bot] No se pudo conectar a Turso:`, err.message);
    estadoWA = 'error_db';
    return;
  }
  try {
    await iniciarCliente({
      onQR: (qr) => { estadoWA = 'qr'; qrActual = qr; tsAutenticando = null; console.log(`[WA] QR listo — abrí https://botwp-ikbb.onrender.com para escanearlo`); },
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
