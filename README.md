# Titanium Corridor Website

Website, scraped references, vendored JS engines (ACE v7/v8/v10), and
benchmark material for the Titanium Corridor project.

Repo: [github.com/titaniummachine1/Titanium-Corridor-Website](https://github.com/titaniummachine1/Titanium-Corridor-Website)

The Rust engine is not copied into this repo. Local builds use the canonical
workspace sibling at `../engine`; the website loads threaded WASM built from
that engine.

Clone the website normally:

```bash
git clone https://github.com/titaniummachine1/Titanium-Corridor-Website.git
```

## Live site (GitHub Pages)

**URL:** https://titaniummachine1.github.io/Titanium-Corridor-Website/

Pushes to `main` auto-deploy via `.github/workflows/deploy-pages.yml`.

**One-time setup** (repo owner, on GitHub):

1. Repo → **Settings** → **Pages**
2. **Build and deployment** → Source: **GitHub Actions**
3. Push to `main` (or run the workflow manually under **Actions**)

**Local dev** (same WASM stack as GitHub Pages — no native `titanium.exe`, fully client-side):

```bash
cd web && npm install && npm run dev
```

**Test the Pages build locally:**

```bash
cd web && npm run build:pages && npm run preview:pages
```

On GitHub Pages:

- **Titanium** — Rust engine compiled to **WebAssembly** (built in CI from `engine/`)
- **JS engines** — Gorisanson MCTS, Ace v8 (HTML extract), reference v3 αβ
- **Remote** — Ishtar / Ka (WebSocket)

Locally and on GitHub Pages, **Titanium** and **ACE Rust** run as **WebAssembly** in the browser (no server, no spawned processes). Only **remote** engines (Ishtar / Ka) use WebSocket servers.

Layout:

- `web/` — the playable website
- `_vendor/` — reference JS engines and parity/diff tooling
- `scraped/`, `extracted/` — reference material
- `benchmark/` — benchmark reports

## License

Titanium-original code: **GPL-3.0-or-later** (see `LICENSE`).
Scraped UI, `_vendor/`, and reference engines keep their upstream licenses
(see `THIRD_PARTY.md`). The `engine/` submodule is GPL-3.0-or-later.
