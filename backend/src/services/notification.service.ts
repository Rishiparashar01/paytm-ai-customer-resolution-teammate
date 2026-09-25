import { prisma } from "../prisma";
import { AppError } from "../errors/AppError";

/**
 * Synthetic notification service (IN_APP / SMS).
 * Does NOT mutate any financial state. The NOTIF policy rules (§8) are
 * enforced by the policy engine before this service is ever invoked;
 * the checks here are defence in depth.
 */

export type NotificationChannel = "SMS" | "IN_APP";

export interface SendNotificationInput {
  customerId: string;
  message: string;
  channel: NotificationChannel;
  sessionId?: string;
}

export interface SendNotificationResult {
  success: boolean;
  notificationId: string;
  channel: NotificationChannel;
  deliveredTo: string;
}

export async function sendNotification(input: SendNotificationInput): Promise<SendNotificationResult> {
  const { customerId, message, channel, sessionId } = input;

  if (channel !== "SMS" && channel !== "IN_APP") {
    throw new AppError(400, `Invalid notification channel: ${channel}`);
  }
  if (typeof message !== "string" || message.length === 0 || message.length > 500) {
    throw new AppError(400, "Notification message must be 1–500 characters");
  }

  const customer = await prisma.syntheticCustomer.findUnique({ where: { customerId } });
  if (!customer) {
    throw new AppError(404, "Customer not found");
  }

  const notificationId = `ntf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Persist as an ActionStep-style record is unnecessary — notifications are
  // recorded by the orchestrator as action steps. Here we just "deliver"
  // deterministically (in-memory outcome + DB row on the session timeline).
  if (sessionId) {
    await prisma.auditLogEntry.create({
      data: {
        sessionId,
        stage: "TOOL_EXECUTED",
        decisionSummary: `Notification delivered via ${channel}`,
        contextReferences: { notificationId, channel, customerId },
        details: { notificationId, channel, message, customerId },
      },
    });
  }

  return {
    success: true,
    notificationId,
    channel,
    deliveredTo: channel === "SMS" ? customer.phone : `in_app:${customerId}`,
  };
}

const notificationService = { sendNotification };
export default notificationService;
