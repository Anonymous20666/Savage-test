'use strict';
// Reproduction: WhatsApp pairing + session isolation in waManager.createSession.
// Baileys is mocked at the Module._load level BEFORE the bundle's require_bot
// factory runs, so buildRawSocket/finishSocketSetup run against a controllable
// fake socket.
const Module = require('module');
const path = require('path');
const fs = require('fs');

// ---------- mock baileys ----------
const state = {
  sockets: [],           // every socket ever built
  pairingRequests: [],   // { sessionId-ish via state dir, number }
  failNextPairing: 0     // make requestPairingCode throw N times
};

function makeFakeSock(authState) {
  const listeners = {};
  const sock = {
    authState,
    user: undefined,
    ws: { on() {}, close() {}, removeAllListeners() {} },
    ev: {
      on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
      removeAllListeners(ev) { if (ev) delete listeners[ev]; else for (const k of Object.keys(listeners)) delete listeners[k]; },
      emit(ev, ...args) { for (const fn of listeners[ev] || []) fn(...args); },
      listenerCount(ev) { return (listeners[ev] || []).length; },
      _listeners: listeners
    },
    sendMessage: async (jid, content, options) => ({ key: { id: 'X', remoteJid: jid }, message: content, options }),
    async requestPairingCode(number) {
      state.pairingRequests.push({ number, dir: sock.__dir });
      if (state.failNextPairing > 0) {
        state.failNextPairing -= 1;
        throw new Error('pairing code request failed (mock)');
      }
      return 'ABCD-EFGH';
    },
    async end() { sock.__ended = true; sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } }); },
    async logout() { sock.__loggedOut = true; },
    async groupFetchAllParticipating() { return {}; },
    async onWhatsApp() { return [{ exists: true, jid: 'x@s.whatsapp.net' }]; },
    async sendPresenceUpdate() {},
    async newsletterFollow() {}
  };
  return sock;
}

const fakeBaileys = {
  default: (opts) => {
    const authState = opts.auth;
    const sock = makeFakeSock(authState);
    sock.__dir = authState.__dir;
    sock.__opts = opts;
    state.sockets.push(sock);
    return sock;
  },
  useMultiFileAuthState: async (dir) => {
    // unique in-memory state per directory (mirrors per-session files)
    const keyPath = path.join(dir, 'creds.json');
    let creds = { registered: false };
    if (fs.existsSync(keyPath)) {
      try { creds = JSON.parse(fs.readFileSync(keyPath, 'utf8')); } catch (_) {}
    }
    const auth = { creds, keys: { get: async () => ({}), set: async () => {} }, __dir: dir };
    return {
      state: auth,
      saveCreds: async () => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(keyPath, JSON.stringify(creds));
      }
    };
  },
  fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0] }),
  DisconnectReason: { loggedOut: 401, restartRequired: 515 },
  Browsers: { ubuntu: (b) => ['Ubuntu', b, '1.0'] }
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@whiskeysockets/baileys') return fakeBaileys;
  return origLoad.apply(this, arguments);
};

// ---------- now load the bundle ----------
const H = require('./harness');
const results = [];
const ok = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

async function main() {
  const botMod = H.load('bot');
  const waManager = botMod.waManager;
  const sessionsModel = H.load('sessions');
  const { sessionIdFor } = H.load('pairingState');

  // keep sessions dir tidy for the test
  const sessionsDir = path.join(__dirname, '..', 'sessions');

  // ---- T1: two different users pair concurrently -> distinct auth dirs & state
  const idA = sessionIdFor(1111, '2348010000001');
  const idB = sessionIdFor(2222, '2348010000002');
  const [ra, rb] = await Promise.all([
    waManager.createSession({ sessionId: idA, phoneNumber: '2348010000001', ownerTelegramId: 1111, onPairingCode: () => {} }),
    waManager.createSession({ sessionId: idB, phoneNumber: '2348010000002', ownerTelegramId: 2222, onPairingCode: () => {} })
  ]);
  ok('T1 concurrent pair: both succeed', ra.success && rb.success);
  const socksOf = (sid) => state.sockets.filter((s) => (s.__dir || '').endsWith(sid));
  ok('T1 auth dirs are per-session', socksOf(idA).length >= 1 && socksOf(idB).length >= 1 && socksOf(idA)[0].__dir !== socksOf(idB)[0].__dir);
  ok('T1 sockets map holds exactly one live socket per session', waManager.getSocket(idA) && waManager.getSocket(idB) && waManager.getSocket(idA) !== waManager.getSocket(idB));
  const rowA = sessionsModel.getSessionById(idA);
  const rowB = sessionsModel.getSessionById(idB);
  ok('T1 DB rows owned by the right users', rowA && Number(rowA.owner_telegram_id) === 1111 && rowB && Number(rowB.owner_telegram_id) === 2222,
    JSON.stringify({ a: rowA && rowA.owner_telegram_id, b: rowB && rowB.owner_telegram_id }));

  // wait for the delayed requestPairingCode (3s)
  await new Promise((r) => setTimeout(r, 4500));
  ok('T1 pairing codes requested for each number',
    state.pairingRequests.some((p) => p.number === '2348010000001') && state.pairingRequests.some((p) => p.number === '2348010000002'),
    JSON.stringify(state.pairingRequests.map((p) => p.number)));

  // ---- T2: pairing-code retry must not leave a duplicate live socket behind
  const idC = sessionIdFor(3333, '2348010000003');
  state.failNextPairing = 1; // first requestPairingCode fails -> forces buildSocket retry
  await waManager.createSession({ sessionId: idC, phoneNumber: '2348010000003', ownerTelegramId: 3333, onPairingCode: () => {} });
  await new Promise((r) => setTimeout(r, 14000)); // 3s first attempt + 4s retry delay + margin
  const socksC = socksOf(idC);
  const liveC = socksC.filter((s) => !s.__ended);
  const entryListeners = socksC.map((s) => s.ev.listenerCount('creds.update'));
  console.log(`  T2: ${socksC.length} socket(s) built for retrying session, live=${liveC.length}, creds.update listeners=${JSON.stringify(entryListeners)}`);
  ok('T2 pairing retry leaves exactly ONE live socket', liveC.length === 1, `live=${liveC.length} of ${socksC.length}`);
  ok('T2 no stale socket keeps creds.update listener', entryListeners.every((n, i) => socksC[i].__ended || n === 1), JSON.stringify(entryListeners));
  ok('T2 current socket in map is the live one', waManager.getSocket(idC) === liveC[0]);

  // ---- T3: reconnect after disconnect does not duplicate listeners
  const sockC = waManager.getSocket(idC);
  sockC.authState.creds.registered = true; // pretend pairing completed
  sockC.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
  await new Promise((r) => setTimeout(r, 6500)); // reconnect delay+jitter
  const sockC2 = waManager.getSocket(idC);
  ok('T3 reconnect builds a fresh socket', sockC2 && sockC2 !== sockC);
  ok('T3 old socket disposed (no listeners)', sockC.ev.listenerCount('messages.upsert') === 0 && sockC.ev.listenerCount('connection.update') === 0);
  const upsertHandlers = sockC2 ? sockC2.ev.listenerCount('messages.upsert') : -1;
  // fresh sockets legitimately carry 2 handlers (command dispatch + anti-delete cache)
  ok('T3 new socket has the expected handler set (no duplicates)', upsertHandlers === 2, String(upsertHandlers));
  // reconnect again: the count must not grow
  sockC2.authState.creds.registered = true;
  sockC2.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
  await new Promise((r) => setTimeout(r, 6500));
  const sockC3 = waManager.getSocket(idC);
  ok('T3 second reconnect: no listener multiplication', sockC3 && sockC3 !== sockC2 && sockC3.ev.listenerCount('messages.upsert') === 2,
    sockC3 ? String(sockC3.ev.listenerCount('messages.upsert')) : 'no socket');

  // ---- T4: one session's logout does not touch another session
  const beforeA = waManager.getSocket(idA);
  await waManager.logoutSession(idB);
  ok('T4 unrelated session still live', waManager.getSocket(idA) === beforeA && waManager.getSocket(idA) !== null);
  ok('T4 logged-out session removed from map', !waManager.getSocket(idB));
  ok('T4 logged-out auth dir removed', !fs.existsSync(path.join(sessionsDir, idB)));
  ok('T4 other auth dir preserved', fs.existsSync(path.join(sessionsDir, idA)));

  // ---- T5: events from a stale socket are ignored (isolation)
  const staleSock = socksC.find((s) => s !== waManager.getSocket(idC)); // superseded socket
  const entryBefore = waManager.getEntry(idC).lastEventAt;
  staleSock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: 'x@s.whatsapp.net', id: '1' }, message: { conversation: 'hi' } }] });
  await new Promise((r) => setTimeout(r, 200));
  ok('T5 stale socket events ignored (lastEventAt unchanged)', waManager.getEntry(idC).lastEventAt === entryBefore);

  // ---- T6: DB ownership — upsert must not clobber/lose owner on status updates
  waManager.createSession({ sessionId: idA, ownerTelegramId: 1111 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  const rowA2 = sessionsModel.getSessionById(idA);
  ok('T6 owner survives session re-create', rowA2 && Number(rowA2.owner_telegram_id) === 1111, JSON.stringify(rowA2 && rowA2.owner_telegram_id));

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
