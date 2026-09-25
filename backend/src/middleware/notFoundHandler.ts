import type { Request, Response } from "express";

/** JSON 404 handler for unmatched routes. */
export default function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: "Not Found",
    path: req.originalUrl,
  });
}
