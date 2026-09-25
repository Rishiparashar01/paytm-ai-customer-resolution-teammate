import {
  TestRunner,
  api,
  requireDatabase,
  startTestServer,
  finish,
} from "./test_harness";

/**
 * End-to-end demo test: runs all three scenarios exactly as §13 specifies.
 *   GET /health 200
 *   seed A → run → VERIFIED_SUCCESS
 *   seed B → run → HUMAN_REVIEW → approve → VERIFIED_SUCCESS
 *   seed C → run → BLOCKED/VERIFIED_FAILURE
 * Also covers input validation. Requires live PostgreSQL (§12.11).
 */

async function main(): Promise<void> {
  await requireDatabase();
  const server = await startTestServer();
  const runner = new TestRunner("test_demo_e2e");

  await runner.test("Health check 200", async () => {
    const res = await api(server.url, "/health");
    runner.assertEqual(res.status, 200, "status");
    runner.assertEqual(res.body.status, "ok", "body.status");
  });

  await runner.test("Scenario A: seed → run → VERIFIED_SUCCESS", async () => {
    const seed = await api(server.url, "/api/v1/demo/seed-scenario", {
      method: "POST",
      body: { scenario: "SCENARIO_A" },
    });
    runner.assertEqual(seed.status, 201, "seed status");

    const run = await api(server.url, `/api/v1/sessions/${seed.body.sessionId}/run`, {
      method: "POST",
      body: {},
    });
    runner.assertEqual(run.body.snapshot.session.outcomeStatus, "VERIFIED_SUCCESS", "A outcome");
    runner.assertEqual(run.body.snapshot.session.currentState, "RESOLVED_SUCCESS", "A state");

    // Customer identity from §13.
    runner.assertEqual(run.body.snapshot.session.customer.name, "Aarav Sharma", "customer name");
    runner.assertEqual(run.body.snapshot.targetTransaction.amount, 1250, "amount");
    runner.assertEqual(run.body.snapshot.targetTransaction.billerOrMerchant, "Airtel Postpaid", "biller");
  });

  await runner.test("Scenario B: seed → run → HUMAN_REVIEW → approve → VERIFIED_SUCCESS", async () => {
    const seed = await api(server.url, "/api/v1/demo/seed-scenario", {
      method: "POST",
      body: { scenario: "SCENARIO_B" },
    });
    runner.assertEqual(seed.status, 201, "seed status");

    const run = await api(server.url, `/api/v1/sessions/${seed.body.sessionId}/run`, {
      method: "POST",
      body: {},
    });
    runner.assertEqual(run.body.outcome.outcome, "PAUSED", "B pauses");
    runner.assertEqual(run.body.snapshot.session.currentState, "HUMAN_REVIEW", "B state");

    const reviewId = run.body.snapshot.pendingReview.reviewId;
    const verdict = await api(
      server.url,
      `/api/v1/sessions/${seed.body.sessionId}/human-review/${reviewId}/verdict`,
      { method: "POST", body: { verdict: "APPROVED", reviewerNotes: "e2e approval" } }
    );
    runner.assertEqual(verdict.body.snapshot.session.outcomeStatus, "VERIFIED_SUCCESS", "B outcome");
    runner.assertEqual(
      verdict.body.snapshot.targetTransaction.billerOrMerchant,
      "Tata Power Electricity",
      "B biller"
    );
    runner.assertEqual(verdict.body.snapshot.targetTransaction.amount, 3500, "B amount");
  });

  await runner.test("Scenario C: seed → run → BLOCKED/VERIFIED_FAILURE", async () => {
    const seed = await api(server.url, "/api/v1/demo/seed-scenario", {
      method: "POST",
      body: { scenario: "SCENARIO_C" },
    });
    runner.assertEqual(seed.status, 201, "seed status");

    const run = await api(server.url, `/api/v1/sessions/${seed.body.sessionId}/run`, {
      method: "POST",
      body: {},
    });
    runner.assert(
      String(run.body.outcome.reason).includes("BLOCKED"),
      `expected BLOCKED (got ${run.body.outcome.reason})`
    );
    runner.assertEqual(run.body.snapshot.session.outcomeStatus, "VERIFIED_FAILURE", "C outcome");
    runner.assertEqual(run.body.snapshot.session.customer.name, "Rohan Mehta", "C customer");
    runner.assertEqual(run.body.snapshot.session.customer.accountStatus, "FROZEN", "C account FROZEN");
    runner.assertEqual(
      run.body.snapshot.transactions.filter((t: any) => t.status === "SUCCESS").length,
      0,
      "C never mutated"
    );
  });

  await runner.test("Validation: unknown scenario → 400 with field details", async () => {
    const res = await api(server.url, "/api/v1/demo/seed-scenario", {
      method: "POST",
      body: { scenario: "SCENARIO_Z" },
    });
    runner.assertEqual(res.status, 400, "status");
    runner.assertEqual(res.body.error, "Validation failed", "error");
    runner.assert(Array.isArray(res.body.details) && res.body.details.length > 0, "field details");
  });

  await runner.test("Validation: malformed JSON → 400", async () => {
    const res = await fetch(`${server.url}/api/v1/demo/seed-scenario`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    runner.assertEqual(res.status, 400, "status");
  });

  await runner.test("404 for missing session", async () => {
    const res = await api(server.url, "/api/v1/sessions/sess_does_not_exist");
    runner.assertEqual(res.status, 404, "status");
    runner.assert(
      typeof res.body.error === "string" && /not found/i.test(res.body.error),
      "JSON 404 body with a not-found message"
    );
  });

  await runner.test("Payload too large → 413 (256kb JSON limit)", async () => {
    const res = await fetch(`${server.url}/api/v1/demo/seed-scenario`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenario: "SCENARIO_A", padding: "x".repeat(300 * 1024) }),
    });
    runner.assertEqual(res.status, 413, "status");
  });

  const code = runner.summary();
  await finish(code, server);
}

main().catch((err) => {
  console.error("test_demo_e2e crashed:", err);
  process.exit(1);
});
