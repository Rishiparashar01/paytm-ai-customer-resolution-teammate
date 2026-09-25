/**
 * API client — 100% env-driven base URL (§12.10: no hardcoded prod URL).
 * Falls back to the local dev server only when VITE_API_BASE_URL is unset.
 */
const API_BASE: string = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:4000";

export function apiBase(): string {
  return API_BASE.replace(/\/$/, "");
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    super(typeof body === "object" && body !== null && "error" in body ? String((body as { error: unknown }).error) : `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

// ---------------------------------------------------------------------------
// Domain types (mirror the backend snapshot shape)
// ---------------------------------------------------------------------------

export type AccountStatus = "ACTIVE" | "SUSPENDED" | "FROZEN";
export type TransactionStatus = "SUCCESS" | "FAILED_AT_BANK" | "PENDING_CLEARING" | "REVERSED";
export type SessionOutcome = "IN_PROGRESS" | "VERIFIED_SUCCESS" | "VERIFIED_FAILURE" | "ESCALATED";
export type PolicyVerdict = "ALLOWED" | "BLOCKED" | "REQUIRES_HUMAN";
export type RuleStatus = "PASS" | "FAIL" | "REVIEW" | "SKIP";

export interface ScenarioDescriptor {
  scenario: "SCENARIO_A" | "SCENARIO_B" | "SCENARIO_C";
  title: string;
  description: string;
  expectedOutcome: string;
  customer: { name: string; phone: string; accountStatus: AccountStatus; syntheticBalance: number };
  transaction: { amount: number; billerOrMerchant: string; status: TransactionStatus; failureReason: string | null };
}

export interface RuleResult {
  rule: string;
  status: RuleStatus;
  detail: string;
}

export interface AuditEntry {
  id: string;
  sessionId: string;
  stage: string;
  decisionSummary: string | null;
  contextReferences: Record<string, unknown> | null;
  details: Record<string, unknown>;
  timestamp: string;
}

export interface ActionStep {
  stepId: string;
  sessionId: string;
  toolName: string;
  toolParams: Record<string, unknown>;
  policyVerdict: PolicyVerdict | "PENDING";
  policyRuleTriggered: string | null;
  executionStatus: "PENDING" | "SUCCESS" | "FAILED" | "SKIPPED";
  executionResult: Record<string, unknown> | null;
  errorMessage: string | null;
  executedAt: string | null;
  createdAt: string;
}

export interface HumanReview {
  reviewId: string;
  sessionId: string;
  stepId: string;
  reason: string;
  proposedTool: string;
  proposedParams: Record<string, unknown>;
  status: "PENDING" | "APPROVED" | "REJECTED" | "MODIFIED";
  reviewerNotes: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface SessionSnapshot {
  session: {
    sessionId: string;
    customerId: string;
    targetTransactionId: string | null;
    statedObjective: string;
    currentState: string;
    retryCount: number;
    maxRetries: number;
    outcomeStatus: SessionOutcome;
    createdAt: string;
    updatedAt: string;
    customer: {
      customerId: string;
      name: string;
      phone: string;
      accountStatus: AccountStatus;
      syntheticBalance: number;
    };
    actionSteps: ActionStep[];
    auditEntries: AuditEntry[];
    humanReviews: HumanReview[];
  };
  transactions: Array<{
    transactionId: string;
    customerId: string;
    amount: number;
    billerOrMerchant: string;
    status: TransactionStatus;
    failureReason: string | null;
    idempotencyKey: string | null;
    createdAt: string;
  }>;
  targetTransaction: {
    transactionId: string;
    amount: number;
    billerOrMerchant: string;
    status: TransactionStatus;
    failureReason: string | null;
    idempotencyKey: string | null;
  } | null;
  pendingReview: HumanReview | null;
}

export interface RunResult {
  stepsExecuted: number;
  outcome:
    | { outcome: "TERMINAL"; reason: string }
    | { outcome: "PAUSED"; reason: string; reviewId?: string }
    | { outcome: "CONTINUE"; reason: string }
    | { outcome: "YIELD"; message: string };
  snapshot: SessionSnapshot;
}

export interface VerdictResult {
  snapshot: SessionSnapshot;
  result: string;
}

// ---------------------------------------------------------------------------
// Endpoints (§2 routes)
// ---------------------------------------------------------------------------

export const api = {
  health: () => request<{ status: string; service: string }>("/api/v1/health"),
  scenarios: () => request<{ scenarios: ScenarioDescriptor[] }>("/api/v1/demo/scenarios"),
  seedScenario: (scenario: string) =>
    request<{ sessionId: string; customerId: string; transactionId: string }>("/api/v1/demo/seed-scenario", {
      method: "POST",
      body: JSON.stringify({ scenario }),
    }),
  runSession: (sessionId: string, maxSteps?: number) =>
    request<RunResult>(`/api/v1/sessions/${sessionId}/run`, {
      method: "POST",
      body: JSON.stringify(maxSteps ? { maxSteps } : {}),
    }),
  snapshot: (sessionId: string) => request<SessionSnapshot>(`/api/v1/sessions/${sessionId}`),
  verdict: (
    sessionId: string,
    reviewId: string,
    payload: { verdict: "APPROVED" | "REJECTED" | "MODIFIED"; reviewerNotes?: string; modifiedParams?: Record<string, unknown> }
  ) =>
    request<VerdictResult>(`/api/v1/sessions/${sessionId}/human-review/${reviewId}/verdict`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
};
