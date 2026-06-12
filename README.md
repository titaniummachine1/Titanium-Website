# Titanium Quoridor Website

Website, scraped references, vendored JS engines (ACE v7/v8/v10), and
benchmark material for the Titanium Quoridor project.

Repo: [github.com/titaniummachine1/Titanium-Quoridor-Website](https://github.com/titaniummachine1/Titanium-Quoridor-Website)

The Rust engine lives in [titanium-quoridor](https://github.com/titaniummachine1/titanium-quoridor) and is included here as a git submodule at `engine/`. The website loads the engine as WASM built from tagged engine releases.

Clone with submodule:

```bash
git clone --recurse-submodules https://github.com/titaniummachine1/Titanium-Quoridor-Website.git
```

Layout:

- `web/` — the playable website
- `_vendor/` — reference JS engines and parity/diff tooling
- `scraped/`, `extracted/` — reference material
- `benchmark/` — benchmark reports

## License

Titanium-original code: **GPL-3.0-or-later** (see `LICENSE`).
Scraped UI, `_vendor/`, and reference engines keep their upstream licenses
(see `THIRD_PARTY.md`). The `engine/` submodule is GPL-3.0-or-later.
