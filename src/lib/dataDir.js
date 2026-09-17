import fs from "node:fs";
import path from "node:path";
import os from "os";
import { isWorkersRuntime } from "./runtime.js";

const APP_NAME = "9router";

// Workers (workerd) have no writable real FS, but they do expose an ephemeral,
// in-memory /tmp through the nodejs_compat fs module. It is cleared when the
// isolate is evicted — treat it as scratch space, not durable storage.
function workersDir() {
  return "/tmp/.9router-workers";
}

function defaultDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
  }
  return path.join(os.homedir(), `.${APP_NAME}`);
}

export function getDataDir() {
  // Workers: real FS is read-only. Never attempt mkdir on the configured path —
  // that would throw EROFS at module scope and kill the whole worker. /tmp is
  // the only writable location (ephemeral).
  if (isWorkersRuntime()) {
    const configured = process.env.DATA_DIR;
    if (configured && !configured.includes("..")) return configured;
    return workersDir();
  }

  const configured = process.env.DATA_DIR;
  if (!configured) return defaultDir();

  // On Windows, ignore Unix-style absolute paths (e.g. /var/lib/...) that come
  // from a Linux-targeted .env or Docker config — they are not valid here.
  if (process.platform === "win32" && /^\//.test(configured)) {
    console.warn(`[DATA_DIR] '${configured}' is a Unix path on Windows → fallback to default`);
    return defaultDir();
  }

  try {
    fs.mkdirSync(configured, { recursive: true });
    return configured;
  } catch (e) {
    if (e?.code === "EACCES" || e?.code === "EPERM" || e?.code === "EROFS") {
      console.warn(`[DATA_DIR] '${configured}' not writable → fallback ~/.${APP_NAME}`);
      return defaultDir();
    }
    throw e;
  }
}

export const DATA_DIR = getDataDir();
