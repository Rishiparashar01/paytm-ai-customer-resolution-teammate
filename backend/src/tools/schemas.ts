import { z } from "zod";

/**
 * Zod parameter schemas for every registered tool (§4 tool registry).
 */

export const retryPaymentSchema = z.object({
  originalTransactionId: z.string().min(1, "originalTransactionId is required"),
  idempotencyKey: z
    .string()
    .min(1, "idempotencyKey is required")
    .regex(/^idemp_[A-Za-z0-9-]+$/, "idempotencyKey must be a fresh idemp_<uuid> key"),
});

export const sendNotificationSchema = z.object({
  customerId: z.string().min(1, "customerId is required"),
  message: z.string().min(1).max(500, "message must be ≤ 500 characters"),
  channel: z.enum(["SMS", "IN_APP"]),
});

export const escalateSchema = z.object({
  customerId: z.string().min(1, "customerId is required"),
  reason: z.string().min(1, "reason is required").max(500),
});

export const getTransactionStatusSchema = z.object({
  transactionId: z.string().min(1),
});

export const getCustomerProfileSchema = z.object({
  customerId: z.string().min(1),
});

export type RetryPaymentParams = z.infer<typeof retryPaymentSchema>;
export type SendNotificationParams = z.infer<typeof sendNotificationSchema>;
export type EscalateParams = z.infer<typeof escalateSchema>;
