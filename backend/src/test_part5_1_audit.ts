import {
  TestRunner,
  api,
  requireDatabase,
  startTestServer,
  finish,
} from "./test_harness";

/**
 * Part 5.1 audit tests: SCENARIO_C.
 * FROZEN account → policy BLOCKED at RP_002 → no mutation → VERIFIED_FAILURE
 * and escalation to human support. Verifies the full audit trail and that the
 * database was never mutated. Requires live PostgreSQL (§12.11).
 */

async function main(): Promise<void> {
  await requireDatabase();
  const server = await startTestServer();
  const runner = new TestRunner("test_part5_1_audit");

  let seedC: any;
  await runner.test("Seed SCENARIO_C", async () => {
    const res = await api(server.url, "/api/v1/demo/seed-scenario", {
      method: "POST",
      body: { scenario: "SCENARIO_C" },
    });
    runner.assertEqual(res.status, 201, "status");
    seedC = res.body;
  });

  await runner.test("Run SCENARIO_C → BLOCKED at RP_002 → VERIFIED_FAILURE", async () => {
    const res = await api(server.url, `/api/v1/sessions/${seedC.sessionId}/run`, {
      method: "POST",
      body: {},
    });
    runner.assertEqual(res.status, 200, "status");
    runner.assertEqual(res.body.outcome.outcome, "TERMINAL", "terminal outcome");
    runner.assert(
      String(res.body.outcome.reason).includes("RP_002"),
      `blocked at RP_002 (got ${res.body.outcome.reason})`
    );

    const snap = res.body.snapshot;
    runner.assertEqual(snap.session.outcomeStatus, "VERIFIED_FAILURE", "outcomeStatus");
    runner.assertEqual(snap.session.currentState, "RESOLVED_FAILURE", "currentState");
  });

  await runner.test("No financial mutation occurred", async () => {
    const res = await api(server.url, `/api/v1/sessions/${seedC.sessionId}`);
    const snap = res.body;

    // The proposed retry was never executed.
    const retrySteps = snap.session.actionSteps.filter((s: any) => s.toolName === "retry_payment");
    runner.assertEqual(retrySteps.length, 1, "one retry proposed");
    runner.assertEqual(retrySteps[0].policyVerdict, "BLOCKED", "policy verdict BLOCKED");
    runner.assertEqual(retrySteps[0].policyRuleTriggered, "RP_002", "rule RP_002");
    runner.assertEqual(retrySteps[0].executionStatus, "SKIPPED", "execution SKIPPED");

    // No SUCCESS transaction was ever created; only the seeded original exists.
    runner.assertEqual(snap.transactions.length, 1, "only the original transaction exists");
    runner.assertEqual(snap.transactions[0].status, "PENDING_CLEARING", "original untouched");
    runner.assertEqual(
      snap.transactions.filter((t: any) => t.status === "SUCCESS").length,
      0,
      "no SUCCESS transactions"
    );
    runner.assertEqual(snap.transactions[0].idempotencyKey, null, "no idempotency key consumed");
  });

  await runner.test("Audit trail contains every required stage", async () => {
    const res = await api(server.url, `/api/v1/sessions/${seedC.sessionId}`);
    const stages = res.body.session.auditEntries.map((e: any) => e.stage);

    for (const required of [
      "INTAKE",
      "CONTEXT_GATHERED",
      "PLAN_PROPOSED",
      "POLICY_EVALUATED",
      "OUTCOME_VERIFIED",
      "STATE_TRANSITION",
    ]) {
      runner.assert(stages.includes(required), `audit contains ${required}`);
    }

    // The blocked policy entry names RP_002.
    const blocked = res.body.session.auditEntries.find(
      (e: any) => e.stage === "POLICY_EVALUATED" && e.details?.ruleTriggered === "RP_002"
    );
    runner.assert(blocked, "POLICY_EVALUATED entry for RP_002");
    runner.assertEqual(blocked.details.verdict, "BLOCKED", "verdict BLOCKED");

    // RP_002's preceding rules passed — first-hit wins ordering is visible.
    const ruleResults = blocked.details.ruleResults;
    runner.assertEqual(ruleResults[0].rule, "RP_001", "RP_001 evaluated first");
    runner.assertEqual(ruleResults[0].status, "PASS", "RP_001 passed");
    runner.assertEqual(ruleResults[1].rule, "RP_002", "RP_002 second");
    runner.assertEqual(ruleResults[1].status, "FAIL", "RP_002 failed");
    runner.assertEqual(ruleResults[2].status, "SKIP", "RP_003 skipped (first-hit wins)");
  });

  await runner.test("Escalated to support (audit ticket + notification)", async () => {
    const res = await api(server.url, `/api/v1/sessions/${seedC.sessionId}`);
    const entries = res.body.session.auditEntries;

    const escalation = entries.find((e: any) => e.stage === "HUMAN_DECIDED");
    runner.assert(escalation, "escalation ticket recorded (HUMAN_DECIDED)");
    runner.assert(String(escalation.details.ticketId).startsWith("tkt_"), "ticket id present");

    const notifyStep = res.body.session.actionSteps.find(
      (s: any) => s.toolName === "send_customer_notification"
    );
    runner.assert(notifyStep, "customer notification step exists");
    runner.assertEqual(notifyStep.executionStatus, "SUCCESS", "notification delivered");
  });

  await runner.test("Re-running a blocked session stays terminal (no mutations)", async () => {
    const res = await api(server.url, `/api/v1/sessions/${seedC.sessionId}/run`, {
      method: "POST",
      body: {},
    });
    runner.assertEqual(res.status, 200, "status");
    runner.assertEqual(res.body.snapshot.session.outcomeStatus, "VERIFIED_FAILURE", "outcome unchanged");
    runner.assertEqual(
      res.body.snapshot.transactions.filter((t: any) => t.status === "SUCCESS").length,
      0,
      "still no SUCCESS transactions"
    );
  });

  const code = runner.summary();
  await finish(code, server);
}

main().catch((err) => {
  console.error("test_part5_1_audit crashed:", err);
  process.exit(1);
});
