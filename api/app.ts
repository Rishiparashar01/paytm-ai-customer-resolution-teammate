// Vercel serverless entry (§11): mount the same Express app as the backend.
//   import { createApp } from "../backend/src/app";
//   const app = createApp();
//   export default (req, res) => app(req, res);
// Node http types are used so this compiles without @vercel/node.
//
// Required env vars: DATABASE_URL (pooled), CORS_ORIGIN, NODE_ENV;
// optional GEMINI_API_KEY / GEMINI_MODEL.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createApp } from "../backend/src/app";

const app = createApp();

// Express apps are `(req, res)` functions at runtime; widen the type here so
// the handler matches Vercel's Node runtime signature.
type NodeHandler = (req: IncomingMessage, res: ServerResponse) => void;
const handler = app as unknown as NodeHandler;

export default function (req: IncomingMessage, res: ServerResponse): void {
  handler(req, res);
}
