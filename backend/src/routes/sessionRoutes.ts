import { Router } from "express";
import { z } from "zod";
import {
  runSession,
  getSessionSnapshot,
  submitHumanVerdict,
} from "../orchestrator/orchestrator";
import { asyncHandler } from "../middleware/asyncHandler";

/**
 * Session routes (§2): run the orchestrator, read snapshots, submit verdicts.
 */

const router = Router();

/** GET /sessions/:sessionId — full session snapshot (session + steps + reviews + audit). */
router.get(
  "/sessions/:sessionId",
  asyncHandler(async (req, res) => {
    const snapshot = await getSessionSnapshot(req.params.sessionId);
    res.json(snapshot);
  })
);

const runSchema = z.object({
  maxSteps: z.number().int().min(1).max(50).optional(),
});

/** POST /sessions/:sessionId/run — run the orchestrator loop. */
router.post(
  "/sessions/:sessionId/run",
  asyncHandler(async (req, res) => {
    const { maxSteps } = runSchema.parse(req.body ?? {});
    const result = await runSession(req.params.sessionId, maxSteps ?? 10);
    res.json(result);
  })
);

const verdictSchema = z.object({
  verdict: z.enum(["APPROVED", "REJECTED", "MODIFIED"]),
  reviewerNotes: z.string().max(1000).optional(),
  modifiedParams: z.record(z.unknown()).optional(),
});

/**
 * POST /sessions/:sessionId/human-review/:reviewId/verdict
 * Applies the verdict; APPROVED/MODIFIED re-enters policy evaluation before
 * execution (§5 submitHumanVerdict), then returns the session snapshot.
 */
router.post(
  "/sessions/:sessionId/human-review/:reviewId/verdict",
  asyncHandler(async (req, res) => {
    const body = verdictSchema.parse(req.body);
    const result = await submitHumanVerdict(req.params.sessionId, req.params.reviewId, body);
    res.json(result);
  })
);

export default router;
