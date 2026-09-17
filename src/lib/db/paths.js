import path from "node:path";
import fs from "node:fs";
import { DATA_DIR } from "@/lib/dataDir.js";

export const DB_DIR = path.join(DATA_DIR, "db");
export const DATA_FILE = path.join(DB_DIR, "data.sqlite");
export const BACKUPS_DIR = path.join(DB_DIR, "backups");
export const LEGACY_FILES = {
  main: path.join(DATA_DIR, "db.json"),
  usage: path.join(DATA_DIR, "usage.json"),
  disabled: path.join(DATA_DIR, "disabledModels.json"),
  details: path.join(DATA_DIR, "request-details.json"),
};
export function ensureDirs() {
  // Workers: DATA_DIR points at the ephemeral /tmp mount. mkdir can still fail
  // there (e.g. read-only edge runtimes) — fail soft instead of throwing out of
  // DB init; individual write attempts surface their own errors.
  for (const dir of [DATA_DIR, DB_DIR, BACKUPS_DIR]) {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch {
      // ignore — writes will fail with their own error and callers handle it
    }
  }
}
