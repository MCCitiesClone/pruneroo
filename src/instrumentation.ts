/**
 * Next calls `register()` once per server instance, before the first request.
 * It runs in every runtime, so the Node-only sync worker is gated and imported
 * dynamically — a top-level import would pull `pg` into the edge bundle.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { bootSyncWorker } = await import("./lib/sync/boot");
  await bootSyncWorker();
}
