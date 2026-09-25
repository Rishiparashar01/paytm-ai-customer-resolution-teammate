import {
  TestRunner,
  api,
  requireDatabase,
  startTestServer,
  finish,
} from "./test_harness";

/**
 * Part 6.1 audit-integrity tests:
 * - audit ids are strictly increasing (append-only, never rewritten)
 * - every state transition in the trail is recorded
 * - details/contextReferences are structured JSON
 * - no API exists that could update or delete audit entries
 * Requires live PostgreSQL (§12.11).
 */

async function main(): Promise<void> {
  await requireDatabase();
  const server = await startTestServer();
  const runner = new TestRunner("test_part6_1_audit");

  let sessionId: string;
  let auditIds: string[];

  await runner.test("Run Scenario A to completion", async () => {
    const seed = await api(server.url, "/api/v1/demo/seed-scenario", {
      method: "POST",
      body: { scenario: "SCENARIO_A" },
    });
    sessionId = seed.body.sessionId;
    const run = await api(server.url, `/api/v1/sessions/${sessionId}/run`, {
      method: "POST",
      body: {},
    });
    runner.assertEqual(run.body.snapshot.session.outcomeStatus, "VERIFIED_SUCCESS", "outcome");
    auditIds = run.body.snapshot.session.auditEntries.map((e: any) => e.id);
  });

  await runner.test("Audit ids are strictly increasing BigInts (append-only)", async () => {
    runner.assert(auditIds.length >= 8, `expected a rich trail, got ${auditIds.length} entries`);
    for (let i = 1; i < auditIds.length; i++) {
      if (BigInt(auditIds[i]) <= BigInt(auditIds[i - 1])) {
        throw new Error(`Audit id out of order at index ${i}: ${auditIds[i - 1]} → ${auditIds[i]}`);
      }
    }
  });

  await runner.test("Snapshot order equals id order (no rewriting)", async () => {
    const res = await api(server.url, `/api/v1/sessions/${sessionId}`);
    const ids = res.body.session.auditEntries.map((e: any) => e.id);
    runner.assertEqual(ids.length, auditIds.length, "same entry count");
    for (let i = 0; i < ids.length; i++) runner.assertEqual(ids[i], auditIds[i], `id at ${i}`);
  });

  await runner.test("Every state transition in the run is audited", async () => {
    const res = await api(server.url, `/api/v1/sessions/${sessionId}`);
    const transitions = res.body.session.auditEntries.filter(
      (e: any) => e.stage === "STATE_TRANSITION"
    );
    runner.assert(transitions.length >= 4, `expected ≥4 transitions, got ${transitions.length}`);

    const described = transitions.map((t: any) => `${t.details.from}→${t.details.to}`);
    runner.assert(described.includes("INTAKE→GATHERING_CONTEXT"), "INTAKE→GATHERING_CONTEXT audited");
    runner.assert(
      described.includes("FORMULATING_PLAN→POLICY_EVALUATION"),
      "FORMULATING_PLAN→POLICY_EVALUATION audited"
    );
    runner.assert(
      described.includes("POLICY_EVALUATION→EXECUTING_STEP"),
      "POLICY_EVALUATION→EXECUTING_STEP audited"
    );
    runner.assert(
      described.includes("VERIFYING_OUTCOME→RESOLVED_SUCCESS"),
      "VERIFYING_OUTCOME→RESOLVED_SUCCESS audited"
    );
  });

  await runner.test("All entries carry structured details + timestamps", async () => {
    const res = await api(server.url, `/api/v1/sessions/${sessionId}`);
    for (const entry of res.body.session.auditEntries) {
      runner.assert(entry.details && typeof entry.details === "object", `details object on ${entry.id}`);
      runner.assert(entry.timestamp, `timestamp on ${entry.id}`);
      runner.assert(
        typeof entry.decisionSummary === "string" && entry.decisionSummary.length > 0,
        `decisionSummary on ${entry.id}`
      );
      const parsed = Date.parse(entry.timestamp);
      runner.assert(!Number.isNaN(parsed), `parseable timestamp on ${entry.id}`);
    }
  });

  await runner.test("Stage ordering follows the state machine", async () => {
    const res = await api(server.url, `/api/v1/sessions/${sessionId}`);
    const stages = res.body.session.auditEntries.map((e: any) => e.stage);
    const order = ["INTAKE", "CONTEXT_GATHERED", "PLAN_PROPOSED", "POLICY_EVALUATED", "TOOL_EXECUTED", "OUTCOME_VERIFIED"];
    let lastIdx = -1;
    for (const stage of order) {
      const idx = stages.indexOf(stage);
      runner.assert(idx !== -1, `stage ${stage} present`);
      runner.assert(idx > lastIdx, `stage ${stage} appears after ${stages[lastIdx] ?? "start"}`);
      lastIdx = idx;
    }
  });

  await runner.test("No endpoint can mutate the audit trail", async () => {
    // Only GET reads exist for sessions; write attempts on audit paths 404/405.
    const attempts: Array<[string, string]> = [
      ["PUT", `/api/v1/sessions/${sessionId}`],
      ["PATCH", `/api/v1/sessions/${sessionId}`],
      ["DELETE", `/api/v1/sessions/${sessionId}`],
      ["PUT", `/api/v1/sessions/${sessionId}/audit`],
      ["DELETE", `/api/v1/audit/1`],
      ["POST", `/api/v1/sessions/${sessionId}/audit`],
    ];
    for (const [method, path] of attempts) {
      const res = await api(server.url, path, { method, body: {} });
      runner.assert(res.status === 404 || res.status === 405, `${method} ${path} → ${res.status} (404/405 expected)`);
    }
  });

  await runner.test("Chained scenarios keep audits isolated per session", async () => {
    const seedB = await api(server.url, "/api/v1/demo/seed-scenario", {
      method: "POST",
      body: { scenario: "SCENARIO_B" },
    });
    await api(server.url, `/api/v1/sessions/${seedB.body.sessionId}/run`, { method: "POST", body: {} });

    const a = await api(server.url, `/api/v1/sessions/${sessionId}`);
    const b = await api(server.url, `/api/v1/sessions/${seedB.body.sessionId}`);
    runner.assertEqual(
      a.body.session.auditEntries.every((e: any) => e.sessionId === sessionId),
      true,
      "A trail only has A entries"
    );
    runner.assertEqual(
      b.body.session.auditEntries.every((e: any) => e.sessionId === seedB.body.sessionId),
      true,
      "B trail only has B entries"
    );
    runner.assertEqual(
      a.body.session.auditEntries.some((e: any) => e.stage === "HUMAN_DECIDED"),
      false,
      "A has no human decisions"
    );
  });

  const code = runner.summary();
  await finish(code, server);
}

main().catch((err) => {
  console.error("test_part6_1_audit crashed:", err);
  process.exit(1);
});
