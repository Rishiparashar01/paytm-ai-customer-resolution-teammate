import { createApp } from "./app";
import { prisma } from "./prisma";

/**
 * Test harness shared by src/test_*.ts (excluded from the emit build, run
 * with `tsx`). Every suite boots the real Express app in-process and
 * requires a live PostgreSQL (prisma db push must have run).
 *
 *   npx tsx src/test_live_servers.ts
 */

export interface TestServer {
  url: string;
  close: () => Promise<void>;
}

export async function requireDatabase(): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    console.error(
      "\n✗ Live PostgreSQL is required but unreachable.\n" +
        "  1. Start one:  docker run -d --name paytm-pg -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=paytm_ai postgres:16\n" +
        "  2. Set DATABASE_URL in backend/.env\n" +
        "  3. Push the schema:  npm --workspace=backend run db:push\n"
    );
    throw err;
  }
}

export async function startTestServer(): Promise<TestServer> {
  const app = createApp();
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Could not determine test server port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      type Closable = typeof server & {
        closeIdleConnections?: () => void;
        closeAllConnections?: () => void;
      };
      const s = server as Closable;
      // Drop keep-alive sockets first so close() resolves immediately —
      // closing with live sockets can trip libuv assertions on Windows.
      s.closeIdleConnections?.();
      s.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

export async function api<T = any>(
  baseUrl: string,
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<ApiResponse<T>> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: { "Content-Type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

export class TestRunner {
  private passed = 0;
  private failed = 0;
  private readonly suite: string;

  constructor(suite: string) {
    this.suite = suite;
    console.log(`\n━━━ ${suite} ━━━`);
  }

  async test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      this.passed += 1;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      this.failed += 1;
      const message = err instanceof Error ? `${err.message}${err.stack ? `\n${err.stack.split("\n").slice(1, 4).join("\n")}` : ""}` : String(err);
      console.error(`  ✗ ${name}\n${message.replace(/^/gm, "      ")}`);
    }
  }

  assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(`Assertion failed: ${message}`);
  }

  assertEqual<T>(actual: T, expected: T, label: string): void {
    if (actual !== expected) {
      throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }

  summary(): number {
    console.log(`  ${this.suite}: ${this.passed} passed, ${this.failed} failed`);
    return this.failed === 0 ? 0 : 1;
  }
}

/**
 * End a suite: close the server, disconnect Prisma, set the exit code.
 * Prefers a natural process exit (so piped stdout fully flushes); if stray
 * handles keep the loop alive, forces the exit shortly after.
 */
export async function finish(code: number, server?: TestServer): Promise<never> {
  if (server) await server.close();
  await prisma.$disconnect();

  process.exitCode = code;
  setTimeout(() => process.exit(code), 1500).unref();

  // Never resolves: the process exits naturally once the loop drains,
  // or via the timer above.
  return new Promise<never>(() => {});
}
