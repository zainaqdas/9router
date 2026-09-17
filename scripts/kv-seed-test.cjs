// Seeds /tmp/kv-seed.sqlite: a copy of the local app DB with a distinctive
// settings.displayName marker and no stored password (so INITIAL_PASSWORD
// login works in wrangler dev). Used to verify KV hydration in workerd.
const fs = require("fs");
const initSqlJs = require("sql.js");

(async () => {
  const SQL = await initSqlJs();
  const bytes = fs.readFileSync(process.env.HOME + "/.9router/db/data.sqlite");
  const db = new SQL.Database(bytes);
  const stmt = db.prepare("SELECT data FROM settings WHERE id = 1");
  let data = {};
  if (stmt.step()) data = JSON.parse(stmt.getAsObject().data);
  stmt.free();
  data.displayName = "KV-HYDRATE-MARKER";
  delete data.password; // fall back to INITIAL_PASSWORD login
  db.run("UPDATE settings SET data = ? WHERE id = 1", [JSON.stringify(data)]);
  fs.writeFileSync("/tmp/kv-seed.sqlite", Buffer.from(db.export()));
  console.log("seeded /tmp/kv-seed.sqlite with displayName=KV-HYDRATE-MARKER");
})().catch((e) => { console.error(e); process.exit(1); });
