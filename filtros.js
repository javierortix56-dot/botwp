let config = require('./config.json');

// Las listas derivadas (vips/grupos/keywords) se recalculan en recargar().
// Importante: NO son `const` capturadas una sola vez — antes, reconfigurar
// desde la web no tenía efecto hasta reiniciar Render, así que mensajes de
// grupos recién agregados no se guardaban. recargar() lo corrige.
let vips, gruposNombres, keywords;

// Normaliza nombres de chat para comparar: sin mayúsculas, sin tildes, sin
// º/°/ª y sin puntuación. Los nombres reales de los grupos difieren del
// config en detalles invisibles ("5° " vs "5º", un espacio antes de un
// paréntesis, una tilde) y el includes() literal no matcheaba nunca → los
// mensajes de esos grupos se descartaban en silencio y el digest salía
// "todo tranquilo".
function normalizarNombre(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[º°ª]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Match tolerante: el nombre real contiene al configurado, o al revés (por si
// el grupo se renombró más corto). El mínimo de 5 caracteres evita que un
// nombre muy corto matchee cualquier cosa.
function coincideNombreGrupo(nombreNorm, configNorm) {
  if (!nombreNorm || !configNorm) return false;
  if (nombreNorm.includes(configNorm)) return true;
  return nombreNorm.length >= 5 && configNorm.includes(nombreNorm);
}

function recargar() {
  delete require.cache[require.resolve('./config.json')];
  config = require('./config.json');
  vips = new Set(config.vips.map((n) => n.replace(/\D/g, '')));
  // Soportar grupos como strings (legacy) o como objetos { nombre, frecuencia_horas }
  gruposNombres = config.grupos.map((g) => normalizarNombre(typeof g === 'string' ? g : g.nombre));
  keywords = config.keywords.map((k) => k.toLowerCase().trim());
}

recargar();

function esVip(remitenteId) {
  const numero = (remitenteId || '').replace(/\D/g, '').replace(/^521/, '52');
  return vips.has(numero);
}

function esGrupoMonitoreado(chatNombre) {
  const nombre = normalizarNombre(chatNombre);
  return gruposNombres.some((g) => coincideNombreGrupo(nombre, g));
}

function tieneKeyword(cuerpo) {
  const texto = (cuerpo || '').toLowerCase();
  return keywords.some((k) => texto.includes(k));
}

function esIndividual(chatId) {
  return chatId && !chatId.endsWith('@g.us');
}

function debeAnalizarse(msg) {
  try {
    const propio = (process.env.MY_WHATSAPP_ID || '').replace('@c.us', '@s.whatsapp.net');
    if (msg.chatId === propio || !/@(g\.us|s\.whatsapp\.net|lid)$/.test(msg.chatId || '')) return false;
    const vip = esVip(msg.remitenteId);
    const grupo = esGrupoMonitoreado(msg.chatNombre);
    const keyword = tieneKeyword(msg.cuerpo);
    const individual = config.monitorear_individuales && esIndividual(msg.chatId);
    return vip || grupo || keyword || individual;
  } catch (err) {
    console.error(`[Filtros] Error evaluando mensaje:`, err.message);
    return false;
  }
}

function obtenerFlags(msg) {
  return {
    esVip: esVip(msg.remitenteId),
    tieneKeyword: tieneKeyword(msg.cuerpo),
  };
}

/**
 * Devuelve los frecuencia_horas del grupo que hace match (case-insensitive, substring),
 * o null si el chat no está configurado.
 */
function obtenerFrecuenciaGrupo(chatNombre) {
  const nombre = normalizarNombre(chatNombre);
  const grupoConfig = config.grupos.find((g) => {
    const gNombre = normalizarNombre(typeof g === 'string' ? g : g.nombre);
    return coincideNombreGrupo(nombre, gNombre);
  });
  if (!grupoConfig) return null;
  if (typeof grupoConfig === 'string') return null; // legacy sin frecuencia
  return grupoConfig.frecuencia_horas ?? null;
}

/**
 * Devuelve el objeto config completo del grupo que hace match, o null si no está.
 */
function obtenerConfigGrupo(chatNombre) {
  const nombre = normalizarNombre(chatNombre);
  const grupoConfig = config.grupos.find((g) => {
    const gNombre = normalizarNombre(typeof g === 'string' ? g : g.nombre);
    return coincideNombreGrupo(nombre, gNombre);
  });
  return grupoConfig || null;
}

/**
 * Opciones de análisis del grupo según config.json: { modo, detalle }.
 *  - modo "catalogo": grupo de compraventa (cada artículo es un ítem, agrupado por vendedor)
 *  - detalle "alto": no descarta ofertas ni temas menores y no recorta tanto el resumen
 * Cualquier otro valor (o grupo sin configurar) cae en "normal".
 */
function obtenerOpcionesGrupo(chatNombre) {
  const g = obtenerConfigGrupo(chatNombre);
  const obj = g && typeof g === 'object' ? g : {};
  return {
    modo: obj.modo === 'catalogo' ? 'catalogo' : 'normal',
    detalle: ['alto', 'normal'].includes(obj.detalle) ? obj.detalle : detalleDefecto(),
  };
}

/** Detalle que usa todo chat sin "detalle" propio: resumen.detalle_defecto ("alto" o "normal"). */
function detalleDefecto() {
  return config.resumen?.detalle_defecto === 'alto' ? 'alto' : 'normal';
}

const sinAcentos = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const escaparRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Mensajes recibidos que mencionan alguno de los intereses configurados
 * (config.resumen.intereses). Sin acentos ni mayúsculas, y la coincidencia tiene
 * que empezar en inicio de palabra: "bici" encuentra "bicicleta" pero "cuna" no
 * encuentra "escuna". Ignora mensajes propios y contexto ya resumido.
 * Devuelve [{ interes, chat, de, texto, ts }] sin repetir el mismo mensaje.
 */
function buscarIntereses(mensajes, intereses) {
  const lista = (intereses || []).map((i) => String(i).trim()).filter(Boolean)
    .map((i) => ({ original: i, re: new RegExp(`(^|[^a-z0-9])${escaparRegex(sinAcentos(i))}`) }));
  if (!lista.length) return [];
  const vistos = new Set();
  const out = [];
  for (const m of mensajes || []) {
    if (m.es_propio || m.solo_contexto) continue;
    const texto = sinAcentos(m.cuerpo);
    const hit = lista.find((i) => i.re.test(texto));
    if (!hit) continue;
    const clave = `${m.chat_id}|${m.remitente_id}|${m.timestamp}|${m.cuerpo}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    out.push({ interes: hit.original, chat: m.chat_nombre || m.chat_id, de: m.remitente || null, texto: String(m.cuerpo || ''), ts: Number(m.timestamp) });
  }
  return out;
}

module.exports = { debeAnalizarse, obtenerFlags, esVip, esGrupoMonitoreado, tieneKeyword, esIndividual, obtenerFrecuenciaGrupo, obtenerConfigGrupo, obtenerOpcionesGrupo, detalleDefecto, buscarIntereses, recargar };
