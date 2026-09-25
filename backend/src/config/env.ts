/**
 * Environment configuration.
 * - Validates PORT (1–65535, fallback 4000)
 * - Throws on missing DATABASE_URL in production, warns in dev
 * - Exposes isProduction, corsOrigin, geminiApiKey, geminiModel, policy config
 */

// Load backend/.env when present so `npm run dev` / tests work out of the box.
// Never commit backend/.env — only placeholders live there (see .env.example).
if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file — DATABASE_URL must come from the process environment.
  }
}

const isProduction = process.env.NODE_ENV === "production";

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 4000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    if (isProduction) {
      throw new Error(`Invalid PORT "${raw}": must be an integer between 1 and 65535`);
    }
    console.warn(`[config] Invalid PORT "${raw}" — falling back to 4000`);
    return 4000;
  }
  return parsed;
}

const port = parsePort(process.env.PORT);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  if (isProduction) {
    throw new Error("DATABASE_URL environment variable is required in production");
  }
  console.warn("[config] DATABASE_URL is not set — set it in backend/.env before starting the server");
}

/** Explicit CORS allowlist (comma separated). Empty when unset. */
const corsOrigin = (process.env.CORS_ORIGIN ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);

const geminiApiKey = process.env.GEMINI_API_KEY ?? "";
const geminiModel = process.env.GEMINI_MODEL ?? "gemini-1.5-flash";

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Policy limits (see §8 of the build prompt). */
const policyMaxRetryAmount = parsePositiveInt(process.env.POLICY_MAX_RETRY_AMOUNT, 2000);
const policyMaxRetries = parsePositiveInt(process.env.POLICY_MAX_RETRIES, 1);

/** In-memory rate limiter: 120 req/min/IP by default. */
const rateLimitMax = parsePositiveInt(process.env.RATE_LIMIT_MAX, 120);
const rateLimitWindowMs = parsePositiveInt(process.env.RATE_LIMIT_WINDOW_MS, 60_000);

export {
  isProduction,
  port,
  databaseUrl,
  corsOrigin,
  geminiApiKey,
  geminiModel,
  policyMaxRetryAmount,
  policyMaxRetries,
  rateLimitMax,
  rateLimitWindowMs,
};
