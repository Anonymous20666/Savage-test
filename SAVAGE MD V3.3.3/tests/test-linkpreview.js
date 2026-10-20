'use strict';
// Reproduction: buildRichLinkPreview for WhatsApp group/channel invite links
// using a fake socket (no network except stubbed thumbnail fetch).
const H = require('./harness');

async function main() {
  const results = [];
  const ok = (name, cond, detail) => {
    results.push({ name, pass: !!cond });
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  };

  // stub global fetch for thumbnail download (pfpCache)
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('pp.thumb')) {
      return new Response(Buffer.alloc(800, 3), { status: 200 });
    }
    return realFetch(url, opts);
  };

  const lp = H.load('linkPreview');
  const fakeSock = {
    user: { id: '2348011111111:12@s.whatsapp.net' },
    async groupGetInviteInfo(code) {
      if (code === 'GOODCODE1234567') {
        return { id: '120363123456789012@g.us', subject: 'Test Group', size: 42, pictureUrl: 'https://pp.thumb/g.png' };
      }
      throw new Error('item-not-found');
    },
    async newsletterMetadata(type, code) {
      return {
        id: '120363999999999999@newsletter',
        name: { text: 'Test Channel' },
        description: { text: 'Channel desc' },
        subscribers_count: 1234,
        picture: { url: 'https://pp.thumb/c.png' }
      };
    },
    async profilePictureUrl() { return 'https://pp.thumb/x.png'; }
  };

  // group invite link
  const gp = await lp.buildRichLinkPreview(fakeSock, 'join https://chat.whatsapp.com/GOODCODE1234567 now');
  console.log('  group preview:', JSON.stringify(gp, (k, v) => (Buffer.isBuffer(v) ? `<buf ${v.length}>` : v)));
  ok('group preview produced', !!gp);
  ok('group preview title = subject', gp && gp.title === 'Test Group', gp && gp.title);
  ok('group preview description has members', gp && /42 members/.test(gp.description), gp && gp.description);
  ok('group preview thumbnail', gp && gp.jpegThumbnail && gp.jpegThumbnail.length === 800, gp && gp.jpegThumbnail && gp.jpegThumbnail.length);

  // channel link
  const cp = await lp.buildRichLinkPreview(fakeSock, 'see https://whatsapp.com/channel/GOODCODE12345678');
  console.log('  channel preview:', JSON.stringify(cp, (k, v) => (Buffer.isBuffer(v) ? `<buf ${v.length}>` : v)));
  ok('channel preview produced', !!cp);
  ok('channel preview title', cp && cp.title === 'Test Channel', cp && cp.title);
  ok('channel preview description fallback', cp && (cp.description === 'Channel desc' || /subscribers/.test(cp.description)), cp && cp.description);

  // withRichLinkPreview: already has linkPreview -> untouched
  const sockWithPreview = { ...fakeSock, sendMessage: async () => ({}) };
  const pre = { text: 'https://chat.whatsapp.com/GOODCODE1234567', linkPreview: { title: 'X' } };
  const out1 = await lp.withRichLinkPreview(fakeSock, pre);
  ok('withRichLinkPreview keeps existing linkPreview', out1 === pre);

  // withRichLinkPreview: no URL -> untouched
  const noUrl = { text: 'hello world' };
  const out2 = await lp.withRichLinkPreview(fakeSock, noUrl);
  ok('withRichLinkPreview no-URL passthrough', out2 === noUrl);

  // withRichLinkPreview: URL -> adds linkPreview
  const out3 = await lp.withRichLinkPreview(fakeSock, { text: 'https://chat.whatsapp.com/GOODCODE1234567' });
  console.log('  withRichLinkPreview adds:', out3 !== undefined && out3.linkPreview ? 'linkPreview set' : JSON.stringify(out3));
  ok('withRichLinkPreview adds linkPreview', !!(out3 && out3.linkPreview));

  // negative: invalid invite falls through to generic (which needs network) -> may be undefined in sandbox
  const bad = await lp.buildRichLinkPreview(fakeSock, 'https://chat.whatsapp.com/BADCODE12345678');
  console.log('  invalid-invite preview:', bad === undefined ? 'undefined (falls back to generic)' : JSON.stringify(bad, (k, v) => (Buffer.isBuffer(v) ? `<buf ${v.length}>` : v)).slice(0, 200));

  global.fetch = realFetch;
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
