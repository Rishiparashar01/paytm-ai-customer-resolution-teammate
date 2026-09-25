import { createApp, closePrisma } from "./app";
import { port } from "./config/env";

/**
 * Server entrypoint: listens on PORT (default 4000) with crash handlers and
 * graceful SIGTERM/SIGINT shutdown.
 */

const app = createApp();

const server = app.listen(port, () => {
  console.log(`[server] Paytm AI Customer Resolution Teammate listening on http://localhost:${port}`);
  console.log(`[server] Health check: http://localhost:${port}/health`);
});

// Unhandled rejections / exceptions are logged and shut the process down
// rather than leaving a half-alive server.
process.on("unhandledRejection", (reason) => {
  console.error("[server] Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[server] Uncaught exception:", err);
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received — shutting down gracefully`);

  const forceExit = setTimeout(() => {
    console.error("[server] Forced shutdown after timeout");
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePrisma();
  console.log("[server] Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
