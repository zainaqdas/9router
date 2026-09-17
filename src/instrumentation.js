export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    // Workers: no long-lived process → no background schedulers, no catalog
    // sync (writeAtomic needs a writable FS; /tmp is ephemeral).
    if (process.env.DISABLE_BACKGROUND_JOBS === "1") {
      return;
    }
    if ((await import("@/lib/runtime.js")).isWorkersRuntime()) {
      return;
    }

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();
  }
}
