// sql.js adapter — pure-JS SQLite (Emscripten). The fallback of last resort:
// it is the only driver that works on Cloudflare Workers (node:sqlite is a
// non-functional stub there and better-sqlite3 is a native addon).
//
// Workers specifics:
// - workerd only allows *pre-compiled* WebAssembly modules; compiling wasm
//   bytes at runtime is rejected ("Wasm code generation disallowed by
//   embedder"). So we load sql.js's asm.js build (dist/sql-asm.js) — pure
//   JavaScript, no WebAssembly anywhere.
// - Durability: the live engine is in-memory; the KV snapshot store
//   (workersKvStore.js) holds the last flushed SQLite image. Boot hydrates
//   from it, writes mark it dirty, flushes are throttled (10s timer) and
//   also flushed at request end via flushSoon() + ctx.waitUntil — an isolate
//   eviction loses at most ~10s of writes.
// - Node/Bun: load from disk, persist with a debounced write-back.
import fs from "node:fs";
import initSqlJs from "sql.js";
import { isWorkersRuntime } from "@/lib/runtime.js";
import { PRAGMA_SQL } from "../schema.js";
import * as kvStore from "./workersKvStore.js";

let SQL = null;

async function loadSql() {
  if (SQL) return SQL;
  if (isWorkersRuntime()) {
    const mod = await import("sql.js/dist/sql-asm.js");
    SQL = await (mod.default ?? mod)();
    return SQL;
  }
  SQL = await initSqlJs();
  return SQL;
}

const FLUSH_THROTTLE_MS = 10_000; // Workers: at most one KV put per 10s
const FILE_SAVE_DEBOUNCE_MS = 100; // Node: debounced file write-back

export async function createSqlJsAdapter(filePath) {
  const SQLLib = await loadSql();

  // ── Workers: hydrate from KV, persist via KV ─────────────────────────────
  if (isWorkersRuntime()) {
    const snapshot = await kvStore.hydrateSnapshot();
    // sql.js requires a byte view — a raw ArrayBuffer silently produces an
    // empty database (FS write of an ArrayBuffer writes nothing).
    const initialBytes = snapshot ? new Uint8Array(snapshot) : null;
    const db = new SQLLib.Database(initialBytes);
    db.exec(PRAGMA_SQL);
    // Schema is created/synced by migrate.js after adapter init.

    let dirty = false;
    let lastFlush = 0;
    let flushTimer = null;
    let flushChain = Promise.resolve();

    function serialize() {
      return Buffer.from(db.export());
    }

    // Dirty-aware: skips the KV put entirely when nothing changed (KV free
    // tier allows 1,000 writes/day — idle isolates must not burn them).
    function doFlush() {
      if (!dirty) return flushChain;
      dirty = false;
      flushChain = flushChain.then(() => kvStore.putSnapshot(serialize()));
      lastFlush = Date.now();
      return flushChain;
    }

    function markDirty() {
      dirty = true;
      if (flushTimer) return;
      const elapsed = Date.now() - lastFlush;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        doFlush();
      }, Math.max(0, FLUSH_THROTTLE_MS - elapsed));
    }

    // Attached to ctx.waitUntil by src/worker-entry.js at request end.
    function flushSoon() {
      return doFlush();
    }

    // The adapter is created inside the Next.js server bundle while
    // src/worker-entry.js runs in the wrangler entry bundle — distinct module
    // instances. Expose the flush hook through globalThis so the entry can
    // attach it to ctx.waitUntil regardless of bundling.
    globalThis.__9R_DB_FLUSH_SOON__ = flushSoon;

    return {
      driver: "sql.js+kv",
      run(sql, params = []) {
        const stmt = db.prepare(sql);
        try {
          stmt.bind(params ?? []);
          stmt.step();
          const changes = db.getRowsModified();
          const lastInsertRowid = db.exec("SELECT last_insert_rowid() as id")[0]?.values?.[0]?.[0] ?? null;
          markDirty();
          return { changes, lastInsertRowid };
        } finally {
          stmt.free();
        }
      },
      get(sql, params = []) {
        const stmt = db.prepare(sql);
        try {
          stmt.bind(params ?? []);
          if (stmt.step()) return stmt.getAsObject();
          return undefined;
        } finally {
          stmt.free();
        }
      },
      all(sql, params = []) {
        const stmt = db.prepare(sql);
        try {
          stmt.bind(params ?? []);
          const rows = [];
          while (stmt.step()) rows.push(stmt.getAsObject());
          return rows;
        } finally {
          stmt.free();
        }
      },
      exec(sql) {
        db.exec(sql);
        markDirty();
      },
      transaction(fn) {
        const sp = `sp_${Math.random().toString(36).slice(2)}`;
        db.exec(`SAVEPOINT ${sp}`);
        try {
          const result = fn();
          db.exec(`RELEASE ${sp}`);
          return result;
        } catch (e) {
          try { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); } catch {}
          throw e;
        }
      },
      checkpoint() {},
      close() {
        if (flushTimer) clearTimeout(flushTimer);
      },
      flushSoon,
      raw: db,
    };
  }

  // ── Node/Bun: file-backed (original behavior) ────────────────────────────
  const buf = fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
  const db = new SQLLib.Database(buf);
  db.exec(PRAGMA_SQL);

  let dirty = false;
  let saveTimer = null;

  function persist() {
    const data = db.export();
    fs.writeFileSync(filePath, Buffer.from(data));
    dirty = false;
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (dirty) {
        try { persist(); } catch (e) { console.error("[sqljs] save failed:", e); }
      }
    }, FILE_SAVE_DEBOUNCE_MS);
  }

  function paramsObj(params) {
    if (!params || (Array.isArray(params) && params.length === 0)) return undefined;
    return params;
  }

  function run(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(paramsObj(params));
      stmt.step();
      const changes = db.getRowsModified();
      const lastInsertRowid = db.exec("SELECT last_insert_rowid() as id")[0]?.values?.[0]?.[0] ?? null;
      scheduleSave();
      return { changes, lastInsertRowid };
    } finally {
      stmt.free();
    }
  }

  function get(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(paramsObj(params));
      if (stmt.step()) return stmt.getAsObject();
      return undefined;
    } finally {
      stmt.free();
    }
  }

  function all(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(paramsObj(params));
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  function exec(sql) {
    db.exec(sql);
    scheduleSave();
  }

  function transaction(fn) {
    const sp = `sp_${Math.random().toString(36).slice(2)}`;
    db.exec(`SAVEPOINT ${sp}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${sp}`);
      scheduleSave();
      return result;
    } catch (e) {
      try { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); } catch {}
      throw e;
    }
  }

  function close() {
    if (saveTimer) clearTimeout(saveTimer);
    if (dirty) persist();
    db.close();
  }

  if (!isWorkersRuntime()) {
    const flush = () => { if (dirty) { try { persist(); } catch {} } };
    process.on("beforeExit", flush);
    process.on("SIGINT", flush);
    process.on("SIGTERM", flush);
  }

  return { driver: "sql.js", run, get, all, exec, transaction, close, flushSoon: null, raw: db };
}
