/**
 * Compare WASM SHA-256 across local file, Vite dev, preview, and deployed GitHub Pages.
 *
 * Usage:
 *   node scripts/audit-wasm-hashes.mjs
 *   node scripts/audit-wasm-hashes.mjs --dev http://localhost:5173 --preview http://localhost:4173
 *   node scripts/audit-wasm-hashes.mjs --deployed https://user.github.io/Titanium-Website/
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const localWasm = path.join(webDir, 'src', 'wasm', 'titanium', 'titanium_bg.wasm');
const buildMetaPath = path.join(webDir, 'src', 'wasm', 'titanium', 'build-meta.json');

function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function sha256File(filePath) {
  return sha256Buffer(readFileSync(filePath));
}

function parseArgs(argv) {
  const out = {
    dev: 'http://localhost:5173',
    preview: 'http://localhost:4173',
    deployed: process.env.DEPLOYED_SITE_URL ?? 'https://titaniummachine1.github.io/Titanium-Website/',
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dev' && argv[i + 1]) out.dev = argv[++i];
    else if (a === '--preview' && argv[i + 1]) out.preview = argv[++i];
    else if (a === '--deployed' && argv[i + 1]) out.deployed = argv[++i];
  }
  if (!out.deployed.endsWith('/')) out.deployed += '/';
  return out;
}

async function fetchBytes(url, label) {
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' },
    });
    if (!res.ok) {
      return { label, url, ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      label,
      url,
      ok: true,
      status: res.status,
      bytes: buf.length,
      sha256: sha256Buffer(buf),
      cacheControl: res.headers.get('cache-control'),
      viaSw: res.headers.get('x-from-service-worker') ?? null,
    };
  } catch (err) {
    return { label, url, ok: false, error: String(err?.message ?? err) };
  }
}

async function findWasmInDist(distDir) {
  const assetsDir = path.join(distDir, 'assets');
  if (!existsSync(assetsDir)) return null;
  const { readdirSync } = await import('node:fs');
  const hit = readdirSync(assetsDir).find((f) => /titanium.*\.wasm$/i.test(f));
  return hit ? path.join(assetsDir, hit) : null;
}

async function discoverDevWasmUrl(base) {
  const candidates = [
    `${base}/src/wasm/titanium/titanium_bg.wasm`,
    `${base}/wasm/titanium_bg.wasm`,
    `${base}/titanium_bg.wasm`,
  ];
  for (const url of candidates) {
    const r = await fetchBytes(url, 'probe');
    if (r.ok) return url;
  }
  return null;
}

async function discoverPreviewWasmUrl(base) {
  const metaUrl = `${base}/wasm/build-meta.json?ts=${Date.now()}`;
  try {
    const res = await fetch(metaUrl, { cache: 'no-store' });
    if (res.ok) {
      const meta = await res.json();
      const distWasm = await findWasmInDist(path.join(webDir, 'dist'));
      if (distWasm) {
        const name = path.basename(distWasm);
        return `${base}/assets/${name}`;
      }
    }
  } catch {
    /* fall through */
  }
  const distWasm = await findWasmInDist(path.join(webDir, 'dist'));
  if (distWasm) {
    return `${base}/assets/${path.basename(distWasm)}`;
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv);
  const report = {
    generatedAt: new Date().toISOString(),
    buildMeta: existsSync(buildMetaPath) ? JSON.parse(readFileSync(buildMetaPath, 'utf8')) : null,
    local: null,
    dev: null,
    preview: null,
    deployed: null,
    distFile: null,
    allMatch: false,
  };

  if (existsSync(localWasm)) {
    report.local = {
      path: localWasm,
      bytes: readFileSync(localWasm).byteLength,
      sha256: sha256File(localWasm),
    };
  }

  const distWasmPath = await findWasmInDist(path.join(webDir, 'dist'));
  if (distWasmPath) {
    report.distFile = {
      path: distWasmPath,
      bytes: readFileSync(distWasmPath).byteLength,
      sha256: sha256File(distWasmPath),
    };
  }

  const devUrl = await discoverDevWasmUrl(args.dev);
  if (devUrl) {
    report.dev = await fetchBytes(devUrl, 'vite-dev');
  } else {
    report.dev = { ok: false, error: 'could not locate dev WASM (is vite running?)' };
  }

  const previewUrl = await discoverPreviewWasmUrl(args.preview);
  if (previewUrl) {
    report.preview = await fetchBytes(previewUrl, 'vite-preview');
  } else {
    report.preview = { ok: false, error: 'could not locate preview WASM (run npm run build:pages && npm run preview:pages)' };
  }

  const deployedMetaUrl = `${args.deployed}wasm/build-meta.json?ts=${Date.now()}`;
  try {
    const res = await fetch(deployedMetaUrl, { cache: 'no-store' });
    report.deployedMeta = {
      url: deployedMetaUrl,
      ok: res.ok,
      status: res.status,
      json: res.ok ? await res.json() : null,
    };
  } catch (err) {
    report.deployedMeta = { url: deployedMetaUrl, ok: false, error: String(err?.message ?? err) };
  }

  const deployedWasmCandidates = [
    `${args.deployed}assets/titanium_bg.wasm`,
  ];
  if (report.distFile) {
    deployedWasmCandidates.unshift(`${args.deployed}assets/${path.basename(report.distFile.path)}`);
  }
  for (const url of deployedWasmCandidates) {
    const r = await fetchBytes(url, 'deployed-wasm');
    if (r.ok) {
      report.deployed = r;
      break;
    }
    report.deployed = r;
  }

  const reference = report.local?.sha256 ?? report.buildMeta?.wasm_sha256;
  const hashes = [
    report.local?.sha256,
    report.dev?.sha256,
    report.preview?.sha256,
    report.distFile?.sha256,
    report.deployed?.sha256,
  ].filter(Boolean);
  report.allMatch = reference != null && hashes.every((h) => h === reference);

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.allMatch ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
