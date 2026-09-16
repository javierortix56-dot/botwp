# Resúmenes centrados en el dueño

- Se capturan mensajes recibidos y enviados; `es_propio` se agrega de forma aditiva a Turso al arrancar. No cambia la sesión de WhatsApp.
- Cada chat se analiza por separado. Cada bloque actualiza un estado consolidado, incluyendo resoluciones y cancelaciones posteriores.
- Solo acciones y pagos explícitamente aplicables al dueño y pendientes aparecen en «Para resolver». Fechas relativas usan la fecha del mensaje en Buenos Aires.
- Se agregan novedades relevantes de grupos y síntesis de conversaciones individuales. La selección usa los grupos configurados, no el estado archivado de WhatsApp.
- El digest automático lee hasta 50 mensajes ya procesados de los últimos siete días por chat activo como contexto. No los marca de nuevo ni repite temas sin evidencia nueva.
- Cada tema requiere ids válidos de evidencia. Un fallo de análisis deja el chat pendiente y evita publicar un estado parcial.
- Sin dependencias o servicios pagos nuevos. El contexto y separar chats pueden aumentar el uso de la cuota existente de Gemini; no se modifica facturación ni modelo.

## Límites

La clasificación sigue dependiendo de Gemini. Las pruebas simulan sus respuestas: validan aislamiento, consolidación y fallos, no garantizan su precisión semántica real. Las respuestas propias descartadas anteriormente no están disponibles salvo que WhatsApp las reenvíe. Audios y contenido interno de documentos no se transcriben. No es un gestor persistente de tareas: el contexto es limitado y no recuerda indefinidamente pendientes antiguos.

## Verificación

`node --test --test-isolation=none test/analisis.test.js`

Después del despliegue, verificar conexión y revisar el siguiente digest con conversaciones reales, especialmente solicitudes ya contestadas y pagos de terceros.
