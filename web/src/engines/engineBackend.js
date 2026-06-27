/**
 * Canonical engine backend kinds — local and remote paths must never mix.
 */

export const EngineBackendKind = Object.freeze({
  HUMAN: 'human',
  LOCAL_JS: 'local-js',
  LOCAL_WASM: 'local-wasm',
  REMOTE_WS: 'remote-ws',
});

export function isLocalEngineBackend(kind) {
  return kind === EngineBackendKind.LOCAL_JS || kind === EngineBackendKind.LOCAL_WASM;
}

export function isRemoteEngineBackend(kind) {
  return kind === EngineBackendKind.REMOTE_WS;
}

/**
 * Local Rust engines (Titanium, ACE Rust/MoveGen+) always run in-browser WASM.
 * Only remote engines (Ka, Ishtar, zero.ink REST) talk to a server.
 */
export function useWasmRustEngines() {
  return true;
}

/** @deprecated alias — dev and production both use WASM for Titanium / ACE Rust. */
export function useStaticEngineBackend() {
  return useWasmRustEngines();
}
