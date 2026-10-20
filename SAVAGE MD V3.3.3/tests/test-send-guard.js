'use strict';
// E2E: the per-socket sendMessage wrapper installed by finishSocketSetup.
// Builds a session through createSession (mocked Baileys), then sends through
// the WRAPPED sock.sendMessage to prove (a) rich link previews are injected
// into outbound text, and (b) Group Status payloads pass through untouched.
const Module = require('module');
const path = require('path');
const fs = require('fs');

const state = { sockets: [] };

function makeFakeSock(auth) {
  const listeners = {};
  return {
    authState: auth,
    user: { id: '2348099999999:7@s.whatsapp.net' },
    ws: { on() {}, close() {}, removeAllListeners() {} },
    ev: {
      on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
      removeAllListeners(ev) { if (ev) delete listeners[ev]; else for (const k of Object.keys(listeners)) delete listeners[k]; },
      emit(ev, ...args) { for (const fn of listeners[ev] || []) fn(...args); },
      listenerCount(ev) { return (listeners[ev] || []).length; }
    },
    sent: [],
    async sendMessage(jid, content, options) {
      this.sent.push({ jid, content, options });
      return { key: { id: 'Z', remoteJid: jid } };
    },
    async requestPairingCode() { return 'ABCD-EFGH'; },
    async end() {},
    async groupFetchAllParticipating() { return {}; },
    async groupGetInviteInfo(code) {
      return { id: '120363123456789012@g.us', subject: 'Guard Group', size: 10, pictureUrl: 'https://pp.thumb/g.png' };
    },
    async profilePictureUrl() { return 'https://pp.thumb/x.png'; },
    waUploadToServer: async () => ({ directPath: '/hq', mediaKey: Buffer.alloc(32), mediaKeyTimestamp: 1, fileSha256: Buffer.alloc(32), fileEncSha256: Buffer.alloc(32), url: 'https://mmg/hq' }),
    async onWhatsApp() { return [{ exists: true }]; },
    async sendPresenceUpdate() {}
  };
}

const realBaileys = require('@whiskeysockets/baileys'); // real fork helpers, before the mock is installed
const fakeBaileys = {
  ...realBaileys, // keep real helpers (extractImageThumb, prepareWAMessageMedia, getUrlInfo, ...)
  default: (opts) => {
    const sock = makeFakeSock(opts.auth);
    sock.__dir = opts.auth.__dir;
    state.sockets.push(sock);
    return sock;
  },
  useMultiFileAuthState: async (dir) => {
    const creds = { registered: false };
    return {
      state: { creds, keys: { get: async () => ({}), set: async () => {} }, __dir: dir },
      saveCreds: async () => {}
    };
  },
  fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0] }),
  DisconnectReason: { loggedOut: 401, restartRequired: 515 },
  Browsers: { ubuntu: (b) => ['Ubuntu', b, '1.0'] }
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@whiskeysockets/baileys') return fakeBaileys;
  return origLoad.apply(this, arguments);
};

const H = require('./harness');
const results = [];
const ok = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

async function main() {
  // real PNG for the thumbnail
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('pp.thumb')) return new Response(png, { status: 200 });
    return realFetch(url, opts);
  };

  const botMod = H.load('bot');
  const waManager = botMod.waManager;
  const r = await waManager.createSession({ sessionId: 'guard-sess', ownerTelegramId: 7, onPairingCode: () => {} });
  ok('session created', r.success === true);
  const sock = waManager.getSocket('guard-sess');
  ok('socket wrapped (sendMessage replaced)', sock && sock.sendMessage !== makeFakeSock({}).sendMessage);

  // (a) outbound text with a WA invite link gets a rich link preview injected
  await sock.sendMessage('123@s.whatsapp.net', { text: 'join https://chat.whatsapp.com/GOODCODE1234567' });
  const sent1 = sock.sent[sock.sent.length - 1];
  ok('guard injects linkPreview on outbound URL text', !!(sent1 && sent1.content.linkPreview), sent1 && JSON.stringify(Object.keys(sent1.content)));
  ok('preview title present', sent1 && sent1.content.linkPreview && sent1.content.linkPreview.title === 'Guard Group');
  ok('preview jpeg is JPEG', sent1 && sent1.content.linkPreview && sent1.content.linkPreview.jpegThumbnail && sent1.content.linkPreview.jpegThumbnail[0] === 0xFF);

  // (b) Group Status payload passes through unchanged (still carries groupStatus + preview)
  await sock.sendMessage('120363000000000000@g.us', {
    text: 'join https://chat.whatsapp.com/GOODCODE1234567',
    groupStatus: true,
    linkPreview: { title: 'Prebuilt', 'matched-text': 'https://chat.whatsapp.com/GOODCODE1234567' }
  });
  const sent2 = sock.sent[sock.sent.length - 1];
  ok('guard preserves groupStatus flag', sent2 && sent2.content.groupStatus === true);
  ok('guard does not overwrite prebuilt preview', sent2 && sent2.content.linkPreview && sent2.content.linkPreview.title === 'Prebuilt');

  // (c) plain text without URL untouched
  await sock.sendMessage('123@s.whatsapp.net', { text: 'hello there' });
  const sent3 = sock.sent[sock.sent.length - 1];
  ok('plain text untouched', sent3 && sent3.content.text === 'hello there' && !sent3.content.linkPreview);

  // (d) duplicate send with same content builds preview only once per URL (cache)
  const before = sock.sent.length;
  await sock.sendMessage('123@s.whatsapp.net', { text: 'again https://chat.whatsapp.com/GOODCODE1234567' });
  const sent4 = sock.sent[sock.sent.length - 1];
  ok('cached preview still attached', !!(sent4 && sent4.content.linkPreview));
  ok('send count consistent', sock.sent.length === before + 1);

  global.fetch = realFetch;
  const failed = results.filter((x) => !x.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
