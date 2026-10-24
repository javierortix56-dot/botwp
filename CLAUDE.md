# Instrucciones para Claude Code

## Actualización de lógica de resúmenes
La especificación vigente está en RESUMENES.md y reemplaza las referencias antiguas a resumir TODOS los temas. analisis.js mantiene el estado de cada conversación por separado; incluye mensajes de JO, evidencia y relevancia. Priorizar pendientes personales abiertos, novedades útiles y acuerdos individuales. Cada digest agrega además los chats individuales donde te escribieron y no respondiste (ver RESUMENES.md → «Chats sin responder»). Pruebas: node --test --test-isolation=none test/analisis.test.js test/sin-responder.test.js.

## Qué es este proyecto
Bot de WhatsApp que monitorea mensajes, analiza con Gemini si son importantes, y manda **dos resúmenes (digests) por día — 11:00 y 21:00** al chat privado de JO. Cada digest es un único mensaje consolidado en tono de asistente personal: saludo según la hora + titular del día (frase generada por Gemini), bloque "📌 Para resolver" (acciones y pagos ordenados por urgencia — YA VENCIÓ / HOY / MAÑANA primero, usando la `fecha_limite` que extrae Gemini), bloque "📅 Se viene" (eventos en orden cronológico con fecha legible) y "💬 De qué se habló" (resumen de TODOS los temas de cada grupo, un renglón por tema aunque no involucre a JO — cumpleaños, oportunidades de venta, novedades, decisiones del grupo, etc.; consolidado por tema, máx. `resumen.max_temas_grupo` ítems por grupo, default 8). Si no hay nada relevante manda igual un mensaje corto "✅ Todo tranquilo", así JO sabe que el bot está vivo. Los horarios se configuran en `config.json` → `resumen.horas_digest`. Las **imágenes** de los chats monitoreados se describen con Gemini (multimodal) al capturarlas y esa descripción se guarda como texto del mensaje (`config.json` → `vision.describir_imagenes`, default activado) — clave para grupos tipo "roperito" donde la foto ES el contenido. **Links** e imágenes/videos/documentos sin caption también se capturan (antes se descartaban por no tener texto).

## Stack — no cambiar sin preguntar
- Node.js (CommonJS, no ESModules)
- @whiskeysockets/baileys para automatizar WhatsApp
- @google/generative-ai para Gemini 2.5 Flash Lite
- @libsql/client para Turso (base de datos)
- node-cron para el scheduler de los digests (11:00 y 21:00)
- dotenv para variables de entorno

## Hosting — no cambiar sin preguntar
- Render.com (servidor 24/7)
- Turso (base de datos SQLite en nube)
- GitHub (repositorio, auto-deploy a Render)

## Estructura de archivos — respetar siempre
```
index.js       → arranque, inicializa todo, corre el cron
whatsapp.js    → leer mensajes, enviar resumen
gemini.js      → llamadas a Gemini API
db.js          → todas las operaciones con Turso
filtros.js     → lógica de VIPs y palabras clave, opciones por grupo e intereses
formato.js     → formato puro de la sección de grupos, intereses y detalle (con tests)
panel.js       → páginas HTML del panel web (funciones puras, un solo estilo, mobile-first)
analisis.js    → motor de análisis por conversación (estado consolidado por chat)
config.json    → configuración editable por el usuario
.env           → API keys (nunca tocar ni subir a GitHub)
```

## Reglas importantes

1. Nunca modificar .env ni sugerir poner API keys en el código
2. Nunca usar ESModules (import/export), solo require()
3. Siempre manejar errores con try/catch — el bot no debe caerse por un mensaje raro
4. Los logs deben ser claros: indicar qué hora es, cuántos mensajes se procesaron, si hubo errores
5. No agregar dependencias nuevas sin preguntar primero
6. Gemini en batches de ~25 mensajes por llamada (`config.max_mensajes_por_batch`). Se subió desde 5 para darle más contexto al modelo: menos fragmentación de temas, menos duplicados y menos llamadas (más barato, no más)
7. La sesión de WhatsApp se guarda en Turso y se restaura al arrancar
8. Cada digest enviado se persiste en la tabla `reportes` y se puede auditar en el endpoint `/reportes`
9. **Modo ahorro de notificaciones** (`config.json` → `conexion.modo_ahorro_notificaciones`): **AHORA DESACTIVADO por default.** Se apagó porque desconectaba el bot casi todo el día y se perdía la mayoría de los mensajes (capturaba solo los pocos que WhatsApp reenviaba al reconectar). Con conexión **24/7** el bot captura todo en vivo; para no perder las push del teléfono re-afirma presencia `unavailable` cada 4 min (`presenciaInterval`). Si JO reporta que dejan de llegarle notificaciones al teléfono, volver a poner `modo_ahorro_notificaciones: true`. La descripción de abajo aplica solo cuando el modo ahorro está en `true`: el bot se desconecta de WhatsApp entre tareas para que el teléfono de JO quede como único dispositivo activo y las push nunca se supriman. Se conecta solo para los digests programados y los pedidos manuales; al reconectar espera a que baje la cola de mensajes offline (`esperarSincronizacion`) antes de analizar, así el digest no sale incompleto. Los mensajes que llegan mientras está desconectado los entrega WhatsApp como `append` al reconectar — no se pierde nada. No cambiar este comportamiento sin preguntar: existe porque a JO le dejaban de llegar notificaciones al teléfono. **Ventanas de conexión (aflojadas para no perder mensajes):** el bot queda conectado `conexion.minutos_conectado_tras_tarea` (default 10) minutos tras cada tarea y `esperarSincronizacion` espera hasta `conexion.sync_max_segundos` (default 240) con `conexion.sync_quiet_segundos` (default 20) de silencio. Son ventanas largas a propósito: con muchos mensajes acumulados (grupos archivados) y fallos de descifrado `Bad MAC`, Baileys reintenta pidiendo los mensajes de nuevo y esos reenvíos tardan; quedarse conectado más tiempo deja que el backlog completo y los reintentos terminen antes de desconectar. Si estas ventanas se bajan mucho, vuelve el digest "casi vacío".

10. **Panel privado**: todo el panel (salvo /health y las pantallas de estado/QR) exige la clave. El link con la clave va al final de cada resumen de WhatsApp (nunca a ntfy ni al historial) y deja una cookie de 1 año. Sin clave, el panel ofrece "mandame el link" solo al WhatsApp del dueño. No agregar rutas que muestren chats sin pasar por esa verificación.
11. **Economía de Gemini (plan gratis)**: todas las llamadas pasan por `callGemini` (cola con `gemini.min_ms_entre_llamadas`, tope `gemini.max_llamadas_dia`, reintento de 429 por minuto, corte en cuota diaria). No llamar al modelo por fuera de esa función. Contexto acotado (`resumen.mensajes_contexto`), chats con solo saludos/ok/emojis no se analizan (`esTrivial`), mensajes que fallan `resumen.max_intentos` veces se abandonan, imágenes con caché por hash y tope `vision.max_por_dia`.
12. **Config del panel en Turso** (tabla `ajustes`, clave `config_usuario`): lo que se edita en /configurar se vuelve a aplicar al arrancar; config.json en Render se pierde en cada deploy.
13. Nunca loguear objetos de sesión de Signal/Baileys: tienen claves privadas (whatsapp.js las filtra).

## Variables de entorno disponibles
- GEMINI_API_KEY
- TURSO_URL
- TURSO_TOKEN
- MY_WHATSAPP_ID
- NTFY_TOPIC (opcional: notificaciones push y alertas)
- PANEL_KEY (opcional: clave fija del panel; si falta se genera una y se guarda en Turso)
- PUBLIC_URL (opcional: URL pública; si falta se usa RENDER_EXTERNAL_URL)

## Cómo probar cambios
1. Correr localmente con `node index.js`
2. Verificar logs en consola
3. `npm test` (corre todos los tests de a uno)
4. Si funciona, hacer commit — Render despliega automáticamente

## Lo que NO hace este bot
- No responde mensajes automáticamente
- No monitorea todos los chats, solo los de config.json
- No usa WhatsApp Business API (usa Baileys)
- No compara precios ni busca productos en supermercados
