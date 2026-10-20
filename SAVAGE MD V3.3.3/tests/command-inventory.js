'use strict';
// Full command inventory (Telegram + WhatsApp + callbacks + dynamic triggers).
// Prints JSON to stdout: { telegram: [...], wa: [...], callbacks: [...], dynamic: [...] }
const H = require('./harness');

function main() {
  // ---------- Telegram commands ----------
  const registry = H.load('registry');
  const flatten = registry.flatten();
  const telegram = flatten.map((r) => ({
    name: r.registeredName,
    canonical: r.name,
    isAlias: !!r.isAlias,
    aliasOf: r.aliasOf || null,
    category: r.category,
    ownerOnly: !!r.ownerOnly,
    slow: !!r.slow,
    usage: r.usage || null,
    description: r.description || null
  }));

  // ---------- WhatsApp plugin commands ----------
  const loader = H.load('loader');
  const stats = loader.loadAll();
  const wa = [];
  for (const [cmd, plugin] of loader.commandIndex.entries()) {
    wa.push({
      command: cmd,
      name: plugin.name || null,
      canonical: Array.isArray(plugin.command) ? plugin.command[0] : plugin.command || plugin.name,
      file: plugin.__file || null,
      category: plugin.category || null,
      ownerOnly: !!plugin.ownerOnly,
      adminOnly: !!plugin.adminOnly,
      groupOnly: !!plugin.groupOnly,
      premiumOnly: !!plugin.premiumOnly,
      privateModeAllowed: !!plugin.privateModeAllowed,
      hidden: !!plugin.hidden || false,
      cooldown: plugin.cooldown ?? null
    });
  }
  wa.sort((a, b) => (a.command < b.command ? -1 : 1));

  // ---------- Callback / button actions ----------
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');
  const cbPatterns = new Set();
  for (const m of src.matchAll(/callbackQuery\(\s*[`'"]([^`'"]+)[`'"]/g)) cbPatterns.add(m[1]);
  for (const m of src.matchAll(/callback_data\s*===?\s*[`'"]([^`'"]+)[`'"]/g)) cbPatterns.add(m[1]);
  for (const m of src.matchAll(/startsWith\(\s*[`'"]([a-zA-Z0-9_:-]+)[`'"]/g)) cbPatterns.add(m[1] + '*');
  for (const m of src.matchAll(/button\.callback\([^)]*[`'"]([a-zA-Z0-9_:-]+)[`'"]/g)) cbPatterns.add(m[1]);
  const callbacks = [...cbPatterns].sort();

  // ---------- dynamic / event-driven handlers ----------
  const dynamic = [];
  for (const m of src.matchAll(/name: "([a-z0-9]+)",\s*\n\s*command: \[([^\]]+)\]/g)) {
    dynamic.push({ via: 'plugin-module', name: m[1], commands: m[2] });
  }

  const out = {
    generatedAt: new Date().toISOString(),
    totals: {
      telegramCommands: telegram.filter((t) => !t.isAlias).length,
      telegramAliases: telegram.filter((t) => t.isAlias).length,
      telegramRegistrations: telegram.length,
      waCommands: wa.length,
      waPlugins: stats.pluginCount,
      callbackPatterns: callbacks.length
    },
    loaderStats: stats,
    telegram,
    wa,
    callbacks,
    savagePlusAliases: H.sp('index').ALIASES
  };
  const target = process.argv[2] || require('path').join(__dirname, 'inventory-baseline.json');
  require('fs').writeFileSync(target, JSON.stringify(out, null, 2));
  console.error(`inventory written to ${target}: ${out.totals.telegramRegistrations} telegram regs, ${out.totals.waCommands} wa commands, ${out.totals.callbackPatterns} callback patterns`);
}

main();
