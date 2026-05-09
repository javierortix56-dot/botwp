global.crypto = require('crypto').webcrypto;

require('dotenv').config();

const REQUIRED_ENV = ['GEMINI_API_KEY', 'TURSO_URL', 'TURSO_TOKEN', 'MY_WHATSAPP_ID', 'NTFY_TOPIC'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`[Bot] Faltan variables de entorno: ${missing.join(', ')}`);
  process.exit(1);
}

const http = require('http');
const cron = require('node-cron');
const QRCode = require('qrcode');
const { conectar, obtenerMensajesSinProcesar, marcarProcesados, guardarMensaje, limpiarAuth } = require('./db');
const { iniciarCliente, enviarResumen, enviarTextoLibre } = require('./whatsapp');
const { analizarMensajes, analizarIndividuales, analizarPrecios, analizarProductoDetallado } = require('./gemini');
const { buscarTodos, buscarProductoDetallado, buscarDesdeUrls } = require('./precios');
const config = require('./config.json');

const https = require('https');

const PORT = process.env.PORT || 3000;

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

let estadoWA = 'arrancando';
let qrActual = null;
let tsAutenticando = null;

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

    if (req.url?.startsWith('/buscar') && req.method === 'GET') {
      if (estadoWA !== 'conectado') { res.end(`<p>El bot no est&#225; conectado.</p>`); return; }
      const params = new URL(req.url, `http://localhost`).searchParams;
      const query = params.get('q')?.trim();
      if (!query) {
        res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0f2f5"><div style="background:#fff;border-radius:12px;max-width:480px;margin:0 auto;padding:32px 24px;box-shadow:0 2px 12px rgba(0,0,0,.08)"><h2>&#128269; Buscar producto</h2><form method="get" action="/buscar" style="margin-top:20px"><input name="q" placeholder="nombre del producto o URL de Jumbo" style="width:100%;box-sizing:border-box;padding:12px;border:1px solid #ddd;border-radius:6px;font-size:1rem;margin-bottom:12px"><button type="submit" style="width:100%;padding:12px;background:#e67e22;color:#fff;border:none;border-radius:6px;font-size:1rem;cursor:pointer">Buscar en Carrefour, Jumbo y Coto</button></form><p style="color:#888;font-size:.8rem;margin-top:16px">Pod&#233;s pegar el nombre del producto o una URL de jumbo.com.ar</p><a href="/" style="font-size:.85rem;color:#555">&#8592; Volver</a></div></body></html>`);
        return;
      }
      (async () => {
        try {
          const resultados = await buscarProductoDetallado(query);
          const analisis = formatearBusqueda(resultados);
          postNtfy('Busqueda producto', analisis.replace(/\*/g, '').replace(/_/g, ''));
          await enviarTextoLibre(analisis);
        } catch (err) {
          console.error('[Buscar]', err.message);
        }
      })();
      res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0f2f5"><div style="background:#fff;border-radius:12px;max-width:420px;margin:0 auto;padding:40px 24px;box-shadow:0 2px 12px rgba(0,0,0,.08)"><div style="font-size:3rem;margin-bottom:16px">&#128269;</div><h2 style="margin:0 0 12px">Buscando &quot;${query}&quot;...</h2><p style="color:#555">Comparando en Carrefour, Jumbo y Coto incluyendo todas las presentaciones.</p><p style="color:#888;font-size:.85rem;margin-top:16px">En ~30 segundos recibi&#769;s el resultado en WhatsApp y ntfy.</p><a href="/buscar" style="display:inline-block;margin-top:24px;padding:10px 24px;background:#e67e22;color:#fff;border-radius:6px;text-decoration:none">Nueva b&#250;squeda</a></div></body></html>`);
      return;
    }

    if (req.url === '/precios' && req.method === 'GET') {
      if (estadoWA !== 'conectado') { res.end(`<p>El bot no est&#225; conectado.</p>`); return; }
      buscarYCompararPrecios().catch((err) => console.error('[Precios]', err.message));
      res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Buscando precios...</title></head><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0f2f5"><div style="background:#fff;border-radius:12px;max-width:420px;margin:0 auto;padding:40px 24px;box-shadow:0 2px 12px rgba(0,0,0,.08)"><div style="font-size:3rem;margin-bottom:16px">&#128722;</div><h2 style="margin:0 0 12px">Buscando precios...</h2><p style="color:#555">Comparando ${(config.lista_compras || []).length} productos en Carrefour, Jumbo y Coto.</p><p style="color:#888;font-size:.85rem;margin-top:16px">En ~60 segundos recibi&#769;s el resultado en WhatsApp y ntfy.</p><a href="/" style="display:inline-block;margin-top:24px;padding:10px 24px;background:#075e54;color:#fff;border-radius:6px;text-decoration:none">Volver al inicio</a></div></body></html>`);
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

    if (estadoWA === 'conectado') {
      res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>&#9989; WhatsApp conectado</h2><p>El bot est&#225; activo y escuchando mensajes.</p><p><a href="/test" style="display:inline-block;margin:6px;padding:10px 24px;background:#075e54;color:#fff;border-radius:6px;text-decoration:none;font-size:.95rem">Enviar mensaje de prueba</a></p><p><a href="/procesar" style="display:inline-block;margin:6px;padding:10px 24px;background:#1d6fa4;color:#fff;border-radius:6px;text-decoration:none;font-size:.95rem">Procesar mensajes nuevos</a></p><p><a href="/historial" style="display:inline-block;margin:6px;padding:10px 24px;background:#7d3c98;color:#fff;border-radius:6px;text-decoration:none;font-size:.95rem">Revisar historial completo</a></p><p><a href="/precios" style="display:inline-block;margin:6px;padding:10px 24px;background:#e67e22;color:#fff;border-radius:6px;text-decoration:none;font-size:.95rem">&#128722; Comparar lista de compras</a></p><p><a href="/buscar" style="display:inline-block;margin:6px;padding:10px 24px;background:#d35400;color:#fff;border-radius:6px;text-decoration:none;font-size:.95rem">&#128269; Buscar producto espec&#237;fico</a></p><p style="margin-top:24px"><a href="/limpiar-sesion" style="display:inline-block;margin:6px;padding:8px 20px;background:#c0392b;color:#fff;border-radius:6px;text-decoration:none;font-size:.85rem" onclick="return confirm('Borrar sesi&#243;n?')">Limpiar sesi&#243;n y re-sincronizar</a></p></body></html>`);
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

    res.end(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="2"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0f2f5"><div style="background:#fff;border-radius:12px;max-width:400px;margin:0 auto;padding:40px 24px;box-shadow:0 2px 12px rgba(0,0,0,.08)"><div style="font-size:3rem;margin-bottom:16px">&#9203;</div><h2 style="margin:0 0 12px">Arrancando bot...</h2><p style="color:#888;font-size:.85rem">Esta p&#225;gina se actualiza sola cada 2 segundos.</p></div></body></html>`);
  });

  server.listen(PORT, () => {
    console.log(`[Server] Escuchando en puerto ${PORT}`);
  });
}

function formatearBusqueda({ query, carrefour, jumbo, coto }) {
  const todos = [...(carrefour || []), ...(jumbo || []), ...(coto || [])];
  if (!todos.length) return `Sin resultados para "${query}".`;

  todos.sort((a, b) => a.precio - b.precio);

  const lineas = [`🔍 *${query}*`, ''];
  todos.forEach((item, i) => {
    const corona = i === 0 ? '👑 ' : '';
    const promo = item.tienePromo ? ` _(antes $${item.precioOriginal.toFixed(0)})_` : '';
    lineas.push(`${corona}*${item.supermercado}* $${item.precio.toFixed(0)} — ${item.nombre}${promo}`);
  });

  if (todos.length > 1) {
    const ahorro = todos[todos.length - 1].precio - todos[0].precio;
    lineas.push('');
    lineas.push(`💰 Diferencia: $${ahorro.toFixed(0)}`);
  }

  return lineas.join('\n');
}

async function buscarYCompararPrecios() {
  const urls = config.lista_compras_urls;
  const lista = config.lista_compras;
  const usandoUrls = Array.isArray(urls) && urls.length > 0;
  if (!usandoUrls && !lista?.length) throw new Error('lista_compras y lista_compras_urls vacías en config.json');
  const cantidad = usandoUrls ? urls.length : lista.length;
  console.log(`[Precios] Iniciando búsqueda de ${cantidad} productos (${usandoUrls ? 'URLs' : 'nombres'})...`);
  const resultados = usandoUrls ? await buscarDesdeUrls(urls) : await buscarTodos(lista);
  const encontrados = resultados.filter((r) => r.resultados.length > 0).length;
  console.log(`[Precios] Búsqueda completa — ${encontrados}/${lista.length} productos encontrados`);
  const analisis = await analizarPrecios(resultados);
  postNtfy('Comparacion supermercados', analisis.replace(/\*/g, '').replace(/_/g, ''));
  try {
    await enviarTextoLibre(analisis);
  } catch (err) {
    console.error(`[Precios] Error enviando a WA:`, err.message);
  }
}

async function procesarMensajesGrupos() {
  const hora = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  console.log(`\n[Cron grupos] Iniciando — ${hora}`);
  try {
    const todos = await obtenerMensajesSinProcesar();
    const grupales = todos.filter((m) => m.chat_id?.endsWith('@g.us'));
    console.log(`[Cron grupos] ${grupales.length} mensajes grupales sin procesar`);
    if (!grupales.length) { console.log(`[Cron grupos] Nada que analizar`); return; }
    const resultados = await analizarMensajes(grupales);
    await enviarResumen(grupales, resultados);
    notificarNtfy(resultados);
    const ids = grupales.map((m) => m.id);
    await marcarProcesados(ids);
    console.log(`[Cron grupos] Completo — ${resultados.length} temas, ${ids.length} mensajes procesados`);
  } catch (err) {
    console.error(`[Cron grupos] Error:`, err.message);
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
    const { eventos, compromisos, pedidos } = await analizarIndividuales(individuales);
    notificarCalendario(eventos, compromisos, pedidos);
    if (eventos.length || compromisos.length || pedidos.length) {
      const texto = formatearResumenIndividuales(eventos, compromisos, pedidos);
      try { await enviarTextoLibre(texto); } catch (err) { console.error(`[Cron individuales] Error enviando a WA:`, err.message); }
    }
    const ids = individuales.map((m) => m.id);
    await marcarProcesados(ids);
    console.log(`[Cron individuales] Completo — ${eventos.length} eventos, ${compromisos.length} compromisos, ${pedidos.length} pedidos, ${ids.length} mensajes procesados`);
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
    process.exit(1);
  }
  try {
    await iniciarCliente({
      onQR: (qr) => { estadoWA = 'qr'; qrActual = qr; tsAutenticando = null; console.log(`[WA] QR listo — visitá https://botwp-ikbb.onrender.com para escanearlo`); },
      onAutenticando: () => { estadoWA = 'autenticando'; qrActual = null; tsAutenticando = Date.now(); console.log(`[WA] QR escaneado — autenticando...`); },
      onListo: () => { const segs = tsAutenticando ? Math.round((Date.now() - tsAutenticando) / 1000) : '?'; estadoWA = 'conectado'; qrActual = null; console.log(`[WA] ¡Listo! Conectado en ${segs}s`); },
    });
  } catch (err) {
    console.error(`[Bot] No se pudo inicializar WhatsApp:`, err.message);
    process.exit(1);
  }
  cron.schedule(config.resumen.hora_cron_grupos, procesarMensajesGrupos, { timezone: 'America/Argentina/Buenos_Aires' });
  cron.schedule(config.resumen.hora_cron_individuales, procesarMensajesIndividuales, { timezone: 'America/Argentina/Buenos_Aires' });
  console.log(`[Bot] Crones activos — grupos "${config.resumen.hora_cron_grupos}", individuales "${config.resumen.hora_cron_individuales}"`);
}

main();
