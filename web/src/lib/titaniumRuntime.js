/**
 * Dev-only: native titanium.exe via Vite proxy (Lazy SMP, shared TT).
 * Production GitHub Pages always uses in-browser WASM — never /api/titanium.
 */
export function hasNativeTitaniumLazySmp() {
  if (import.meta.env.PROD) {
    return false;
  }
  return import.meta.env?.VITE_TITANIUM_NATIVE_PROXY === '1';
}
