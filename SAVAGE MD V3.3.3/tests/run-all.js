'use strict';
// Runs the full regression suite. Each test is a separate process so mocked
// Module._load patches cannot leak between suites.
const { spawnSync } = require('child_process');
const path = require('path');

const suites = [
  'test-preview-gstatus.js',
  'test-linkpreview.js',
  'test-gstatus-send.js',
  'test-send-guard.js',
  'test-pairing.js',
  'test-session-ownership.js'
];

let failed = 0;
for (const suite of suites) {
  const res = spawnSync(process.execPath, [path.join(__dirname, suite)], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8'
  });
  const out = (res.stdout || '') + (res.stderr || '');
  const m = out.match(/(\d+)\/(\d+) passed/);
  const summary = m ? `${m[1]}/${m[2]}` : `CRASH (exit ${res.status})`;
  const pass = res.status === 0 && m && m[1] === m[2];
  if (!pass) failed += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${suite}  ${summary}`);
  if (!pass) {
    console.log(out.split('\n').filter((l) => /FAIL|Error|error/.test(l)).slice(0, 12).join('\n'));
  }
}
console.log(failed ? `\n${failed} suite(s) failed` : '\nALL SUITES PASSED');
process.exit(failed ? 1 : 0);
