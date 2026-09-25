import type { Request, Response, NextFunction } from "express";

/**
 * Security headers middleware (in order per spec):
 * - X-Content-Type-Options: nosniff
 * - X-Frame-Options: DENY
 * - Referrer-Policy: no-referrer
 * - removes X-Powered-By
 */
export default function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.removeHeader("X-Powered-By");
  next();
}
