import fs from 'node:fs';

const src = (process.argv[2] ?? '').trim();
const dst = (process.argv[3] ?? '').trim();

if (!src || !dst) {
  throw new Error('Usage: node scripts/disable-tauri-updater.mjs <src-json> <dst-json>');
}

const conf = JSON.parse(fs.readFileSync(src, 'utf8'));

// Tauri v1 config shape
if (conf.tauri) {
  conf.tauri = conf.tauri || {};
  conf.tauri.updater = conf.tauri.updater || {};
  conf.tauri.updater.active = false;
} else {
  // Tauri v2 config shape
  conf.bundle = conf.bundle || {};
  conf.bundle.createUpdaterArtifacts = false;
}

fs.writeFileSync(dst, `${JSON.stringify(conf, null, 2)}\n`, 'utf8');
console.log(`Wrote updater-disabled config to ${dst}`);
