import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Plain config: no R2 incremental cache / DO queue. The dashboard and /v1 API
// are dynamic (no ISR routes), so the default no-op caches are fine. If ISR or
// `revalidate` is ever added, enable `r2IncrementalCache` here (see
// https://opennext.js.org/cloudflare/caching).
export default defineCloudflareConfig({});
