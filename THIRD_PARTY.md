# Third-party and reference material

Original Titanium-authored code in this repository is licensed under
**GPL-3.0-or-later** (see `LICENSE`). The following directories retain
their **original licenses** from upstream authors:

| Path              | Source                                | Notes                        |
| ----------------- | ------------------------------------- | ---------------------------- |
| `scraped/`        | quoridor-ai.netlify.app scrape        | Reference / UI protocol only |
| `extracted/`      | Derived from scraped bundles          | Reference docs               |
| `_vendor/`        | Various open-source Quoridor projects | See each subdirectory        |
| `web/src/vendor/` | Bundled reference engines             | See file headers             |

The canonical Rust engine is [titanium-engine](https://github.com/titaniummachine1/titanium-engine)
(GPL-3.0-or-later) and is built from the workspace sibling `../engine`, not
copied into this repo. When distributing a combined product, comply with GPL for
Titanium-original parts and respect upstream licenses for vendored code.
