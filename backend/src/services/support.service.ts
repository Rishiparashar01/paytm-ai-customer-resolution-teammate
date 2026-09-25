import { prisma } from "../prisma";
import { AppError } from "../errors/AppError";

/**
 * Support escalation service.
 * Creates an immutable escalation ticket in the audit trail when an action is
 * blocked by policy, rejected by a supervisor, or otherwise unresolvable.
 * Escalation is a non-financial mutation — it never touches money.
 */

export interface EscalationInput {
  sessionId: string;
  customerId: string;
  reason: string;
  ruleTriggered?: string;
  /** Optional step that triggered the escalation. */
  stepId?: string;
}

export interface EscalationResult {
  ticketId: string;
  status: "OPEN";
}

export async function escalate(input: EscalationInput): Promise<EscalationResult> {
  const { sessionId, customerId, reason, ruleTriggered, stepId } = input;

  const session = await prisma.resolutionSession.findUnique({ where: { sessionId } });
  if (!session) {
    throw new AppError(404, "Session not found for escalation");
  }

  const ticketId = `tkt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  await prisma.auditLogEntry.create({
    data: {
      sessionId,
      stage: "HUMAN_DECIDED",
      decisionSummary: `Escalated to human support: ${reason}`,
      contextReferences: { ticketId, customerId, ruleTriggered, stepId },
      details: { ticketId, customerId, reason, ruleTriggered, stepId, status: "OPEN" },
    },
  });

  return { ticketId, status: "OPEN" };
}

const supportService = { escalate };
export default supportService;
