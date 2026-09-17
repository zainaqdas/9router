import { machineIdSync } from 'node-machine-id';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '@/lib/dataDir';
import { isWorkersRuntime } from '@/lib/runtime';

const MACHINE_ID_FILE = path.join(DATA_DIR, 'machine-id');
const AUTH_DIR = path.join(DATA_DIR, 'auth');
const CLI_SECRET_FILE = path.join(AUTH_DIR, 'cli-secret');
const CLI_AUTH_SALT = '9r-cli-auth';
let cachedRawId = null;
let cachedCliSecret = null;

// Persist raw machine ID to file → guarantees CLI/server/middleware see same value
// even when machineIdSync fails or returns inconsistent values across runtimes.
function loadRawMachineId() {
  if (cachedRawId) return cachedRawId;
  // Workers (workerd): no host machine id exists and the FS is not writable.
  // Prefer a stable value provided via env (MACHINE_ID) — a random UUID would
  // change per isolate and invalidate API keys / CLI tokens between requests.
  if (isWorkersRuntime()) {
    const envId = String(process.env.MACHINE_ID || '').trim();
    if (envId) {
      cachedRawId = envId;
    } else {
      console.warn('[machineId] MACHINE_ID env is not set — generating a per-isolate random id. Set MACHINE_ID to a fixed value for stable keys/CLI tokens.');
      cachedRawId = crypto.randomUUID();
    }
    return cachedRawId;
  }
  try {
    cachedRawId = fs.readFileSync(MACHINE_ID_FILE, 'utf8').trim();
    if (cachedRawId) return cachedRawId;
  } catch {}
  try {
    cachedRawId = machineIdSync();
  } catch {
    cachedRawId = crypto.randomUUID();
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(MACHINE_ID_FILE, cachedRawId, { mode: 0o600 });
  } catch {}
  return cachedRawId;
}

// Random secret persisted on first run → unpredictable CLI token even when machineId leaks.
function loadCliSecret() {
  if (cachedCliSecret) return cachedCliSecret;
  // Workers: no writable FS — derive the CLI secret deterministically from the
  // machine id instead of reading/writing a file. Machine id is env-stable.
  if (isWorkersRuntime()) {
    const raw = loadRawMachineId();
    cachedCliSecret = crypto.createHash('sha256').update(`cli-secret:${raw}`).digest('hex');
    return cachedCliSecret;
  }
  try {
    cachedCliSecret = fs.readFileSync(CLI_SECRET_FILE, 'utf8').trim();
    if (cachedCliSecret) return cachedCliSecret;
  } catch {}
  cachedCliSecret = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    fs.writeFileSync(CLI_SECRET_FILE, cachedCliSecret, { mode: 0o600 });
  } catch {}
  return cachedCliSecret;
}

export async function getConsistentMachineId(salt = null) {
  const saltValue = salt || process.env.MACHINE_ID_SALT || 'endpoint-proxy-salt';
  const raw = loadRawMachineId();
  const extra = saltValue === CLI_AUTH_SALT ? loadCliSecret() : '';
  return crypto.createHash('sha256').update(raw + saltValue + extra).digest('hex').substring(0, 16);
}

export async function getRawMachineId() {
  return loadRawMachineId();
}

/**
 * Check if we're running in browser or server environment
 * @returns {boolean} True if in browser, false if in server
 */
export function isBrowser() {
  return typeof window !== 'undefined';
}
