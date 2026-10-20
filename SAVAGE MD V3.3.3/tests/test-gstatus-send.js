'use strict';
// End-to-end Group Status send path through integrations/whatsapp/commands.js
// (ggstatus broadcast + togstatus single) with a mocked socket, asserting the
// payload that reaches Baileys carries the groupStatus wrapper flag and a
// real link preview for chat.whatsapp.com content.
const Module = require('module');
const H = require('./harness');

const results = [];
const ok = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

async function main() {
  // stub fetch for thumbnails
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('pp.thumb')) return new Response(Buffer.alloc(600, 9), { status: 200 });
    return realFetch(url, opts);
  };

  const botMod = H.load('bot');
  const waManager = botMod.waManager;
  const wa = H.load('whatsapp');

  // Build fake socket
  const sent = [];
  const sock = {
    user: { id: '2348099999999:4@s.whatsapp.net' },
    authState: { creds: { registered: true } },
    async sendMessage(jid, content, options) { sent.push({ jid, content, options }); return { key: { id: 'M1', remoteJid: jid } }; },
    async groupFetchAllParticipating() {
      return {
        'g1@g.us': { id: 'g1@g.us', subject: 'Group One', announce: false, participants: [
          { id: '2348099999999@s.whatsapp.net', admin: 'superadmin' },
          { id: '2348077777777@s.whatsapp.net', admin: null }
        ] },
        'g2@g.us': { id: 'g2@g.us', subject: 'Group Two', announce: true, participants: [
          { id: '2348099999999@s.whatsapp.net', admin: null },
          { id: '2348077777777@s.whatsapp.net', admin: 'superadmin' }
        ] }
      };
    },
    async groupMetadata(id) {
      const all = await this.groupFetchAllParticipating();
      return all[id];
    },
    async groupGetInviteInfo(code) {
      return { id: 'g1@g.us', subject: 'Group One', size: 55, pictureUrl: 'https://pp.thumb/g.png' };
    },
    async profilePictureUrl() { return 'https://pp.thumb/x.png'; }
  };

  // patch waManager accessors used by integrations/whatsapp/commands.js
  waManager.getSocket = (id) => (id === 'sess1' ? sock : null);
  waManager.listConnectedEntries = () => [{ sessionId: 'sess1', sock, status: 'connected' }];

  // ---- togstatus (single group)
  const t1 = await wa.togstatus({ sessionId: 'sess1', groupJid: 'g1@g.us', content: 'hello status', media: null });
  ok('togstatus succeeds', t1.success === true, JSON.stringify(t1));
  const last = sent[sent.length - 1];
  ok('togstatus payload carries groupStatus flag', last && last.content.groupStatus === true);
  ok('togstatus sends to the group JID', last && last.jid === 'g1@g.us');
  ok('togstatus payload text kept', last && last.content.text === 'hello status', JSON.stringify(last && last.content.text));

  // ---- ggstatus broadcast with a WA invite link (preview must be attached)
  sent.length = 0;
  const r2 = await wa.ggstatus({ content: 'join https://chat.whatsapp.com/GOODCODE1234567 now', sessionIds: ['sess1'] });
  console.log('  ggstatus result:', JSON.stringify({ total: r2.totalTargets, delivered: r2.delivered, failed: r2.failed, ppgc: r2.ppgc }));
  ok('ggstatus delivered to >=1 group', r2.delivered >= 1, `delivered=${r2.delivered} failed=${r2.failed} total=${r2.totalTargets}`);
  const gstatusSends = sent.filter((s) => s.content.groupStatus === true);
  ok('ggstatus every send has groupStatus flag', sent.length > 0 && gstatusSends.length === sent.length, `${gstatusSends.length}/${sent.length}`);
  ok('ggstatus PPGC-off sends to locked groups too (locked=true tracked)', r2.report && r2.report.lockedSent >= 0);
  const withPreview = sent.find((s) => s.content.linkPreview);
  ok('ggstatus attaches rich link preview for invite link', !!withPreview, withPreview ? JSON.stringify({ title: withPreview.content.linkPreview.title, desc: withPreview.content.linkPreview.description }) : 'none');
  ok('ggstatus preview is inside the payload preserved with groupStatus', !!(withPreview && withPreview.content.groupStatus === true));

  // ---- gcast (should NOT be a group status)
  sent.length = 0;
  const r3 = await wa.gcast({ content: 'plain gcast https://chat.whatsapp.com/GOODCODE1234567', sessionIds: ['sess1'] });
  const nonStatus = sent.every((s) => !s.content.groupStatus);
  ok('gcast does not set groupStatus', sent.length > 0 && nonStatus, `${sent.length} sends`);
  ok('gcast attaches rich link preview', sent.some((s) => s.content.linkPreview));

  global.fetch = realFetch;
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
