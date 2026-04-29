const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

const BATCH_SIZE = 5;

const PROMPT_SISTEMA = `Eres un asistente que clasifica mensajes de WhatsApp para su dueño.
Para cada mensaje devuelves EXACTAMENTE uno de estos tres valores:
- "urgente"    → requiere atención inmediata (emergencia, dinero, plazo hoy, problema crítico)
- "importante" → hay que leerlo pronto pero no es emergencia
- "ignorar"    → spam, saludos, memes, conversación intrascendente

Responde SOLO con un array JSON, sin texto extra, con este formato:
[{"id": <id>, "clasificacion": "<urgente|importante|ignorar>", "razon": "<una frase corta>"}]`;

async function clasificarBatch(mensajes) {
  const lista = mensajes
    .map((m) => `ID ${m.id} | De: ${m.remitente ?? m.remitente_id} | Chat: ${m.chat_nombre ?? m.chat_id}\nMensaje: ${m.cuerpo}`)
    .join('\n---\n');

  const prompt = `${PROMPT_SISTEMA}\n\nMensajes a clasificar:\n${lista}`;

  const result = await model.generateContent(prompt);
  const texto = result.response.text().trim();

  // Extraer el JSON aunque Gemini agregue markdown
  const match = texto.match(/\[[\s\S]*\]/);
  if (!match) throw new Error(`Respuesta inesperada de Gemini: ${texto.slice(0, 200)}`);

  return JSON.parse(match[0]);
}

async function analizarMensajes(mensajes) {
  if (!mensajes.length) return [];

  const resultados = [];

  for (let i = 0; i < mensajes.length; i += BATCH_SIZE) {
    const batch = mensajes.slice(i, i + BATCH_SIZE);
    const numBatch = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(mensajes.length / BATCH_SIZE);

    console.log(`[Gemini] Analizando batch ${numBatch}/${totalBatches} (${batch.length} mensajes)`);

    try {
      const clasificaciones = await clasificarBatch(batch);
      resultados.push(...clasificaciones);
      console.log(`[Gemini] Batch ${numBatch} OK — resultados: ${clasificaciones.map((c) => c.clasificacion).join(', ')}`);
    } catch (err) {
      console.error(`[Gemini] Error en batch ${numBatch}:`, err.message);
      // Si un batch falla, marcar todos sus mensajes como "ignorar" para no bloquear el flujo
      batch.forEach((m) => resultados.push({ id: m.id, clasificacion: 'ignorar', razon: 'Error de análisis' }));
    }
  }

  return resultados;
}

module.exports = { analizarMensajes };
