import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const roots = [
  path.resolve('src-tauri/target/release/bundle'),
  path.resolve('src-tauri/target/x86_64-unknown-linux-gnu/release/bundle'),
  path.resolve('src-tauri/target/aarch64-unknown-linux-gnu/release/bundle'),
  path.resolve('src-tauri/target/x86_64-apple-darwin/release/bundle'),
  path.resolve('src-tauri/target/aarch64-apple-darwin/release/bundle'),
  path.resolve('src-tauri/gen/android/app/build/outputs/apk'),
  path.resolve('src-tauri/gen/android/app/build/outputs/bundle')
];

const targets = roots.filter((root) => fs.existsSync(root));
if (targets.length === 0) {
  console.log('No bundle directory found. Skip checksum generation.');
  process.exit(0);
}

const supportedExt = new Set(['.dmg', '.tar.gz', '.msi', '.exe', '.appimage', '.deb', '.rpm', '.apk', '.aab']);

const shouldHash = (file) => {
  if (file.endsWith('.tar.gz')) return true;
  const ext = path.extname(file).toLowerCase();
  return supportedExt.has(ext);
};

for (const root of targets) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      const rel = path.relative(root, fullPath).replace(/\\/g, '/');
      if (shouldHash(rel)) files.push(rel);
    }
  };

  walk(root);
  files.sort();
  const lines = files.map((rel) => {
    const fullPath = path.join(root, rel);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex');
    return `${hash}  ./${rel}`;
  });

  const outPath = path.join(root, 'SHA256SUMS.txt');
  fs.writeFileSync(outPath, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
  console.log(`Generated ${outPath}`);
}
