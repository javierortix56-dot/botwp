// Páginas del panel web. Funciones puras que devuelven HTML (sin WhatsApp ni
// base de datos) para poder probarlas solas. Todo dato dinámico pasa por
// escapar(). Un solo estilo para todas las páginas, pensado para el celular y
// con modo oscuro automático.

function escapar(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const CSS = `
:root{--bg:#f3f5f7;--card:#fff;--txt:#14181c;--sub:#5f6b76;--borde:#e3e8ed;--verde:#0b8a5f;--verde2:#e6f5ee;--azul:#1f6feb;--azul2:#e8f0fe;--rojo:#c62828;--rojo2:#fdecea;--ambar:#b26a00;--ambar2:#fff4e0;--sombra:0 1px 3px rgba(16,24,40,.06),0 1px 2px rgba(16,24,40,.04)}
@media (prefers-color-scheme:dark){:root{--bg:#0f1418;--card:#182026;--txt:#e8edf1;--sub:#97a4ae;--borde:#26313a;--verde:#3ccf91;--verde2:#123227;--azul:#6ea8ff;--azul2:#16263d;--rojo:#ff7b72;--rojo2:#3a1a1a;--ambar:#f0b44c;--ambar2:#3a2c12;--sombra:none}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:640px;margin:0 auto;padding:20px 16px 48px}
a{color:var(--azul);text-decoration:none}
h1{font-size:1.35rem;margin:4px 0 2px}
h2{font-size:.78rem;letter-spacing:.06em;text-transform:uppercase;color:var(--sub);margin:28px 4px 10px;font-weight:600}
.sub{color:var(--sub);font-size:.92rem;margin:0}
.volver{display:inline-block;font-size:.9rem;margin-bottom:12px}
.card{background:var(--card);border:1px solid var(--borde);border-radius:16px;padding:18px;box-shadow:var(--sombra)}
.card+.card{margin-top:12px}
.estado{display:flex;align-items:center;gap:10px;font-weight:600}
.punto{width:10px;height:10px;border-radius:50%;background:var(--verde);box-shadow:0 0 0 4px var(--verde2);flex:none}
.punto.ambar{background:var(--ambar);box-shadow:0 0 0 4px var(--ambar2)}
.punto.rojo{background:var(--rojo);box-shadow:0 0 0 4px var(--rojo2)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}
.dato{background:var(--bg);border-radius:12px;padding:10px 12px}
.dato b{display:block;font-size:1.1rem}
.dato span{font-size:.8rem;color:var(--sub)}
.barra{height:6px;background:var(--borde);border-radius:4px;margin-top:6px;overflow:hidden}
.barra i{display:block;height:100%;background:var(--verde);border-radius:4px}
.barra i.ambar{background:var(--ambar)}.barra i.rojo{background:var(--rojo)}
.btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:14px 16px;border-radius:12px;border:1px solid var(--borde);background:var(--card);color:var(--txt);font:inherit;font-weight:600;cursor:pointer;text-align:center}
.btn.primario{background:var(--verde);border-color:var(--verde);color:#fff}
@media (prefers-color-scheme:dark){.btn.primario{color:#06110c}}
.btn.peligro{color:var(--rojo);border-color:var(--rojo)}
.btn+.btn,.fila+.btn,.btn+.fila{margin-top:10px}
.fila{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.fila .btn{padding:12px 6px;font-size:.92rem;margin-top:0}
.lista{list-style:none;margin:0;padding:0}
.lista li{border-top:1px solid var(--borde)}
.lista li:first-child{border-top:none}
.lista a,.lista summary{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:13px 2px;color:var(--txt);cursor:pointer;list-style:none}
.lista summary::-webkit-details-marker{display:none}
.lista small{color:var(--sub)}
.chip{display:inline-block;flex:none;align-self:flex-start;font-size:.72rem;font-weight:600;padding:2px 8px;border-radius:20px;background:var(--azul2);color:var(--azul);white-space:nowrap}
.chip.verde{background:var(--verde2);color:var(--verde)}
.aviso{border-radius:12px;padding:12px 14px;margin-bottom:12px;font-size:.95rem}
.aviso.ok{background:var(--verde2);color:var(--verde)}
.aviso.alerta{background:var(--ambar2);color:var(--ambar)}
.aviso.error{background:var(--rojo2);color:var(--rojo)}
.centro{text-align:center}
.icono{font-size:2.6rem;line-height:1;margin-bottom:10px}
.contenido{white-space:pre-wrap;word-break:break-word;line-height:1.55}
.cabecera{background:var(--verde2);border-color:transparent;font-size:1.02rem}
label{display:block;font-weight:600;margin:0 0 6px}
input[type=text],textarea,select{width:100%;padding:10px 12px;border:1px solid var(--borde);border-radius:10px;background:var(--bg);color:var(--txt);font:inherit}
textarea{min-height:64px}
.ayuda{color:var(--sub);font-size:.82rem;margin:6px 0 18px}
.chat{padding:14px 0;border-top:1px solid var(--borde)}
.chat:first-of-type{border-top:none}
.chat-nombre{font-weight:600;display:flex;justify-content:space-between;gap:8px;margin-bottom:8px}
.selects{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.selects label{font-size:.72rem;color:var(--sub);font-weight:500;margin-bottom:3px}
.selects select{padding:8px;font-size:.88rem}
.qr{display:block;margin:16px auto;border-radius:12px;background:#fff;padding:8px;max-width:100%}
ol{padding-left:20px;margin:8px 0}
footer{color:var(--sub);font-size:.78rem;text-align:center;margin-top:32px}
`;

function layout({ titulo, cuerpo, refresco = 0, volver = null }) {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0b8a5f"><meta name="robots" content="noindex">${refresco ? `<meta http-equiv="refresh" content="${Number(refresco)}">` : ''}<title>${escapar(titulo)} · BotWP</title><style>${CSS}</style></head><body><main>${volver ? `<a class="volver" href="${escapar(volver)}">← Volver</a>` : ''}${cuerpo}<footer>BotWP · tu asistente de WhatsApp</footer></main></body></html>`;
}

function porcentaje(n, total) {
  return total > 0 ? Math.min(100, Math.round((n / total) * 100)) : 0;
}

/**
 * Inicio del panel. `e` = {
 *   nombre, conexion: 'conectado'|'standby'|'reconectando', ultimoDigest: { cuando, hace } | null,
 *   proximoDigest, pendientes, gemini: { total, limite, por_tipo }, grupos, aviso
 * }
 */
function paginaInicio(e) {
  const conexiones = {
    conectado: ['', 'WhatsApp conectado', 'Escuchando tus chats en vivo.'],
    standby: ['ambar', 'En pausa (modo ahorro)', 'Se conecta solo para cada resumen, así tu teléfono recibe todas las notificaciones.'],
    reconectando: ['ambar', 'Reconectando con WhatsApp…', 'Suele resolverse solo en unos segundos.'],
  };
  const [colorEstado, tituloEstado, detalleEstado] = conexiones[e.conexion] || conexiones.reconectando;
  const g = e.gemini || { total: 0, limite: 0 };
  const pct = porcentaje(g.total, g.limite);
  const colorBarra = pct >= 90 ? 'rojo' : pct >= 70 ? 'ambar' : '';
  const aviso = e.aviso ? `<div class="aviso ${escapar(e.aviso.tipo || 'ok')}">${escapar(e.aviso.texto)}</div>` : '';

  return layout({
    titulo: 'Inicio',
    cuerpo: `${aviso}
<h1>Hola${e.nombre ? `, ${escapar(e.nombre)}` : ''} 👋</h1>
<p class="sub">Tu asistente resume tus chats de WhatsApp dos veces por día.</p>

<h2>Estado</h2>
<div class="card">
  <div class="estado"><span class="punto ${colorEstado}"></span>${escapar(tituloEstado)}</div>
  <p class="sub" style="margin-top:4px">${escapar(detalleEstado)}</p>
  <div class="grid">
    ${e.ultimoDigest?.id ? `<a class="dato" href="/reporte?id=${escapar(e.ultimoDigest.id)}" style="color:inherit">` : '<div class="dato">'}<span>Último resumen</span><b>${escapar(e.ultimoDigest?.hace || '—')}</b><span>${escapar(e.ultimoDigest?.id ? 'tocá para verlo ›' : (e.ultimoDigest?.cuando || 'todavía no hubo'))}</span>${e.ultimoDigest?.id ? '</a>' : '</div>'}
    <div class="dato"><span>Próximo resumen</span><b>${escapar(e.proximoDigest || '—')}</b><span>automático</span></div>
    <div class="dato"><span>Mensajes en espera</span><b>${e.pendientes == null ? '—' : escapar(e.pendientes)}</b><span>entran en el próximo</span></div>
    <div class="dato"><span>Gemini hoy (gratis)</span><b>${escapar(g.total)} <small style="font-weight:400;color:var(--sub)">/ ${escapar(g.limite)}</small></b><div class="barra"><i class="${colorBarra}" style="width:${pct}%"></i></div></div>
  </div>
</div>

<h2>Resúmenes</h2>
<a class="btn primario" href="/procesar">📋 Resumir lo nuevo ahora</a>
<div class="fila" style="margin-top:10px">
  <a class="btn" href="/resumen?h=24">24 horas</a>
  <a class="btn" href="/resumen?h=72">3 días</a>
  <a class="btn" href="/resumen?h=168">7 días</a>
</div>
<a class="btn" href="/sin-responder">💬 Chats que no respondí</a>

<h2>Más</h2>
<div class="card" style="padding:4px 16px">
  <ul class="lista">
    <li><a href="/reportes"><span>📜 Resúmenes enviados</span><small>›</small></a></li>
    <li><a href="/configurar"><span>⚙️ Chats, detalle e intereses</span><small>${escapar(e.grupos ?? 0)} grupos ›</small></a></li>
    <li><a href="/test"><span>🔔 Enviarme un mensaje de prueba</span><small>›</small></a></li>
    <li><a href="/sesion"><span>🔗 Vincular WhatsApp de nuevo</span><small>›</small></a></li>
  </ul>
</div>`,
  });
}

/** Confirmación de una acción lanzada en segundo plano (resúmenes, prueba). */
function paginaAccion({ icono = '⏳', titulo, texto, detalle = '' }) {
  return layout({
    titulo,
    volver: '/',
    cuerpo: `<div class="card centro"><div class="icono">${icono}</div><h1>${escapar(titulo)}</h1><p class="sub">${escapar(texto)}</p>${detalle ? `<p class="sub" style="font-size:.85rem;margin-top:10px">${escapar(detalle)}</p>` : ''}</div>
<a class="btn" style="margin-top:12px" href="/">Volver al inicio</a>`,
  });
}

const NOMBRES_TIPO = {
  digest: ['Resumen', 'verde'],
  detalle: ['Detalle completo', ''],
  sin_responder: ['Sin responder', ''],
  periodo_24h: ['Últimas 24 h', ''],
  periodo_72h: ['Últimos 3 días', ''],
  periodo_168h: ['Últimos 7 días', ''],
};

function fechaCorta(ts, tz) {
  return new Date(Number(ts) * 1000).toLocaleString('es-AR', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function paginaReportes(reportes, { tz = 'America/Argentina/Buenos_Aires' } = {}) {
  const items = reportes.length
    ? reportes.map((r) => {
        const [nombre, color] = NOMBRES_TIPO[r.tipo] || [r.tipo || 'Reporte', ''];
        const temas = Number(r.n_temas) ? ` · ${escapar(r.n_temas)} temas` : '';
        return `<li><a href="/reporte?id=${escapar(r.id)}"><span>${escapar(fechaCorta(r.creado_en, tz))}<br><small>${escapar(r.n_mensajes)} mensajes${temas}</small></span><span class="chip ${color}">${escapar(nombre)}</span></a></li>`;
      }).join('')
    : '<li><p class="sub" style="padding:14px 0">Todavía no hay resúmenes guardados.</p></li>';
  return layout({
    titulo: 'Resúmenes enviados',
    volver: '/',
    cuerpo: `<h1>📜 Resúmenes enviados</h1><p class="sub">Los últimos ${reportes.length}. Tocá uno para verlo completo.</p><div class="card" style="padding:4px 16px;margin-top:16px"><ul class="lista">${items}</ul></div>`,
  });
}

/**
 * Un resumen como tarjetas, una por sección. `bloques` es la lista de HTML ya
 * formateado (el primero es el encabezado con el saludo); un string suelto se
 * muestra en una sola tarjeta.
 */
function paginaReporte(r, bloques, { tz = 'America/Argentina/Buenos_Aires' } = {}) {
  const [nombre] = NOMBRES_TIPO[r.tipo] || [r.tipo || 'Reporte'];
  let lista = (Array.isArray(bloques) ? bloques : [bloques]).filter(Boolean);
  // "N mensajes revisados" va como línea chica al pie, no como tarjeta propia.
  const pie = lista.length > 1 && /mensajes revisados/.test(lista.at(-1)) && lista.at(-1).length < 80 ? lista.at(-1) : '';
  if (pie) lista = lista.slice(0, -1);
  const tarjetas = lista.map((b, i) => `<div class="card contenido${i === 0 && lista.length > 1 ? ' cabecera' : ''}">${b}</div>`).join('')
    + (pie ? `<p class="sub centro" style="margin-top:12px;font-size:.85rem">${pie}</p>` : '');
  return layout({
    titulo: nombre,
    volver: '/reportes',
    cuerpo: `<p class="sub">${escapar(fechaCorta(r.creado_en, tz))} · ${escapar(nombre)}</p><div style="margin-top:8px">${tarjetas}</div>`,
  });
}

function paginaNoEncontrado() {
  return layout({ titulo: 'No encontrado', volver: '/', cuerpo: '<div class="card centro"><div class="icono">🔍</div><h1>No lo encontré</h1><p class="sub">Puede que ese resumen ya no exista.</p></div>' });
}

/** 401: panel privado. Ofrece mandar el link de acceso al WhatsApp del dueño. */
function paginaAcceso({ enviado = false, espera = false } = {}) {
  const estado = enviado
    ? '<div class="aviso ok">Listo: te mandé el link por WhatsApp (o ntfy). Abrilo desde este mismo teléfono.</div>'
    : espera
      ? '<div class="aviso alerta">Ya te mandé un link hace un rato. Revisá tu WhatsApp o probá en unos minutos.</div>'
      : '';
  return layout({
    titulo: 'Acceso privado',
    cuerpo: `${estado}<div class="card centro"><div class="icono">🔒</div><h1>Panel privado</h1><p class="sub">Este panel muestra tus chats, así que necesita tu link de acceso. Lo encontrás al final de cada resumen de WhatsApp.</p>
<form method="POST" action="/enviar-link" style="margin-top:16px"><button class="btn primario" type="submit">📲 Mandame el link a mi WhatsApp</button></form>
<p class="sub" style="font-size:.8rem;margin-top:12px">Solo se envía al número dueño del bot.</p></div>`,
  });
}

function paginaQR(imgDataUrl) {
  return layout({
    titulo: 'Vincular WhatsApp',
    refresco: 30,
    cuerpo: `<div class="card"><h1 class="centro">📱 Vinculá tu WhatsApp</h1>
<div class="aviso alerta" style="margin-top:12px">Escaneá el código <b>desde adentro de WhatsApp</b>, no con la cámara del teléfono.</div>
<img class="qr" src="${imgDataUrl}" width="280" height="280" alt="Código QR de WhatsApp">
<ol class="sub"><li>Abrí WhatsApp → <b>Configuración</b> (iPhone) o <b>⋮</b> (Android).</li><li>Tocá <b>Dispositivos vinculados</b> → <b>Vincular dispositivo</b>.</li><li>Apuntá al código. Se renueva solo cada 30 segundos.</li></ol></div>`,
  });
}

function paginaEstado({ icono, titulo, texto, refresco = 5, tono = '' }) {
  return layout({
    titulo,
    refresco,
    cuerpo: `<div class="card centro"><div class="icono">${icono}</div><h1>${escapar(titulo)}</h1><p class="sub">${escapar(texto)}</p>${tono ? `<div class="aviso ${tono}" style="margin-top:14px">La página se actualiza sola.</div>` : '<p class="sub" style="font-size:.82rem;margin-top:10px">La página se actualiza sola.</p>'}</div>`,
  });
}

function paginaSesion({ hecho = false } = {}) {
  if (hecho) {
    return paginaAccion({ icono: '🔗', titulo: 'Sesión reiniciada', texto: 'En unos segundos vas a ver el código QR en el inicio del panel para vincular de nuevo.', detalle: 'En tu teléfono podés borrar el dispositivo viejo de "Dispositivos vinculados".' });
  }
  return layout({
    titulo: 'Vincular de nuevo',
    volver: '/',
    cuerpo: `<div class="card"><h1>🔗 Vincular WhatsApp de nuevo</h1><p class="sub">Usalo solo si los resúmenes dejan de llegar o ves "Esperando el mensaje" en WhatsApp. Se borra la sesión actual y aparece un código QR para escanear.</p>
<form method="POST" action="/sesion" style="margin-top:16px" onsubmit="return confirm('¿Borrar la sesión actual y vincular de nuevo?')"><button class="btn peligro" type="submit">Borrar sesión y mostrar QR</button></form></div>`,
  });
}

/**
 * Configuración de chats. `chats` = [{ chat_nombre, cantidad, frecuencia, modo, detalle, esGrupo }].
 */
function paginaConfigurar({ chats, nombreDueno = '', intereses = [], detalleDefecto = 'normal', mensaje = '' }) {
  const frecuencias = [[0, 'No'], [1, 'Sí · 1 h'], [8, 'Sí · 8 h'], [12, 'Sí · 12 h'], [24, 'Sí · 24 h']];
  const select = (prefijo, nombre, actual, opciones) => {
    const opts = opciones.map(([v, l]) => `<option value="${escapar(v)}"${String(v) === String(actual) ? ' selected' : ''}>${escapar(l)}</option>`).join('');
    return `<select name="${prefijo}_${encodeURIComponent(nombre)}">${opts}</select>`;
  };
  const filas = chats.length
    ? chats.map((c) => `<div class="chat"><div class="chat-nombre"><span>${escapar(c.chat_nombre)}</span><span class="chip ${c.esGrupo ? '' : 'verde'}">${c.esGrupo ? 'Grupo' : 'Individual'} · ${escapar(c.cantidad)}</span></div>
<div class="selects"><div><label>Monitorear</label>${select('freq', c.chat_nombre, c.frecuencia || 0, frecuencias)}</div>
${c.esGrupo ? `<div><label>Modo</label>${select('modo', c.chat_nombre, c.modo || 'normal', [['normal', 'Normal'], ['catalogo', 'Ventas']])}</div>
<div><label>Detalle</label>${select('det', c.chat_nombre, c.detalle || detalleDefecto, [['normal', 'Resumido'], ['alto', 'Completo']])}</div>` : ''}</div></div>`).join('')
    : '<p class="sub">No hay mensajes recientes en la base de datos.</p>';

  return layout({
    titulo: 'Configuración',
    volver: '/',
    cuerpo: `${mensaje ? `<div class="aviso ok">${escapar(mensaje)}</div>` : ''}<h1>⚙️ Configuración</h1><p class="sub">Los cambios se guardan en la base y no se pierden con los deploys.</p>
<form method="POST" action="/configurar">
<h2>Vos</h2>
<div class="card">
<label for="nombre_dueno">Tu nombre</label>
<input type="text" id="nombre_dueno" name="nombre_dueno" value="${escapar(nombreDueno)}" placeholder="Ej: Martín">
<p class="ayuda">Así te nombra el asistente en los resúmenes.</p>
<label for="intereses">Tus intereses</label>
<textarea id="intereses" name="intereses" placeholder="Ej: cochecito, bicicleta, talle 10">${escapar((intereses || []).join(', '))}</textarea>
<p class="ayuda" style="margin-bottom:0">Si alguien los menciona en cualquier chat, te aviso arriba del resumen. Separalos con coma.</p>
</div>
<h2>Chats de los últimos 30 días</h2>
<div class="card"><p class="ayuda" style="margin-top:0"><b>Ventas</b> (para grupos de compraventa) lista cada publicación por rubro y vendedor. <b>Completo</b> no descarta ofertas ni charla menor.</p>${filas}</div>
<button class="btn primario" type="submit" style="margin-top:16px">💾 Guardar</button>
</form>`,
  });
}

module.exports = {
  escapar, layout, paginaInicio, paginaAccion, paginaReportes, paginaReporte, paginaNoEncontrado,
  paginaAcceso, paginaQR, paginaEstado, paginaSesion, paginaConfigurar,
};
