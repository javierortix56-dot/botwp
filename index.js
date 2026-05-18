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
  obtenerMensajesChatSinProcesar,
  obtenerUltimoProcesado,
  actualizarUltimoProcesado,
} = require('./db');
const { iniciarCliente, enviarResumen, enviarTextoLibre } = require('./whatsapp');
const { analizarMensajes, analizarChat, analizarIndividuales } = require('./gemini');
const { obtenerFrecuenciaGrupo, obtenerConfigGrupo } = require('./filtros');

let config = require('./config.json');

const https = require('https');

const PORT = process.env.PORT || 3000;

function recargarConfig() {
  try {
    delete require.cache[require.resolve('./config.json')];
    config = require('./config.json');
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

function notificarNtfy(temas) {
  if (!temas.length) return;
  const resumen = temas.map((t) => `- ${t.tema}: ${t.resumen}`).join('\n');
  postNtfy(`Resumen grupos - ${temas.length} tema${temas.length > 1 ? 's' : ''}`, resumen);
}

function formatearResumenIndividuales(eventos, compromisos, pedidos) {
  const hora = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  const lineas = [`\u{1F4F1} *Resumen diario ${hora}*\n`];
  if (eventos.length) {
    lineas.push('\u{1F4C5} *EVENTOS*');
    eventos.forEach((e) => {
      lineas.push(`• ${e.fecha} — ${e.titulo} (${e.chat})`);
      if (e.detalle) lineas.push(`  ${e.detalle}`);
    });
  }
  if (pedidos.length) {
    if (lineas.length > 1) lineas.push('');
    lineas.push('\u{1F4EC} *TE PIDEN*');
    pedidos.forEach((p) => {
      lineas.push(`• *${p.de}*: ${p.pedido}`);
      if (p.contexto) lineas.push(`  ${p.contexto}`);
    });
  }
  if (compromisos.length) {
    if (lineas.length > 1) lineas.push('');
    lineas.push('✅ *TUS PENDIENTES*');
    compromisos.forEach((c) => {
      lineas.push(`• *${c.tema}* (${c.chat})`);
      lineas.push(`  ${c.resumen}`);
    });
  }
  return lineas.join('\n');
}

function notificarCalendario(eventos, compromisos, pedidos) {
  if (!eventos.length && !compromisos.length && !pedidos.length) return;
  const lineas = [];
  if (eventos.length) {
    lineas.push('EVENTOS:');
    eventos.forEach((e) => {
      lineas.push(`- ${e.fecha} | ${e.titulo} (${e.chat})`);
      if (e.detalle) lineas.push(`  ${e.detalle}`);
    });
  }
  if (pedidos.length) {
    if (lineas.length) lineas.push('');
    lineas.push('TE PIDEN:');
    pedidos.forEach((p) => {
      lineas.push(`- ${p.de}: ${p.pedido} (${p.chat})`);
      if (p.contexto) lineas.push(`  ${p.contexto}`);
    });
  }
  if (compromisos.length) {
    if (lineas.length) lineas.push('');
    lineas.push('TUS PENDIENTES:');
    compromisos.forEach((c) => {
      lineas.push(`- ${c.tema} (${c.chat})`);
      lineas.push(`  ${c.resumen}`);
    });
  }
  const total = eventos.length + compromisos.length + pedidos.length;
  postNtfy(`Resumen diario - ${total} items`, lineas.join('\n'));
}

/**
 * Formatea el resumen de un chat con sus temas para enviar por WA.
 * Ordena: primero me_piden:true, luego por tipo (accion → pago → evento → info).
 */
function formatearResumenChat(chatNombre, temas) {
  if (!temas.length) return '';

  const ORDEN_TIPO = { accion: 0, pago: 1, evento: 2, info: 3 };
  const EMOJI_TIPO = { accion: '🔴', pago: '💰', evento: '📅', info: 'ℹ️' };

  // Separar los que me piden directamente
  const mePiden = temas.filter((t) => t.me_piden);
  const resto = temas.filter((t) => !t.me_piden);

  // Ordenar el resto por tipo
  resto.sort((a, b) => (ORDEN_TIPO[a.tipo] ?? 3) - (ORDEN_TIPO[b.tipo] ?? 3));

  // Ordenados: primero me_piden, luego resto
  const ordenados = [...mePiden, ...resto];

  const lineas = [`📋 *${chatNombre}*\n`];

  // Sección especial "Te piden directamente" al inicio si hay me_piden
  if (mePiden.length) {
    lineas.push('📬 *Te piden directamente:*');
    mePiden.forEach((t) => {
      lineas.push(`  • ${t.de}: ${t.accion || t.resumen}`);
    });
    lineas.push('');
  }

  // Todos los temas ordenados con su emoji y detalle
  ordenados.forEach((t) => {
    const emoji = EMOJI_TIPO[t.tipo] || '•';
    lineas.push(`${emoji} *De: ${t.de}* — ${t.tema}`);
    lineas.push(`  ${t.resumen}`);
    if (t.accion) lineas.push(`  _→ ${t.accion}_`);
  });

  return lineas.join('\n').trim();
}

let estadoWA = 'arrancando';
let qrActual = null;
let tsAutenticando = null;

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
      if (estadoWA !== 'conectado') {
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
      if (estadoWA !== 'conectado') { res.end(`<p>El bot no est&#225; conectado.</p>`); return; }
      try {
        await procesarMensajes();
        res.end(`<p>An&#225;lisis ejecutado. Revis&#225; ntfy.</p><a href="/">Volver</a>`);
      } catch (err) {
        res.end(`<p>Error: ${err.message}</p>`);
      }
      return;
    }

    if (req.url?.startsWith('/resumen') && req.method === 'GET') {
      if (estadoWA !== 'conectado') { res.end(`<p>El bot no est&#225; conectado.</p>`); return; }
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
      if (estadoWA !== 'conectado') { res.end(`<p>El bot no est&#225; conectado.</p>`); return; }
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

    if (estadoWA === 'conectado') {
      res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>&#9989; WhatsApp conectado</h2><p>El bot est&#225; activo y escuchando mensajes.</p><h3 style="margin-top:32px;color:#555">Res&#250;menes por per&#237;odo</h3><p style="color:#888;font-size:.85rem;margin:0 0 12px">Analiza todos los mensajes (le&#237;dos y no le&#237;dos) del per&#237;odo elegido</p><p><a href="/resumen?h=24" style="display:inline-block;margin:6px;padding:10px 24px;background:#27ae60;color:#fff;border-radius:6px;text-decoration:none;font-size:.95rem">&#128203; &#218;ltimas 24 horas</a></p><p><a href="/resumen?h=72" style="display:inline-block;margin:6px;padding:10px 24px;background:#16a085;color:#fff;border-radius:6px;text-decoration:none;font-size:.95rem">&#128203; &#218;ltimas 72 horas</a></p><p><a href="/resumen?h=168" style="display:inline-block;margin:6px;padding:10px 24px;background:#117a65;color:#fff;border-radius:6px;text-decoration:none;font-size:.95rem">&#128203; &#218;ltima semana</a></p><h3 style="margin-top:32px;color:#555">Configuraci&#243;n</h3><p><a href="/configurar" style="display:inline-block;margin:6px;padding:10px 24px;background:#6c3483;color:#fff;border-radius:6px;text-decoration:none;font-size:.95rem">&#9881;&#65039; Configurar chats</a></p><h3 style="margin-top:32px;color:#555">Mantenimiento</h3><p><a href="/test" style="display:inline-block;margin:6px;padding:10px 24px;background:#075e54;color:#fff;border-radius:6px;text-decoration:none;font-size:.95rem">Enviar mensaje de prueba</a></p><p><a href="/procesar" style="display:inline-block;margin:6px;padding:10px 24px;background:#1d6fa4;color:#fff;border-radius:6px;text-decoration:none;font-size:.95rem">Procesar mensajes nuevos (cron manual)</a></p><p><a href="/historial" style="display:inline-block;margin:6px;padding:10px 24px;background:#7d3c98;color:#fff;border-radius:6px;text-decoration:none;font-size:.95rem">Revisar historial completo</a></p><p style="margin-top:24px"><a href="/limpiar-sesion" style="display:inline-block;margin:6px;padding:8px 20px;background:#c0392b;color:#fff;border-radius:6px;text-decoration:none;font-size:.85rem" onclick="return confirm('Borrar sesi&#243;n?')">Limpiar sesi&#243;n y re-sincronizar</a></p></body></html>`);
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

async function resumenPeriodo(horas) {
  const labelHoras = horas === 168 ? '7 días' : `${horas}h`;
  console.log(`\n[Resumen ${labelHoras}] Iniciando...`);
  const desde = Math.floor(Date.now() / 1000) - horas * 3600;
  const todos = await obtenerMensajesDesde(desde);
  if (!todos.length) {
    console.log(`[Resumen ${labelHoras}] Sin mensajes en el período`);
    try { await enviarTextoLibre(`📋 *Resumen últimas ${labelHoras}*\n\nNo hay mensajes en este período.`); } catch (err) { console.error(`[Resumen ${labelHoras}] Error enviando WA:`, err.message); }
    return;
  }
  const grupales = todos.filter((m) => m.chat_id?.endsWith('@g.us'));
  const individuales = todos.filter((m) => !m.chat_id?.endsWith('@g.us'));
  console.log(`[Resumen ${labelHoras}] ${todos.length} mensajes — ${grupales.length} grupales, ${individuales.length} individuales`);

  // Agrupar mensajes grupales por chat_id y analizar cada chat por separado
  const porChat = new Map();
  for (const m of grupales) {
    const chatId = m.chat_id;
    if (!porChat.has(chatId)) porChat.set(chatId, []);
    porChat.get(chatId).push(m);
  }

  const resumenesChats = []; // { chatNombre, temas }
  for (const [chatId, mensajesChat] of porChat) {
    const chatNombre = mensajesChat[0].chat_nombre || chatId;
    console.log(`[Resumen ${labelHoras}] Analizando "${chatNombre}" (${mensajesChat.length} mensajes)`);
    try {
      const { temas } = await analizarChat(chatNombre, mensajesChat);
      if (temas.length) {
        resumenesChats.push({ chatNombre, temas });
      }
    } catch (err) {
      console.error(`[Resumen ${labelHoras}] Error analizando "${chatNombre}":`, err.message);
    }
  }

  // Analizar individuales
  let resIndiv = { eventos: [], compromisos: [], pedidos: [] };
  if (individuales.length) {
    try {
      resIndiv = await analizarIndividuales(individuales);
    } catch (err) {
      console.error(`[Resumen ${labelHoras}] Error analizando individuales:`, err.message);
    }
  }

  // Enviar un mensaje por chat grupal (si tiene temas)
  const header = `📋 *Resumen últimas ${labelHoras}*\n_${todos.length} mensajes — ${grupales.length} grupales, ${individuales.length} individuales_\n`;
  try { await enviarTextoLibre(header); } catch (err) { console.error(`[Resumen ${labelHoras}] Error enviando header:`, err.message); }

  for (const { chatNombre, temas } of resumenesChats) {
    const texto = formatearResumenChat(chatNombre, temas);
    if (texto) {
      try { await enviarTextoLibre(texto); } catch (err) { console.error(`[Resumen ${labelHoras}] Error enviando resumen de "${chatNombre}":`, err.message); }
    }
  }

  // Enviar resumen de individuales si hay algo
  if (resIndiv.eventos.length || resIndiv.compromisos.length || resIndiv.pedidos.length) {
    const textoIndiv = formatearResumenIndividuales(resIndiv.eventos, resIndiv.compromisos, resIndiv.pedidos);
    try { await enviarTextoLibre(textoIndiv); } catch (err) { console.error(`[Resumen ${labelHoras}] Error enviando individuales:`, err.message); }
  }

  if (!resumenesChats.length && !resIndiv.eventos.length && !resIndiv.compromisos.length && !resIndiv.pedidos.length) {
    try { await enviarTextoLibre('_Sin temas relevantes en este período._'); } catch (err) { console.error(`[Resumen ${labelHoras}] Error enviando sin-temas:`, err.message); }
  }

  const totalTemas = resumenesChats.reduce((acc, r) => acc + r.temas.length, 0);
  console.log(`[Resumen ${labelHoras}] Enviado — ${resumenesChats.length} chats con temas, ${totalTemas} temas totales`);
  postNtfy(`Resumen ${labelHoras}`, `${resumenesChats.length} chats con temas, ${totalTemas} temas`);
}

/**
 * Cron grupos: corre cada 30 minutos.
 * Para cada chat grupal sin procesar, verifica si corresponde procesarlo según su frecuencia_horas.
 */
async function procesarMensajesGrupos() {
  const hora = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  console.log(`\n[Cron grupos] Iniciando — ${hora}`);
  try {
    const todos = await obtenerMensajesSinProcesar();
    const grupales = todos.filter((m) => m.chat_id?.endsWith('@g.us'));
    console.log(`[Cron grupos] ${grupales.length} mensajes grupales sin procesar`);
    if (!grupales.length) { console.log(`[Cron grupos] Nada que analizar`); return; }

    // Agrupar por chat_id
    const porChat = new Map();
    for (const m of grupales) {
      const chatId = m.chat_id;
      if (!porChat.has(chatId)) porChat.set(chatId, []);
      porChat.get(chatId).push(m);
    }

    const ahora = Math.floor(Date.now() / 1000);

    for (const [chatId, mensajesChat] of porChat) {
      const chatNombre = mensajesChat[0].chat_nombre || chatId;
      const frecuencia = obtenerFrecuenciaGrupo(chatNombre);

      if (frecuencia === null) {
        console.log(`[Cron grupos] "${chatNombre}" — no configurado, skip`);
        continue;
      }

      const chatNombreKey = chatNombre.toLowerCase().trim();
      const ultimoProcesado = await obtenerUltimoProcesado(chatNombreKey);
      const segundosTranscurridos = ahora - ultimoProcesado;
      const segundosFrecuencia = frecuencia * 3600;

      if (segundosTranscurridos < segundosFrecuencia) {
        const minutosRestantes = Math.round((segundosFrecuencia - segundosTranscurridos) / 60);
        console.log(`[Cron grupos] "${chatNombre}" — faltan ${minutosRestantes} min para próximo proceso, skip`);
        continue;
      }

      console.log(`[Cron grupos] Procesando "${chatNombre}" (${mensajesChat.length} mensajes, frecuencia ${frecuencia}h)`);
      try {
        const { temas, idsProcesados } = await analizarChat(chatNombre, mensajesChat);

        if (temas.length) {
          const texto = formatearResumenChat(chatNombre, temas);
          try { await enviarTextoLibre(texto); } catch (err) { console.error(`[Cron grupos] Error enviando WA para "${chatNombre}":`, err.message); }
          notificarNtfy(temas);
        } else {
          console.log(`[Cron grupos] "${chatNombre}" — sin temas relevantes`);
        }

        await marcarProcesados(idsProcesados);
        await actualizarUltimoProcesado(chatNombreKey);

        console.log(`[Cron grupos] "${chatNombre}" OK — ${temas.length} temas, ${idsProcesados.length} mensajes procesados`);
      } catch (err) {
        console.error(`[Cron grupos] Error procesando "${chatNombre}":`, err.message);
      }
    }

    console.log(`[Cron grupos] Ciclo completo`);
  } catch (err) {
    console.error(`[Cron grupos] Error general:`, err.message);
  }
}

async function procesarMensajesIndividuales() {
  const hora = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  console.log(`\n[Cron individuales] Iniciando — ${hora}`);
  try {
    const todos = await obtenerMensajesSinProcesar();
    const individuales = todos.filter((m) => !m.chat_id?.endsWith('@g.us'));
    console.log(`[Cron individuales] ${individuales.length} mensajes individuales sin procesar`);
    if (!individuales.length) { console.log(`[Cron individuales] Nada que analizar`); return; }
    const { eventos, compromisos, pedidos, idsProcesados } = await analizarIndividuales(individuales);
    notificarCalendario(eventos, compromisos, pedidos);
    if (eventos.length || compromisos.length || pedidos.length) {
      const texto = formatearResumenIndividuales(eventos, compromisos, pedidos);
      try { await enviarTextoLibre(texto); } catch (err) { console.error(`[Cron individuales] Error enviando a WA:`, err.message); }
    }
    await marcarProcesados(idsProcesados);
    const fallidos = individuales.length - idsProcesados.length;
    console.log(`[Cron individuales] Completo — ${eventos.length} eventos, ${compromisos.length} compromisos, ${pedidos.length} pedidos, ${idsProcesados.length} mensajes procesados${fallidos > 0 ? `, ${fallidos} quedaron pendientes para el próximo ciclo` : ''}`);
  } catch (err) {
    console.error(`[Cron individuales] Error:`, err.message);
  }
}

async function procesarMensajes() {
  await procesarMensajesGrupos();
  await procesarMensajesIndividuales();
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
      onListo: () => { const segs = tsAutenticando ? Math.round((Date.now() - tsAutenticando) / 1000) : '?'; estadoWA = 'conectado'; qrActual = null; console.log(`[WA] ¡Listo! Conectado en ${segs}s`); },
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

  // Cron grupos: cada 30 minutos — verifica por frecuencia de cada chat
  cron.schedule('0,30 * * * *', procesarMensajesGrupos, { timezone: 'America/Argentina/Buenos_Aires' });

  // Cron individuales: según config o default 22:00
  const cronIndividuales = config.resumen?.hora_cron_individuales || '0 22 * * *';
  cron.schedule(cronIndividuales, procesarMensajesIndividuales, { timezone: 'America/Argentina/Buenos_Aires' });

  console.log(`[Bot] Crones activos — grupos "0,30 * * * *" (cada 30 min), individuales "${cronIndividuales}"`);
}

main();
