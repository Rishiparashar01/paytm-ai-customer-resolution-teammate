import {
  TestRunner,
  api,
  requireDatabase,
  startTestServer,
  finish,
} from "./test_harness";

/**
 * Live-server smoke tests: health, scenario descriptors, and the full
 * SCENARIO_A autonomous run (seed → run → VERIFIED_SUCCESS).
 * Requires live PostgreSQL (§12.11).
 */

async function main(): Promise<void> {
  await requireDatabase();
  const server = await startTestServer();
  const runner = new TestRunner("test_live_servers");

  await runner.test("GET /health returns 200 {status:'ok'}", async () => {
    const res = await api(server.url, "/health");
    runner.assertEqual(res.status, 200, "status");
    runner.assertEqual(res.body.status, "ok", "body.status");
    runner.assert(typeof res.body.service === "string", "service present");
  });

  await runner.test("GET /api/v1/health returns 200", async () => {
    const res = await api(server.url, "/api/v1/health");
    runner.assertEqual(res.status, 200, "status");
  });

  await runner.test("GET /api/v1/demo/scenarios returns the 3 descriptors", async () => {
    const res = await api(server.url, "/api/v1/demo/scenarios");
    runner.assertEqual(res.status, 200, "status");
    runner.assertEqual(res.body.scenarios.length, 3, "scenario count");
    const keys = res.body.scenarios.map((s: any) => s.scenario);
    runner.assert(keys.includes("SCENARIO_A"), "has SCENARIO_A");
    runner.assert(keys.includes("SCENARIO_B"), "has SCENARIO_B");
    runner.assert(keys.includes("SCENARIO_C"), "has SCENARIO_C");
  });

  await runner.test("Unknown route returns JSON 404", async () => {
    const res = await api(server.url, "/api/v1/nope");
    runner.assertEqual(res.status, 404, "status");
    runner.assertEqual(res.body.error, "Not Found", "body.error");
  });

  await runner.test("Security headers are present", async () => {
    const res = await fetch(`${server.url}/health`);
    runner.assertEqual(res.headers.get("x-content-type-options"), "nosniff", "nosniff");
    runner.assertEqual(res.headers.get("x-frame-options"), "DENY", "frame options");
    runner.assertEqual(res.headers.get("referrer-policy"), "no-referrer", "referrer policy");
    runner.assertEqual(res.headers.get("x-powered-by"), null, "x-powered-by removed");
  });

  let seedA: any;
  await runner.test("Seed SCENARIO_A", async () => {
    const res = await api(server.url, "/api/v1/demo/seed-scenario", {
      method: "POST",
      body: { scenario: "SCENARIO_A" },
    });
    runner.assertEqual(res.status, 201, "status");
    runner.assert(res.body.sessionId && res.body.customerId && res.body.transactionId, "ids returned");
    seedA = res.body;
  });

  await runner.test("Run SCENARIO_A → VERIFIED_SUCCESS", async () => {
    const res = await api(server.url, `/api/v1/sessions/${seedA.sessionId}/run`, {
      method: "POST",
      body: {},
    });
    runner.assertEqual(res.status, 200, "status");
    const snap = res.body.snapshot;
    runner.assertEqual(snap.session.outcomeStatus, "VERIFIED_SUCCESS", "outcomeStatus");
    runner.assertEqual(snap.session.currentState, "RESOLVED_SUCCESS", "currentState");

    // A retry step executed SUCCESS and a new SUCCESS transaction exists.
    const retrySteps = snap.session.actionSteps.filter((s: any) => s.toolName === "retry_payment");
    runner.assertEqual(retrySteps.length, 1, "one retry step");
    runner.assertEqual(retrySteps[0].executionStatus, "SUCCESS", "retry executed");
    runner.assertEqual(retrySteps[0].policyVerdict, "ALLOWED", "policy allowed");
    runner.assert(retrySteps[0].toolParams.idempotencyKey.startsWith("idemp_"), "fresh idempotency key");

    const successTxns = snap.transactions.filter((t: any) => t.status === "SUCCESS");
    runner.assertEqual(successTxns.length, 1, "exactly one SUCCESS transaction created");

    // Verified only after re-read: an OUTCOME_VERIFIED audit entry exists.
    const verified = snap.session.auditEntries.filter((e: any) => e.stage === "OUTCOME_VERIFIED");
    runner.assert(verified.length >= 1, "OUTCOME_VERIFIED audit entry present");
  });

  await runner.test("Re-running a terminal session is a no-op (idempotent)", async () => {
    const res = await api(server.url, `/api/v1/sessions/${seedA.sessionId}/run`, {
      method: "POST",
      body: {},
    });
    runner.assertEqual(res.status, 200, "status");
    runner.assertEqual(res.body.snapshot.session.outcomeStatus, "VERIFIED_SUCCESS", "outcome unchanged");
    runner.assertEqual(res.body.outcome.outcome, "TERMINAL", "loop reports terminal");
  });

  const code = runner.summary();
  await finish(code, server);
}

main().catch(async (err) => {
  console.error("test_live_servers crashed:", err);
  process.exit(1);
});
