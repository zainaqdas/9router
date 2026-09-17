// sql.js adapter — pure-JS SQLite (Emscripten). The fallback of last resort:
// it is the only driver that works on Cloudflare Workers (node:sqlite is a
// non-functional stub there and better-sqlite3 is a native addon).
//
// Workers specifics:
// - workerd only allows *pre-compiled* WebAssembly modules (imported from a
//   .wasm asset); WebAssembly.instantiate() on raw bytes is rejected with
//   "Wasm code generation disallowed by embedder", and Emscripten's wasm
//   runtime also wants to fetch the .wasm from a filesystem workerd lacks.
//   So on Workers we load sql.js's asm.js build (dist/sql-asm.js) instead —
//   pure JavaScript, no WebAssembly anywhere.
// - Persistence: writes go to /tmp via the nodejs_compat fs shim (ephemeral,
//   per-isolate). Treat the DB as scratch state on Workers — no cross-isolate
//   durability without a KV/R2/D1 extension.
import fs from "node:fs";
import initSqlJs from "sql.js";
import { isWorkersRuntime } from "@/lib/runtime.js";
import { PRAGMA_SQL } from "../schema.js";

let SQL = null;

async function loadSql() {
  if (SQL) return SQL;
  if (isWorkersRuntime()) {
    // asm.js build — no .wasm fetch, no byte compilation. Bundlers resolve this
    // subpath through sql.js's "./dist/*" exports map.
    const mod = await import("sql.js/dist/sql-asm.js");
    SQL = await (mod.default ?? mod)();
    return SQL;
  }
  // Node/Bun: default locateFile resolves sql-wasm.wasm from node_modules on disk.
  SQL = await initSqlJs();
  return SQL;
}

export async function createSqlJsAdapter(filePath) {
  const SQLLib = await loadSql();
  const buf = fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
  const db = new SQLLib.Database(buf);
  db.exec(PRAGMA_SQL);
  // Schema is created/synced by migrate.js after adapter init

  let dirty = false;
  let saveTimer = null;
  const SAVE_DEBOUNCE_MS = 100;

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
    }, SAVE_DEBOUNCE_MS);
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

  // Flush on shutdown — Node only (Workers has no process signal semantics).
  if (!isWorkersRuntime()) {
    const flush = () => { if (dirty) { try { persist(); } catch {} } };
    process.on("beforeExit", flush);
    process.on("SIGINT", flush);
    process.on("SIGTERM", flush);
  }

  return { driver: "sql.js", run, get, all, exec, transaction, close, raw: db };
}
