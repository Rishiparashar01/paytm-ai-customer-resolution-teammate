import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { isProduction } from "../config/env";
import { isAppError } from "../errors/AppError";

/**
 * Central error handler.
 * - ZodError → 400 with per-field details
 * - Malformed JSON body → 400
 * - Prisma P2002 (unique violation) → 409 idempotent-replay
 * - AppError → its own status
 * - Anything else → 500, generic message in production (no err.message leak);
 *   the full error is always logged server-side only.
 */
export default function errorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  // Zod validation errors → 400 with field details
  if (err instanceof ZodError) {
    const fields = err.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    res.status(400).json({ error: "Validation failed", details: fields });
    return;
  }

  const anyErr = err as
    | { type?: string; status?: number; statusCode?: number; code?: string; message?: string; stack?: string }
    | undefined;

  // Malformed JSON from express.json()
  if (anyErr?.type === "entity.parse.failed") {
    res.status(400).json({ error: "Invalid JSON body" });
    return;
  }

  // Body too large (256kb limit) → 413
  if (anyErr?.type === "entity.too.large") {
    res.status(413).json({ error: "Payload too large" });
    return;
  }

  // Other body-parser / middleware errors carry their own 4xx status
  const carried = anyErr?.status ?? anyErr?.statusCode;
  if (typeof carried === "number" && carried >= 400 && carried < 500) {
    res.status(carried).json({ error: anyErr?.message ?? "Bad request" });
    return;
  }

  // Prisma unique-constraint violation → idempotent replay conflict
  if (anyErr?.code === "P2002") {
    res.status(409).json({
      error: "Idempotent replay conflict: a record with that idempotency key already exists",
      code: "P2002",
    });
    return;
  }

  if (isAppError(err)) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }

  // Generic 500 — never leak internals in production
  console.error("[errorHandler] Unhandled error:", err);
  if (isProduction) {
    res.status(500).json({ error: "Internal Server Error" });
  } else {
    res.status(500).json({
      error: anyErr?.message ?? "Internal Server Error",
      stack: anyErr?.stack,
    });
  }
}
