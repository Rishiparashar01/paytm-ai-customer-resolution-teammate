import { randomUUID } from "node:crypto";
import { geminiApiKey, geminiModel } from "../config/env";

/**
 * §7 AI planner.
 * `planResolution(context)` calls Google Gemini when GEMINI_API_KEY is set
 * (structured prompt → JSON {toolName, params, reasoning} with retries).
 * When the key is missing or any call fails, it falls back to a deterministic
 * offline planner keyed off a structured `hasRetryInTrace` flag — it never
 * string-matches on error messages.
 */

export interface PlannerContext {
  sessionId: string;
  customer: {
    customerId: string;
    name: string;
    accountStatus: string;
    syntheticBalance: unknown;
  } | null;
  originalTransaction: {
    transactionId: string;
    amount: unknown;
    billerOrMerchant: string;
    status: string;
    failureReason: string | null;
  } | null;
  sessionRetryCount: number;
  policyConfig: {
    maxAutonomousRetryAmount: number;
    maxRetries: number;
  };
  /** Structured flag — a retry_payment step already exists in the trace. */
  hasRetryInTrace: boolean;
}

export interface PlannedAction {
  toolName: string;
  params: Record<string, unknown>;
  reasoning: string;
  planner: "gemini" | "offline";
}

const VALID_TOOLS = new Set([
  "retry_payment",
  "send_customer_notification",
  "escalate_to_human_support",
]);

function buildPrompt(ctx: PlannerContext): string {
  return `You are the resolution planner for a fintech customer support agent.
Decide the single next action for this failed-payment resolution session.

Return ONLY minified JSON of the form:
{"toolName":"...","params":{...},"reasoning":"..."}

Rules:
- If no retry has been attempted yet (hasRetryInTrace=false),
  propose {"toolName":"retry_payment","params":{"originalTransactionId":"<id>","idempotencyKey":"idemp_<fresh-uuid>"}}
  with a FRESH idempotency key. Never skip proposing it — the policy engine decides
  whether it may run.
- If a retry already exists in the trace (hasRetryInTrace=true), propose
  {"toolName":"send_customer_notification","params":{"customerId":"<id>","message":"<max 500 chars>","channel":"IN_APP"}}
  with a helpful status update message.
- Never propose two actions; never add commentary outside the JSON.

Context (JSON):
${JSON.stringify(
    {
      sessionId: ctx.sessionId,
      customer: ctx.customer,
      originalTransaction: ctx.originalTransaction,
      sessionRetryCount: ctx.sessionRetryCount,
      hasRetryInTrace: ctx.hasRetryInTrace,
      policyConfig: ctx.policyConfig,
    },
    null,
    2
  )}`;
}

function isValidProposal(value: unknown): value is { toolName: string; params: Record<string, unknown>; reasoning: string } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { toolName?: unknown; params?: unknown; reasoning?: unknown };
  return (
    typeof v.toolName === "string" &&
    VALID_TOOLS.has(v.toolName) &&
    typeof v.params === "object" &&
    v.params !== null &&
    typeof v.reasoning === "string"
  );
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Planner response contained no JSON object");
    return JSON.parse(match[0]);
  }
}

async function planWithGemini(ctx: PlannerContext): Promise<PlannedAction> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    geminiModel
  )}:generateContent?key=${encodeURIComponent(geminiApiKey)}`;

  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: buildPrompt(ctx) }],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
    },
  };

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const json = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      const parsed = extractJson(text);
      if (!isValidProposal(parsed)) {
        throw new Error("Gemini returned an invalid proposal shape");
      }
      return {
        toolName: parsed.toolName,
        params: parsed.params,
        reasoning: parsed.reasoning,
        planner: "gemini",
      };
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Gemini planning failed");
}

/**
 * Deterministic offline planner (§7):
 * - no retry_payment step in the trace → propose retry_payment
 *   {originalTransactionId, idempotencyKey}
 * - otherwise → propose send_customer_notification
 *   {customerId, message, channel:"IN_APP"}
 */
function planOffline(ctx: PlannerContext): PlannedAction {
  // Note: the planner does NOT self-censor on account status — proposing an
  // action and blocking it is the policy engine's job (Scenario C relies on
  // this: retry is proposed, RP_002 blocks it on a FROZEN account).
  if (!ctx.hasRetryInTrace && ctx.originalTransaction && ctx.customer) {
    return {
      toolName: "retry_payment",
      params: {
        originalTransactionId: ctx.originalTransaction.transactionId,
        idempotencyKey: `idemp_${randomUUID()}`,
      },
      reasoning: "Offline planner: no retry_payment step exists in the trace — proposing a fresh-key retry.",
      planner: "offline",
    };
  }

  if (ctx.customer && ctx.originalTransaction) {
    const amount = Number(ctx.originalTransaction.amount);
    const message =
      `Update on your ₹${amount} payment to ${ctx.originalTransaction.billerOrMerchant}: ` +
      `we could not complete it (${ctx.originalTransaction.failureReason ?? "bank failure"}). ` +
      `Our team is on it — you will hear from us shortly.`;
    return {
      toolName: "send_customer_notification",
      params: {
        customerId: ctx.customer.customerId,
        message: message.slice(0, 500),
        channel: "IN_APP",
      },
      reasoning: "Offline planner: retry already present in trace — notifying the customer instead.",
      planner: "offline",
    };
  }

  return {
    toolName: "escalate_to_human_support",
    params: {
      customerId: ctx.customer?.customerId ?? "unknown",
      reason: "Planner could not gather sufficient context",
    },
    reasoning: "Offline planner: missing context — escalating to human support.",
    planner: "offline",
  };
}

/**
 * Public planner entry point: Gemini first (when keyed), offline fallback always available.
 */
export async function planResolution(context: PlannerContext): Promise<PlannedAction> {
  if (geminiApiKey) {
    try {
      return await planWithGemini(context);
    } catch (err) {
      console.warn("[planner] Gemini call failed — using deterministic offline fallback:", err);
    }
  }
  return planOffline(context);
}

export { planOffline };
export default planResolution;
