// Formato de los digests: sección de grupos (versión resumida y completa),
// coincidencias con intereses, detalle completo y conversión a HTML. Son
// funciones puras (sin WhatsApp ni base de datos) para poder probarlas solas.
// `limites` es config.resumen (max_temas_grupo, max_temas_grupo_alto, max_items_catalogo).
const TZ = 'America/Argentina/Buenos_Aires';

function normalizarClave(s) {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function recortar(texto, max = 80) {
  const t = String(texto || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Sección "Novedades de tus grupos" en dos versiones del mismo contenido:
 *  - resumida (WhatsApp): con topes por grupo
 *  - completa (detalle web): sin topes, con vendidos y charla menor
 * Grupos en modo "catalogo" (compraventa): una línea por artículo, agrupados por
 * vendedor. Grupos con detalle "alto": tope más alto (resumen.max_temas_grupo_alto).
 * Devuelve { texto, ocultos } — ocultos = ítems que la versión resumida dejó afuera.
 */
function seccionGrupos(resumenesChats, { completo = false, limites = {} } = {}) {
  const tope = (n) => (completo ? Infinity : n);
  const maxNormal = tope(Math.min(limites.max_temas_grupo ?? 5, 5));
  const maxAlto = tope(limites.max_temas_grupo_alto ?? 12);
  const maxCatalogo = tope(limites.max_items_catalogo ?? 20);
  const bloques = [];
  let ocultos = 0;

  for (const { chatNombre, temas, menores = [], modo = 'normal', detalle = 'normal' } of resumenesChats) {
    const vistosInfo = new Set();
    const infos = temas
      .filter((t) => !(t.para_mi && t.estado === 'pendiente' && ['accion', 'pago', 'evento'].includes(t.tipo)))
      .sort((a, b) => b.relevancia - a.relevancia)
      .filter((t) => {
        const k = normalizarClave(t.resumen);
        if (k && vistosInfo.has(k)) return false;
        if (k) vistosInfo.add(k);
        return true;
      });

    if (modo === 'catalogo') {
      const disponibles = infos.filter((t) => t.estado !== 'resuelto');
      const vendidos = infos.filter((t) => t.estado === 'resuelto');
      const visibles = disponibles.slice(0, maxCatalogo);
      ocultos += disponibles.length - visibles.length;
      const lista = completo ? [...visibles, ...vendidos] : visibles;
      if (!lista.length) continue;
      const porVendedor = new Map();
      for (const t of lista) {
        const vendedor = (t.de || '').trim() || 'Sin nombre';
        if (!porVendedor.has(vendedor)) porVendedor.set(vendedor, []);
        porVendedor.get(vendedor).push(t);
      }
      const n = disponibles.length;
      const lineas = [`🛍️ *${chatNombre}* — ${n} publicaci${n === 1 ? 'ón' : 'ones'}`];
      for (const [vendedor, items] of porVendedor) {
        lineas.push(`*${vendedor}*`);
        items.forEach((t) => {
          const texto = t.estado === 'resuelto' ? `~${t.resumen}~ (vendido)` : t.resumen;
          lineas.push(`• ${t.categoria === 'busca' ? '🔎 ' : ''}${texto}`);
        });
      }
      if (disponibles.length > visibles.length) {
        lineas.push(`_…y ${disponibles.length - visibles.length} publicación(es) más en el detalle completo_`);
      }
      bloques.push(lineas.join('\n'));
      continue;
    }

    if (!infos.length && !(completo && menores.length)) continue;
    const mostrados = infos.slice(0, detalle === 'alto' ? maxAlto : maxNormal);
    const lineas = [`*${chatNombre}*`];
    mostrados.forEach((t) => lineas.push(`• ${t.resumen}`));
    if (infos.length > mostrados.length) {
      ocultos += infos.length - mostrados.length;
      lineas.push(`_…y ${infos.length - mostrados.length} tema(s) más en el detalle completo_`);
    }
    if (completo && menores.length) {
      lineas.push('_Charla menor:_');
      menores.forEach((t) => lineas.push(`◦ ${t.resumen}`));
    }
    bloques.push(lineas.join('\n'));
  }
  return { texto: bloques.join('\n\n'), ocultos };
}

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

/** Texto del detalle completo: todo lo de los grupos sin topes + todos los intereses. */
function formatearDetalle(resumenesChats, coincidencias, etiqueta, limites = {}) {
  const cuando = new Date().toLocaleString('es-AR', { timeZone: TZ, dateStyle: 'full', timeStyle: 'short' });
  const out = [`📋 *Detalle completo*${etiqueta ? ` · ${etiqueta}` : ''} — ${cuando}`];
  const grupos = seccionGrupos(resumenesChats, { completo: true, limites });
  if (grupos.texto) out.push('', '📢 *Novedades de tus grupos*', '', grupos.texto);
  const intereses = formatearIntereses(coincidencias, { max: Infinity, largo: 400 });
  if (intereses) out.push('', intereses);
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

module.exports = { seccionGrupos, formatearIntereses, formatearDetalle, htmlDesdeTexto, MAX_INTERESES_WA };
