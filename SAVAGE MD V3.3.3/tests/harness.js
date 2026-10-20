'use strict';
// Test harness: loads the bundled bot.js WITHOUT executing its boot section,
// and exposes the internal __commonJS module getters so each feature can be
// unit-tested in isolation with mocked I/O.
//
// Usage: const H = require('./harness'); const linkPreview = H.load('linkPreview');

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BUNDLE = path.join(__dirname, '..', 'bot.js');
const BOOT_MARKER = '// index.js\nrequire_db();';

function buildSource() {
  const src = fs.readFileSync(BUNDLE, 'utf8');
  const idx = src.indexOf(BOOT_MARKER);
  if (idx === -1) throw new Error('boot marker not found in bot.js');
  // Keep everything before the boot block, then append an export of internals.
  const head = src.slice(0, idx);
  return (
    head +
    '\n;module.exports = {\n' +
    '  __spRequire,\n' +
    '  getters: (function () {\n' +
    '    const names = [];\n' +
    '    const out = {};\n' +
    '    return { out: typeof require_config === "function" ? null : null, collect: function (n) { names.push(n); } };\n' +
    '  })(),\n' +
    '  req: function (name) {\n' +
    '    switch (name) {\n' +
    MODULE_GETTER_CASES +
    '      default: throw new Error("unknown module " + name);\n' +
    '    }\n' +
    '  }\n' +
    '};\n'
  );
}

// Auto-generate a switch over every `var require_X = __commonJS(` in the bundle.
const rawSrc = fs.readFileSync(BUNDLE, 'utf8');
const MODULE_NAMES = [...rawSrc.matchAll(/var (require_[A-Za-z0-9_]+) = __commonJS\(/g)].map((m) => m[1]);
const MODULE_GETTER_CASES = MODULE_NAMES.map((n) => `      case '${n}': return ${n};`).join('\n') + '\n';

function loadBundle() {
  const src = buildSource();
  const module_ = { exports: {} };
  const sandboxRequire = (name) => require(name); // real node_modules (telegraf, baileys, ...)
  const fn = new Function('require', 'module', 'exports', '__filename', '__dirname', src);
  fn(sandboxRequire, module_, module_.exports, BUNDLE, path.dirname(BUNDLE));
  return module_.exports;
}

const bundle = loadBundle();

/** Load one bundled __commonJS module by short name, e.g. load('linkPreview'). */
function load(shortName) {
  return bundle.req('require_' + shortName)();
}

/** Access SAVAGE PLUS modules by name, e.g. sp('cmd_net'). */
function sp(name) {
  return bundle.__spRequire(name);
}

/** All internal module short names (for inventory tooling). */
const names = MODULE_NAMES.map((n) => n.replace(/^require_/, ''));

module.exports = { load, sp, names, bundle };
