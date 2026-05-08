const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('./config.json');
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

const BATCH_SIZE = config.resumen.max_mensajes_por_batch;

const PROMPT_SISTEMA = `Eres un asistente que resume conversaciones de WhatsApp para su dueño.

Se te dan mensajes de distintos chats. Tu tarea es agruparlos por temática y devolver un resumen compacto de cada tema.

Reglas:
- Ignorá saludos, memes, stickers, audios de cortesía y spam — no los incluyas en el resumen
- Agrupá mensajes relacionados bajo un mismo tema aunque vengan de chats distintos
- El resumen de cada tema debe ser una oración clara que explique qué está pasando
- Si hay algo que requiere acción o respuesta, indicalo en el resumen

Responde SOLO con un array JSON, sin texto extra, con este formato:
[{"tema": "<tema en 2-4 palabras>", "resumen": "<una oración explicando qué pasa>", "chat": "<nombre del chat o chats>", "ids": [<id>, ...]}]

Si todos los mensajes son irrelevantes (saludos, spam, etc.), devolvé un array vacío: []`;

async function resumirBatch(mensajes) {
  const lista = mensajes
    .map((m) => `ID ${m.id} | De: ${m.remitente ?? m.remitente_id} | Chat: ${m.chat_nombre ?? m.chat_id}\nMensaje: ${m.cuerpo}`)
    .join('\n---\n');

  const prompt = `${PROMPT_SISTEMA}\n\nMensajes:\n${lista}`;

  const result = await model.generateContent(prompt);
  const texto = result.response.text().trim();

  const match = texto.match(/\[[\s\S]*\]/);
  if (!match) throw new Error(`Respuesta inesperada de Gemini: ${texto.slice(0, 200)}`);

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
      const resultado = await resumirBatch(batch);
      temas.push(...resultado);
      console.log(`[Gemini] Batch ${numBatch} OK — ${resultado.length} temas encontrados`);
    } catch (err) {
      console.error(`[Gemini] Error en batch ${numBatch}:`, err.message);
    }
  }

  return temas;
}

module.exports = { analizarMensajes };
