const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('./config.json');
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

const BATCH_SIZE = config.resumen.max_mensajes_por_batch;

const PROMPT_GRUPOS = `Sos un asistente que analiza grupos de WhatsApp y le reporta al dueño del teléfono qué necesita saber o hacer.

Se te dan mensajes de distintos grupos. Tu trabajo es identificar temas relevantes y determinar con precisión qué implica cada uno para el dueño.

CLASIFICACIÓN DE TEMAS:
- "accion": el dueño debe responder, confirmar, firmar, traer algo, decidir, autorizar, etc.
- "pago": hay que pagar algo — cuota, excursión, materiales, servicio, etc.
- "evento": algo que ocurre en una fecha específica — acto, reunión, excursión, partido, etc.
- "info": información útil pero sin acción requerida del dueño

PARA GRUPOS ESCOLARES prestá especial atención a:
- Autorizaciones para firmar o devolver (indicá el plazo si lo hay)
- Pagos: cuotas, actividades, materiales, viajes (incluí monto y fecha límite si se mencionan)
- Eventos: actos patrios, obras de teatro, excursiones, competencias, jornadas especiales
- Comunicados de docentes o dirección con instrucciones para los padres
- Cosas que los chicos deben llevar o traer

REGLAS:
- Ignorá completamente: saludos, GIFs, stickers, audios de cortesía, chistes, spam, comentarios sin contenido
- Una oración precisa por tema, sin vaguedades — si hay fecha, monto o destinatario específico, incluílos
- El campo "accion" debe decir exactamente qué tiene que hacer el dueño (o null si es solo info)
- No agrupés temas distintos — mejor dos entradas separadas que una entrada confusa

Respondé SOLO con un array JSON válido, sin texto extra antes ni después:
[{"tema": "<2-4 palabras>", "resumen": "<qué pasa, con datos concretos>", "chat": "<nombre del grupo>", "ids": [<id>, ...], "tipo": "<accion|pago|evento|info>", "accion": "<qué debe hacer el dueño exactamente, o null>"}]

Si todos los mensajes son irrelevantes (saludos, spam, etc.), devolvé: []`;

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
  if (!mensajes.length) return { eventos: [], compromisos: [], pedidos: [] };
  const eventos = [];
  const compromisos = [];
  const pedidos = [];
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
      console.log(`[Gemini] Batch ${numBatch} OK — ${resultado.eventos?.length || 0} eventos, ${resultado.compromisos?.length || 0} compromisos, ${resultado.pedidos?.length || 0} pedidos`);
    } catch (err) {
      console.error(`[Gemini] Error en batch ${numBatch}:`, err.message);
    }
  }

  return { eventos, compromisos, pedidos };
}

const PROMPT_PRECIOS = `Sos un asistente que analiza precios de supermercados para optimizar las compras de una familia argentina.

Se te da una lista de productos con los precios encontrados en Carrefour, Jumbo y Coto. Tu tarea es armar la estrategia de compra más inteligente.

REGLAS:
- Si la diferencia entre supermercados es menor a 5%, no vale la pena dividir el viaje por ese producto
- Agrupá los productos por supermercado donde conviene comprarlos
- Si hay descuento (precioOriginal > precio), mencionalo como "en oferta"
- Si un producto no se encontró en algún super, indicalo
- Calculá el ahorro total estimado vs comprar todo en el más caro
- Sé directo y práctico — el objetivo es ahorrar tiempo y plata

Respondé en texto plano formateado para WhatsApp (usá *negrita* y saltos de línea). Estructura:
1. Primero la estrategia recomendada por supermercado
2. Después los productos sin resultados (si hay)
3. Al final el ahorro estimado`;

async function analizarPrecios(resultados) {
  const lista = resultados.map(({ producto, resultados: r }) => {
    if (!r.length) return `${producto}: sin resultados`;
    const precios = r.map((x) => {
      const oferta = x.precioOriginal > x.precio ? ` (antes $${x.precioOriginal.toFixed(0)})` : '';
      return `${x.supermercado}: $${x.precio.toFixed(0)}${oferta}`;
    }).join(' | ');
    return `${producto}: ${precios}`;
  }).join('\n');

  const texto = await callGemini(`${PROMPT_PRECIOS}\n\nProductos y precios:\n${lista}`);
  return texto;
}

const PROMPT_PRODUCTO_DETALLADO = `Comparás precios de supermercados argentinos. Se te dan resultados de Carrefour, Jumbo y Coto con varias presentaciones.

Respondé en máximo 8 líneas para WhatsApp (*negrita*). Sin repetir datos. Sin secciones vacías.

Formato:
🏆 *Mejor opción:* [super] — [producto] $[precio] ([precio/litro o kg si aplica])
🏷️ *Promos:* [solo si hay descuento real, sino omitir esta línea]
📦 *Por super:* [Jumbo: mejor opción | Carrefour: mejor opción | Coto: mejor opción o "sin resultados"]
💡 [Una sola oración de recomendación concreta]`;

async function analizarProductoDetallado({ query, carrefour, jumbo, coto }) {
  const formatear = (items, super_) => {
    if (!items.length) return `${super_}: sin resultados`;
    return items.map((x) => {
      const promo = x.tienePromo ? ` 🏷️ OFERTA (antes $${x.precioOriginal.toFixed(0)})` : '';
      return `  • ${x.nombre}: $${x.precio.toFixed(0)}${promo}`;
    }).join('\n');
  };

  const lista = [
    `Búsqueda: "${query}"`,
    '',
    `JUMBO:\n${formatear(jumbo, 'Jumbo')}`,
    `CARREFOUR:\n${formatear(carrefour, 'Carrefour')}`,
    `COTO:\n${formatear(coto, 'Coto')}`,
  ].join('\n');

  return callGemini(`${PROMPT_PRODUCTO_DETALLADO}\n\nResultados:\n${lista}`);
}

module.exports = { analizarMensajes, analizarIndividuales, analizarPrecios, analizarProductoDetallado };
