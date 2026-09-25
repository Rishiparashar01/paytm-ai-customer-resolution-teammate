import { useCallback, useEffect, useRef, useState } from "react";
import Header from "./components/Header";
import MetricsStrip, { type SessionMetrics } from "./components/MetricsStrip";
import ScenarioSelector from "./components/ScenarioSelector";
import WorkflowPipeline from "./components/WorkflowPipeline";
import CasePanel from "./components/CasePanel";
import AiPlannerPanel from "./components/AiPlannerPanel";
import PolicyEnginePanel from "./components/PolicyEnginePanel";
import ExecutionAndOutcomePanel from "./components/ExecutionAndOutcomePanel";
import HumanReviewModal from "./components/HumanReviewModal";
import AuditTimeline from "./components/AuditTimeline";
import {
  api,
  ApiError,
  type ScenarioDescriptor,
  type SessionSnapshot,
} from "./api/client";

const METRICS_KEY = "paytm_ai_metrics_v1";

function loadMetrics(): SessionMetrics {
  try {
    const raw = localStorage.getItem(METRICS_KEY);
    if (raw) return JSON.parse(raw) as SessionMetrics;
  } catch {
    /* ignore corrupt metrics */
  }
  return { runs: 0, successes: 0, humanEscalations: 0, totalMs: 0, completedRuns: 0 };
}

function saveMetrics(metrics: SessionMetrics): void {
  try {
    localStorage.setItem(METRICS_KEY, JSON.stringify(metrics));
  } catch {
    /* storage unavailable — metrics are cosmetic */
  }
}

const TERMINAL = new Set(["RESOLVED_SUCCESS", "RESOLVED_FAILURE", "ESCALATED"]);

export default function App() {
  const [health, setHealth] = useState<"checking" | "ok" | "down">("checking");
  const [scenarios, setScenarios] = useState<ScenarioDescriptor[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<SessionMetrics>(loadMetrics);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runStartedRef = useRef<number>(0);

  // ---- On load: health + scenarios (§10) --------------------------------
  useEffect(() => {
    let cancelled = false;

    api
      .scenarios()
      .then((res) => {
        if (!cancelled) setScenarios(res.scenarios);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load demo scenarios — is the backend running?");
      });

    api
      .health()
      .then(() => !cancelled && setHealth("ok"))
      .catch(() => !cancelled && setHealth("down"));

    return () => {
      cancelled = true;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  /**
   * Records metrics for a session.
   * - mode "run": a new run started — counts runs + (if it paused) escalation.
   * - mode "verdict": a paused run was resolved — updates success/completion
   *   for the run that was already counted, without inflating run counts.
   */
  const recordMetrics = useCallback(
    (snap: SessionSnapshot, startedAt: number, mode: "run" | "verdict" = "run") => {
      setMetrics((prev) => {
        const isTerminal = TERMINAL.has(snap.session.currentState);
        const isSuccess = snap.session.outcomeStatus === "VERIFIED_SUCCESS";
        const hasHuman = snap.session.humanReviews.length > 0;
        const elapsed = Math.max(0, Date.now() - startedAt);

        const next: SessionMetrics =
          mode === "run"
            ? {
                runs: prev.runs + 1,
                successes: prev.successes + (isSuccess ? 1 : 0),
                humanEscalations: prev.humanEscalations + (hasHuman ? 1 : 0),
                totalMs: prev.totalMs + (isTerminal ? elapsed : 0),
                completedRuns: prev.completedRuns + (isTerminal ? 1 : 0),
              }
            : {
                runs: prev.runs,
                successes: prev.successes + (isSuccess ? 1 : 0),
                humanEscalations: prev.humanEscalations,
                totalMs: prev.totalMs + (isTerminal ? elapsed : 0),
                completedRuns: prev.completedRuns + (isTerminal ? 1 : 0),
              };
        saveMetrics(next);
        return next;
      });
    },
    []
  );

  // ---- Poll snapshot while the session is still moving ------------------
  const pollSnapshot = useCallback(
    (sessionId: string, attemptsLeft: number) => {
      if (attemptsLeft <= 0) return;
      pollRef.current = setTimeout(async () => {
        try {
          const snap = await api.snapshot(sessionId);
          setSnapshot(snap);
          if (snap.session.currentState === "HUMAN_REVIEW" || TERMINAL.has(snap.session.currentState)) {
            return;
          }
          pollSnapshot(sessionId, attemptsLeft - 1);
        } catch {
          /* transient poll error — stop */
        }
      }, 1200);
    },
    []
  );

  // ---- Run workflow: seed → run -----------------------------------------
  const handleRun = useCallback(async () => {
    if (!selected) return;
    stopPolling();
    setRunning(true);
    setError(null);
    setSnapshot(null);
    runStartedRef.current = Date.now();

    try {
      const seed = await api.seedScenario(selected);
      const run = await api.runSession(seed.sessionId);
      setSnapshot(run.snapshot);
      recordMetrics(run.snapshot, runStartedRef.current);

      if (!TERMINAL.has(run.snapshot.session.currentState) && run.snapshot.session.currentState !== "HUMAN_REVIEW") {
        pollSnapshot(seed.sessionId, 10);
      }
    } catch (err) {
      setError(err instanceof ApiError ? `API ${err.status}: ${err.message}` : String(err));
    } finally {
      setRunning(false);
    }
  }, [selected, stopPolling, recordMetrics, pollSnapshot]);

  // ---- Human verdict ----------------------------------------------------
  const handleVerdict = useCallback(
    async (
      verdict: "APPROVED" | "REJECTED" | "MODIFIED",
      reviewerNotes: string,
      modifiedParams?: Record<string, unknown>
    ) => {
      if (!snapshot?.pendingReview) return;
      setSubmitting(true);
      setError(null);
      try {
        const res = await api.verdict(snapshot.session.sessionId, snapshot.pendingReview.reviewId, {
          verdict,
          reviewerNotes: reviewerNotes || undefined,
          modifiedParams,
        });
        setSnapshot(res.snapshot);
        recordMetrics(res.snapshot, runStartedRef.current, "verdict");
        if (!TERMINAL.has(res.snapshot.session.currentState)) {
          pollSnapshot(res.snapshot.session.sessionId, 8);
        }
      } catch (err) {
        setError(err instanceof ApiError ? `API ${err.status}: ${err.message}` : String(err));
      } finally {
        setSubmitting(false);
      }
    },
    [snapshot, recordMetrics, pollSnapshot]
  );

  return (
    <>
      <Header health={health} environment={import.meta.env.MODE.toUpperCase()} />

      <MetricsStrip metrics={metrics} snapshot={snapshot} />

      {error && <div className="error-banner">{error}</div>}

      <ScenarioSelector
        scenarios={scenarios}
        selected={selected}
        running={running}
        onSelect={(key) => {
          setSelected(key);
          setError(null);
        }}
        onRun={handleRun}
      />

      <WorkflowPipeline snapshot={snapshot} />

      <div className="panels">
        {snapshot?.pendingReview && (
          <HumanReviewModal
            snapshot={snapshot}
            onVerdict={handleVerdict}
            busy={submitting}
          />
        )}

        <CasePanel snapshot={snapshot} />
        <AiPlannerPanel snapshot={snapshot} />
        <PolicyEnginePanel snapshot={snapshot} />
        <ExecutionAndOutcomePanel snapshot={snapshot} />
        <AuditTimeline snapshot={snapshot} />
      </div>
    </>
  );
}
