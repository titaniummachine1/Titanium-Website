/**
 * Dev-only: native titanium.exe via Vite proxy (Lazy SMP, shared TT).
 * Production GitHub Pages: same WASM worker stack as `npm run dev` (no /api/titanium).
 */
import { resolveCores } from './timeControl.js';

export function hasNativeTitaniumLazySmp() {
  if (import.meta.env.PROD) {
    return false;
  }
  return import.meta.env?.VITE_TITANIUM_NATIVE_PROXY === '1';
}

/** Worker count — identical for dev WASM and GitHub Pages WASM. */
export function resolveTitaniumSearchCores(aiSettings) {
  return resolveCores(aiSettings);
}
