const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('./config.json');
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });


async function callGemini(prompt, intento = 1) {
  try {
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch (err) {
    const es503 = err.message?.includes('503') || err.message?.includes('Service Unavailable') || err.message?.includes('high demand');
    if (es503 && intento < 4) {
      const espera = intento === 1 ? 5000 : intento === 2 ? 15000 : 45000;
      console.warn(`[Gemini] 503 en intento ${intento}, reintentando en ${espera / 1000}s...`);
      await new Promise((r) => setTimeout(r, espera));
      return callGemini(prompt, intento + 1);
    }
    throw err;
  }
}

async function analizarChat(chatNombre, mensajes) {
  return require('./analisis').analizarConversacion(chatNombre, mensajes, callGemini, config);
}

/**
 * Analiza un array de mensajes grupales (de distintos chats).
 * Agrupa por chat_id y llama analizarChat para cada uno.
 * Devuelve { temas: [...], idsProcesados: [...] } consolidado.
 * Mantiene compatibilidad con el uso anterior.
 */
async function analizarMensajes(mensajes) {
  if (!mensajes.length) return { temas: [], idsProcesados: [] };

  // Agrupar por chat_id
  const porChat = new Map();
  for (const m of mensajes) {
    const chatId = m.chat_id;
    if (!porChat.has(chatId)) porChat.set(chatId, []);
    porChat.get(chatId).push(m);
  }

  const temas = [];
  const idsProcesados = [];

  for (const [chatId, chatMensajes] of porChat) {
    const chatNombre = chatMensajes[0].chat_nombre || chatId;
    console.log(`[Gemini] Analizando chat "${chatNombre}" (${chatMensajes.length} mensajes)`);
    try {
      const resultado = await analizarChat(chatNombre, chatMensajes);
      // Agregar campo chat a cada tema para compatibilidad con resumenPeriodo
      resultado.temas.forEach((t) => { if (!t.chat) t.chat = chatNombre; });
      temas.push(...resultado.temas);
      idsProcesados.push(...resultado.idsProcesados);
    } catch (err) {
      console.error(`[Gemini] Error analizando chat "${chatNombre}":`, err.message);
    }
  }

  return { temas, idsProcesados };
}

async function analizarIndividuales(mensajes, contactos = new Map()) {
  const { agrupar, analizarConversacion } = require('./analisis');
  const salida = { eventos: [], compromisos: [], pedidos: [], conversaciones: [], idsProcesados: [], errores: 0 };
  for (const [chatId, lista] of agrupar(mensajes)) {
    const nombre = contactos.get(chatId) || lista.find(m => !m.es_propio)?.remitente || chatId;
    const r = await analizarConversacion(nombre, lista, callGemini, config, true);
    salida.idsProcesados.push(...r.idsProcesados);
    salida.errores += r.errores;
    salida.conversaciones.push({ chatNombre: nombre, temas: r.temas });
    for (const t of r.temas) {
      if (!t.para_mi || t.estado !== 'pendiente') continue;
      if (t.tipo === 'evento') salida.eventos.push({ titulo: t.resumen, fecha: t.fecha_limite, chat: nombre });
      if (['accion', 'pago'].includes(t.tipo)) salida.pedidos.push({ de: nombre, pedido: t.accion || t.resumen, chat: nombre, fecha_limite: t.fecha_limite });
    }
  }
  return salida;
}

/**
 * Describe con Gemini (multimodal) qué se ve en una imagen compartida en un
 * chat, en una frase corta. Pensado para grupos tipo "roperito" donde la foto
 * ES el contenido (productos en venta, flyers, comprobantes). Devuelve '' si
 * falla — nunca rompe la captura del mensaje.
 */
async function describirImagen(base64Data, mimeType, caption = '') {
  if (!base64Data) return '';
  const ctx = caption ? ` Vino con este texto: "${caption}".` : '';
  const prompt = `Esta es una imagen compartida en un grupo de WhatsApp.${ctx} Describí en UNA sola frase corta y concreta qué se ve, priorizando lo útil para el dueño del teléfono: si es un producto en venta decí qué es, estado y precio si aparece; si es un flyer/afiche, el dato principal (qué, cuándo, dónde); si es un comprobante o documento, qué es. Sin introducción ni comillas, solo la frase.`;
  try {
    const result = await model.generateContent([
      { inlineData: { mimeType: mimeType || 'image/jpeg', data: base64Data } },
      { text: prompt },
    ]);
    return result.response.text().trim().replace(/\s+/g, ' ').slice(0, 300);
  } catch (err) {
    console.warn(`[Gemini] No se pudo describir imagen:`, err.message);
    return '';
  }
}

/**
 * Genera el "titular del día": una frase corta en tono de asistente personal
 * que resume lo más importante de los pendientes. Si falla, devuelve '' y el
 * digest sale sin titular (nunca rompe el envío).
 */
async function generarTitular(items) {
  if (!items.length) return '';
  const nombre = (config.nombre_dueno || '').trim() || 'el dueño';
  const prompt = `Sos el asistente personal de ${nombre}. Estos son sus pendientes de hoy según sus mensajes de WhatsApp:
${items.map((i) => `- ${i}`).join('\n')}

Escribí UNA sola frase (máximo 25 palabras) que le resuma lo más importante, priorizando lo urgente. Tono cercano y directo, voseo argentino, sin saludo, sin emojis, sin comillas. Respondé solo la frase.`;
  try {
    const texto = await callGemini(prompt);
    return texto.replace(/^["'\s]+|["'\s]+$/g, '').split('\n')[0].trim();
  } catch (err) {
    console.warn(`[Gemini] No se pudo generar titular:`, err.message);
    return '';
  }
}

module.exports = { analizarMensajes, analizarChat, analizarIndividuales, generarTitular, describirImagen };
