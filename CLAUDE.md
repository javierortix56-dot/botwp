# Instrucciones para Claude Code

## Qué es este proyecto
Bot de WhatsApp que monitorea mensajes, analiza con Gemini si son importantes, y manda **dos resúmenes (digests) por día — 11:00 y 21:00** al chat privado del dueño. Cada digest es un único mensaje consolidado en tono de asistente personal: saludo según la hora + titular del día (frase generada por Gemini), bloque "📌 Para resolver" (acciones y pagos ordenados por urgencia — YA VENCIÓ / HOY / MAÑANA primero, usando la `fecha_limite` que extrae Gemini), bloque "📅 Se viene" (eventos en orden cronológico con fecha legible) y "💬 De qué se habló" (resumen de TODOS los temas de cada grupo, un renglón por tema aunque no involucre al dueño — cumpleaños, oportunidades de venta, novedades, decisiones del grupo, etc.; consolidado por tema, máx. `resumen.max_temas_grupo` ítems por grupo, default 8). Si no hay nada relevante manda igual un mensaje corto "✅ Todo tranquilo", así el dueño sabe que el bot está vivo. Los horarios se configuran en `config.json` → `resumen.horas_digest`.

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
filtros.js     → lógica de VIPs y palabras clave
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
9. **Modo ahorro de notificaciones** (`config.json` → `conexion.modo_ahorro_notificaciones`, default activado): el bot se desconecta de WhatsApp entre tareas para que el teléfono del dueño quede como único dispositivo activo y las push nunca se supriman. Se conecta solo para los digests programados y los pedidos manuales; al reconectar espera a que baje la cola de mensajes offline (`esperarSincronizacion`) antes de analizar, así el digest no sale incompleto. Los mensajes que llegan mientras está desconectado los entrega WhatsApp como `append` al reconectar — no se pierde nada. No cambiar este comportamiento sin preguntar: existe porque al dueño le dejaban de llegar notificaciones al teléfono. **Ventanas de conexión (aflojadas para no perder mensajes):** el bot queda conectado `conexion.minutos_conectado_tras_tarea` (default 10) minutos tras cada tarea y `esperarSincronizacion` espera hasta `conexion.sync_max_segundos` (default 240) con `conexion.sync_quiet_segundos` (default 20) de silencio. Son ventanas largas a propósito: con muchos mensajes acumulados (grupos archivados) y fallos de descifrado `Bad MAC`, Baileys reintenta pidiendo los mensajes de nuevo y esos reenvíos tardan; quedarse conectado más tiempo deja que el backlog completo y los reintentos terminen antes de desconectar. Si estas ventanas se bajan mucho, vuelve el digest "casi vacío".

## Variables de entorno disponibles
- GEMINI_API_KEY
- TURSO_URL
- TURSO_TOKEN
- MY_WHATSAPP_ID

## Cómo probar cambios
1. Correr localmente con `node index.js`
2. Verificar logs en consola
3. Si funciona, hacer commit — Render despliega automáticamente

## Lo que NO hace este bot
- No responde mensajes automáticamente
- No monitorea todos los chats, solo los de config.json
- No usa WhatsApp Business API (usa Baileys)
- No compara precios ni busca productos en supermercados
