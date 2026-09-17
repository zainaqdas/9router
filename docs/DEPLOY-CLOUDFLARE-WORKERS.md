# Deploying 9Router to Cloudflare Workers

The dashboard + gateway can run on Cloudflare Workers via
[`@opennextjs/cloudflare`](https://opennext.js.org/cloudflare). This document
covers what was wired up, how to deploy, and the **functional limits** of a
Workers deployment compared to the Node/Docker runtime.

## One-time setup

```bash
npm install            # includes devDeps: @opennextjs/cloudflare, wrangler
npx wrangler login     # or set CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
```

## Build & deploy

```bash
npm run build:workers      # next build --webpack + opennextjs-cloudflare build
npm run deploy:workers     # wrangler deploy (uses .open-next/worker.js)
npm run preview:workers    # local workerd preview via wrangler dev
```

Worker name and bindings live in `wrangler.jsonc` (name: `ninerouter`).
Static assets are served from the `.open-next/assets` directory via the
`ASSETS` binding; a **KV namespace** (`DB_KV`) is bound for durable state
(see below). Create your own namespace and put its id in `wrangler.jsonc`:

```bash
npx wrangler kv namespace create DB_KV
```

## Environment variables

Set via the Cloudflare dashboard (Workers → Settings → Variables) or
`wrangler secret put`. Recommended set:

| Variable | Why |
|---|---|
| `JWT_SECRET` | Dashboard session cookie signing — **required for any public deploy** |
| `INITIAL_PASSWORD` | Default dashboard password (default `123456` — **must override**) |
| `MACHINE_ID` | **Workers-specific:** there is no host machine id in workerd. Set a fixed random hex string, otherwise API keys and the CLI token flap between isolates. |
| `API_KEY_SECRET` | HMAC secret for generated `sk-` keys |
| `MACHINE_ID_SALT` | Machine-id hash salt |
| `AUTH_COOKIE_SECURE=true` | Workers serves HTTPS — keep cookies secure |
| `BASE_URL` / `NEXT_PUBLIC_BASE_URL` | Public URL of the worker (used by cloud sync) |

Secrets must **not** be placed in `.dev.vars` in production; `.dev.vars`
(gitignored, see `.dev.vars.example`) is only for `npm run preview:workers`.

## What was adapted for Workers

- **Runtime detection** — `src/lib/runtime.js` (`isWorkersRuntime()`,
  `isLongLivedServer()`) gates everything Node-specific.
- **SQLite layer + KV durability** — workerd stubs `node:sqlite` and cannot
  load native `better-sqlite3`, and only permits *pre-compiled* wasm modules,
  so the driver chain resolves to the **sql.js asm.js build** (pure JS, no
  wasm) on Workers. sql.js cannot persist to disk in workerd, so the worker
  entry (`src/worker-entry.js`) + `src/lib/db/adapters/workersKvStore.js`
  keep the snapshot durable: hydrate from KV on isolate boot, mark writes
  dirty, and flush the whole SQLite file back to KV (throttled to one put per
  10s, plus a `flushSoon()` awaited through `ctx.waitUntil` at request end).
  Driver reports `sql.js+kv` when the `DB_KV` binding is present, and falls
  back to in-memory-only when it isn't.
- **Machine ID** — `src/shared/utils/machineId.js` prefers `MACHINE_ID` env
  on Workers (no host id, no writable FS) and derives the CLI secret
  deterministically instead of persisting it.
- **Data dir** — `src/lib/dataDir.js` points `DATA_DIR` at a scratch dir
  under `/tmp` on Workers (never attempts `mkdir` on a read-only FS); the
  durable copy of the DB is the KV snapshot, not this dir.
- **Background jobs** — token refresh and model-catalog sync schedulers are
  disabled on Workers (`instrumentation.js` + `isLongLivedServer()`; also
  honored via `DISABLE_BACKGROUND_JOBS=1` on any runtime).
- **`bun:sqlite` import** — hidden behind a variable specifier +
  `webpackIgnore` so the OpenNext esbuild pass can't fail on the `bun:` scheme.
- **Build memory** — `next.config.mjs` enables
  `experimental.webpackMemoryOptimizations`; on ≤2GB CI sandboxes build with
  `NODE_OPTIONS=--max-old-space-size=768 NEXT_BUILD_CPUS=1`.

## Functional limits on Workers

1. **KV snapshot durability (not per-statement).** State survives isolate
   eviction and redeploys via the KV snapshot, but the flush window means a
   worker killed mid-request can lose the last ~10s of writes. Concurrent
   isolates last-writer-wins on the snapshot (fine for a single-user gateway;
   don't run multi-writer load against it).
2. **KV account limits.** Free tier: 1,000 writes/day (the throttle keeps a
   quiet instance at ~8,640/day worst case — writes only happen when dirty)
   and 25MB per value (the snapshot is currently ~176KB; heavy usage/request
   logs grow it — prune via the dashboard if it approaches the limit).
3. **No background schedulers.** Token refresh and catalog sync don't run;
   refresh still happens inline on 401/403 during live traffic.
3. **No local-machine features.** CLI tool config writers, tunnel/Tailscale,
   MITM, headroom proxy, and update/shutdown endpoints are meaningless
   server-side and are blocked by the existing local-only guard.
4. **No `open` (browser opening)** — desktop-only by design; import failures
   for its optional deps during OpenNext tracing are harmless.
5. **Bundle size.** The worker is ~33MB raw / ~5MB gzip against the 3MB
   gzipped startup budget — cold starts may be slow and Cloudflare may warn
   at deploy. `cli/**` is already excluded from tracing to keep it lean.

## CI sandboxes (2GB cgroup)

The full pipeline was verified with:

```bash
NODE_OPTIONS=--max-old-space-size=768 NEXT_BUILD_CPUS=1 \
  npx next build --webpack
npx opennextjs-cloudflare build --skipNextBuild
npx wrangler deploy --dry-run --outdir /tmp/wrangler-dry
```

If `next build` is `Killed`, memory pressure from sibling processes is the
cause — lower `--max-old-space-size` (e.g. 640) and retry.
