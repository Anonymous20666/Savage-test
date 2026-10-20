'use strict';
// Reproduction tests: bot payload <-> Baileys fork interop for
// (1) rich link previews and (2) Group Status (groupStatusMessageV2).
const H = require('./harness');

async function main() {
  const results = [];
  const ok = (name, cond, detail) => {
    results.push({ name, pass: !!cond, detail });
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  };

  const wa = await import('@whiskeysockets/baileys');
  const generateWAMessage = wa.generateWAMessage || wa.default?.generateWAMessage;
  const { normalizeMessageContent, extractMessageContent } = wa;
  ok('fork exports generateWAMessage', typeof generateWAMessage === 'function');

  // ---- 1. Rich link preview payload (shape produced by lib/whatsapp/linkPreview.js)
  const previewObj = {
    'canonical-url': 'https://example.com/page',
    'matched-text': 'https://example.com/page',
    title: 'Example Title',
    description: 'Example description',
    jpegThumbnail: Buffer.alloc(1000, 7)
  };
  const brand = H.load('channelBrand');
  const content1 = brand.withChannelBrand({ text: 'check https://example.com/page', linkPreview: previewObj });
  const msg1 = await generateWAMessage('123@s.whatsapp.net', content1, { userJid: 'me@s.whatsapp.net' });
  const ext = msg1.message.extendedTextMessage;
  ok('preview: extendedTextMessage produced', !!ext);
  ok('preview: title copied', ext && ext.title === 'Example Title', `got ${JSON.stringify(ext && ext.title)}`);
  ok('preview: matchedText copied', ext && ext.matchedText === 'https://example.com/page');
  ok('preview: description copied', ext && ext.description === 'Example description');
  ok('preview: jpegThumbnail copied', ext && ext.jpegThumbnail && ext.jpegThumbnail.length === 1000);
  ok('preview: brand contextInfo attached', !!(ext && ext.contextInfo && ext.contextInfo.forwardedNewsletterMessageInfo), JSON.stringify(ext?.contextInfo?.forwardedNewsletterMessageInfo?.newsletterName || null));

  // ---- 2. Group Status text payload (shape from buildGroupStatusContent)
  const content2 = brand.withChannelBrand({ ...content1, groupStatus: true });
  const msg2 = await generateWAMessage('120363000000000000@g.us', { ...content2 }, { userJid: 'me@s.whatsapp.net' });
  ok('gstatus: wrapped in groupStatusMessageV2', !!msg2.message.groupStatusMessageV2, JSON.stringify(Object.keys(msg2.message)));
  const inner = msg2.message.groupStatusMessageV2?.message;
  ok('gstatus: inner extendedTextMessage kept', !!(inner && inner.extendedTextMessage));
  ok('gstatus: isGroupStatus flag on inner contextInfo', inner?.extendedTextMessage?.contextInfo?.isGroupStatus === true, JSON.stringify(inner?.extendedTextMessage?.contextInfo?.isGroupStatus));
  ok('gstatus: preview survives wrapper', inner?.extendedTextMessage?.title === 'Example Title');
  ok('gstatus: brand survives wrapper', !!inner?.extendedTextMessage?.contextInfo?.forwardedNewsletterMessageInfo);

  // ---- 3. Group Status media payload
  const stubUpload = async () => ({ directPath: '/x', mediaKey: Buffer.alloc(32), mediaKeyTimestamp: 0, fileSha256: Buffer.alloc(32), fileEncSha256: Buffer.alloc(32), url: 'https://mmg/x' });
  // 1x1 red PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const content3 = brand.withChannelBrand({ image: png, caption: 'hello', groupStatus: true });
  const msg3 = await generateWAMessage('120363000000000000@g.us', content3, { userJid: 'me@s.whatsapp.net', upload: stubUpload });
  ok('gstatus media: wrapped', !!msg3.message.groupStatusMessageV2);
  ok('gstatus media: inner imageMessage', !!msg3.message.groupStatusMessageV2?.message?.imageMessage);
  ok('gstatus media: caption kept', msg3.message.groupStatusMessageV2?.message?.imageMessage?.caption === 'hello');

  // ---- 4. serialize() must unwrap groupStatusMessageV2 (receiving side)
  const ser = H.load('serialize');
  const raw = {
    key: { remoteJid: '120363000000000000@g.us', id: 'ABC', participant: '5511999999999@s.whatsapp.net', fromMe: false },
    message: msg2.message,
    messageTimestamp: Date.now() / 1000
  };
  const m = ser.serialize(raw, null);
  console.log('  serialize(groupStatusMessageV2) =>', JSON.stringify({ type: m.type, body: m.body }));
  ok('serialize: body extracted through groupStatusMessageV2', m.body === 'check https://example.com/page', `got ${JSON.stringify(m.body)}`);

  // quoted group-status message (user replies to a group status)
  const quotedRaw = {
    key: { remoteJid: '120363000000000000@g.us', id: 'DEF', participant: '5511888888888@s.whatsapp.net', fromMe: false },
    message: {
      extendedTextMessage: {
        text: '.ping',
        contextInfo: {
          stanzaId: 'ABC',
          participant: '5511999999999@s.whatsapp.net',
          quotedMessage: msg2.message
        }
      }
    },
    messageTimestamp: Date.now() / 1000
  };
  const m2 = ser.serialize(quotedRaw, null);
  console.log('  serialize(quoted groupStatus) =>', JSON.stringify({ body: m2.body, quotedBody: m2.quoted && m2.quoted.body, quotedType: m2.quoted && m2.quoted.type }));
  ok('serialize: quoted body extracted through groupStatusMessageV2', m2.quoted && m2.quoted.body === 'check https://example.com/page', `got ${JSON.stringify(m2.quoted && m2.quoted.body)}`);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
