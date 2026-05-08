const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('./config.json');
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

const BATCH_SIZE = config.resumen.max_mensajes_por_batch;

const PROMPT_GRUPOS = `Eres un asistente que resume conversaciones de WhatsApp para su dueño.

Se te dan mensajes de distintos chats. Tu tarea es agruparlos por temática y devolver un resumen compacto de cada tema.

Reglas:
- Ignorá saludos, memes, stickers, audios de cortesía y spam — no los incluyas en el resumen
- Agrupá mensajes relacionados bajo un mismo tema aunque vengan de chats distintos
- El resumen de cada tema debe ser una oración clara que explique qué está pasando
- Si hay algo que requiere acción o respuesta, indicalo en el resumen

Responde SOLO con un array JSON, sin texto extra, con este formato:
[{"tema": "<tema en 2-4 palabras>", "resumen": "<una oración explicando qué pasa>", "chat": "<nombre del chat o chats>", "ids": [<id>, ...]}]

Si todos los mensajes son irrelevantes (saludos, spam, etc.), devolvé un array vacío: []`;

const PROMPT_INDIVIDUALES = `Eres un asistente que analiza chats individuales de WhatsApp para su dueño.

Tu tarea es identificar dos tipos de cosas:
1. EVENTOS calendarizables: reuniones, citas, plazos, fechas de pago, cumpleaños, vencimientos — cualquier cosa con fecha/hora específica que se beneficie de estar en un calendario
2. ASUNTOS importantes: temas que requieren acción, respuesta o recordar (sin fecha específica)

Reglas:
- Ignorá saludos, memes, conversación social, audios cortos y spam
- Para eventos, extraé la fecha/hora si está mencionada (formato ISO 8601 si es posible: YYYY-MM-DD HH:MM)
- Si la fecha es relativa ("mañana", "el viernes"), interpretala según la fecha de hoy y devolvé la fecha absoluta
- Sé conservador — solo incluí cosas que realmente parecen importantes

Responde SOLO con un objeto JSON, sin texto extra, con este formato:
{
  "eventos": [{"titulo": "<qué es>", "fecha": "<YYYY-MM-DD HH:MM o YYYY-MM-DD si no hay hora>", "chat": "<de quién>", "detalle": "<contexto breve>"}],
  "asuntos": [{"tema": "<asunto en 2-4 palabras>", "resumen": "<qué pasa y qué se espera>", "chat": "<de quién>"}]
}

Si no hay nada relevante: {"eventos": [], "asuntos": []}`;

async function callGemini(prompt) {
  const result = await model.generateContent(prompt);
  return result.response.text().trim();
}

async function resumirBatchGrupos(mensajes) {
  const lista = mensajes
    .map((m) => `ID ${m.id} | De: ${m.remitente ?? m.remitente_id} | Chat: ${m.chat_nombre ?? m.chat_id}\nMensaje: ${m.cuerpo}`)
    .join('\n---\n');

  const texto = await callGemini(`${PROMPT_GRUPOS}\n\nMensajes:\n${lista}`);
  const match = texto.match(/\[[\s\S]*\]/);
  if (!match) throw new Error(`Respuesta inesperada: ${texto.slice(0, 200)}`);
  return JSON.parse(match[0]);
}

async function resumirBatchIndividuales(mensajes, hoy) {
  const lista = mensajes
    .map((m) => `ID ${m.id} | De: ${m.remitente ?? m.remitente_id}\nMensaje: ${m.cuerpo}`)
    .join('\n---\n');

  const texto = await callGemini(`${PROMPT_INDIVIDUALES}\n\nFecha de hoy: ${hoy}\n\nMensajes:\n${lista}`);
  const match = texto.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Respuesta inesperada: ${texto.slice(0, 200)}`);
  return JSON.parse(match[0]);
}

async function analizarMensajes(mensajes) {
  if (!mensajes.length) return [];
  const temas = [];

  for (let i = 0; i < mensajes.length; i += BATCH_SIZE) {
    const batch = mensajes.slice(i, i + BATCH_SIZE);
    const numBatch = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(mensajes.length / BATCH_SIZE);

    console.log(`[Gemini] Resumiendo batch ${numBatch}/${totalBatches} (${batch.length} mensajes)`);

    try {
      const resultado = await resumirBatchGrupos(batch);
      temas.push(...resultado);
      console.log(`[Gemini] Batch ${numBatch} OK — ${resultado.length} temas`);
    } catch (err) {
      console.error(`[Gemini] Error en batch ${numBatch}:`, err.message);
    }
  }

  return temas;
}

async function analizarIndividuales(mensajes) {
  if (!mensajes.length) return { eventos: [], asuntos: [] };
  const eventos = [];
  const asuntos = [];
  const hoy = new Date().toISOString().slice(0, 10);

  for (let i = 0; i < mensajes.length; i += BATCH_SIZE) {
    const batch = mensajes.slice(i, i + BATCH_SIZE);
    const numBatch = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(mensajes.length / BATCH_SIZE);

    console.log(`[Gemini] Analizando individuales batch ${numBatch}/${totalBatches} (${batch.length} mensajes)`);

    try {
      const resultado = await resumirBatchIndividuales(batch, hoy);
      eventos.push(...(resultado.eventos || []));
      asuntos.push(...(resultado.asuntos || []));
      console.log(`[Gemini] Batch ${numBatch} OK — ${resultado.eventos?.length || 0} eventos, ${resultado.asuntos?.length || 0} asuntos`);
    } catch (err) {
      console.error(`[Gemini] Error en batch ${numBatch}:`, err.message);
    }
  }

  return { eventos, asuntos };
}

module.exports = { analizarMensajes, analizarIndividuales };
