# Titanium Quoridor Website

Website, scraped references, vendored JS engines (ACE v7/v8/v10), and
benchmark material for the Titanium Quoridor project.

Repo: [github.com/titaniummachine1/Titanium-Quoridor-Website](https://github.com/titaniummachine1/Titanium-Quoridor-Website)

The Rust engine lives in [titanium-quoridor](https://github.com/titaniummachine1/titanium-quoridor) and is included here as a git submodule at `engine/`. The website loads the engine as WASM built from tagged engine releases.

Clone with submodule:

```bash
git clone --recurse-submodules https://github.com/titaniummachine1/Titanium-Quoridor-Website.git
```

## Live site (GitHub Pages)

**URL:** https://titaniummachine1.github.io/Titanium-Quoridor-Website/

Pushes to `main` auto-deploy via `.github/workflows/deploy-pages.yml`.

**One-time setup** (repo owner, on GitHub):

1. Repo → **Settings** → **Pages**
2. **Build and deployment** → Source: **GitHub Actions**
3. Push to `main` (or run the workflow manually under **Actions**)

**Local dev** (Titanium Rust via proxy — not available on static Pages):

```bash
cd web && npm install && npm run dev
```

**Test the Pages build locally:**

```bash
cd web && npm run build:pages && npm run preview:pages
```

On GitHub Pages:

- **Titanium** — Rust engine compiled to **WebAssembly** (built in CI from `engine/`)
- **JS engines** — Gorisanson MCTS, Ace v8 (HTML extract), Quoridor v3 αβ
- **Remote** — Ishtar / Ka (WebSocket)

Locally, `npm run dev` uses the native Rust binary (faster); `npm run build:pages` uses WASM like production.

Layout:

- `web/` — the playable website
- `_vendor/` — reference JS engines and parity/diff tooling
- `scraped/`, `extracted/` — reference material
- `benchmark/` — benchmark reports

## License

Titanium-original code: **GPL-3.0-or-later** (see `LICENSE`).
Scraped UI, `_vendor/`, and reference engines keep their upstream licenses
(see `THIRD_PARTY.md`). The `engine/` submodule is GPL-3.0-or-later.
