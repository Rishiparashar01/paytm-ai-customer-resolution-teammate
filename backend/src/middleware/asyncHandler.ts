import type { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * express@4 does not forward rejected promises from async route handlers to
 * the error middleware — this wrapper does.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export default asyncHandler;
