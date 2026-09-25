import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { prisma } from "../prisma";
import { DEMO_SCENARIOS, findScenario } from "../demo/scenarios";
import { logEvent } from "../services/audit.service";
import { AppError } from "../errors/AppError";
import { asyncHandler } from "../middleware/asyncHandler";

/**
 * Demo routes (§2): scenario descriptors + idempotent-ish seeding.
 */

const router = Router();

/** GET /demo/scenarios — the three demo scenario descriptors. */
router.get("/demo/scenarios", (_req, res) => {
  res.json({ scenarios: DEMO_SCENARIOS });
});

const seedSchema = z.object({
  scenario: z.enum(["SCENARIO_A", "SCENARIO_B", "SCENARIO_C"]),
});

/**
 * POST /demo/seed-scenario
 * Creates synthetic customer + failed transaction + resolution session.
 * IDs are timestamp-suffixed (and UUID backed) so repeated seeding is safe.
 */
router.post(
  "/demo/seed-scenario",
  asyncHandler(async (req, res) => {
  const { scenario } = seedSchema.parse(req.body);
  const descriptor = findScenario(scenario);
  if (!descriptor) throw new AppError(400, `Unknown scenario ${scenario}`);

  const suffix = `${Date.now()}_${randomUUID().slice(0, 8)}`;
  const customerId = `cust_${suffix}`;
  const transactionId = `txn_${suffix}`;
  const sessionId = `sess_${suffix}`;

  await prisma.syntheticCustomer.create({
    data: {
      customerId,
      name: descriptor.customer.name,
      phone: descriptor.customer.phone,
      accountStatus: descriptor.customer.accountStatus,
      syntheticBalance: descriptor.customer.syntheticBalance,
    },
  });

  await prisma.syntheticTransaction.create({
    data: {
      transactionId,
      customerId,
      amount: descriptor.transaction.amount,
      billerOrMerchant: descriptor.transaction.billerOrMerchant,
      status: descriptor.transaction.status,
      failureReason: descriptor.transaction.failureReason,
      // Deliberately no idempotencyKey: only *retries* carry keys (RP_001
      // checks that a proposed key is fresh and unused).
    },
  });

  await prisma.resolutionSession.create({
    data: {
      sessionId,
      customerId,
      targetTransactionId: transactionId,
      statedObjective: `Resolve failed payment: ${descriptor.title}`,
      currentState: "INTAKE",
      outcomeStatus: "IN_PROGRESS",
      retryCount: 0,
      maxRetries: 2,
    },
  });

  await logEvent({
    sessionId,
    stage: "INTAKE",
    decisionSummary: `Seeded ${scenario}: ${descriptor.customer.name}, ₹${descriptor.transaction.amount} ${descriptor.transaction.billerOrMerchant}`,
    contextReferences: { customerId, transactionId, scenario },
    details: {
      scenario,
      customerId,
      transactionId,
      accountStatus: descriptor.customer.accountStatus,
      amount: descriptor.transaction.amount,
      billerOrMerchant: descriptor.transaction.billerOrMerchant,
      transactionStatus: descriptor.transaction.status,
    },
  });

  res.status(201).json({ sessionId, customerId, transactionId, scenario });
  })
);

export default router;
