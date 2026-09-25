import { Zap, CircleCheck, CircleX, Timer } from "lucide-react";
import type { SessionSnapshot } from "../api/client";

/**
 * ExecutionAndOutcomePanel — new txn ID, biller ack, execution status,
 * and the outcome-verified badge.
 */
export default function ExecutionAndOutcomePanel({
  snapshot,
}: {
  snapshot: SessionSnapshot | null }) {
  if (!snapshot) {
    return (
      <section className="panel span-6">
        <h2>
          <Zap size={14} /> Execution &amp; Outcome
        </h2>
        <div className="empty">Nothing executed yet.</div>
      </section>
    );
  }

  const { session } = snapshot;
  const outcome = session.outcomeStatus;

  const executedSteps = session.actionSteps.filter((s) => s.executionStatus !== "PENDING");
  const lastStep = executedSteps[executedSteps.length - 1];

  const newTxn = [...snapshot.transactions]
    .filter((t) => t.status === "SUCCESS" && t.transactionId !== snapshot.targetTransaction?.transactionId)
    .pop();

  const outcomeClass =
    outcome === "VERIFIED_SUCCESS"
      ? "success"
      : outcome === "VERIFIED_FAILURE"
        ? "failure"
        : outcome === "ESCALATED"
          ? "escalated"
          : "pending";

  const verifiedEntry = [...session.auditEntries]
    .reverse()
    .find((e) => e.stage === "OUTCOME_VERIFIED");

  return (
    <section className="panel span-6">
      <h2>
        <Zap size={14} /> Execution &amp; Outcome
      </h2>

      <div className={`big-status ${outcomeClass}`}>
        {outcome === "VERIFIED_SUCCESS" ? <CircleCheck size={18} /> : outcome === "IN_PROGRESS" ? <Timer size={18} /> : <CircleX size={18} />}
        {outcome.replace(/_/g, " ")}
        {verifiedEntry && outcome !== "IN_PROGRESS" && (
          <span className="badge ok" style={{ marginLeft: 8 }}>
            verified from DB
          </span>
        )}
      </div>

      {lastStep ? (
        <>
          <div className="kv">
            <span className="k">Last tool</span>
            <span className="v tool-name" style={{ fontSize: 13 }}>
              {lastStep.toolName}
            </span>
          </div>
          <div className="kv">
            <span className="k">Execution status</span>
            <span className="v">
              <span
                className={`badge ${lastStep.executionStatus === "SUCCESS" ? "ok" : lastStep.executionStatus === "SKIPPED" ? "warn" : "err"}`}
              >
                {lastStep.executionStatus}
              </span>
            </span>
          </div>
          {newTxn && (
            <>
              <div className="kv">
                <span className="k">New transaction ID</span>
                <span className="v mono" style={{ color: "var(--green)" }}>
                  {newTxn.transactionId}
                </span>
              </div>
              <div className="kv">
                <span className="k">Biller acknowledgement</span>
                <span className="v mono">
                  {String(
                    (lastStep.executionResult as { acknowledgementId?: string } | null)
                      ?.acknowledgementId ?? "ack confirmed"
                  )}
                </span>
              </div>
            </>
          )}
          {lastStep.errorMessage && (
            <div className="kv">
              <span className="k">Error</span>
              <span className="v mono" style={{ color: "var(--red)" }}>
                {lastStep.errorMessage}
              </span>
            </div>
          )}
          {lastStep.toolParams && "idempotencyKey" in lastStep.toolParams && (
            <div className="kv">
              <span className="k">Idempotency key</span>
              <span className="v mono">{String(lastStep.toolParams.idempotencyKey)}</span>
            </div>
          )}
        </>
      ) : (
        <div className="empty">No tool has been executed in this session yet.</div>
      )}

      <div className="badge-row" style={{ marginTop: 14 }}>
        <span className="badge">Steps: {session.actionSteps.length}</span>
        <span className="badge">Retries: {session.retryCount}/{session.maxRetries}</span>
        <span className="badge info">State: {session.currentState}</span>
        {session.outcomeStatus === "VERIFIED_SUCCESS" && <span className="badge ok">DB confirmed</span>}
      </div>
    </section>
  );
}
