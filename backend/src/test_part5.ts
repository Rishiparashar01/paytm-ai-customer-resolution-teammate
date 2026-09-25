import {
  TestRunner,
  api,
  requireDatabase,
  startTestServer,
  finish,
} from "./test_harness";

/**
 * Part 5 tests: SCENARIO_B human-in-the-loop flow.
 * ₹3,500 > ₹2,000 autonomous cap → HUMAN_REVIEW → supervisor approves →
 * the action re-enters policy with a fresh idempotency key → executes →
 * VERIFIED_SUCCESS. Also covers REJECTED and MODIFIED verdicts.
 * Requires live PostgreSQL (§12.11).
 */

async function main(): Promise<void> {
  await requireDatabase();
  const server = await startTestServer();
  const runner = new TestRunner("test_part5");

  let seedB: any;
  await runner.test("Seed SCENARIO_B", async () => {
    const res = await api(server.url, "/api/v1/demo/seed-scenario", {
      method: "POST",
      body: { scenario: "SCENARIO_B" },
    });
    runner.assertEqual(res.status, 201, "status");
    seedB = res.body;
  });

  await runner.test("Run SCENARIO_B → pauses at HUMAN_REVIEW (RP_006)", async () => {
    const res = await api(server.url, `/api/v1/sessions/${seedB.sessionId}/run`, {
      method: "POST",
      body: {},
    });
    runner.assertEqual(res.status, 200, "status");
    runner.assertEqual(res.body.outcome.outcome, "PAUSED", "run paused");

    const snap = res.body.snapshot;
    runner.assertEqual(snap.session.currentState, "HUMAN_REVIEW", "currentState");
    runner.assertEqual(snap.session.outcomeStatus, "IN_PROGRESS", "still in progress");

    // Nothing was mutated while awaiting review.
    runner.assertEqual(
      snap.transactions.filter((t: any) => t.status === "SUCCESS").length,
      0,
      "no SUCCESS transaction before approval"
    );

    // Pending review exists, pointing at the proposed retry.
    runner.assert(snap.pendingReview, "pending human review exists");
    runner.assertEqual(snap.pendingReview.status, "PENDING", "review PENDING");
    runner.assertEqual(snap.pendingReview.proposedTool, "retry_payment", "proposed tool");

    // RP_006 recorded as REVIEW in the policy audit.
    const policyAudits = snap.session.auditEntries.filter((e: any) => e.stage === "POLICY_EVALUATED");
    const requiresHuman = policyAudits.filter((e: any) => e.details?.verdict === "REQUIRES_HUMAN");
    runner.assert(requiresHuman.length >= 1, "REQUIRES_HUMAN policy entry");
    const ruleResults = requiresHuman[requiresHuman.length - 1].details.ruleResults;
    const rp006 = ruleResults.find((r: any) => r.rule === "RP_006");
    runner.assertEqual(rp006.status, "REVIEW", "RP_006 flagged for review");
    const rp005 = ruleResults.find((r: any) => r.rule === "RP_005");
    runner.assertEqual(rp005.status, "PASS", "RP_005 passed before RP_006");
  });

  let pendingReviewId: string;
  await runner.test("Fetch snapshot shows the pending review", async () => {
    const res = await api(server.url, `/api/v1/sessions/${seedB.sessionId}`);
    runner.assertEqual(res.status, 200, "status");
    runner.assert(res.body.pendingReview, "pendingReview present");
    pendingReviewId = res.body.pendingReview.reviewId;
  });

  await runner.test("Approve → re-enters policy → executes → VERIFIED_SUCCESS", async () => {
    const res = await api(
      server.url,
      `/api/v1/sessions/${seedB.sessionId}/human-review/${pendingReviewId}/verdict`,
      { method: "POST", body: { verdict: "APPROVED", reviewerNotes: "Looks good, amount verified" } }
    );
    runner.assertEqual(res.status, 200, "status");
    runner.assertEqual(res.body.result, "APPROVED_EXECUTED", "verdict result");

    const snap = res.body.snapshot;
    runner.assertEqual(snap.session.outcomeStatus, "VERIFIED_SUCCESS", "outcomeStatus");
    runner.assertEqual(snap.session.currentState, "RESOLVED_SUCCESS", "currentState");

    const successTxns = snap.transactions.filter((t: any) => t.status === "SUCCESS");
    runner.assertEqual(successTxns.length, 1, "one SUCCESS transaction after approval");
    runner.assert(String(successTxns[0].idempotencyKey ?? "").startsWith("idemp_"), "approved retry carries idempotency key");

    // Post-approval re-evaluation is audited with the human override.
    const postApproval = snap.session.auditEntries.filter(
      (e: any) => e.stage === "POLICY_EVALUATED" && e.details?.humanOverride === true
    );
    runner.assertEqual(postApproval.length, 1, "one post-approval policy evaluation");
    runner.assertEqual(postApproval[0].details.verdict, "ALLOWED", "post-approval verdict ALLOWED");

    // Human decision is in the audit trail.
    const decisions = snap.session.auditEntries.filter((e: any) => e.stage === "HUMAN_DECIDED");
    runner.assert(decisions.length >= 1, "HUMAN_DECIDED audit entry");
    runner.assertEqual(decisions[0].details.verdict, "APPROVED", "verdict recorded");

    // Review row updated.
    const review = snap.session.humanReviews.find((r: any) => r.reviewId === pendingReviewId);
    runner.assertEqual(review.status, "APPROVED", "review status APPROVED");
    runner.assert(review.resolvedAt, "review resolvedAt set");
  });

  await runner.test("Double-verdict returns 409", async () => {
    const res = await api(
      server.url,
      `/api/v1/sessions/${seedB.sessionId}/human-review/${pendingReviewId}/verdict`,
      { method: "POST", body: { verdict: "APPROVED" } }
    );
    runner.assertEqual(res.status, 409, "status");
  });

  await runner.test("REJECTED verdict escalates the session", async () => {
    const seed = await api(server.url, "/api/v1/demo/seed-scenario", {
      method: "POST",
      body: { scenario: "SCENARIO_B" },
    });
    const sessionId = seed.body.sessionId;
    const run = await api(server.url, `/api/v1/sessions/${sessionId}/run`, { method: "POST", body: {} });
    runner.assertEqual(run.body.outcome.outcome, "PAUSED", "paused");

    const snapshot = await api(server.url, `/api/v1/sessions/${sessionId}`);
    const reviewId = snapshot.body.pendingReview.reviewId;

    const verdict = await api(
      server.url,
      `/api/v1/sessions/${sessionId}/human-review/${reviewId}/verdict`,
      { method: "POST", body: { verdict: "REJECTED", reviewerNotes: "Customer asked to hold" } }
    );
    runner.assertEqual(verdict.status, 200, "status");
    runner.assertEqual(verdict.body.result, "REJECTED_ESCALATED", "result");
    runner.assertEqual(verdict.body.snapshot.session.outcomeStatus, "ESCALATED", "outcomeStatus");
    runner.assertEqual(verdict.body.snapshot.session.currentState, "ESCALATED", "currentState");
    runner.assertEqual(
      verdict.body.snapshot.transactions.filter((t: any) => t.status === "SUCCESS").length,
      0,
      "no mutation on reject"
    );
  });

  await runner.test("MODIFIED verdict merges params and executes", async () => {
    const seed = await api(server.url, "/api/v1/demo/seed-scenario", {
      method: "POST",
      body: { scenario: "SCENARIO_B" },
    });
    const sessionId = seed.body.sessionId;
    await api(server.url, `/api/v1/sessions/${sessionId}/run`, { method: "POST", body: {} });
    const snapshot = await api(server.url, `/api/v1/sessions/${sessionId}`);
    const reviewId = snapshot.body.pendingReview.reviewId;

    const verdict = await api(
      server.url,
      `/api/v1/sessions/${sessionId}/human-review/${reviewId}/verdict`,
      { method: "POST", body: { verdict: "MODIFIED", reviewerNotes: "Adjusted", modifiedParams: {} } }
    );
    runner.assertEqual(verdict.status, 200, "status");
    runner.assertEqual(verdict.body.result, "APPROVED_EXECUTED", "result");
    runner.assertEqual(verdict.body.snapshot.session.outcomeStatus, "VERIFIED_SUCCESS", "outcome");
  });

  const code = runner.summary();
  await finish(code, server);
}

main().catch((err) => {
  console.error("test_part5 crashed:", err);
  process.exit(1);
});
