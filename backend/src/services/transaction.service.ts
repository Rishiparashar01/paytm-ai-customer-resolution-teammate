import { prisma } from "../prisma";
import { AppError } from "../errors/AppError";
import { retry as gatewayRetry } from "./mockBillerGateway";

/**
 * Transaction service (DB reads) + retryPayment mutation (§6).
 *
 * retryPayment idempotency contract:
 * 1. Existing idempotencyKey + SUCCESS → replay of the winner.
 * 2. Existing idempotencyKey + non-success → IDEMPOTENCY_CONFLICT (409).
 * 3. Preconditions: original exists, belongs to session customer, status
 *    FAILED_AT_BANK, account not FROZEN/SUSPENDED, retry budget not exhausted.
 * 4. Gateway call → on success create a SUCCESS txn with the key; the whole
 *    check-then-act block catches Prisma P2002 and returns the concurrent
 *    winner as a replay (never 500).
 * 5. Gateway failure → record a FAILED retry txn carrying the same key.
 */

export interface RetryPaymentInput {
  originalTransactionId: string;
  idempotencyKey: string;
  /** Used to enforce the per-session retry budget (POLICY_MAX_RETRIES). */
  sessionId?: string;
}

export interface RetryPaymentResult {
  success: boolean;
  isReplay?: boolean;
  newTransactionId?: string;
  acknowledgementId?: string;
  failureReason?: string;
}

export async function getTransaction(transactionId: string) {
  return prisma.syntheticTransaction.findUnique({ where: { transactionId } });
}

export async function getRecentTransactions(customerId: string, take = 10) {
  return prisma.syntheticTransaction.findMany({
    where: { customerId },
    orderBy: { createdAt: "desc" },
    take,
  });
}

export async function retryPayment(input: RetryPaymentInput): Promise<RetryPaymentResult> {
  const { originalTransactionId, idempotencyKey, sessionId } = input;

  // --- Step 1: idempotency replay check ---------------------------------
  const existing = await prisma.syntheticTransaction.findUnique({
    where: { idempotencyKey },
  });

  if (existing) {
    if (existing.status === "SUCCESS") {
      return {
        success: true,
        isReplay: true,
        newTransactionId: existing.transactionId,
        acknowledgementId: (existing.failureReason === null ? undefined : undefined),
      };
    }
    throw new AppError(409, "IDEMPOTENCY_CONFLICT: key already used by a non-successful transaction", "IDEMPOTENCY_CONFLICT");
  }

  try {
    // --- Step 2: preconditions ------------------------------------------
    const original = await prisma.syntheticTransaction.findUnique({
      where: { transactionId: originalTransactionId },
    });
    if (!original) {
      throw new AppError(404, "Original transaction not found");
    }

    const session = sessionId
      ? await prisma.resolutionSession.findUnique({ where: { sessionId } })
      : null;
    const customerId = session?.customerId ?? original.customerId;

    if (original.customerId !== customerId) {
      throw new AppError(403, "Transaction does not belong to this session's customer");
    }
    if (original.status !== "FAILED_AT_BANK") {
      throw new AppError(409, `Transaction not retry-eligible (status=${original.status})`);
    }

    const customer = await prisma.syntheticCustomer.findUnique({ where: { customerId } });
    if (!customer) {
      throw new AppError(404, "Customer not found");
    }
    if (customer.accountStatus === "FROZEN" || customer.accountStatus === "SUSPENDED") {
      throw new AppError(403, `No mutation allowed: account is ${customer.accountStatus}`);
    }

    if (session) {
      const executedRetries = await prisma.actionStep.count({
        where: {
          sessionId,
          toolName: "retry_payment",
          executionStatus: { in: ["SUCCESS", "FAILED"] },
        },
      });
      const maxRetries = Number(process.env.POLICY_MAX_RETRIES ?? 1);
      if (executedRetries >= maxRetries) {
        throw new AppError(429, `Retry budget exhausted (${executedRetries}/${maxRetries})`, "RETRY_BUDGET_EXHAUSTED");
      }
    }

    // --- Step 3: deterministic gateway ----------------------------------
    const gatewayResult = gatewayRetry({
      amount: Number(original.amount),
      billerOrMerchant: original.billerOrMerchant,
    });

    // --- Step 4/5: persist outcome --------------------------------------
    const newTransactionId = `txn_retry_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    if (gatewayResult.ok) {
      await prisma.syntheticTransaction.create({
        data: {
          transactionId: newTransactionId,
          customerId: original.customerId,
          amount: original.amount,
          billerOrMerchant: original.billerOrMerchant,
          status: "SUCCESS",
          idempotencyKey,
        },
      });
      return {
        success: true,
        isReplay: false,
        newTransactionId,
        acknowledgementId: gatewayResult.acknowledgementId,
      };
    }

    // Gateway declined → record FAILED retry carrying the same key
    await prisma.syntheticTransaction.create({
      data: {
        transactionId: newTransactionId,
        customerId: original.customerId,
        amount: original.amount,
        billerOrMerchant: original.billerOrMerchant,
        status: "FAILED_AT_BANK",
        failureReason: gatewayResult.message,
        idempotencyKey,
      },
    });
    return { success: false, isReplay: false, failureReason: gatewayResult.message };
  } catch (err) {
    // Step 4 hardening: concurrent winner on the unique idempotency key →
    // re-fetch the winner and return it as a replay. Never 500 on P2002.
    const code = (err as { code?: string }).code;
    if (code === "P2002") {
      const winner = await prisma.syntheticTransaction.findUnique({
        where: { idempotencyKey },
      });
      if (winner && winner.status === "SUCCESS") {
        return {
          success: true,
          isReplay: true,
          newTransactionId: winner.transactionId,
        };
      }
      throw new AppError(409, "IDEMPOTENCY_CONFLICT: concurrent writer won the race", "IDEMPOTENCY_CONFLICT");
    }
    throw err;
  }
}

const transactionService = { getTransaction, getRecentTransactions, retryPayment };
export default transactionService;
