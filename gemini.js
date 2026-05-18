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

const PROMPT_INDIVIDUALES = `Analizás chats 1-a-1 de WhatsApp. Todos los mensajes que recibís son de la otra persona dirigidos al dueño del teléfono.
[CONTEXTO_DUENO]

Identificá solo lo que impacta directamente en el dueño:

1. EVENTOS: solo fechas donde el dueño debe estar presente o actuar — su propio turno médico, una entrega que va a recibir, un vencimiento que le aplica, una reunión a la que debe ir. NO incluyas eventos de la vida de la otra persona aunque los mencione ("llevo a mi mamá al médico" no es un evento del dueño).

2. COMPROMISOS: cosas que el dueño prometió o tiene pendiente hacer. Sé muy específico — qué exactamente y para cuándo. Nunca escribas cosas vagas como "resolver algo" o "confirmar algo" sin aclarar QUÉ.

3. PEDIDOS: cosas concretas que la otra persona le está pidiendo al dueño en esa conversación. Cada pedido distinto va separado. Solo incluí pedidos reales — preguntas dirigidas al dueño que esperan respuesta o acción.

REGLAS:
- Ignorá: saludos, chistes, conversación social, info sobre la vida de la otra persona sin impacto en el dueño, stickers, GIFs
- Para eventos: fecha ISO 8601 (YYYY-MM-DD o YYYY-MM-DD HH:MM). Si es relativa ("mañana"), convertíla usando la fecha de hoy
- Sé conservador — solo lo que realmente requiere atención del dueño

Respondé SOLO con un objeto JSON válido, sin texto extra:
{
  "eventos": [{"titulo": "<qué es>", "fecha": "<YYYY-MM-DD HH:MM o YYYY-MM-DD>", "chat": "<de quién>", "detalle": "<contexto concreto>"}],
  "compromisos": [{"tema": "<2-4 palabras específicas>", "resumen": "<qué exactamente quedó pendiente y para cuándo>", "chat": "<con quién>"}],
  "pedidos": [{"de": "<nombre de la persona>", "pedido": "<qué pide exactamente>", "chat": "<contacto>", "contexto": "<contexto breve>"}]
}

Si no hay nada relevante para el dueño: {"eventos": [], "compromisos": [], "pedidos": []}`;

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

function resolverNombreContacto(m, contactos) {
  if (m.remitente && !m.remitente.includes('@')) return m.remitente;
  const jid = m.remitente_id || m.chat_id || '';
  const desdeAgenda = contactos.get(jid);
  if (desdeAgenda) return desdeAgenda;
  if (jid.includes('@')) {
    const num = jid.split('@')[0];
    return num.match(/^\d+$/) ? `+${num}` : jid;
  }
  return jid || 'Desconocido';
}

async function resumirBatchIndividuales(mensajes, hoy, contactos = new Map()) {
  const lista = mensajes
    .map((m) => `ID ${m.id} | De: ${resolverNombreContacto(m, contactos)}\nMensaje: ${m.cuerpo}`)
    .join('\n---\n');

  const contextoDueno = buildContextoDueno();
  const prompt = PROMPT_INDIVIDUALES.replace('[CONTEXTO_DUENO]', contextoDueno);
  const texto = await callGemini(`${prompt}\n\nFecha de hoy: ${hoy}\n\nMensajes:\n${lista}`);
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

async function analizarIndividuales(mensajes, contactos = new Map()) {
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
      const resultado = await resumirBatchIndividuales(batch, hoy, contactos);
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
