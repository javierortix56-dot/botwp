// Formato de los digests: sección de grupos y de conversaciones (versión
// resumida y completa), coincidencias con intereses, detalle completo y
// conversión a HTML. Son funciones puras (sin WhatsApp ni base de datos) para
// poder probarlas solas. `limites` es config.resumen (max_temas_grupo,
// max_temas_grupo_alto, max_items_catalogo, max_temas_conversacion).
const TZ = 'America/Argentina/Buenos_Aires';

// Separador entre secciones principales del digest.
const SEPARADOR = '━━━━━━━━━━━━━━';

function normalizarClave(s) {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function sinAcentos(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function recortar(texto, max = 80) {
  const t = String(texto || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function hoyISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}

// ── Clases y rubros ─────────────────────────────────────────────────────────

// Orden en que se muestran las clases dentro de cada chat.
const CLASES = [
  ['aviso', '📢', 'Avisos'],
  ['evento', '📅', 'Fechas y eventos'],
  ['solicitud', '🙋', 'Piden o buscan'],
  ['ofrecimiento', '🎁', 'Ofrecen'],
  ['social', '🎉', 'Social'],
  ['charla', '💬', 'Charla'],
  [null, '📌', 'Otros'],
];
const CLASES_VALIDAS = CLASES.map(([c]) => c).filter(Boolean);

// Clase de un tema. Acepta la "categoria" vieja del catálogo (venta/busca) y,
// si no viene clase, usa el tipo evento como pista.
function claseDe(t) {
  if (CLASES_VALIDAS.includes(t.clase)) return t.clase;
  if (t.categoria === 'venta') return 'ofrecimiento';
  if (t.categoria === 'busca') return 'solicitud';
  if (t.tipo === 'evento') return 'evento';
  return null;
}

const ICONOS_RUBRO = [
  [/alquil|inmueble|casa|depto|departamento|vivienda|propiedad|quinta/, '🏠'],
  [/ropa|indument|calzado|zapat|uniforme|vestim/, '👕'],
  [/comida|aliment|torta|dulce|paste|galleta|cocina|reposter|vianda/, '🍪'],
  [/electro|hogar|mueble|deco|aire acond/, '🛋️'],
  [/servic|oficio|repar|tecnic|clase|profe/, '🛠️'],
  [/escuel|colegio|util|libro|escolar|educ/, '📚'],
  [/juguet|beb|nin|infantil/, '🧸'],
  [/auto|vehic|moto|bici|transporte/, '🚗'],
  [/emprend|negocio|tienda|marca/, '🏪'],
  [/salud|belleza|estetic|medic/, '💆'],
  [/viaje|turismo|vacacion/, '✈️'],
  [/deporte|futbol|camiseta/, '⚽'],
  [/tecnolog|compu|notebook|chromebook|celular|tablet|electronic/, '💻'],
];

function iconoRubro(rubro) {
  const s = sinAcentos(rubro);
  const hit = ICONOS_RUBRO.find(([re]) => re.test(s));
  return hit ? hit[1] : '📦';
}

function nombreRubro(rubro) {
  const r = String(rubro || '').trim();
  return r ? r.charAt(0).toUpperCase() + r.slice(1) : 'Varios';
}

// ── Piezas de una línea ─────────────────────────────────────────────────────

// Precios en negrita: $350.000, USD 5.500, U$S 200, $20 mil.
function resaltarPrecios(texto) {
  const t = String(texto || '');
  if (t.includes('*')) return t;
  return t.replace(/((?:US\$|USD|U\$S|\$)\s?\d(?:[\d.,]*\d)?(?:\s?(?:mil|k)\b)?)/gi, '*$1*');
}

// Marca de fecha según cuánto falta: ⚠️ HOY, ⏰ MAÑANA, 🗓️ día. Vacío si no hay
// fecha válida o ya pasó.
function marcaFecha(fechaLimite, hoy = hoyISO()) {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/.exec(String(fechaLimite || '').trim());
  if (!m) return '';
  const dias = Math.round((Date.parse(`${m[1]}T00:00:00Z`) - Date.parse(`${hoy}T00:00:00Z`)) / 86400000);
  if (Number.isNaN(dias) || dias < 0) return '';
  const hora = m[2] ? ` ${m[2]}` : '';
  if (dias === 0) return `⚠️ *HOY${hora}* · `;
  if (dias === 1) return `⏰ *MAÑANA${hora}* · `;
  const d = new Date(`${m[1]}T12:00:00Z`);
  const dia = d.toLocaleDateString('es-AR', { weekday: 'short', timeZone: 'UTC' }).replace(/[.,]/g, '');
  return `🗓️ *${dia} ${d.getUTCDate()}/${d.getUTCMonth() + 1}${hora}* · `;
}

// Si el resumen arranca con el nombre de quien publica y ese nombre ya va al
// final de la línea, se saca del principio para no repetirlo.
function sinAutorAlInicio(resumen, autor) {
  const r = String(resumen || '').trim();
  const a = String(autor || '').trim();
  if (!a || !sinAcentos(r).startsWith(`${sinAcentos(a)} `)) return r;
  const resto = r.slice(a.length).trim();
  return resto.charAt(0).toUpperCase() + resto.slice(1);
}

// "Se vende ...", "Se comparte ...": relleno al principio de un ofrecimiento o
// pedido, que ya está bajo el encabezado "Ofrecen" / "Piden o buscan".
function sinRelleno(resumen) {
  const r = String(resumen || '').trim();
  const sin = r.replace(/^se\s+(?:venden?|ofrecen?|comparten?|alquilan?|anuncian?|regalan?|buscan?|necesitan?|publican?)\s+(?:(?:una?|el|la|los|las)\s+)?/i, '');
  return sin === r || !sin ? r : sin.charAt(0).toUpperCase() + sin.slice(1);
}

function lineaTema(t, { mostrarAutor = false, hoy } = {}) {
  const autor = mostrarAutor && t.de ? String(t.de).trim() : '';
  const resumen = mostrarAutor ? sinRelleno(autor ? sinAutorAlInicio(t.resumen, autor) : t.resumen) : String(t.resumen || '');
  if (t.estado === 'resuelto' && mostrarAutor) {
    return `• ~${resumen}~ _(ya no está)_${autor ? ` — *${autor}*` : ''}`;
  }
  const atencion = t.relevancia === 3 ? '❗ ' : '';
  return `• ${atencion}${marcaFecha(t.fecha_limite, hoy)}${resaltarPrecios(resumen)}${autor ? ` — *${autor}*` : ''}`;
}

// Agrupa los temas de un chat por clase (y por rubro dentro de ofrecimientos y
// pedidos). Sin encabezado de clase si el chat tiene una sola.
function lineasAgrupadas(temas, { hoy, rubrosSiempre = false } = {}) {
  const porClase = new Map(CLASES.map(([c]) => [c, []]));
  for (const t of temas) porClase.get(claseDe(t)).push(t);
  const presentes = CLASES.filter(([c]) => porClase.get(c).length);
  const conEncabezado = presentes.length > 1;
  const lineas = [];

  for (const [clase, icono, etiqueta] of presentes) {
    const items = porClase.get(clase);
    const comercial = clase === 'ofrecimiento' || clase === 'solicitud';
    if (conEncabezado) lineas.push(`${icono} *${etiqueta}*`);

    const rubros = new Map();
    if (comercial) {
      for (const t of items) {
        const k = nombreRubro(t.rubro);
        if (!rubros.has(k)) rubros.set(k, []);
        rubros.get(k).push(t);
      }
    }
    if (comercial && (rubros.size > 1 || (rubrosSiempre && items.some((t) => t.rubro)))) {
      for (const [rubro, deRubro] of rubros) {
        lineas.push(`   ${iconoRubro(rubro)} _${rubro}_`);
        deRubro.forEach((t) => lineas.push(lineaTema(t, { mostrarAutor: true, hoy })));
      }
    } else {
      items.forEach((t) => lineas.push(lineaTema(t, { mostrarAutor: comercial, hoy })));
    }
  }
  return lineas;
}

function sinDuplicados(temas) {
  const vistos = new Set();
  return temas.filter((t) => {
    const k = normalizarClave(t.resumen);
    if (k && vistos.has(k)) return false;
    if (k) vistos.add(k);
    return true;
  });
}

// Pendientes personales: ya salen en "Para resolver" / "Se viene".
const esPendientePersonal = (t) => t.para_mi && t.estado === 'pendiente' && ['accion', 'pago', 'evento'].includes(t.tipo);

// ── Grupos ──────────────────────────────────────────────────────────────────

/**
 * Sección "Novedades de tus grupos" en dos versiones del mismo contenido:
 *  - resumida (WhatsApp): con topes por grupo
 *  - completa (detalle web): sin topes, con vendidos y charla menor
 * Cada grupo se ordena por clase (avisos, fechas, piden, ofrecen, social…) y,
 * dentro de ofrecimientos y pedidos, por rubro. En modo "catalogo" (compraventa)
 * los vendidos se ocultan en WhatsApp. Devuelve { texto, ocultos } — ocultos =
 * ítems que la versión resumida dejó afuera.
 */
function seccionGrupos(resumenesChats, { completo = false, limites = {}, hoy } = {}) {
  const tope = (n) => (completo ? Infinity : n);
  const maxNormal = tope(Math.min(limites.max_temas_grupo ?? 5, 5));
  const maxAlto = tope(limites.max_temas_grupo_alto ?? 12);
  const maxCatalogo = tope(limites.max_items_catalogo ?? 20);
  const bloques = [];
  let ocultos = 0;

  for (const { chatNombre, temas, menores = [], modo = 'normal', detalle = 'normal' } of resumenesChats) {
    const infos = sinDuplicados(temas.filter((t) => !esPendientePersonal(t)).sort((a, b) => b.relevancia - a.relevancia));
    const catalogo = modo === 'catalogo';
    const vigentes = catalogo ? infos.filter((t) => t.estado !== 'resuelto') : infos;
    const vendidos = catalogo ? infos.filter((t) => t.estado === 'resuelto') : [];
    const visibles = vigentes.slice(0, catalogo ? maxCatalogo : detalle === 'alto' ? maxAlto : maxNormal);
    const lista = completo ? [...visibles, ...vendidos] : visibles;
    if (!lista.length && !(completo && menores.length)) continue;

    const n = vigentes.length;
    const lineas = [catalogo
      ? `🛍️ *${chatNombre}* · ${n} publicaci${n === 1 ? 'ón' : 'ones'}`
      : `👥 *${chatNombre}*`];
    lineas.push(...lineasAgrupadas(lista, { hoy, rubrosSiempre: catalogo }));

    const faltan = vigentes.length - visibles.length;
    if (faltan > 0) {
      ocultos += faltan;
      lineas.push(`_…y ${faltan} ${catalogo ? 'publicación(es)' : 'tema(s)'} más en el detalle completo_`);
    }
    if (completo && menores.length) {
      lineas.push('_Charla menor:_');
      menores.forEach((t) => lineas.push(`◦ ${t.resumen}`));
    }
    bloques.push(lineas.join('\n'));
  }
  return { texto: bloques.join('\n\n'), ocultos };
}

// ── Conversaciones individuales ─────────────────────────────────────────────

/**
 * "💬 Tus conversaciones": temas de cada chat individual. En WhatsApp solo va lo
 * sustancial (relevancia 2+): saludos y charla de cortesía quedan para el
 * detalle web. Las preguntas o pedidos de JO que siguen sin respuesta van primero,
 * marcadas con ⏳. Devuelve { texto, ocultos }.
 */
function seccionConversaciones(conversaciones, { completo = false, limites = {}, hoy } = {}) {
  const max = completo ? Infinity : (limites.max_temas_conversacion ?? 8);
  const bloques = [];
  let ocultos = 0;

  for (const c of conversaciones || []) {
    const todos = [...(c.temas || []), ...(c.menores || [])].filter((t) => t.estado !== 'cancelado' && !esPendientePersonal(t));
    const relevantes = sinDuplicados(todos.filter((t) => t.relevancia >= 2))
      .sort((a, b) => (b.esperando_respuesta === true) - (a.esperando_respuesta === true) || b.relevancia - a.relevancia);
    const menores = todos.filter((t) => !(t.relevancia >= 2));
    const visibles = relevantes.slice(0, max);
    ocultos += relevantes.length - visibles.length;
    if (!visibles.length && !(completo && menores.length)) continue;

    const lineas = [`👤 *${c.chatNombre}*`];
    visibles.forEach((t) => {
      const espera = t.esperando_respuesta === true ? '⏳ _Esperás respuesta:_ ' : '';
      const atencion = t.relevancia === 3 ? '❗ ' : '';
      lineas.push(`• ${atencion}${espera}${marcaFecha(t.fecha_limite, hoy)}${resaltarPrecios(t.resumen)}`);
    });
    if (relevantes.length > visibles.length) {
      lineas.push(`_…y ${relevantes.length - visibles.length} tema(s) más en el detalle completo_`);
    }
    if (completo && menores.length) {
      lineas.push('_Charla menor:_');
      menores.forEach((t) => lineas.push(`◦ ${t.resumen}`));
    }
    bloques.push(lineas.join('\n'));
  }
  return { texto: bloques.length ? `💬 *Tus conversaciones*\n\n${bloques.join('\n\n')}` : '', ocultos };
}

// ── Intereses, detalle y HTML ───────────────────────────────────────────────

const MAX_INTERESES_WA = 6;

/**
 * "🔔 Coincidencias con tus intereses": mensajes que mencionan algo de
 * config.resumen.intereses. En WhatsApp se muestran pocos; el resto va al detalle.
 */
function formatearIntereses(coincidencias, { max = MAX_INTERESES_WA, largo = 110 } = {}) {
  if (!coincidencias?.length) return '';
  const mostradas = coincidencias.slice(0, max);
  const lineas = ['🔔 *Coincidencias con tus intereses*'];
  mostradas.forEach((c) => lineas.push(`• *${c.interes}* — ${c.de ? `${c.de} en ` : ''}${c.chat}: ${recortar(c.texto, largo)}`));
  if (coincidencias.length > mostradas.length) {
    lineas.push(`_…y ${coincidencias.length - mostradas.length} más en el detalle completo_`);
  }
  return lineas.join('\n');
}

/** Texto del detalle completo: grupos y conversaciones sin topes + todos los intereses. */
function formatearDetalle(resumenesChats, coincidencias, etiqueta, limites = {}, conversaciones = [], hoy) {
  const cuando = new Date().toLocaleString('es-AR', { timeZone: TZ, dateStyle: 'full', timeStyle: 'short' });
  const out = [`📋 *Detalle completo*${etiqueta ? ` · ${etiqueta}` : ''} — ${cuando}`];
  const grupos = seccionGrupos(resumenesChats, { completo: true, limites, hoy });
  if (grupos.texto) out.push('', SEPARADOR, '📢 *Novedades de tus grupos*', '', grupos.texto);
  const convs = seccionConversaciones(conversaciones, { completo: true, limites, hoy });
  if (convs.texto) out.push('', SEPARADOR, convs.texto);
  const intereses = formatearIntereses(coincidencias, { max: Infinity, largo: 400 });
  if (intereses) out.push('', SEPARADOR, intereses);
  return out.join('\n');
}

// Texto con formato de WhatsApp (*negrita*, _cursiva_, ~tachado~, links) a HTML seguro.
function htmlDesdeTexto(texto) {
  return String(texto || '')
    .replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
    .replace(/\*([^*\n]+)\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,;:])/gm, '$1<i>$2</i>')
    .replace(/(^|[\s(])~([^~\n]+)~(?=$|[\s).,;:])/gm, '$1<s>$2</s>')
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
}

module.exports = {
  SEPARADOR, CLASES_VALIDAS, seccionGrupos, seccionConversaciones, formatearIntereses, formatearDetalle,
  htmlDesdeTexto, resaltarPrecios, marcaFecha, iconoRubro, claseDe, sinRelleno, MAX_INTERESES_WA,
};
