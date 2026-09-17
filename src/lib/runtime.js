// Runtime detector: tells apart Node.js (docker/vps/desktop) from edge/worker
// runtimes (Cloudflare Workers via @opennextjs/cloudflare, Vercel Edge...).
//
// Kept dependency-free and import-safe everywhere: modules that run in the
// browser, in the Node server and inside the worker bundle can all import it.

export function isWorkersRuntime() {
  // Cloudflare Workers / workerd exposes a global `caches` + `scheduler` and a
  // `userAgent` brand on `navigator` when nodejs_compat is enabled.
  try {
    if (typeof navigator !== "undefined" && typeof navigator.userAgent === "string") {
      if (navigator.userAgent.includes("Cloudflare-Workers")) return true;
    }
  } catch {}
  try {
    if (typeof WebSocketPair !== "undefined") return true;
  } catch {}
  return false;
}

export function isNodeRuntime() {
  try {
    return Boolean(process.versions?.node) && !isWorkersRuntime();
  } catch {
    return false;
  }
}

// True wherever long-lived background timers/processes make sense (Node server,
// CLI). False in Workers, where timers would be tied to an isolate that gets
// evicted, and during builds / static generation.
export function isLongLivedServer() {
  try {
    if (isWorkersRuntime()) return false;
    if (!process.versions?.node) return false;
    const phase = process.env.NEXT_PHASE || "";
    if (phase === "phase-production-build" || phase === "phase-export" || phase === "phase-static") return false;
    return true;
  } catch {
    return false;
  }
}
