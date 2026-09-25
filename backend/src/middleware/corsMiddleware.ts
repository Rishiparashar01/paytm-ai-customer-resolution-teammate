import type { Request, Response, NextFunction } from "express";
import { corsOrigin, isProduction } from "../config/env";

/**
 * CORS middleware with an explicit allowlist only — never `origin: true`.
 * - CORS_ORIGIN set → exact match against the comma-separated list.
 * - CORS_ORIGIN unset in development → allow localhost:5173 / 127.0.0.1:5173.
 * - CORS_ORIGIN unset in production → deny gracefully (no ACAO header, never throws).
 */
export default function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;

  let allowed: string | null = null;

  if (corsOrigin.length > 0) {
    if (origin && corsOrigin.includes(origin)) allowed = origin;
  } else if (!isProduction) {
    if (origin && (origin.startsWith("http://localhost:5173") || origin.startsWith("http://127.0.0.1:5173"))) {
      allowed = origin;
    }
  }
  // Production with no allowlist: allowed stays null → cross-origin blocked gracefully.

  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", allowed);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    // Never pair allowlist CORS with wildcard credentials.
    res.setHeader("Access-Control-Allow-Credentials", "false");
  }

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  next();
}
