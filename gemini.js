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

El dueño quiere estar al día de TODO lo que se habla en el grupo, no solo lo que le piden. Resumí cada tema de la conversación en una línea, aunque no requiera ninguna acción de su parte.

CLASIFICÁ cada tema que se hable:
- "accion": el dueño debe responder, confirmar, firmar, traer algo, decidir, autorizar, etc.
- "pago": hay que pagar algo — cuota, actividad, servicio (incluí monto y fecha si se menciona)
- "evento": algo en fecha específica — acto, reunión, excursión, partido (incluí fecha y hora)
- "info": CUALQUIER otro tema del que se hable y valga la pena contarle al dueño, aunque no lo involucre. Incluí SIEMPRE: novedades y anuncios, oportunidades (algo que alguien vende, ofrece, regala o busca), organización y decisiones del grupo, felicitaciones (ej: cumpleaños de alguien → decí de quién es el cumple), quejas o problemas comentados, y cualquier conversación con contenido real. Resumilo en UNA línea con los datos concretos (quién, qué). Ejemplos: "Es el cumpleaños de Marta, la están saludando", "Cintia vende una bici de nena usada a $30.000", "Debaten cambiar el horario de la reunión del jueves".
- "spam": cadenas virales, publicidad masiva impersonal, memes, reenvíos sin contenido propio → OMITIR del resultado

IGNORAR solo lo verdaderamente vacío: stickers/GIFs sueltos, saludos aislados sin tema ("hola", "buen día"), "ok"/"gracias"/"jaja" sueltos, audios de cortesía.

AGRUPÁ POR TEMA: si varios mensajes hablan de lo mismo, es UN solo ítem resumido — nunca un ítem por mensaje. No repitas el mismo tema dos veces.

FECHA LÍMITE: cuando un tema tiene fecha (vencimiento de pago, fecha de evento, deadline), completá "fecha_limite" en formato YYYY-MM-DD. Convertí fechas relativas ("mañana", "el viernes") usando la fecha de hoy que se indica abajo. Si no hay fecha, null.

DETECTAR "me_piden": true cuando alguien le está pidiendo ALGO ESPECÍFICO al dueño del teléfono (responder, confirmar, enviar, decidir algo). false cuando es información general o una pregunta al grupo.

Para grupos escolares prestá atención a: autorizaciones para firmar, pagos con fecha límite, actos/excursiones, comunicados de docentes.

Respondé SOLO con JSON válido, sin texto extra:
[{"tema":"<2-4 palabras>","resumen":"<qué pasa con datos concretos>","tipo":"<accion|pago|evento|info>","de":"<nombre del remitente>","me_piden":false,"accion":"<qué debe hacer el dueño exactamente, o null>","fecha_limite":"<YYYY-MM-DD o null>","ids":[<id>,…]}]
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

function fechaHoy() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
}

async function resumirBatchChat(mensajes, promptGrupos) {
  const lista = mensajes
    .map((m) => `ID ${m.id} | De: ${m.remitente ?? m.remitente_id}\nMensaje: ${m.cuerpo}`)
    .join('\n---\n');

  const texto = await callGemini(`${promptGrupos}\n\nFecha de hoy: ${fechaHoy()}\n\nMensajes:\n${lista}`);
  const match = texto.match(/\[[\s\S]*\]/);
  if (!match) throw new Error(`Respuesta inesperada: ${texto.slice(0, 200)}`);
  return JSON.parse(match[0]);
}

async function resumirBatchGrupos(mensajes) {
  const lista = mensajes
    .map((m) => `ID ${m.id} | De: ${m.remitente ?? m.remitente_id} | Chat: ${m.chat_nombre ?? m.chat_id}\nMensaje: ${m.cuerpo}`)
    .join('\n---\n');

  const promptGrupos = buildPromptGrupos(null);
  const texto = await callGemini(`${promptGrupos}\n\nFecha de hoy: ${fechaHoy()}\n\nMensajes:\n${lista}`);
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
  if (!mensajes.length) return { temas: [], idsProcesados: [], errores: 0 };
  const temas = [];
  const idsProcesados = [];
  let errores = 0;
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
      errores++;
      console.error(`[Gemini] Error en batch ${numBatch} de "${chatNombre}":`, err.message);
    }
  }

  return { temas, idsProcesados, errores };
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
  if (!mensajes.length) return { eventos: [], compromisos: [], pedidos: [], idsProcesados: [], errores: 0 };
  const eventos = [];
  const compromisos = [];
  const pedidos = [];
  const idsProcesados = [];
  let errores = 0;
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
      errores++;
      console.error(`[Gemini] Error en batch ${numBatch}:`, err.message);
    }
  }

  return { eventos, compromisos, pedidos, idsProcesados, errores };
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

module.exports = { analizarMensajes, analizarChat, analizarIndividuales, generarTitular };
