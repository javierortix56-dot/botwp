const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('./config.json');
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

const BATCH_SIZE = config.max_mensajes_por_batch || config.resumen?.max_mensajes_por_batch || 5;

/**
 * Construye el bloque de contexto del dueño para insertar en el prompt de grupos.
 */
function buildContextoDueno() {
  const nombre = (config.nombre_dueno || '').trim();
  if (!nombre) return '';
  return `\nEl dueño del teléfono se llama ${nombre}. "me_piden" = true cuando alguien le habla directamente a ${nombre} o le pide algo personal.`;
}

const PROMPT_GRUPOS_BASE = `Analizás mensajes de UN grupo de WhatsApp para reportarle al dueño del teléfono qué necesita saber o hacer.
[CONTEXTO_DUENO]

CLASIFICÁ cada tema relevante:
- "accion": el dueño debe responder, confirmar, firmar, traer algo, decidir, autorizar, etc.
- "pago": hay que pagar algo — cuota, actividad, servicio (incluí monto y fecha si se menciona)
- "evento": algo en fecha específica — acto, reunión, excursión, partido (incluí fecha y hora)
- "info": información útil pero sin acción requerida
- "spam": cadenas virales, publicidad, memes, reenvíos sin contenido propio → OMITIR del resultado

IGNORAR completamente: saludos, stickers, GIFs, audios de cortesía, comentarios de relleno

DETECTAR "me_piden": true cuando alguien le está pidiendo ALGO ESPECÍFICO al dueño del teléfono (responder, confirmar, enviar, decidir algo). false cuando es información general o una pregunta al grupo.

Para grupos escolares prestá atención a: autorizaciones para firmar, pagos con fecha límite, actos/excursiones, comunicados de docentes.

Respondé SOLO con JSON válido, sin texto extra:
[{"tema":"<2-4 palabras>","resumen":"<qué pasa con datos concretos>","tipo":"<accion|pago|evento|info>","de":"<nombre del remitente>","me_piden":false,"accion":"<qué debe hacer el dueño exactamente, o null>","ids":[<id>,…]}]
Si todo es spam/saludos/irrelevante: []`;

const PROMPT_INDIVIDUALES = `Sos un asistente que analiza chats individuales de WhatsApp para su dueño y le reporta qué tiene pendiente.

Tu tarea es identificar tres tipos de cosas en las conversaciones:

1. EVENTOS: cosas con fecha/hora — turnos médicos, reuniones, citas, plazos, vencimientos, cumpleaños, entregas
2. COMPROMISOS: cosas que el dueño prometió hacer, quedó en hacer, o tiene pendiente resolver
3. PEDIDOS: cosas que otras personas le están pidiendo al dueño — responder algo, hacer algo, enviar algo, decidir algo

DIFERENCIA CLAVE:
- "compromisos" = el dueño tomó una iniciativa o prometió algo ("voy a mandar el presupuesto", "te confirmo mañana")
- "pedidos" = alguien le pide algo al dueño ("necesito que me pases X", "podés revisar Y?", "cuándo me mandás Z?")

REGLAS:
- Ignorá completamente: saludos, chistes, conversación social sin peso, stickers, GIFs, audios cortos de cortesía
- Sé preciso — indicá exactamente qué, para quién, y cuándo si aplica
- Para eventos: extraé fecha y hora en formato ISO 8601 (YYYY-MM-DD HH:MM). Si la fecha es relativa ("mañana", "el viernes"), convertíla usando la fecha de hoy
- Si el mismo chat tiene varios pedidos, listálos por separado
- Sé conservador — solo lo que realmente importa o requiere acción

Respondé SOLO con un objeto JSON válido, sin texto extra:
{
  "eventos": [{"titulo": "<qué es>", "fecha": "<YYYY-MM-DD HH:MM o YYYY-MM-DD>", "chat": "<de quién>", "detalle": "<contexto concreto>"}],
  "compromisos": [{"tema": "<2-4 palabras>", "resumen": "<qué quedó pendiente y para cuándo>", "chat": "<con quién>"}],
  "pedidos": [{"de": "<nombre de la persona>", "pedido": "<qué pide exactamente>", "chat": "<contacto>", "contexto": "<contexto breve para entender de qué trata>"}]
}

Si no hay nada relevante: {"eventos": [], "compromisos": [], "pedidos": []}`;

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

/**
 * Arma el prompt de grupos reemplazando el placeholder de contexto del dueño.
 */
function buildPromptGrupos(chatNombre) {
  const contextoDueno = buildContextoDueno();
  const base = PROMPT_GRUPOS_BASE.replace('[CONTEXTO_DUENO]', contextoDueno);
  if (chatNombre) {
    return `${base}\n\nGrupo: ${chatNombre}`;
  }
  return base;
}

async function resumirBatchChat(mensajes, promptGrupos) {
  const lista = mensajes
    .map((m) => `ID ${m.id} | De: ${m.remitente ?? m.remitente_id}\nMensaje: ${m.cuerpo}`)
    .join('\n---\n');

  const texto = await callGemini(`${promptGrupos}\n\nMensajes:\n${lista}`);
  const match = texto.match(/\[[\s\S]*\]/);
  if (!match) throw new Error(`Respuesta inesperada: ${texto.slice(0, 200)}`);
  return JSON.parse(match[0]);
}

async function resumirBatchGrupos(mensajes) {
  const lista = mensajes
    .map((m) => `ID ${m.id} | De: ${m.remitente ?? m.remitente_id} | Chat: ${m.chat_nombre ?? m.chat_id}\nMensaje: ${m.cuerpo}`)
    .join('\n---\n');

  const promptGrupos = buildPromptGrupos(null);
  const texto = await callGemini(`${promptGrupos}\n\nMensajes:\n${lista}`);
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

/**
 * Analiza mensajes de UN solo chat en batches.
 * Devuelve { temas: [...], idsProcesados: [...] }
 */
async function analizarChat(chatNombre, mensajes) {
  if (!mensajes.length) return { temas: [], idsProcesados: [] };
  const temas = [];
  const idsProcesados = [];
  const promptGrupos = buildPromptGrupos(chatNombre);

  for (let i = 0; i < mensajes.length; i += BATCH_SIZE) {
    const batch = mensajes.slice(i, i + BATCH_SIZE);
    const numBatch = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(mensajes.length / BATCH_SIZE);

    console.log(`[Gemini] Chat "${chatNombre}" — batch ${numBatch}/${totalBatches} (${batch.length} mensajes)`);

    try {
      const resultado = await resumirBatchChat(batch, promptGrupos);
      temas.push(...resultado);
      idsProcesados.push(...batch.map((m) => m.id));
      console.log(`[Gemini] Batch ${numBatch} OK — ${resultado.length} temas`);
    } catch (err) {
      console.error(`[Gemini] Error en batch ${numBatch} de "${chatNombre}":`, err.message);
    }
  }

  return { temas, idsProcesados };
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

async function analizarIndividuales(mensajes) {
  if (!mensajes.length) return { eventos: [], compromisos: [], pedidos: [], idsProcesados: [] };
  const eventos = [];
  const compromisos = [];
  const pedidos = [];
  const idsProcesados = [];
  const hoy = new Date().toISOString().slice(0, 10);

  for (let i = 0; i < mensajes.length; i += BATCH_SIZE) {
    const batch = mensajes.slice(i, i + BATCH_SIZE);
    const numBatch = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(mensajes.length / BATCH_SIZE);

    console.log(`[Gemini] Analizando individuales batch ${numBatch}/${totalBatches} (${batch.length} mensajes)`);

    try {
      const resultado = await resumirBatchIndividuales(batch, hoy);
      eventos.push(...(resultado.eventos || []));
      compromisos.push(...(resultado.compromisos || []));
      pedidos.push(...(resultado.pedidos || []));
      idsProcesados.push(...batch.map((m) => m.id));
      console.log(`[Gemini] Batch ${numBatch} OK — ${resultado.eventos?.length || 0} eventos, ${resultado.compromisos?.length || 0} compromisos, ${resultado.pedidos?.length || 0} pedidos`);
    } catch (err) {
      console.error(`[Gemini] Error en batch ${numBatch}:`, err.message);
    }
  }

  return { eventos, compromisos, pedidos, idsProcesados };
}

module.exports = { analizarMensajes, analizarChat, analizarIndividuales };
