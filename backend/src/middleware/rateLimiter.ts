import type { Request, Response, NextFunction } from "express";
import { rateLimitMax, rateLimitWindowMs } from "../config/env";

/**
 * In-memory sliding-window rate limiter.
 * 120 req/min/IP (configurable), responds 429 + Retry-After,
 * pruned every 60s by an unref'd interval.
 */

const hits = new Map<string, number[]>();

// Prune expired timestamps every 60s so the map cannot grow unbounded.
const pruneTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of hits) {
    const alive = timestamps.filter((t) => now - t < rateLimitWindowMs);
    if (alive.length === 0) hits.delete(ip);
    else hits.set(ip, alive);
  }
}, 60_000);
pruneTimer.unref();

export default function rateLimiter(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const now = Date.now();

  const timestamps = (hits.get(ip) ?? []).filter((t) => now - t < rateLimitWindowMs);

  if (timestamps.length >= rateLimitMax) {
    hits.set(ip, timestamps);
    const oldest = timestamps[0];
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + rateLimitWindowMs - now) / 1000));
    res.setHeader("Retry-After", String(retryAfterSeconds));
    res.status(429).json({
      error: "Too many requests",
      retryAfterSeconds,
    });
    return;
  }

  timestamps.push(now);
  hits.set(ip, timestamps);
  next();
}
