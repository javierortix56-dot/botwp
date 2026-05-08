const config = require('./config.json');

const vips = new Set(config.vips.map((n) => n.replace(/\D/g, '')));
const grupos = config.grupos.map((g) => g.toLowerCase().trim());
const keywords = config.keywords.map((k) => k.toLowerCase().trim());

function esVip(remitenteId) {
  const numero = (remitenteId || '').replace(/\D/g, '').replace(/^521/, '52');
  return vips.has(numero);
}

function esGrupoMonitoreado(chatNombre) {
  const nombre = (chatNombre || '').toLowerCase().trim();
  return grupos.some((g) => nombre.includes(g));
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

module.exports = { debeAnalizarse, obtenerFlags, esVip, esGrupoMonitoreado, tieneKeyword, esIndividual };
