# Instrucciones para Claude Code

## Qué es este proyecto
Bot de WhatsApp que monitorea mensajes cada hora, analiza con Gemini si son importantes, y manda un resumen al chat privado del dueño.

## Stack — no cambiar sin preguntar
- Node.js (CommonJS, no ESModules)
- whatsapp-web.js para automatizar WhatsApp
- @google/generative-ai para Gemini 2.0 Flash
- @libsql/client para Turso (base de datos)
- node-cron para el scheduler cada hora
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
6. Gemini siempre en batches de 5 mensajes por llamada para no desperdiciar cuota
7. La sesión de WhatsApp se guarda en Turso y se restaura al arrancar

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
- No usa WhatsApp Business API (usa whatsapp-web.js)
- No tiene interfaz web ni dashboard
