// Mensajes propios sin texto (nota de voz, sticker, reacción): se guardan con un
// marcador para que un chat contestado con un audio no figure como "sin responder".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const stubs = {
  '@whiskeysockets/baileys': { default() {}, DisconnectReason: {}, fetchLatestBaileysVersion() {}, downloadMediaMessage() {} },
  pino: () => ({}),
  dotenv: { config() {} },
  './db': {},
  './filtros': {},
  './gemini': {},
};
const cargaOriginal = Module._load;
Module._load = function (pedido, ...resto) {
  return Object.prototype.hasOwnProperty.call(stubs, pedido) ? stubs[pedido] : cargaOriginal.call(this, pedido, ...resto);
};
const { marcadorMensajePropio, cuerpoParaGuardar } = require('../whatsapp');

const individual = '5491100000000@s.whatsapp.net';
const grupo = '120363000000000000@g.us';
const mensaje = (message, { fromMe = true, remoteJid = individual } = {}) => ({ key: { fromMe, remoteJid }, message });

test('nota de voz, audio, sticker, contacto, ubicación y encuesta tienen marcador', () => {
  assert.equal(marcadorMensajePropio({ audioMessage: { ptt: true } }), '[nota de voz]');
  assert.equal(marcadorMensajePropio({ audioMessage: { ptt: false } }), '[audio]');
  assert.equal(marcadorMensajePropio({ stickerMessage: {} }), '[sticker]');
  assert.equal(marcadorMensajePropio({ contactMessage: {} }), '[contacto]');
  assert.equal(marcadorMensajePropio({ locationMessage: {} }), '[ubicación]');
  assert.equal(marcadorMensajePropio({ pollCreationMessageV3: {} }), '[encuesta]');
});

test('una reacción cuenta como respuesta, pero quitarla (texto vacío) no', () => {
  assert.equal(marcadorMensajePropio({ reactionMessage: { text: '👍' } }), '[reacción 👍]');
  assert.equal(marcadorMensajePropio({ reactionMessage: { text: '' } }), '');
});

test('atraviesa los envoltorios de mensaje temporal y de ver una vez', () => {
  assert.equal(marcadorMensajePropio({ ephemeralMessage: { message: { audioMessage: { ptt: true } } } }), '[nota de voz]');
});

test('un tipo desconocido no genera marcador', () => {
  assert.equal(marcadorMensajePropio({ protocolMessage: {} }), '');
  assert.equal(marcadorMensajePropio(null), '');
});

test('mensaje propio sin texto en chat individual: se guarda con marcador', () => {
  assert.equal(cuerpoParaGuardar(mensaje({ audioMessage: { ptt: true } })), '[nota de voz]');
});

test('el texto real siempre tiene prioridad sobre el marcador', () => {
  assert.equal(cuerpoParaGuardar(mensaje({ conversation: 'dale, mañana nos vemos' })), 'dale, mañana nos vemos');
});

test('mensajes ajenos sin texto y propios en grupos siguen descartándose', () => {
  assert.equal(cuerpoParaGuardar(mensaje({ audioMessage: { ptt: true } }, { fromMe: false })), '');
  assert.equal(cuerpoParaGuardar(mensaje({ stickerMessage: {} }, { remoteJid: grupo })), '');
});
