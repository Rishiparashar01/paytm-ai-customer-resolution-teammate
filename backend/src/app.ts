import express from "express";
import type { Request, Response, NextFunction } from "express";
import securityHeaders from "./middleware/securityHeaders";
import rateLimiter from "./middleware/rateLimiter";
import corsMiddleware from "./middleware/corsMiddleware";
import notFoundHandler from "./middleware/notFoundHandler";
import errorHandler from "./middleware/errorHandler";
import demoRoutes from "./routes/demoRoutes";
import sessionRoutes from "./routes/sessionRoutes";
import { prisma } from "./prisma";

/**
 * `createApp()` builds the Express app without listening (§4).
 * Middleware order: trust proxy → security headers → rate limiter → CORS →
 * JSON body (256kb) → routes → JSON 404 → central error handler.
 */
export function createApp() {
  const app = express();

  // Behind one proxy (Railway/Vercel/nginx) so req.ip is the real client IP.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(securityHeaders);
  app.use(rateLimiter);
  app.use(corsMiddleware);
  app.use(express.json({ limit: "256kb" }));

  // Health checks at root and under /api/v1.
  const health = (_req: Request, res: Response) => {
    res.json({ status: "ok", service: "paytm-ai-customer-resolution-backend" });
  };
  app.get("/health", health);

  app.use("/api/v1", demoRoutes);
  app.use("/api/v1", sessionRoutes);
  app.get("/api/v1/health", health);

  app.use(notFoundHandler);

  // express@4 only forwards sync throws from async handlers — wrap async
  // routes so rejections reach the central error handler.
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    errorHandler(err, req, res, next);
  });

  return app;
}

export async function closePrisma(): Promise<void> {
  await prisma.$disconnect();
}

export default createApp;
