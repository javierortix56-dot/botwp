let config = require('./config.json');

// Las listas derivadas (vips/grupos/keywords) se recalculan en recargar().
// Importante: NO son `const` capturadas una sola vez — antes, reconfigurar
// desde la web no tenía efecto hasta reiniciar Render, así que mensajes de
// grupos recién agregados no se guardaban. recargar() lo corrige.
let vips, gruposNombres, keywords;

function recargar() {
  delete require.cache[require.resolve('./config.json')];
  config = require('./config.json');
  vips = new Set(config.vips.map((n) => n.replace(/\D/g, '')));
  // Soportar grupos como strings (legacy) o como objetos { nombre, frecuencia_horas }
  gruposNombres = config.grupos.map((g) => (typeof g === 'string' ? g : g.nombre).toLowerCase().trim());
  keywords = config.keywords.map((k) => k.toLowerCase().trim());
}

recargar();

function esVip(remitenteId) {
  const numero = (remitenteId || '').replace(/\D/g, '').replace(/^521/, '52');
  return vips.has(numero);
}

function esGrupoMonitoreado(chatNombre) {
  const nombre = (chatNombre || '').toLowerCase().trim();
  return gruposNombres.some((g) => nombre.includes(g));
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
  const nombre = (chatNombre || '').toLowerCase().trim();
  const grupoConfig = config.grupos.find((g) => {
    const gNombre = (typeof g === 'string' ? g : g.nombre).toLowerCase().trim();
    return nombre.includes(gNombre);
  });
  if (!grupoConfig) return null;
  if (typeof grupoConfig === 'string') return null; // legacy sin frecuencia
  return grupoConfig.frecuencia_horas ?? null;
}

/**
 * Devuelve el objeto config completo del grupo que hace match, o null si no está.
 */
function obtenerConfigGrupo(chatNombre) {
  const nombre = (chatNombre || '').toLowerCase().trim();
  const grupoConfig = config.grupos.find((g) => {
    const gNombre = (typeof g === 'string' ? g : g.nombre).toLowerCase().trim();
    return nombre.includes(gNombre);
  });
  return grupoConfig || null;
}

module.exports = { debeAnalizarse, obtenerFlags, esVip, esGrupoMonitoreado, tieneKeyword, esIndividual, obtenerFrecuenciaGrupo, obtenerConfigGrupo, recargar };
