import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { isProduction } from "../config/env";

export type AuditStageValue =
  | "INTAKE"
  | "CONTEXT_GATHERED"
  | "PLAN_PROPOSED"
  | "POLICY_EVALUATED"
  | "TOOL_EXECUTED"
  | "HUMAN_DECIDED"
  | "OUTCOME_VERIFIED"
  | "STATE_TRANSITION";

/**
 * JSON payloads are accepted as plain `unknown` and cast once at the DB
 * boundary — callers stay free of Prisma's InputJsonValue boilerplate.
 */
export interface AuditEventInput {
  sessionId: string;
  stage: AuditStageValue;
  decisionSummary?: string;
  contextReferences?: unknown;
  details: unknown;
}

const asJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

/**
 * §9 Audit service.
 * Append-only insert into audit_log_entries. Never updates or deletes.
 * On failure the error is logged at CRITICAL level and rethrown in production —
 * audit integrity is a core invariant and must not be silently swallowed.
 */
export async function logEvent(input: AuditEventInput): Promise<void> {
  try {
    await prisma.auditLogEntry.create({
      data: {
        sessionId: input.sessionId,
        stage: input.stage,
        decisionSummary: input.decisionSummary ?? null,
        contextReferences:
          input.contextReferences === undefined || input.contextReferences === null
            ? Prisma.DbNull
            : asJson(input.contextReferences),
        details: asJson(input.details),
      },
    });
  } catch (err) {
    console.error(`[audit:CRITICAL] Failed to append audit entry for session ${input.sessionId}`, err);
    if (isProduction) {
      throw err;
    }
  }
}

const auditService = { logEvent };
export default auditService;
