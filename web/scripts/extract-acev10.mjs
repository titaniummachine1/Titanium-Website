import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const siteDir = path.resolve(webDir, '..');
const htmlPath =
  process.argv[2] ?? 'C:/Users/Terminatort8000/Downloads/quoridor (8).html';

const html = fs.readFileSync(htmlPath, 'utf8');
const match = html.match(/<script id="enginecode">([\s\S]*?)<\/script>/);
if (!match) {
  throw new Error(`no enginecode in ${htmlPath}`);
}
const engine = match[1].trim();
fs.writeFileSync(path.join(siteDir, '_vendor/acev10_engine.js'), engine);
fs.mkdirSync(path.join(webDir, 'src/vendor/ace-v10'), { recursive: true });
fs.writeFileSync(path.join(webDir, 'src/vendor/ace-v10/engine.js'), engine);
console.log(`ACE v10 engine: ${engine.length} bytes → _vendor/ + web/src/vendor/ace-v10/`);
