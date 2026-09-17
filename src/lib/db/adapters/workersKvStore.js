// Cloudflare Workers KV snapshot store for the SQLite DB.
//
// The app's DB layer is synchronous (better-sqlite3-style API), so instead of
// translating every query into KV lookups we keep the proven in-memory sql.js
// engine as the live DB and use this module for durability:
//
//   hydrateSnapshot() — isolate boot: download the last flushed SQLite
//                       snapshot from KV and load it into sql.js (exact
//                       schema, indexes and rows — nothing to replay).
//   putSnapshot()     — persist the current SQLite bytes to KV. Calls are
//                       serialized through an in-flight chain so concurrent
//                       requests can never interleave two PUTs, and the last
//                       caller always writes the newest bytes.
//
// Env binding access order (belt-and-suspenders):
//   1. globalThis.__9R_CLOUDFLARE_ENV__  — stashed by src/worker-entry.js
//   2. globalThis[Symbol.for("__cloudflare-context__")].env — OpenNext's stash
//
// All KV failures are logged and swallowed: durability degrades to the
// previous ephemeral-/tmp behavior instead of taking requests down.
//
import { isWorkersRuntime } from "@/lib/runtime.js";

const KV_KEY = "9router/db/data.sqlite";
const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024; // KV value limit is 25MB

let kv = null;
let kvResolved = false;
let putChain = Promise.resolve();

function getKvBinding() {
  if (kvResolved) return kv;
  kvResolved = true;
  if (!isWorkersRuntime()) return kv;
  const env =
    (typeof globalThis !== "undefined" && globalThis.__9R_CLOUDFLARE_ENV__) ||
    (typeof Symbol !== "undefined" &&
      globalThis[Symbol.for("__cloudflare-context__")]?.env) ||
    null;
  kv = env?.DB_KV || null;
  if (!kv) {
    console.warn(
      "[KV-DB] DB_KV binding not found — falling back to ephemeral /tmp persistence on Workers."
    );
  }
  return kv;
}

function logFail(op, e) {
  console.error(`[KV-DB] ${op} failed (continuing):`, e?.message || e);
}

// Returns an ArrayBuffer of the last flushed SQLite snapshot, or null.
export async function hydrateSnapshot() {
  const kv = getKvBinding();
  if (!kv) return null;
  try {
    const stored = await kv.getWithMetadata(KV_KEY, { type: "arrayBuffer" });
    const bytes = stored?.value;
    if (!bytes || !bytes.byteLength) return null;
    console.log(`[KV-DB] hydrated snapshot from KV (${bytes.byteLength} bytes)`);
    return bytes;
  } catch (e) {
    logFail("hydrate", e);
    return null;
  }
}

// Persist `bytes` (Uint8Array/ArrayBuffer of the sqlite file) to KV.
// Serialized: joins the in-flight chain so puts never race. Never throws.
export function putSnapshot(bytes) {
  const kv = getKvBinding();
  if (!kv) return Promise.resolve(false);
  if (!bytes || !bytes.byteLength) return Promise.resolve(false);
  if (bytes.byteLength > MAX_SNAPSHOT_BYTES) {
    logFail("flush", new Error(`snapshot too large: ${bytes.byteLength} bytes (cap ${MAX_SNAPSHOT_BYTES})`));
    return Promise.resolve(false);
  }
  const run = async () => {
    try {
      await kv.put(KV_KEY, bytes);
      console.log(`[KV-DB] flushed snapshot to KV (${bytes.byteLength} bytes)`);
      return true;
    } catch (e) {
      logFail("flush", e);
      return false;
    }
  };
  putChain = putChain.then(run, run);
  return putChain;
}

// True when a durable store is wired up (worker has the DB_KV binding).
export function isDurable() {
  return Boolean(getKvBinding());
}

// Test hook — not used in production paths.
export function _resetForTests() {
  kv = null;
  kvResolved = false;
  putChain = Promise.resolve();
}
