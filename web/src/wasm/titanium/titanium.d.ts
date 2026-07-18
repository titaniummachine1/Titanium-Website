/* tslint:disable */
/* eslint-disable */
/**
 * Read the last captured panic message (see `panic_capture`). Returns "" if no
 * panic has occurred. Safe to call after a trapped threaded search.
 */
export function last_panic(): string;
export function helper_starts(): number;
/**
 * CAT v3 heatmap JSON for the website overlay (`catHeatmap.js`).
 *
 * Stateless: rebuilds the board from the full move list each call. Prefer
 * `WasmCatEngine` (below), which keeps the board warm and only applies the new
 * move — the overlay was re-replaying the whole game on every ply.
 */
export function cat_snapshot(moves: string): string;
/**
 * JSON build identity for browser debug panel / console.
 */
export function wasm_build_identity_json(): string;
export function initThreadPool(num_threads: number): Promise<any>;
export function wbg_rayon_start_worker(receiver: number): void;
/**
 * ACE Rust port in WASM — one-shot genmove from a move list (GitHub Pages; no native binary).
 */
export class WasmAceEngine {
  free(): void;
  constructor();
  genmove(moves: string, movetime_ms: number, max_depth: number, engine_mode: string, on_progress?: Function | null): string;
}
/**
 * Warm, single-purpose CAT instance for the overlay worker. Holds the board
 * across plies: forward play applies only the appended move(s); undo/jump
 * rebuilds from the longest common prefix. No search, no thread pool — its only
 * job is to return the CAT snapshot for the current node fast.
 */
export class WasmCatEngine {
  free(): void;
  /**
   * LMR plan JSON — `lmr_aggression_percent` is viz tuning, -500..150.
   */
  lmr_snapshot(moves: string, time_ms: number, id_depth: number, lmr_aggression_percent: number): string;
  get_cat_distance_bias_bp(): number;
  /**
   * Path tilt for CAT heat visualization (basis points). Visualization worker only.
   */
  set_cat_distance_bias_bp(bias: number): void;
  static default_cat_distance_bias_bp(): number;
  constructor();
  /**
   * CAT JSON for `moves` (space-separated algebraic), reusing the warm board.
   */
  snapshot(moves: string): string;
}
/**
 * Warm Titanium v17 session. TT and history persist between plies.
 */
export class WasmEngine {
  free(): void;
  go_threads(movetime_ms: number, _max_nodes: number, max_depth: number, threads: number, on_progress?: Function | null): string;
  engine_mode(): string;
  legal_moves(): string;
  set_multipv(n: number): void;
  go_threads_json(movetime_ms: number, _max_nodes: number, max_depth: number, threads: number, on_progress?: Function | null): string;
  set_root_scores(enabled: boolean): void;
  last_stop_reason(): string;
  last_search_depth(): number;
  last_search_nodes(): bigint;
  go(movetime_ms: number, _max_nodes: number, max_depth: number, on_progress?: Function | null): string;
  /**
   * `tier`: 3 = CAT 500, 4 = CAT 800, 5 = CAT 1000. Other values use CAT 800.
   */
  constructor(tier: number);
  reset(): void;
  winner(): number;
  /**
   * Current strongest profile, packaged in the same WASM module as v16.
   */
  static new_v17(tier: number): WasmEngine;
  position(moves: string): number;
  make_move(mv: string): boolean;
}
export class wbg_rayon_PoolBuilder {
  private constructor();
  free(): void;
  numThreads(): number;
  build(): void;
  receiver(): number;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly __wbg_wasmaceengine_free: (a: number, b: number) => void;
  readonly __wbg_wasmcatengine_free: (a: number, b: number) => void;
  readonly __wbg_wasmengine_free: (a: number, b: number) => void;
  readonly cat_snapshot: (a: number, b: number) => [number, number];
  readonly helper_starts: () => number;
  readonly last_panic: () => [number, number];
  readonly wasm_build_identity_json: () => [number, number];
  readonly wasmaceengine_genmove: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
  readonly wasmcatengine_default_cat_distance_bias_bp: () => number;
  readonly wasmcatengine_get_cat_distance_bias_bp: (a: number) => number;
  readonly wasmcatengine_lmr_snapshot: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
  readonly wasmcatengine_new: () => number;
  readonly wasmcatengine_set_cat_distance_bias_bp: (a: number, b: number) => void;
  readonly wasmcatengine_snapshot: (a: number, b: number, c: number) => [number, number];
  readonly wasmengine_engine_mode: (a: number) => [number, number];
  readonly wasmengine_go: (a: number, b: number, c: number, d: number, e: number) => [number, number];
  readonly wasmengine_go_threads: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
  readonly wasmengine_go_threads_json: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
  readonly wasmengine_last_search_depth: (a: number) => number;
  readonly wasmengine_last_search_nodes: (a: number) => bigint;
  readonly wasmengine_last_stop_reason: (a: number) => [number, number];
  readonly wasmengine_legal_moves: (a: number) => [number, number];
  readonly wasmengine_make_move: (a: number, b: number, c: number) => number;
  readonly wasmengine_new: (a: number) => number;
  readonly wasmengine_new_v17: (a: number) => number;
  readonly wasmengine_position: (a: number, b: number, c: number) => [number, number, number];
  readonly wasmengine_reset: (a: number) => void;
  readonly wasmengine_set_multipv: (a: number, b: number) => void;
  readonly wasmengine_set_root_scores: (a: number, b: number) => void;
  readonly wasmengine_winner: (a: number) => number;
  readonly wasmaceengine_new: () => number;
  readonly __wbg_wbg_rayon_poolbuilder_free: (a: number, b: number) => void;
  readonly initThreadPool: (a: number) => any;
  readonly wbg_rayon_poolbuilder_build: (a: number) => void;
  readonly wbg_rayon_poolbuilder_numThreads: (a: number) => number;
  readonly wbg_rayon_poolbuilder_receiver: (a: number) => number;
  readonly wbg_rayon_start_worker: (a: number) => void;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_export_2: WebAssembly.Table;
  readonly memory: WebAssembly.Memory;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_thread_destroy: (a?: number, b?: number, c?: number) => void;
  readonly __wbindgen_start: (a: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput, memory?: WebAssembly.Memory, thread_stack_size?: number }} module - Passing `SyncInitInput` directly is deprecated.
* @param {WebAssembly.Memory} memory - Deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput, memory?: WebAssembly.Memory, thread_stack_size?: number } | SyncInitInput, memory?: WebAssembly.Memory): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory, thread_stack_size?: number }} module_or_path - Passing `InitInput` directly is deprecated.
* @param {WebAssembly.Memory} memory - Deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory, thread_stack_size?: number } | InitInput | Promise<InitInput>, memory?: WebAssembly.Memory): Promise<InitOutput>;
