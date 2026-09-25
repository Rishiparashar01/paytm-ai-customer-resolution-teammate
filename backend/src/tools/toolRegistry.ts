import { prisma } from "../prisma";
import { retryPayment } from "../services/transaction.service";
import { sendNotification } from "../services/notification.service";
import { escalate } from "../services/support.service";
import {
  retryPaymentSchema,
  sendNotificationSchema,
  escalateSchema,
  getTransactionStatusSchema,
  getCustomerProfileSchema,
} from "./schemas";

/**
 * §4 Tool registry.
 * Every tool validates its params with Zod before touching the database.
 * Mutations: retry_payment, send_customer_notification, escalate_to_human_support.
 * Read-only: get_transaction_status, get_customer_profile.
 */

export interface ToolContext {
  sessionId: string;
  customerId: string;
}

export interface ToolExecutionResult {
  success: boolean;
  /** Non-financial retries (replays) are flagged explicitly. */
  isReplay?: boolean;
  data: Record<string, unknown>;
}

export type ToolHandler = (
  params: Record<string, unknown>,
  ctx: ToolContext
) => Promise<ToolExecutionResult>;

const registry: Record<string, ToolHandler> = {
  retry_payment: async (rawParams, ctx) => {
    const params = retryPaymentSchema.parse(rawParams);
    const result = await retryPayment({
      originalTransactionId: params.originalTransactionId,
      idempotencyKey: params.idempotencyKey,
      sessionId: ctx.sessionId,
    });
    if (!result.success) {
      const err = new Error(result.failureReason ?? "retry_payment failed") as Error & {
        retryable?: boolean;
      };
      err.retryable = true;
      throw err;
    }
    return {
      success: true,
      isReplay: result.isReplay ?? false,
      data: {
        newTransactionId: result.newTransactionId,
        acknowledgementId: result.acknowledgementId,
        isReplay: result.isReplay ?? false,
      },
    };
  },

  send_customer_notification: async (rawParams) => {
    const params = sendNotificationSchema.parse(rawParams);
    const result = await sendNotification(params);
    return { success: true, data: { ...result } };
  },

  escalate_to_human_support: async (rawParams, ctx) => {
    const params = escalateSchema.parse(rawParams);
    const result = await escalate({
      sessionId: ctx.sessionId,
      customerId: params.customerId,
      reason: params.reason,
    });
    return { success: true, data: { ...result } };
  },

  get_transaction_status: async (rawParams) => {
    const params = getTransactionStatusSchema.parse(rawParams);
    const txn = await prisma.syntheticTransaction.findUnique({
      where: { transactionId: params.transactionId },
    });
    return {
      success: true,
      data: {
        transactionId: txn?.transactionId ?? null,
        status: txn?.status ?? null,
        amount: txn ? Number(txn.amount) : null,
        billerOrMerchant: txn?.billerOrMerchant ?? null,
        failureReason: txn?.failureReason ?? null,
      },
    };
  },

  get_customer_profile: async (rawParams) => {
    const params = getCustomerProfileSchema.parse(rawParams);
    const customer = await prisma.syntheticCustomer.findUnique({
      where: { customerId: params.customerId },
    });
    return {
      success: true,
      data: {
        customerId: customer?.customerId ?? null,
        name: customer?.name ?? null,
        accountStatus: customer?.accountStatus ?? null,
        syntheticBalance: customer ? Number(customer.syntheticBalance) : null,
      },
    };
  },
};

export function hasTool(toolName: string): boolean {
  return Object.prototype.hasOwnProperty.call(registry, toolName);
}

export async function dispatchTool(
  toolName: string,
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolExecutionResult> {
  const handler = registry[toolName];
  if (!handler) {
    throw new Error(`Unknown tool: ${toolName}`);
  }
  return handler(params, ctx);
}

export default registry;
