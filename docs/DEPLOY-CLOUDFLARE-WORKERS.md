# Deploying 9Router to Cloudflare Workers

9Router runs on Cloudflare Workers via
[`@opennextjs/cloudflare`](https://opennext.js.org/cloudflare): the Next.js
dashboard and the OpenAI-compatible `/v1` gateway are served from a single
worker, and all state (provider connections, API keys, settings, usage logs)
survives redeploys and isolate eviction through a **KV-backed SQLite
snapshot**. This guide covers everything from a fresh account to a verified
production deployment.

---

## 1. Architecture on Workers (what you're deploying)

```
Browser / AI client
        │  HTTPS
        ▼
┌─────────────────────────────────────────────┐
│  Worker "ninerouter"                        │
│  ├─ Next.js app (OpenNext handler)          │
│  │    /dashboard, /api/*, /v1/*             │
│  ├─ DB engine: sql.js (pure-JS SQLite,      │
│  │   in-memory, per-isolate)                │
│  └─ worker-entry.js wrapper                 │
│       hydrate on boot ◄──┐   └─ flush on    │
└──────────────────────────┼───┬──write───────┘
                           │   │ (throttled 10s + waitUntil)
                           ▼   ▼
              ┌─────────────────────────┐
              │  KV namespace (DB_KV)   │  ← durable state
              │  key: 9router/db/       │
              │       data.sqlite       │
              └─────────────────────────┘
```

- The live DB is an **in-memory sql.js** instance per isolate.
- On isolate boot the worker **hydrates** the last flushed SQLite snapshot
  from KV; every write marks the engine dirty and the snapshot is flushed
  back (at most one KV put per 10s, plus a flush attached to
  `ctx.waitUntil` at the end of every request).
- Static assets (`.open-next/assets`) are served via the `ASSETS` binding.
- No R2/D1/Durable Objects are needed (no ISR routes).

## 2. Prerequisites

- Node.js ≥ 18 and npm
- A Cloudflare account (free plan works)
- A Cloudflare API token **or** interactive `wrangler login`

If you use an API token, create one in
Dashboard → My Profile → API Tokens with at least:

| Permission | Why |
|---|---|
| Account → Workers Scripts → **Edit** | upload/deploy the worker |
| Account → Workers KV Storage → **Edit** | create/use the `DB_KV` namespace |

> Note: the "Edit Cloudflare Workers" token template covers both. D1/R2
> permissions are **not** needed for this deployment.

## 3. One-time setup

```bash
git clone <your-fork-url> 9router && cd 9router
npm install                          # includes devDeps: wrangler, @opennextjs/cloudflare

# Authenticate wrangler — either interactively:
npx wrangler login
# ...or with a token (prefix every command, or export it):
export CLOUDFLARE_API_TOKEN="your-token"
export CLOUDFLARE_ACCOUNT_ID="your-account-id"   # optional; auto-detected for single accounts
```

## 4. Create the KV namespace (durable state)

```bash
npx wrangler kv namespace create DB_KV
```

Copy the returned `id` into `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  {
    "binding": "DB_KV",
    "id": "<the-id-from-the-command>"
  }
]
```

## 5. Configure the worker (`wrangler.jsonc`)

Full reference of the shipped config — usually only `name` and the KV `id`
need changing:

```jsonc
{
  "main": "src/worker-entry.js",        // wrapper around .open-next/worker.js
  "name": "ninerouter",                 // → ninerouter.<subdomain>.workers.dev
  "compatibility_date": "2025-09-15",
  "compatibility_flags": ["nodejs_compat"],  // Node API shims — required
  "assets": {
    "directory": ".open-next/assets",   // static files, emitted by the build
    "binding": "ASSETS"
  },
  "kv_namespaces": [
    { "binding": "DB_KV", "id": "..." } // durable SQLite snapshots — required
  ],
  "services": [
    { "binding": "WORKER_SELF_REFERENCE", "service": "ninerouter" } // must match "name"
  ]
}
```

**Custom domain (optional):** add
`"routes": [{ "pattern": "router.example.com", "custom_domain": true }]`
— the zone must be on the same account.

## 6. Secrets & environment variables

Two kinds:

- **Secrets** — sensitive values, set per-worker with `wrangler secret put`
  (or Dashboard → Workers → ninerouter → Settings → Variables → Encrypt).
- **Plain vars** — non-sensitive config; set in the dashboard, or via a
  `vars` block in `wrangler.jsonc` (⚠️ never put a name in *both* a `vars`
  block and a secret — deploys will conflict).

### Required secrets

Generate values first:

```bash
openssl rand -hex 32   # JWT_SECRET
openssl rand -hex 32   # API_KEY_SECRET
openssl rand -hex 16   # MACHINE_ID
openssl rand -hex 8    # INITIAL_PASSWORD  (or choose your own password)
```

Upload them (each reads the value from stdin):

```bash
echo "<jwt-secret>"        | npx wrangler secret put JWT_SECRET
echo "<api-key-secret>"    | npx wrangler secret put API_KEY_SECRET
echo "<fixed-hex>"         | npx wrangler secret put MACHINE_ID
echo "<initial-password>"  | npx wrangler secret put INITIAL_PASSWORD
```

| Secret | Why it matters |
|---|---|
| `JWT_SECRET` | Signs dashboard session cookies. **Required for any public deploy.** |
| `INITIAL_PASSWORD` | Dashboard login password. Default is `123456`, and remote clients are **blocked** from logging in with the default (CVE guard) — on Workers there is no "local machine" to change it from, so you **must** set this. |
| `MACHINE_ID` | **Workers-specific:** there is no host machine id in workerd. A fixed value keeps generated `sk-` API keys and the CLI token stable across isolates and redeploys. |
| `API_KEY_SECRET` | HMAC secret for generated `sk-` keys. |
| `MACHINE_ID_SALT` | Optional salt for machine-id hashing. |

### Recommended plain vars

| Variable | Suggested value | Why |
|---|---|---|
| `AUTH_COOKIE_SECURE` | `true` | Workers serves HTTPS — keep session cookies secure |
| `BASE_URL` / `NEXT_PUBLIC_BASE_URL` | `https://<name>.<subdomain>.workers.dev` | public URL used by cloud sync / links |
| `DISABLE_BACKGROUND_JOBS` | already implied on Workers | background schedulers are disabled by the runtime detector |

> After changing secrets/vars, the new version takes effect on the next
> request — Cloudflare rolls it out automatically. Redeploying the worker
> does **not** lose state (the KV snapshot survives).

## 7. Local preview (before deploying)

```bash
cp .dev.vars.example .dev.vars     # gitignored — local-only secrets for workerd
# edit .dev.vars: NEXTJS_ENV=development, JWT_SECRET, INITIAL_PASSWORD, MACHINE_ID...

npm run preview:workers            # = opennextjs-cloudflare preview (wrangler dev)
curl http://localhost:8787/api/health   # → {"ok":true}
```

`wrangler dev` with `--local` stores KV in `.wrangler/state` — perfect for
testing hydration/flush without touching production data.

## 8. Build & deploy

```bash
npm run build:workers     # next build --webpack && opennextjs-cloudflare build
npm run deploy:workers    # wrangler deploy (uploads the bundle + assets)
```

- `deploy:workers` rebuilds everything. To skip the (slower) Next build when
  `.next` is already current: `SKIP_NEXT_BUILD=1 npm run deploy:workers`.
- On memory-limited CI/sandboxes (≤2GB), the Next build needs caps — it is
  already wired in `next.config.mjs` (`webpackMemoryOptimizations`); run:

  ```bash
  NODE_OPTIONS=--max-old-space-size=768 NEXT_BUILD_CPUS=1 \
    npm run build:workers
  ```

  If the build is still `Killed`, lower to `640` and retry (sibling
  processes eat into the same cgroup).

### Deploying from CI

```bash
export CLOUDFLARE_API_TOKEN="..."        # token from section 2
NODE_OPTIONS=--max-old-space-size=768 NEXT_BUILD_CPUS=1 \
  npm run build:workers
npm run deploy:workers
```

### Dry-run (validate without deploying)

```bash
npx opennextjs-cloudflare build
CLOUDFLARE_API_TOKEN= npx wrangler deploy --dry-run --outdir /tmp/wrangler-dry
```

## 9. Post-deploy verification

```bash
BASE="https://<name>.<subdomain>.workers.dev"

# 1. Gateway is alive
curl -s "$BASE/api/health"                    # → {"ok":true}

# 2. Dashboard guard works (unauthenticated → redirect)
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/dashboard"   # → 307

# 3. Login works with your INITIAL_PASSWORD (NOT the default)
curl -s -c /tmp/cj -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"password":"<initial-password>"}'      # → {"success":true,...}

# 4. A DB write + readback proves the KV round-trip
curl -s -b /tmp/cj -X PATCH "$BASE/api/settings" \
  -H 'Content-Type: application/json' \
  -d '{"displayName":"deploy-check"}' -o /dev/null -w '%{http_code}\n'   # → 200
sleep 12                                      # let the flush land
curl -s -b /tmp/cj "$BASE/api/settings" | grep deploy-check

# 5. The snapshot exists in KV
npx wrangler kv key list --binding DB_KV      # → ["9router/db/data.sqlite"]
```

Then open `$BASE/dashboard` in a browser and **change the password**
(Profile → Security) — `INITIAL_PASSWORD` is only the bootstrap.

## 10. Using the gateway

```bash
export NINEROUTER_URL="https://<name>.<subdomain>.workers.dev"
export NINEROUTER_KEY="sk-..."                # Dashboard → Keys
curl "$NINEROUTER_URL/v1/models" -H "Authorization: Bearer $NINEROUTER_KEY"
```

Add provider connections in the dashboard (Providers → Add); they persist
in the KV snapshot just like the Node app's `data.sqlite`.

## 11. Updating to a new version

```bash
git pull
npm install                        # if package.json changed
NODE_OPTIONS=--max-old-space-size=768 NEXT_BUILD_CPUS=1 npm run build:workers
npm run deploy:workers
```

State (connections, keys, settings, usage) survives the redeploy via KV.
If a release ever changes the DB schema, migrations run on boot against the
hydrated snapshot and the upgraded snapshot is flushed back automatically.

## 12. What was adapted for Workers (repo internals)

- **Runtime detection** — `src/lib/runtime.js` (`isWorkersRuntime()`,
  `isLongLivedServer()`) gates everything Node-specific.
- **SQLite layer + KV durability** — workerd stubs `node:sqlite`, cannot
  load native `better-sqlite3`, and rejects `WebAssembly.instantiate` on
  raw bytes ("code generation disallowed by embedder"). The driver chain
  therefore resolves to the **sql.js asm.js build** (pure JS, no wasm), and
  `src/worker-entry.js` + `src/lib/db/adapters/workersKvStore.js` handle
  hydrate/flush. Driver reports `sql.js+kv` when `DB_KV` is bound, and
  falls back to in-memory-only (ephemeral) when it isn't.
- **Hydration detail** — sql.js requires a byte view: the KV `ArrayBuffer`
  is wrapped in `Uint8Array` before `new SQL.Database(bytes)`, otherwise it
  silently boots an empty DB and migrations re-run over your data.
- **Machine ID** — `src/shared/utils/machineId.js` prefers the `MACHINE_ID`
  env on Workers and derives the CLI secret deterministically (no writable
  FS).
- **Data dir** — `src/lib/dataDir.js` points `DATA_DIR` at a scratch dir
  under `/tmp` and never `mkdir`s on a read-only FS; the durable copy of
  the DB is the KV snapshot, not this dir.
- **Background jobs** — token refresh / model-catalog sync schedulers are
  disabled on Workers (`instrumentation.js` + `isLongLivedServer()`; also
  honored via `DISABLE_BACKGROUND_JOBS=1` on any runtime). Refresh still
  happens inline on 401/403 during live traffic.
- **`bun:sqlite` import** — hidden behind a variable specifier +
  `webpackIgnore` so OpenNext's esbuild pass tolerates the `bun:` scheme.
- **Lazy native/Node modules** — anything unsupported by workerd
  (`dns.Resolver.setServers`, child_process at import time, …) must never
  run at **module scope**; it either runs lazily inside functions or is
  gated by `isWorkersRuntime()` (see `src/lib/tunnel/shared/dnsResolver.js`
  for the pattern).

## 13. Functional limits on Workers

1. **Snapshot durability, not per-statement.** A worker killed mid-request
   can lose the last ~10s of writes (throttled flush). Concurrent isolates
   are last-writer-wins on the snapshot — fine for a single-user gateway;
   don't run multi-writer load against it.
2. **KV account limits.** Free tier: 1,000 writes/day (flushes only happen
   when dirty) and **25MB per value**. The snapshot starts at ~176KB but
   usage/request logs grow it — prune old usage from the dashboard if it
   approaches the cap (check size:
   `npx wrangler kv key get "9router/db/data.sqlite" --binding DB_KV | wc -c`).
3. **No background schedulers.** No periodic token refresh / catalog sync
   cron; both still work on-demand during traffic.
4. **No local-machine features.** CLI tool config writers, tunnel/Tailscale
   management, MITM, headroom proxy, shutdown/update endpoints are blocked
   by the local-only guard — they're meaningless on a serverless runtime.
5. **Bundle size / cold starts.** The worker is ~33MB raw / ~5MB gzip
   against the 3MB-gzip startup budget; Cloudflare may warn at deploy and
   cold starts are slow (warm requests are unaffected). `cli/**` is already
   excluded from tracing to keep it lean.

## 14. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| **500 on every page** (dashboard, API, even 404s) | An exception at module scope in some import chain. Run `npx wrangler tail`, curl the route, read the stack. Classic case: `dns.promises.Resolver().setServers()` at import time → *"Not implemented"* in workerd. Fix: construct lazily inside functions (see §12, last bullet). |
| `[KV-DB] DB_KV binding not found` in logs; **state resets on redeploy** | KV binding missing — check `kv_namespaces` in `wrangler.jsonc` (correct namespace id?) and redeploy. The app keeps running but only in memory. |
| `next build` **Killed** | OOM in a memory-capped environment. Use `NODE_OPTIONS=--max-old-space-size=768 NEXT_BUILD_CPUS=1`; drop to `640` if needed. |
| `Authentication error [code: 10000]` from the CF API | Token missing permission for that API (e.g. D1) or wrong/expired token. Workers deploys need Workers Scripts:Edit + KV Storage:Edit. |
| Login returns *"Default password must be changed before remote access"* | `INITIAL_PASSWORD` secret not set. Set it (§6) and log in with the new value. |
| Worker **bundle size warning** at deploy | Expected (~5MB gzip vs 3MB startup budget). Deployment still succeeds; cold starts are just slower. |
| *"Wasm code generation disallowed by embedder"* | Something tried `WebAssembly.instantiate` from bytes — unsupported in workerd. The DB layer already uses pure-JS sql.js; check any newly added dependency. |
| `bun:sqlite` / *"Could not resolve bun:*"* during OpenNext build | The adapter import must stay hidden behind a variable specifier + `/* webpackIgnore: true */` (already done in `src/lib/db/adapters/bunSqliteAdapter.js`). |
| Data present but stale after an outage | A snapshot flush window was missed; the last ≤10s of writes before the kill were lost. Nothing to recover — writes are periodic snapshots, not a transactional log. |

## 15. Removing the deployment

```bash
npx wrangler delete                        # deletes the worker
npx wrangler kv namespace delete --binding DB_KV   # deletes the durable state
```
