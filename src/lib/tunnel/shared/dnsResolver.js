import dns from "dns";
import { isWorkersRuntime } from "@/lib/runtime";

// Force public DNS to bypass OS negative cache (mDNSResponder holds NXDOMAIN).
//
// workerd (Cloudflare Workers) throws "Not implemented" from
// `Resolver.setServers()` — and it throws at *import time* if we construct
// eagerly, killing every route in the import chain (connections, usage,
// dashboard SSR). Create the resolver lazily so importing this module is
// always safe, and fail open on Workers where custom DNS is irrelevant.
let resolver = null;
function getResolver() {
  if (!resolver) {
    resolver = new dns.promises.Resolver();
    try {
      resolver.setServers(["1.1.1.1", "1.0.0.1", "8.8.8.8"]);
    } catch {
      // Not implemented on this runtime — OS/default resolution only.
    }
  }
  return resolver;
}

// Try custom public DNS first, fall back to OS resolver
// (Cloudflare DNS may not resolve all hostnames, e.g. *.ts.net)
export async function resolveDns(hostname, timeoutMs) {
  if (isWorkersRuntime()) return true; // no tunnel/DNS checks on Workers — fail open

  const tryResolver = (fn) => Promise.race([
    fn(),
    new Promise((_, rej) => setTimeout(() => rej(new Error("dns timeout")), timeoutMs)),
  ]).then(() => true).catch(() => false);

  if (await tryResolver(() => getResolver().resolve4(hostname))) return true;
  return tryResolver(() => dns.promises.resolve4(hostname));
}
