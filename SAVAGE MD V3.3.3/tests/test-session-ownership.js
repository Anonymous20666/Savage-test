'use strict';
// Regression: session row ownership/phone survival across upserts, and
// WA-side .pair instance scoping (master vs clone namespaces).
const H = require('./harness');

const results = [];
const ok = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

function main() {
  const sessionsModel = H.load('sessions');

  // ---- upsert preserves owner + phone when called with nulls (status-only update)
  sessionsModel.upsertSession({ sessionId: 'own-test-1', ownerTelegramId: 4242, phoneNumber: '2348012345678', status: 'pairing' });
  sessionsModel.upsertSession({ sessionId: 'own-test-1', ownerTelegramId: null, phoneNumber: null, status: 'connected' });
  let row = sessionsModel.getSessionById('own-test-1');
  ok('status-only upsert keeps owner', row && Number(row.owner_telegram_id) === 4242, JSON.stringify(row && row.owner_telegram_id));
  ok('status-only upsert keeps phone', row && row.phone_number === '2348012345678', JSON.stringify(row && row.phone_number));
  ok('status-only upsert applies new status', row && row.status === 'connected');

  // ---- a REAL owner supplied later repairs an orphaned/NULL owner row
  sessionsModel.upsertSession({ sessionId: 'own-test-2', ownerTelegramId: null, phoneNumber: '2348099999999', status: 'pairing' });
  row = sessionsModel.getSessionById('own-test-2');
  ok('orphan row starts with NULL owner', row && row.owner_telegram_id == null);
  sessionsModel.upsertSession({ sessionId: 'own-test-2', ownerTelegramId: 5151, phoneNumber: '2348099999999', status: 'pairing' });
  row = sessionsModel.getSessionById('own-test-2');
  ok('repair upsert assigns the real owner', row && Number(row.owner_telegram_id) === 5151, JSON.stringify(row && row.owner_telegram_id));

  // ---- findSessionByOwnerAndPhone now finds the repaired row
  const found = sessionsModel.findSessionByOwnerAndPhone(5151, '2348099999999');
  ok('owner lookup finds repaired session', found && found.session_id === 'own-test-2');
  const owned = sessionsModel.listSessionsByOwner(5151).map((s) => s.session_id);
  ok('owner session list includes repaired session', owned.includes('own-test-2'));

  // ---- phone never blanked by repair/restart without phone
  sessionsModel.upsertSession({ sessionId: 'own-test-3', ownerTelegramId: 6262, phoneNumber: '2348055555555', status: 'pairing' });
  sessionsModel.upsertSession({ sessionId: 'own-test-3', ownerTelegramId: 6262, phoneNumber: null, status: 'pairing' });
  row = sessionsModel.getSessionById('own-test-3');
  ok('phone survives restart-without-phone', row && row.phone_number === '2348055555555', JSON.stringify(row && row.phone_number));

  // ---- cleanup
  sessionsModel.removeSession('own-test-1');
  sessionsModel.removeSession('own-test-2');
  sessionsModel.removeSession('own-test-3');
  ok('cleanup done', !sessionsModel.getSessionById('own-test-1'));

  // ---- WA-side .pair instance scoping (module-level logic, exercised directly)
  const cloneRuntime = H.load('cloneRuntime');
  ok('cloneOfSession master session -> null', cloneRuntime.cloneOfSession('tg123_234801') === null);
  ok('cloneOfSession clone session -> clone id', cloneRuntime.cloneOfSession('clone_deadbeef__tg123_234801') === 'clone_deadbeef');
  const guardMaster = cloneRuntime.resolvePairingSession('tg9_23480', null);
  ok('master pairing stays unprefixed', guardMaster.ok && guardMaster.sessionId === 'tg9_23480');
  const foreignRow = { session_id: 'clone_deadbeef__tg9_23480' };
  const guardForeign = cloneRuntime.resolvePairingSession('tg9_23480', foreignRow);
  ok('existing session on another instance is rejected', !guardForeign.ok, guardForeign.message);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main();
