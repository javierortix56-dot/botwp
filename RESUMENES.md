# Resúmenes centrados en JO

- Se capturan mensajes recibidos y enviados; `es_propio` se agrega de forma aditiva a Turso al arrancar. No cambia la sesión de WhatsApp.
- Cada chat se analiza por separado. Cada bloque actualiza un estado consolidado, incluyendo resoluciones y cancelaciones posteriores.
- Solo acciones y pagos explícitamente aplicables a JO y pendientes aparecen en «Para resolver». Fechas relativas usan la fecha del mensaje en Buenos Aires.
- Se agregan novedades relevantes de grupos y síntesis de conversaciones individuales. La selección usa los grupos configurados, no el estado archivado de WhatsApp.
- El digest automático lee hasta 50 mensajes ya procesados de los últimos siete días por chat activo como contexto. No los marca de nuevo ni repite temas sin evidencia nueva.
- **Chats sin responder** (`config.sin_responder`): cada digest incluye «💬 Te escribieron y no respondiste», con los chats individuales de los últimos 7 días cuyo último mensaje es de la otra persona, tiene al menos 3 horas y no tiene respuesta de JO. Se calcula con `es_propio`, no con el estado de leído, así que cuenta aunque JO lo haya leído. Gemini descarta en una sola llamada los que no esperan respuesta (agradecimientos, stickers, avisos automáticos, códigos). No marca nada: el chat sigue apareciendo hasta que JO contesta. Si Gemini falla, se muestran todos con un aviso. El botón «Chats sin responder» de la página del bot (`/sin-responder`) manda solo esa lista. Solo aplica a chats individuales, no a grupos.
- **Detalle de grupos** (en `config.json`, por grupo, editable desde `/configurar`):
  - `"modo": "catalogo"` para grupos de compraventa (ej. el Roperito): cada artículo ofrecido o buscado es un ítem propio, agrupado por vendedor, con precio y datos si se mencionan; los vendidos se ocultan en WhatsApp y se muestran tachados en el detalle. Tope en WhatsApp: `resumen.max_items_catalogo` (20).
  - `"detalle": "alto"`: no se filtra por interés ni se descartan ofertas, cumpleaños ni temas de relevancia 1, y cada tema puede ocupar hasta 2 frases. Tope en WhatsApp: `resumen.max_temas_grupo_alto` (40). `"detalle": "normal"` vuelve al resumen estricto (tope `max_temas_grupo`, máximo 5).
  - **Defecto**: `resumen.detalle_defecto: "alto"` aplica el detalle alto a todo chat sin `detalle` propio, individuales incluidos (de esos se muestran hasta `resumen.max_temas_conversacion`, 8). Para volver al resumen estricto en todos: `"detalle_defecto": "normal"`.
  - Cuando el mensaje de WhatsApp deja ítems afuera se guarda el **detalle completo** (sin topes, con vendidos y charla menor) como reporte y se agrega al final el link `/reporte?id=N`. La base URL sale de `PUBLIC_URL` o `RENDER_EXTERNAL_URL`.
  - **Intereses** (`resumen.intereses`, lista de palabras): cualquier mensaje recibido que las mencione, en cualquier chat, aparece en «🔔 Coincidencias con tus intereses». Búsqueda sin acentos ni mayúsculas, desde inicio de palabra; no usa Gemini.
- Tus audios, stickers y reacciones en chats individuales se guardan con un marcador (`[nota de voz]`, `[sticker]`, `[reacción 👍]`) para que cuenten como respuesta en «sin responder».
- Cada tema requiere ids válidos de evidencia. Un fallo de análisis deja el chat pendiente y evita publicar un estado parcial.
- Sin dependencias o servicios pagos nuevos. El contexto y separar chats pueden aumentar el uso de la cuota existente de Gemini; no se modifica facturación ni modelo.

## Límites

La clasificación sigue dependiendo de Gemini. Las pruebas simulan sus respuestas: validan aislamiento, consolidación y fallos, no garantizan su precisión semántica real. Las respuestas propias descartadas anteriormente no están disponibles salvo que WhatsApp las reenvíe. Audios y contenido interno de documentos no se transcriben. No es un gestor persistente de tareas: el contexto es limitado y no recuerda indefinidamente pendientes antiguos.

## Verificación

`npm test` (corre los tests de a uno: uno de ellos escribe config.json)

Después del despliegue, verificar conexión y revisar el siguiente digest con conversaciones reales, especialmente solicitudes ya contestadas y pagos de terceros.
