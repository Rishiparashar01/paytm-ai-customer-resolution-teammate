import { prisma } from "../prisma";
import { policyMaxRetries, policyMaxRetryAmount } from "../config/env";

/**
 * §8 Policy engine — RP_001…RP_007 for `retry_payment`, NOTIF_001…NOTIF_005
 * for `send_customer_notification`, plus ESC_001 / READ_001 for the other
 * registry tools. Rules are evaluated in order; first hit wins; every rule
 * after the hit is recorded as SKIP so the dashboard can render all rows.
 */

export type PolicyVerdict = "ALLOWED" | "BLOCKED" | "REQUIRES_HUMAN";
export type RuleStatus = "PASS" | "FAIL" | "REVIEW" | "SKIP";

export interface PolicyRuleResult {
  rule: string;
  status: RuleStatus;
  detail: string;
}

export interface PolicyEvaluation {
  verdict: PolicyVerdict;
  /** Rule that decided the verdict (undefined when no rule fired / ALLOWED final gate). */
  ruleTriggered?: string;
  ruleResults: PolicyRuleResult[];
  contextReferences: Record<string, unknown>;
}

export interface EvaluateInput {
  sessionId: string;
  toolName: string;
  params: Record<string, unknown>;
  /** Human approval removes the autonomous amount cap (RP_006 → Infinity). */
  maxAutonomousRetryAmount?: number;
}

function skipRemaining(rules: string[], results: PolicyRuleResult[], decision: string): void {
  for (const rule of rules) {
    results.push({ rule, status: "SKIP", detail: `Not evaluated — ${decision}` });
  }
}

/**
 * Context loader + ordered evaluation. Returns the verdict, the deciding
 * rule, the full per-rule results and context references for the audit log.
 */
export async function evaluateProposedAction(input: EvaluateInput): Promise<PolicyEvaluation> {
  const { sessionId, toolName, params } = input;

  // ---- Context loader --------------------------------------------------
  const session = await prisma.resolutionSession.findUnique({ where: { sessionId } });
  if (!session) {
    return {
      verdict: "BLOCKED",
      ruleTriggered: "CONTEXT_MISSING",
      ruleResults: [{ rule: "CONTEXT", status: "FAIL", detail: "Session not found" }],
      contextReferences: { sessionId },
    };
  }

  const customer = await prisma.syntheticCustomer.findUnique({
    where: { customerId: session.customerId },
  });
  const originalTransaction = session.targetTransactionId
    ? await prisma.syntheticTransaction.findUnique({
        where: { transactionId: session.targetTransactionId },
      })
    : null;

  const contextReferences: Record<string, unknown> = {
    sessionId,
    customerId: session.customerId,
    targetTransactionId: session.targetTransactionId,
    accountStatus: customer?.accountStatus ?? null,
    transactionStatus: originalTransaction?.status ?? null,
    amount: originalTransaction ? Number(originalTransaction.amount) : null,
    retryCount: session.retryCount,
    maxAutonomousRetryAmount: input.maxAutonomousRetryAmount ?? policyMaxRetryAmount,
    policyMaxRetries,
  };

  // ---- retry_payment: RP_001 … RP_007 ----------------------------------
  if (toolName === "retry_payment") {
    const results: PolicyRuleResult[] = [];
    const cap = input.maxAutonomousRetryAmount ?? policyMaxRetryAmount;

    // RP_001 — idempotency: key must be present and unused
    const key = typeof params.idempotencyKey === "string" ? params.idempotencyKey : null;
    if (!key) {
      results.push({ rule: "RP_001", status: "FAIL", detail: "Missing idempotencyKey on proposed mutation" });
      skipRemaining(["RP_002", "RP_003", "RP_004", "RP_005", "RP_006", "RP_007"], results, "first-hit wins");
      return { verdict: "BLOCKED", ruleTriggered: "RP_001", ruleResults: results, contextReferences };
    }
    const usedKey = await prisma.syntheticTransaction.findUnique({ where: { idempotencyKey: key } });
    if (usedKey) {
      results.push({ rule: "RP_001", status: "FAIL", detail: `IdempotencyKey already used by ${usedKey.transactionId}` });
      skipRemaining(["RP_002", "RP_003", "RP_004", "RP_005", "RP_006", "RP_007"], results, "first-hit wins");
      return { verdict: "BLOCKED", ruleTriggered: "RP_001", ruleResults: results, contextReferences };
    }
    results.push({ rule: "RP_001", status: "PASS", detail: "Fresh, unused idempotency key" });

    // RP_002 — account state: must be ACTIVE (no mutation on frozen account)
    const accountStatus = customer?.accountStatus;
    if (accountStatus !== "ACTIVE") {
      results.push({ rule: "RP_002", status: "FAIL", detail: `Account status is ${accountStatus ?? "UNKNOWN"} — no mutation allowed` });
      skipRemaining(["RP_003", "RP_004", "RP_005", "RP_006", "RP_007"], results, "first-hit wins");
      return { verdict: "BLOCKED", ruleTriggered: "RP_002", ruleResults: results, contextReferences };
    }
    results.push({ rule: "RP_002", status: "PASS", detail: "Account status ACTIVE" });

    // RP_003 — transaction integrity
    const txnOk =
      !!originalTransaction &&
      originalTransaction.transactionId === session.targetTransactionId &&
      originalTransaction.customerId === session.customerId &&
      typeof params.originalTransactionId === "string" &&
      params.originalTransactionId === originalTransaction.transactionId;
    if (!txnOk) {
      results.push({ rule: "RP_003", status: "FAIL", detail: "Target transaction missing, mismatched or not owned by customer" });
      skipRemaining(["RP_004", "RP_005", "RP_006", "RP_007"], results, "first-hit wins");
      return { verdict: "BLOCKED", ruleTriggered: "RP_003", ruleResults: results, contextReferences };
    }
    results.push({ rule: "RP_003", status: "PASS", detail: "Transaction exists, matches session target and owner" });

    // RP_004 — retry eligibility
    if (originalTransaction!.status !== "FAILED_AT_BANK") {
      results.push({ rule: "RP_004", status: "FAIL", detail: `Transaction status ${originalTransaction!.status} not retry-eligible (needs FAILED_AT_BANK)` });
      skipRemaining(["RP_005", "RP_006", "RP_007"], results, "first-hit wins");
      return { verdict: "BLOCKED", ruleTriggered: "RP_004", ruleResults: results, contextReferences };
    }
    results.push({ rule: "RP_004", status: "PASS", detail: "Transaction FAILED_AT_BANK — retry eligible" });

    // RP_005 — retry budget
    if (session.retryCount >= policyMaxRetries) {
      results.push({ rule: "RP_005", status: "FAIL", detail: `Retry count ${session.retryCount} ≥ budget ${policyMaxRetries}` });
      skipRemaining(["RP_006", "RP_007"], results, "first-hit wins");
      return { verdict: "BLOCKED", ruleTriggered: "RP_005", ruleResults: results, contextReferences };
    }
    results.push({ rule: "RP_005", status: "PASS", detail: `Retry ${session.retryCount + 1}/${policyMaxRetries} within budget` });

    // RP_006 — amount cap → REQUIRES_HUMAN above the autonomous cap
    const amount = Number(originalTransaction!.amount);
    if (amount > cap) {
      results.push({ rule: "RP_006", status: "REVIEW", detail: `₹${amount} exceeds autonomous cap ₹${cap} — human approval required` });
      skipRemaining(["RP_007"], results, "first-hit wins");
      return { verdict: "REQUIRES_HUMAN", ruleTriggered: "RP_006", ruleResults: results, contextReferences };
    }
    results.push({ rule: "RP_006", status: "PASS", detail: `₹${amount} within autonomous cap ₹${cap}` });

    // RP_007 — final gate
    results.push({ rule: "RP_007", status: "PASS", detail: "All policy gates passed — execution allowed" });
    return { verdict: "ALLOWED", ruleTriggered: "RP_007", ruleResults: results, contextReferences };
  }

  // ---- send_customer_notification: NOTIF_001 … NOTIF_005 ---------------
  if (toolName === "send_customer_notification") {
    const results: PolicyRuleResult[] = [];

    // NOTIF_001 — channel ∈ {SMS, IN_APP}
    const channel = params.channel;
    if (channel !== "SMS" && channel !== "IN_APP") {
      results.push({ rule: "NOTIF_001", status: "FAIL", detail: `Channel ${String(channel)} not in {SMS, IN_APP}` });
      skipRemaining(["NOTIF_002", "NOTIF_003", "NOTIF_004", "NOTIF_005"], results, "first-hit wins");
      return { verdict: "BLOCKED", ruleTriggered: "NOTIF_001", ruleResults: results, contextReferences };
    }
    results.push({ rule: "NOTIF_001", status: "PASS", detail: `Channel ${channel} allowed` });

    // NOTIF_002 — customer exists
    if (!customer) {
      results.push({ rule: "NOTIF_002", status: "FAIL", detail: "Customer not found" });
      skipRemaining(["NOTIF_003", "NOTIF_004", "NOTIF_005"], results, "first-hit wins");
      return { verdict: "BLOCKED", ruleTriggered: "NOTIF_002", ruleResults: results, contextReferences };
    }
    results.push({ rule: "NOTIF_002", status: "PASS", detail: "Customer exists" });

    // NOTIF_003 — message length ≤ 500
    const message = typeof params.message === "string" ? params.message : "";
    if (message.length === 0 || message.length > 500) {
      results.push({ rule: "NOTIF_003", status: "FAIL", detail: `Message length ${message.length} outside 1–500` });
      skipRemaining(["NOTIF_004", "NOTIF_005"], results, "first-hit wins");
      return { verdict: "BLOCKED", ruleTriggered: "NOTIF_003", ruleResults: results, contextReferences };
    }
    results.push({ rule: "NOTIF_003", status: "PASS", detail: `${message.length}/500 characters` });

    // NOTIF_004 — account not SUSPENDED
    if (customer.accountStatus === "SUSPENDED") {
      results.push({ rule: "NOTIF_004", status: "FAIL", detail: "Account SUSPENDED — notifications blocked" });
      skipRemaining(["NOTIF_005"], results, "first-hit wins");
      return { verdict: "BLOCKED", ruleTriggered: "NOTIF_004", ruleResults: results, contextReferences };
    }
    results.push({ rule: "NOTIF_004", status: "PASS", detail: `Account ${customer.accountStatus}` });

    // NOTIF_005 — no duplicate identical message sent in this session
    const priorNotifications = await prisma.actionStep.findMany({
      where: { sessionId, toolName: "send_customer_notification", executionStatus: "SUCCESS" },
    });
    const duplicate = priorNotifications.some((step) => {
      const prior = step.toolParams as { message?: string } | null;
      return prior?.message === message;
    });
    if (duplicate) {
      results.push({ rule: "NOTIF_005", status: "FAIL", detail: "Identical message already sent in this session" });
      return { verdict: "BLOCKED", ruleTriggered: "NOTIF_005", ruleResults: results, contextReferences };
    }
    results.push({ rule: "NOTIF_005", status: "PASS", detail: "No duplicate message in this session" });

    return { verdict: "ALLOWED", ruleTriggered: "NOTIF_005", ruleResults: results, contextReferences };
  }

  // ---- escalate_to_human_support: ESC_001 ------------------------------
  if (toolName === "escalate_to_human_support") {
    const results: PolicyRuleResult[] = [
      { rule: "ESC_001", status: "PASS", detail: "Escalation is always permitted (non-financial)" },
    ];
    return { verdict: "ALLOWED", ruleTriggered: "ESC_001", ruleResults: results, contextReferences };
  }

  // ---- read-only tools -------------------------------------------------
  if (toolName === "get_transaction_status" || toolName === "get_customer_profile") {
    const results: PolicyRuleResult[] = [
      { rule: "READ_001", status: "PASS", detail: "Read-only tool — no mutation, always allowed" },
    ];
    return { verdict: "ALLOWED", ruleTriggered: "READ_001", ruleResults: results, contextReferences };
  }

  // Unknown tool → blocked
  return {
    verdict: "BLOCKED",
    ruleTriggered: "UNKNOWN_TOOL",
    ruleResults: [{ rule: "UNKNOWN_TOOL", status: "FAIL", detail: `Tool ${toolName} not registered` }],
    contextReferences,
  };
}

export default evaluateProposedAction;
