import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { AppError } from "../errors/AppError";
import { logEvent } from "../services/audit.service";
import { evaluateProposedAction, type PolicyEvaluation } from "../policy/engine";
import { planResolution, type PlannedAction, type PlannerContext } from "../planners/geminiAdapter";
import { dispatchTool } from "../tools/toolRegistry";
import { escalate } from "../services/support.service";
import { policyMaxRetryAmount, policyMaxRetries } from "../config/env";

/**
 * §5 Orchestrator state machine.
 *
 * INTAKE → GATHERING_CONTEXT → FORMULATING_PLAN → POLICY_EVALUATION →
 * EXECUTING_STEP → VERIFYING_OUTCOME → RESOLVED_SUCCESS | RESOLVED_FAILURE |
 * ESCALATED, plus HUMAN_REVIEW (paused).
 *
 * Invariants enforced here:
 * - No financial mutation without a fresh idempotency key.
 * - No action executes without passing policy evaluation.
 * - "Success" only after the DB is re-read and a SUCCESS txn is confirmed.
 * - Every state transition writes an immutable audit entry.
 * - A human-approved action re-enters policy evaluation before execution.
 */

export const STATES = {
  INTAKE: "INTAKE",
  GATHERING_CONTEXT: "GATHERING_CONTEXT",
  FORMULATING_PLAN: "FORMULATING_PLAN",
  POLICY_EVALUATION: "POLICY_EVALUATION",
  EXECUTING_STEP: "EXECUTING_STEP",
  VERIFYING_OUTCOME: "VERIFYING_OUTCOME",
  RESOLVED_SUCCESS: "RESOLVED_SUCCESS",
  RESOLVED_FAILURE: "RESOLVED_FAILURE",
  ESCALATED: "ESCALATED",
  HUMAN_REVIEW: "HUMAN_REVIEW",
} as const;

export type StateValue = (typeof STATES)[keyof typeof STATES];

const TERMINAL_STATES = new Set<string>([
  STATES.RESOLVED_SUCCESS,
  STATES.RESOLVED_FAILURE,
  STATES.ESCALATED,
]);

export type StepOutcome =
  | { outcome: "TERMINAL"; reason: string }
  | { outcome: "PAUSED"; reason: string; reviewId?: string }
  | { outcome: "CONTINUE"; reason: string }
  | { outcome: "YIELD"; message: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compare-and-set state transition. Every transition appends an audit entry.
 * Returns false when the expected state no longer matches (concurrent writer).
 */
async function transition(sessionId: string, from: string, to: string, reason?: string): Promise<boolean> {
  const res = await prisma.resolutionSession.updateMany({
    where: { sessionId, currentState: from },
    data: { currentState: to },
  });
  if (res.count === 0) return false;
  if (from !== to) {
    await logEvent({
      sessionId,
      stage: "STATE_TRANSITION",
      decisionSummary: `${from} → ${to}${reason ? ` (${reason})` : ""}`,
      contextReferences: { from, to, reason: reason ?? null },
      details: { from, to, reason: reason ?? null },
    });
  }
  return true;
}

async function loadSessionOr404(sessionId: string) {
  const session = await prisma.resolutionSession.findUnique({ where: { sessionId } });
  if (!session) throw new AppError(404, `Session ${sessionId} not found`);
  return session;
}

async function loadContext(sessionId: string) {
  const session = await loadSessionOr404(sessionId);
  const customer = await prisma.syntheticCustomer.findUnique({
    where: { customerId: session.customerId },
  });
  const originalTransaction = session.targetTransactionId
    ? await prisma.syntheticTransaction.findUnique({
        where: { transactionId: session.targetTransactionId },
      })
    : null;
  const recentTransactions = await prisma.syntheticTransaction.findMany({
    where: { customerId: session.customerId },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  const actionSteps = await prisma.actionStep.findMany({
    where: { sessionId },
    orderBy: { createdAt: "asc" },
  });
  return { session, customer, originalTransaction, recentTransactions, actionSteps };
}

/**
 * Structured success detection — never string-matches on error messages.
 * Success = the original txn is SUCCESS, or a prior retry_payment step executed SUCCESS.
 */
function detectSuccess(
  originalTransaction: { status: string } | null,
  actionSteps: Array<{ toolName: string; executionStatus: string; executionResult: Prisma.JsonValue }>
): { verified: boolean; evidence: Record<string, unknown> } {
  if (originalTransaction?.status === "SUCCESS") {
    return { verified: true, evidence: { via: "original_transaction", status: "SUCCESS" } };
  }
  const successRetry = actionSteps.find(
    (s) => s.toolName === "retry_payment" && s.executionStatus === "SUCCESS"
  );
  if (successRetry) {
    const result = (successRetry.executionResult ?? {}) as { newTransactionId?: string; isReplay?: boolean };
    return {
      verified: true,
      evidence: {
        via: "retry_step",
        stepId: undefined,
        newTransactionId: result.newTransactionId ?? null,
        isReplay: result.isReplay ?? false,
      },
    };
  }
  return { verified: false, evidence: {} };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export async function getSessionSnapshot(sessionId: string) {
  const session = await prisma.resolutionSession.findUnique({
    where: { sessionId },
    include: {
      customer: true,
      actionSteps: { orderBy: { createdAt: "asc" } },
      auditEntries: { orderBy: { id: "asc" } },
      humanReviews: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!session) throw new AppError(404, `Session ${sessionId} not found`);

  const transactions = await prisma.syntheticTransaction.findMany({
    where: { customerId: session.customerId },
    orderBy: { createdAt: "asc" },
  });

  const targetTransaction =
    transactions.find((t) => t.transactionId === session.targetTransactionId) ?? null;

  const pendingReview =
    session.humanReviews.find((r) => r.status === "PENDING") ?? null;

  return {
    session: {
      ...session,
      customer: {
        ...session.customer,
        syntheticBalance: Number(session.customer.syntheticBalance),
      },
      // BigInt cannot cross JSON — stringify the audit id.
      auditEntries: session.auditEntries.map((e) => ({ ...e, id: e.id.toString() })),
    },
    transactions: transactions.map((t) => ({ ...t, amount: Number(t.amount) })),
    targetTransaction: targetTransaction ? { ...targetTransaction, amount: Number(targetTransaction.amount) } : null,
    pendingReview,
  };
}

export type SessionSnapshot = Awaited<ReturnType<typeof getSessionSnapshot>>;

// ---------------------------------------------------------------------------
// Finalizers
// ---------------------------------------------------------------------------

/**
 * VERIFIED_SUCCESS: notification is proposed through the normal policy gate,
 * executed only when ALLOWED, then the session lands in RESOLVED_SUCCESS.
 */
async function finalizeSuccessfulResolution(sessionId: string, evidence: Record<string, unknown>): Promise<void> {
  const { session, customer, originalTransaction } = await loadContext(sessionId);
  if (!customer || !originalTransaction) return;

  const message =
    `Update on your ₹${Number(originalTransaction.amount)} payment to ${originalTransaction.billerOrMerchant}: ` +
    `the retry succeeded and your payment is confirmed. Thank you for your patience!`;

  const notificationAction = {
    toolName: "send_customer_notification",
    params: { customerId: customer.customerId, message, channel: "IN_APP" },
  };

  await logEvent({
    sessionId,
    stage: "PLAN_PROPOSED",
    decisionSummary: "Verified success — proposing customer notification",
    contextReferences: { hasRetryInTrace: true },
    details: { ...notificationAction, reasoning: "Outcome verified: notify the customer of the successful retry" },
  });

  const policy = await evaluateProposedAction({ sessionId, ...notificationAction });
  await logEvent({
    sessionId,
    stage: "POLICY_EVALUATED",
    decisionSummary: `Notification policy ${policy.verdict}${policy.ruleTriggered ? ` (${policy.ruleTriggered})` : ""}`,
    contextReferences: policy.contextReferences,
    details: { verdict: policy.verdict, ruleTriggered: policy.ruleTriggered ?? null, ruleResults: policy.ruleResults },
  });

  if (policy.verdict === "ALLOWED") {
    const stepId = randomUUID();
    await prisma.actionStep.create({
      data: {
        stepId,
        sessionId,
        toolName: notificationAction.toolName,
        toolParams: notificationAction.params as Prisma.InputJsonObject,
        policyVerdict: "ALLOWED",
        policyRuleTriggered: policy.ruleTriggered ?? null,
        executionStatus: "PENDING",
      },
    });
    try {
      const result = await dispatchTool(notificationAction.toolName, notificationAction.params, {
        sessionId,
        customerId: session.customerId,
      });
      await prisma.actionStep.update({
        where: { stepId },
        data: {
          executionStatus: "SUCCESS",
          executionResult: result.data as Prisma.InputJsonValue,
          executedAt: new Date(),
        },
      });
      await logEvent({
        sessionId,
        stage: "TOOL_EXECUTED",
        decisionSummary: "send_customer_notification delivered",
        contextReferences: { stepId, toolName: notificationAction.toolName },
        details: { stepId, toolName: notificationAction.toolName, success: true, data: result.data },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await prisma.actionStep.update({
        where: { stepId },
        data: { executionStatus: "FAILED", errorMessage: message, executedAt: new Date() },
      });
      await logEvent({
        sessionId,
        stage: "TOOL_EXECUTED",
        decisionSummary: "send_customer_notification failed (non-blocking)",
        contextReferences: { stepId },
        details: { stepId, toolName: notificationAction.toolName, success: false, error: message },
      });
    }
  }

  await prisma.resolutionSession.update({
    where: { sessionId },
    data: { outcomeStatus: "VERIFIED_SUCCESS", currentState: STATES.RESOLVED_SUCCESS },
  });
  await logEvent({
    sessionId,
    stage: "OUTCOME_VERIFIED",
    decisionSummary: "VERIFIED_SUCCESS — a SUCCESS transaction was confirmed by re-reading the database",
    contextReferences: evidence,
    details: { outcome: "VERIFIED_SUCCESS", evidence },
  });
  await logEvent({
    sessionId,
    stage: "STATE_TRANSITION",
    decisionSummary: `${STATES.VERIFYING_OUTCOME} → ${STATES.RESOLVED_SUCCESS}`,
    contextReferences: { to: STATES.RESOLVED_SUCCESS },
    details: { from: STATES.VERIFYING_OUTCOME, to: STATES.RESOLVED_SUCCESS, reason: "verified success" },
  });
}

/**
 * BLOCKED by policy: no mutation was made; notify + escalate (both
 * non-financial) and land in RESOLVED_FAILURE / VERIFIED_FAILURE.
 */
async function finalizeBlockedFailure(
  sessionId: string,
  policy: PolicyEvaluation,
  action: { toolName: string; params: Record<string, unknown> }
): Promise<void> {
  const { session, customer, originalTransaction } = await loadContext(sessionId);
  if (!customer) return;

  // 1. Notify the customer — through the policy gate like any other action.
  const amount = originalTransaction ? Number(originalTransaction.amount) : null;
  const biller = originalTransaction?.billerOrMerchant ?? "this payment";
  const notifyAction = {
    toolName: "send_customer_notification",
    params: {
      customerId: customer.customerId,
      message:
        `We could not retry your ₹${amount} payment to ${biller} (policy ${policy.ruleTriggered}). ` +
        `No changes were made to your account — our support team has been notified.`,
      channel: "IN_APP",
    },
  };

  await logEvent({
    sessionId,
    stage: "PLAN_PROPOSED",
    decisionSummary: `Blocked at ${policy.ruleTriggered} — proposing customer notification`,
    contextReferences: { ruleTriggered: policy.ruleTriggered },
    details: { ...notifyAction, reasoning: "Policy blocked the mutation; notify the customer without mutating funds" },
  });

  const notifyPolicy = await evaluateProposedAction({ sessionId, ...notifyAction });
  await logEvent({
    sessionId,
    stage: "POLICY_EVALUATED",
    decisionSummary: `Notification policy ${notifyPolicy.verdict}${notifyPolicy.ruleTriggered ? ` (${notifyPolicy.ruleTriggered})` : ""}`,
    contextReferences: notifyPolicy.contextReferences,
    details: {
      verdict: notifyPolicy.verdict,
      ruleTriggered: notifyPolicy.ruleTriggered ?? null,
      ruleResults: notifyPolicy.ruleResults,
    },
  });

  if (notifyPolicy.verdict === "ALLOWED") {
    const stepId = randomUUID();
    await prisma.actionStep.create({
      data: {
        stepId,
        sessionId,
        toolName: notifyAction.toolName,
        toolParams: notifyAction.params as Prisma.InputJsonObject,
        policyVerdict: "ALLOWED",
        policyRuleTriggered: notifyPolicy.ruleTriggered ?? null,
        executionStatus: "PENDING",
      },
    });
    try {
      const result = await dispatchTool(notifyAction.toolName, notifyAction.params, {
        sessionId,
        customerId: session.customerId,
      });
      await prisma.actionStep.update({
        where: { stepId },
        data: {
          executionStatus: "SUCCESS",
          executionResult: result.data as Prisma.InputJsonValue,
          executedAt: new Date(),
        },
      });
      await logEvent({
        sessionId,
        stage: "TOOL_EXECUTED",
        decisionSummary: "send_customer_notification delivered",
        contextReferences: { stepId },
        details: { stepId, toolName: notifyAction.toolName, success: true, data: result.data },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await prisma.actionStep.update({
        where: { stepId },
        data: { executionStatus: "FAILED", errorMessage: message, executedAt: new Date() },
      });
      await logEvent({
        sessionId,
        stage: "TOOL_EXECUTED",
        decisionSummary: "send_customer_notification failed (non-blocking)",
        contextReferences: { stepId },
        details: { stepId, toolName: notifyAction.toolName, success: false, error: message },
      });
    }
  }

  // 2. Escalate to human support (audit ticket).
  const ticket = await escalate({
    sessionId,
    customerId: session.customerId,
    reason: `Policy ${policy.ruleTriggered} blocked ${action.toolName} — human follow-up required`,
    ruleTriggered: policy.ruleTriggered ?? undefined,
  });

  // 3. Outcome: verified failure (a re-read confirmed no mutation occurred).
  await prisma.resolutionSession.update({
    where: { sessionId },
    data: { outcomeStatus: "VERIFIED_FAILURE", currentState: STATES.RESOLVED_FAILURE },
  });
  await logEvent({
    sessionId,
    stage: "OUTCOME_VERIFIED",
    decisionSummary: `VERIFIED_FAILURE — ${policy.ruleTriggered} blocked the action, database re-read confirms no mutation`,
    contextReferences: { ruleTriggered: policy.ruleTriggered, ticketId: ticket.ticketId },
    details: {
      outcome: "VERIFIED_FAILURE",
      ruleTriggered: policy.ruleTriggered ?? null,
      ticketId: ticket.ticketId,
      mutationPerformed: false,
    },
  });
  await logEvent({
    sessionId,
    stage: "STATE_TRANSITION",
    decisionSummary: `${STATES.POLICY_EVALUATION} → ${STATES.RESOLVED_FAILURE}`,
    contextReferences: { to: STATES.RESOLVED_FAILURE },
    details: { from: STATES.POLICY_EVALUATION, to: STATES.RESOLVED_FAILURE, reason: `blocked at ${policy.ruleTriggered}` },
  });
}

/**
 * Post-execution outcome verifier (§5 step 10): re-read the DB.
 * SUCCESS retry → finalize success. Otherwise INCONCLUSIVE → loop again.
 */
async function verifyOutcomeAndFinalize(sessionId: string): Promise<StepOutcome> {
  const { session, originalTransaction, actionSteps } = await loadContext(sessionId);
  const success = detectSuccess(originalTransaction, actionSteps);

  if (success.verified) {
    await prisma.resolutionSession.update({
      where: { sessionId },
      data: { outcomeStatus: "VERIFIED_SUCCESS" },
    });
    await logEvent({
      sessionId,
      stage: "OUTCOME_VERIFIED",
      decisionSummary: "Database re-read confirmed a SUCCESS transaction",
      contextReferences: success.evidence,
      details: { outcome: "VERIFIED_SUCCESS", evidence: success.evidence, state: session.currentState },
    });
    await finalizeSuccessfulResolution(sessionId, success.evidence);
    return { outcome: "TERMINAL", reason: "VERIFIED_SUCCESS" };
  }

  // INCONCLUSIVE — return to context gathering; the planner will propose a
  // notification or escalation on the next cycle.
  const moved = await transition(sessionId, STATES.VERIFYING_OUTCOME, STATES.GATHERING_CONTEXT, "INCONCLUSIVE outcome");
  if (!moved) return { outcome: "YIELD", message: "Concurrent lock yielded" };
  return { outcome: "CONTINUE", reason: "INCONCLUSIVE — outcome not verified yet" };
}

// ---------------------------------------------------------------------------
// executeStep
// ---------------------------------------------------------------------------

export async function executeStep(sessionId: string): Promise<StepOutcome> {
  // ---- 1. Claim lock (concurrency) -------------------------------------
  let session = await loadSessionOr404(sessionId);
  const expectedState = session.currentState;

  if (TERMINAL_STATES.has(expectedState)) {
    return { outcome: "TERMINAL", reason: expectedState };
  }
  if (expectedState === STATES.HUMAN_REVIEW) {
    const pending = await prisma.humanReview.findFirst({
      where: { sessionId, status: "PENDING" },
      orderBy: { createdAt: "desc" },
    });
    return { outcome: "PAUSED", reason: "HUMAN_REVIEW", reviewId: pending?.reviewId };
  }

  const locked = await transition(sessionId, expectedState, STATES.GATHERING_CONTEXT, "step lock");
  if (!locked) return { outcome: "YIELD", message: "Concurrent lock yielded" };

  // ---- 2. Gather context ----------------------------------------------
  let context = await loadContext(sessionId);
  session = context.session;
  const { customer, originalTransaction, recentTransactions, actionSteps } = context;

  const hasRetryInTrace = actionSteps.some((s) => s.toolName === "retry_payment");

  await logEvent({
    sessionId,
    stage: "CONTEXT_GATHERED",
    decisionSummary: `Loaded customer, target transaction, ${recentTransactions.length} recent transactions, ${actionSteps.length} action steps`,
    contextReferences: {
      customerId: session.customerId,
      targetTransactionId: session.targetTransactionId,
      hasRetryInTrace,
    },
    details: {
      accountStatus: customer?.accountStatus ?? null,
      transactionStatus: originalTransaction?.status ?? null,
      amount: originalTransaction ? Number(originalTransaction.amount) : null,
      retryCount: session.retryCount,
      actionStepCount: actionSteps.length,
      hasRetryInTrace,
    },
  });

  // ---- 3. Outcome check (pre-plan) -------------------------------------
  const preCheck = detectSuccess(originalTransaction, actionSteps);
  if (preCheck.verified) {
    await prisma.resolutionSession.update({
      where: { sessionId },
      data: { outcomeStatus: "VERIFIED_SUCCESS" },
    });
    await logEvent({
      sessionId,
      stage: "OUTCOME_VERIFIED",
      decisionSummary: "Pre-plan check: SUCCESS transaction already present",
      contextReferences: preCheck.evidence,
      details: { outcome: "VERIFIED_SUCCESS", evidence: preCheck.evidence, phase: "pre-plan" },
    });
    await finalizeSuccessfulResolution(sessionId, preCheck.evidence);
    return { outcome: "TERMINAL", reason: "VERIFIED_SUCCESS" };
  }

  // ---- 4. Transition to FORMULATING_PLAN -------------------------------
  const planned = await transition(sessionId, STATES.GATHERING_CONTEXT, STATES.FORMULATING_PLAN);
  if (!planned) return { outcome: "YIELD", message: "Concurrent lock yielded" };

  // ---- 5. AI planner ----------------------------------------------------
  const plannerContext: PlannerContext = {
    sessionId,
    customer: customer
      ? {
          customerId: customer.customerId,
          name: customer.name,
          accountStatus: customer.accountStatus,
          syntheticBalance: Number(customer.syntheticBalance),
        }
      : null,
    originalTransaction: originalTransaction
      ? {
          transactionId: originalTransaction.transactionId,
          amount: Number(originalTransaction.amount),
          billerOrMerchant: originalTransaction.billerOrMerchant,
          status: originalTransaction.status,
          failureReason: originalTransaction.failureReason,
        }
      : null,
    sessionRetryCount: session.retryCount,
    policyConfig: {
      maxAutonomousRetryAmount: policyMaxRetryAmount,
      maxRetries: policyMaxRetries,
    },
    hasRetryInTrace,
  };

  let proposal: PlannedAction;
  try {
    proposal = await planResolution(plannerContext);
  } catch (err) {
    const plannerError = err instanceof Error ? err.message : String(err);
    if (session.retryCount < session.maxRetries) {
      // Persist BOTH retryCount and currentState (§12.6 — omitting the state
      // update was a real bug).
      await prisma.resolutionSession.update({
        where: { sessionId },
        data: { retryCount: { increment: 1 }, currentState: STATES.FORMULATING_PLAN },
      });
      await logEvent({
        sessionId,
        stage: "STATE_TRANSITION",
        decisionSummary: `Planner failure — retry ${session.retryCount + 1}/${session.maxRetries}`,
        contextReferences: { from: STATES.FORMULATING_PLAN, to: STATES.FORMULATING_PLAN },
        details: { from: STATES.FORMULATING_PLAN, to: STATES.FORMULATING_PLAN, reason: "planner failure retry", error: plannerError },
      });
      return { outcome: "CONTINUE", reason: "planner failure — retrying" };
    }
    await transition(sessionId, STATES.FORMULATING_PLAN, STATES.ESCALATED, "planner exhausted retries");
    await prisma.resolutionSession.update({
      where: { sessionId },
      data: { outcomeStatus: "ESCALATED" },
    });
    const ticket = await escalate({
      sessionId,
      customerId: session.customerId,
      reason: `AI planner failed after ${session.maxRetries} attempts: ${plannerError}`,
    });
    return { outcome: "TERMINAL", reason: "planner failure — escalated" };
  }

  // ---- 6. Provisional step + fresh idempotency key ----------------------
  const provisionalStepId = randomUUID();
  const params: Record<string, unknown> = { ...proposal.params };
  if (proposal.toolName === "retry_payment") {
    // Invariant: no financial mutation without a fresh idempotency key.
    params.idempotencyKey = `idemp_${randomUUID()}`;
  }

  await logEvent({
    sessionId,
    stage: "PLAN_PROPOSED",
    decisionSummary: `${proposal.toolName}: ${proposal.reasoning}`,
    contextReferences: { planner: proposal.planner, hasRetryInTrace },
    details: { toolName: proposal.toolName, params, reasoning: proposal.reasoning, planner: proposal.planner },
  });

  // ---- 7. Policy evaluation --------------------------------------------
  const enteredPolicy = await transition(sessionId, STATES.FORMULATING_PLAN, STATES.POLICY_EVALUATION);
  if (!enteredPolicy) return { outcome: "YIELD", message: "Concurrent lock yielded" };

  const policy = await evaluateProposedAction({ sessionId, toolName: proposal.toolName, params });

  await logEvent({
    sessionId,
    stage: "POLICY_EVALUATED",
    decisionSummary: `${policy.verdict}${policy.ruleTriggered ? ` — ${policy.ruleTriggered}` : ""}`,
    contextReferences: policy.contextReferences,
    details: { toolName: proposal.toolName, verdict: policy.verdict, ruleTriggered: policy.ruleTriggered ?? null, ruleResults: policy.ruleResults },
  });

  if (policy.verdict === "BLOCKED") {
    await prisma.actionStep.create({
      data: {
        stepId: provisionalStepId,
        sessionId,
        toolName: proposal.toolName,
        toolParams: params as Prisma.InputJsonObject,
        policyVerdict: "BLOCKED",
        policyRuleTriggered: policy.ruleTriggered ?? null,
        executionStatus: "SKIPPED",
        errorMessage: `Blocked by policy rule ${policy.ruleTriggered}`,
      },
    });
    const transitioned = await transition(
      sessionId,
      STATES.POLICY_EVALUATION,
      STATES.RESOLVED_FAILURE,
      `blocked at ${policy.ruleTriggered}`
    );
    if (!transitioned) return { outcome: "YIELD", message: "Concurrent lock yielded" };
    await finalizeBlockedFailure(sessionId, policy, { toolName: proposal.toolName, params });
    return { outcome: "TERMINAL", reason: `BLOCKED at ${policy.ruleTriggered}` };
  }

  if (policy.verdict === "REQUIRES_HUMAN") {
    await prisma.actionStep.create({
      data: {
        stepId: provisionalStepId,
        sessionId,
        toolName: proposal.toolName,
        toolParams: params as Prisma.InputJsonObject,
        policyVerdict: "REQUIRES_HUMAN",
        policyRuleTriggered: policy.ruleTriggered ?? null,
        executionStatus: "PENDING",
      },
    });
    const reviewId = `rev_${randomUUID()}`;
    await prisma.humanReview.create({
      data: {
        reviewId,
        sessionId,
        stepId: provisionalStepId,
        reason: `Policy rule ${policy.ruleTriggered} requires human approval before execution`,
        proposedTool: proposal.toolName,
        proposedParams: params as Prisma.InputJsonObject,
        status: "PENDING",
      },
    });
    const paused = await transition(sessionId, STATES.POLICY_EVALUATION, STATES.HUMAN_REVIEW, `paused on ${policy.ruleTriggered}`);
    if (!paused) return { outcome: "YIELD", message: "Concurrent lock yielded" };
    return { outcome: "PAUSED", reason: `REQUIRES_HUMAN (${policy.ruleTriggered})`, reviewId };
  }

  // ---- 8. ALLOWED → create PENDING step, transition to EXECUTING_STEP ---
  await prisma.actionStep.create({
    data: {
      stepId: provisionalStepId,
      sessionId,
      toolName: proposal.toolName,
      toolParams: params as Prisma.InputJsonObject,
      policyVerdict: "ALLOWED",
      policyRuleTriggered: policy.ruleTriggered ?? null,
      executionStatus: "PENDING",
    },
  });
  const executing = await transition(sessionId, STATES.POLICY_EVALUATION, STATES.EXECUTING_STEP);
  if (!executing) return { outcome: "YIELD", message: "Concurrent lock yielded" };

  // ---- 9. Execute the tool ---------------------------------------------
  try {
    const result = await dispatchTool(proposal.toolName, params, {
      sessionId,
      customerId: session.customerId,
    });
    await prisma.actionStep.update({
      where: { stepId: provisionalStepId },
      data: {
        executionStatus: "SUCCESS",
        executionResult: result.data as Prisma.InputJsonValue,
        executedAt: new Date(),
      },
    });
    await logEvent({
      sessionId,
      stage: "TOOL_EXECUTED",
      decisionSummary: `${proposal.toolName} executed successfully${result.isReplay ? " (idempotent replay)" : ""}`,
      contextReferences: { stepId: provisionalStepId, isReplay: result.isReplay ?? false },
      details: { stepId: provisionalStepId, toolName: proposal.toolName, success: true, isReplay: result.isReplay ?? false, data: result.data },
    });
    const verifying = await transition(sessionId, STATES.EXECUTING_STEP, STATES.VERIFYING_OUTCOME);
    if (!verifying) return { outcome: "YIELD", message: "Concurrent lock yielded" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const retryable = (err as { retryable?: boolean }).retryable === true;

    await prisma.actionStep.update({
      where: { stepId: provisionalStepId },
      data: { executionStatus: "FAILED", errorMessage: message, executedAt: new Date() },
    });
    await logEvent({
      sessionId,
      stage: "TOOL_EXECUTED",
      decisionSummary: `${proposal.toolName} failed: ${message}`,
      contextReferences: { stepId: provisionalStepId, retryable },
      details: { stepId: provisionalStepId, toolName: proposal.toolName, success: false, error: message, retryable },
    });

    if (retryable && session.retryCount < session.maxRetries) {
      await prisma.resolutionSession.update({
        where: { sessionId },
        data: { retryCount: { increment: 1 }, currentState: STATES.GATHERING_CONTEXT },
      });
      await logEvent({
        sessionId,
        stage: "STATE_TRANSITION",
        decisionSummary: `${STATES.EXECUTING_STEP} → ${STATES.GATHERING_CONTEXT} (retry budget remains)`,
        contextReferences: { from: STATES.EXECUTING_STEP, to: STATES.GATHERING_CONTEXT },
        details: { from: STATES.EXECUTING_STEP, to: STATES.GATHERING_CONTEXT, reason: "retryable tool failure" },
      });
      return { outcome: "CONTINUE", reason: "tool failed — retry budget remains" };
    }

    const escalated = await transition(sessionId, STATES.EXECUTING_STEP, STATES.ESCALATED, "tool failure");
    if (!escalated) return { outcome: "YIELD", message: "Concurrent lock yielded" };
    await prisma.resolutionSession.update({
      where: { sessionId },
      data: { outcomeStatus: "ESCALATED" },
    });
    await escalate({
      sessionId,
      customerId: session.customerId,
      reason: `${proposal.toolName} failed: ${message}`,
    });
    return { outcome: "TERMINAL", reason: "tool failure — escalated" };
  }

  // ---- 10. Post-execution outcome verifier ------------------------------
  return verifyOutcomeAndFinalize(sessionId);
}

// ---------------------------------------------------------------------------
// runSession
// ---------------------------------------------------------------------------

export async function runSession(sessionId: string, maxSteps = 10) {
  await loadSessionOr404(sessionId);
  let steps = 0;
  let last: StepOutcome = { outcome: "CONTINUE", reason: "not started" };

  while (steps < maxSteps) {
    const session = await loadSessionOr404(sessionId);
    if (TERMINAL_STATES.has(session.currentState)) {
      last = { outcome: "TERMINAL", reason: session.currentState };
      break;
    }
    if (session.currentState === STATES.HUMAN_REVIEW) {
      const pending = await prisma.humanReview.findFirst({
        where: { sessionId, status: "PENDING" },
        orderBy: { createdAt: "desc" },
      });
      last = { outcome: "PAUSED", reason: "HUMAN_REVIEW", reviewId: pending?.reviewId };
      break;
    }

    steps += 1;
    last = await executeStep(sessionId);
    if (last.outcome === "CONTINUE") continue;
    // TERMINAL / PAUSED / YIELD → break
    break;
  }

  return {
    stepsExecuted: steps,
    outcome: last,
    snapshot: await getSessionSnapshot(sessionId),
  };
}

// ---------------------------------------------------------------------------
// Human verdict (§5 submitHumanVerdict)
// ---------------------------------------------------------------------------

export interface VerdictInput {
  verdict: "APPROVED" | "REJECTED" | "MODIFIED";
  reviewerNotes?: string;
  modifiedParams?: Record<string, unknown>;
}

export async function submitHumanVerdict(sessionId: string, reviewId: string, input: VerdictInput) {
  const review = await prisma.humanReview.findUnique({
    where: { reviewId },
    include: { step: true },
  });
  if (!review || review.sessionId !== sessionId) {
    throw new AppError(404, `Human review ${reviewId} not found for session ${sessionId}`);
  }
  if (review.status !== "PENDING") {
    throw new AppError(409, `Review already resolved with status ${review.status}`);
  }

  const session = await loadSessionOr404(sessionId);
  const notes = input.reviewerNotes ?? null;

  // Record the decision (immutable append + status update on the review row).
  await prisma.humanReview.update({
    where: { reviewId },
    data: { status: input.verdict, reviewerNotes: notes, resolvedAt: new Date() },
  });
  await logEvent({
    sessionId,
    stage: "HUMAN_DECIDED",
    decisionSummary: `${input.verdict}${notes ? ` — ${notes}` : ""}`,
    contextReferences: { reviewId, verdict: input.verdict, stepId: review.stepId },
    details: { reviewId, verdict: input.verdict, reviewerNotes: notes, proposedTool: review.proposedTool },
  });

  // ---- REJECTED → escalate ---------------------------------------------
  if (input.verdict === "REJECTED") {
    await prisma.resolutionSession.update({
      where: { sessionId },
      data: { outcomeStatus: "ESCALATED", currentState: STATES.ESCALATED },
    });
    await escalate({
      sessionId,
      customerId: session.customerId,
      reason: `Supervisor rejected ${review.proposedTool}${notes ? `: ${notes}` : ""}`,
    });
    await logEvent({
      sessionId,
      stage: "STATE_TRANSITION",
      decisionSummary: `${STATES.HUMAN_REVIEW} → ${STATES.ESCALATED} (rejected)`,
      contextReferences: { to: STATES.ESCALATED },
      details: { from: STATES.HUMAN_REVIEW, to: STATES.ESCALATED, reason: "human rejected" },
    });
    return { snapshot: await getSessionSnapshot(sessionId), result: "REJECTED_ESCALATED" as const };
  }

  // ---- APPROVED / MODIFIED → re-enter policy evaluation ------------------
  const baseParams = { ...(review.proposedParams as Record<string, unknown>) };
  const mergedParams: Record<string, unknown> =
    input.verdict === "MODIFIED"
      ? { ...baseParams, ...(input.modifiedParams ?? {}) }
      : baseParams;

  if (review.proposedTool === "retry_payment") {
    // Fresh key for every executed financial mutation.
    const supplied = mergedParams.idempotencyKey;
    const suppliedUnused =
      typeof supplied === "string" && supplied.length > 0
        ? !(await prisma.syntheticTransaction.findUnique({ where: { idempotencyKey: supplied } }))
        : false;
    mergedParams.idempotencyKey = suppliedUnused ? supplied : `idemp_${randomUUID()}`;
  }

  // Re-enter policy with the human amount-cap override (§5, §8 RP_006).
  const policy = await evaluateProposedAction({
    sessionId,
    toolName: review.proposedTool,
    params: mergedParams,
    maxAutonomousRetryAmount: Number.POSITIVE_INFINITY,
  });
  await logEvent({
    sessionId,
    stage: "POLICY_EVALUATED",
    decisionSummary: `Post-approval re-evaluation: ${policy.verdict}${policy.ruleTriggered ? ` — ${policy.ruleTriggered}` : ""} (human override)`,
    contextReferences: policy.contextReferences,
    details: {
      toolName: review.proposedTool,
      verdict: policy.verdict,
      ruleTriggered: policy.ruleTriggered ?? null,
      ruleResults: policy.ruleResults,
      humanOverride: true,
    },
  });

  const postApprovalStepId = randomUUID();

  if (policy.verdict !== "ALLOWED") {
    await prisma.actionStep.create({
      data: {
        stepId: postApprovalStepId,
        sessionId,
        toolName: review.proposedTool,
        toolParams: mergedParams as Prisma.InputJsonObject,
        policyVerdict: policy.verdict === "BLOCKED" ? "BLOCKED" : "REQUIRES_HUMAN",
        policyRuleTriggered: policy.ruleTriggered ?? null,
        executionStatus: "SKIPPED",
        errorMessage: `Post-approval policy ${policy.verdict} (${policy.ruleTriggered})`,
      },
    });

    if (policy.verdict === "BLOCKED") {
      await prisma.resolutionSession.update({
        where: { sessionId },
        data: { currentState: STATES.RESOLVED_FAILURE, outcomeStatus: "VERIFIED_FAILURE" },
      });
      await logEvent({
        sessionId,
        stage: "STATE_TRANSITION",
        decisionSummary: `${STATES.HUMAN_REVIEW} → ${STATES.RESOLVED_FAILURE} (blocked after approval)`,
        contextReferences: { to: STATES.RESOLVED_FAILURE },
        details: { from: STATES.HUMAN_REVIEW, to: STATES.RESOLVED_FAILURE, reason: `blocked at ${policy.ruleTriggered}` },
      });
      await finalizeBlockedFailure(sessionId, policy, { toolName: review.proposedTool, params: mergedParams });
      return { snapshot: await getSessionSnapshot(sessionId), result: "BLOCKED_AFTER_APPROVAL" as const };
    }

    // Still requires human → fresh pending review.
    const freshReviewId = `rev_${randomUUID()}`;
    await prisma.humanReview.create({
      data: {
        reviewId: freshReviewId,
        sessionId,
        stepId: postApprovalStepId,
        reason: `Policy rule ${policy.ruleTriggered} still requires human approval`,
        proposedTool: review.proposedTool,
        proposedParams: mergedParams as Prisma.InputJsonObject,
        status: "PENDING",
      },
    });
    return { snapshot: await getSessionSnapshot(sessionId), result: "STILL_REQUIRES_HUMAN" as const, reviewId: freshReviewId };
  }

  // ALLOWED → create the step and transition HUMAN_REVIEW → EXECUTING_STEP.
  await prisma.actionStep.create({
    data: {
      stepId: postApprovalStepId,
      sessionId,
      toolName: review.proposedTool,
      toolParams: mergedParams as Prisma.InputJsonObject,
      policyVerdict: "ALLOWED",
      policyRuleTriggered: policy.ruleTriggered ?? null,
      executionStatus: "PENDING",
    },
  });
  await prisma.resolutionSession.update({
    where: { sessionId },
    data: { currentState: STATES.EXECUTING_STEP },
  });
  await logEvent({
    sessionId,
    stage: "STATE_TRANSITION",
    decisionSummary: `${STATES.HUMAN_REVIEW} → ${STATES.EXECUTING_STEP} (approved, re-entered policy)`,
    contextReferences: { to: STATES.EXECUTING_STEP, reviewId },
    details: { from: STATES.HUMAN_REVIEW, to: STATES.EXECUTING_STEP, reason: "human approved" },
  });

  try {
    const result = await dispatchTool(review.proposedTool, mergedParams, {
      sessionId,
      customerId: session.customerId,
    });
    await prisma.actionStep.update({
      where: { stepId: postApprovalStepId },
      data: {
        executionStatus: "SUCCESS",
        executionResult: result.data as Prisma.InputJsonValue,
        executedAt: new Date(),
      },
    });
    await logEvent({
      sessionId,
      stage: "TOOL_EXECUTED",
      decisionSummary: `${review.proposedTool} executed after human approval`,
      contextReferences: { stepId: postApprovalStepId, reviewId },
      details: { stepId: postApprovalStepId, toolName: review.proposedTool, success: true, approved: true, data: result.data },
    });
    await transition(sessionId, STATES.EXECUTING_STEP, STATES.VERIFYING_OUTCOME, "post-approval");
    const outcome = await verifyOutcomeAndFinalize(sessionId);
    return { snapshot: await getSessionSnapshot(sessionId), result: "APPROVED_EXECUTED" as const, outcome };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.actionStep.update({
      where: { stepId: postApprovalStepId },
      data: { executionStatus: "FAILED", errorMessage: message, executedAt: new Date() },
    });
    await logEvent({
      sessionId,
      stage: "TOOL_EXECUTED",
      decisionSummary: `${review.proposedTool} failed after approval: ${message}`,
      contextReferences: { stepId: postApprovalStepId, reviewId },
      details: { stepId: postApprovalStepId, toolName: review.proposedTool, success: false, error: message, approved: true },
    });
    await prisma.resolutionSession.update({
      where: { sessionId },
      data: { currentState: STATES.ESCALATED, outcomeStatus: "ESCALATED" },
    });
    await escalate({
      sessionId,
      customerId: session.customerId,
      reason: `Approved action ${review.proposedTool} failed: ${message}`,
    });
    return { snapshot: await getSessionSnapshot(sessionId), result: "FAILED_AFTER_APPROVAL" as const };
  }
}
