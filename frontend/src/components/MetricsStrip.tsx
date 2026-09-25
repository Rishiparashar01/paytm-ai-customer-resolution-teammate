import { Gauge, Timer, CircleCheck, Handshake, ScrollText } from "lucide-react";
import type { SessionSnapshot } from "../api/client";

export interface SessionMetrics {
  runs: number;
  successes: number;
  humanEscalations: number;
  totalMs: number;
  completedRuns: number;
}

interface Props {
  metrics: SessionMetrics;
  snapshot: SessionSnapshot | null;
}

/**
 * MetricsStrip — Autonomy Rate, Avg Resolution Time, Success Rate,
 * Human Escalations, Audit Events.
 *
 * `metrics` already includes the current session (recorded by App when a run
 * or verdict completes), so only the audit-event count is read live from the
 * snapshot — no double counting.
 */
export default function MetricsStrip({ metrics, snapshot }: Props) {
  const runs = metrics.runs;
  const successes = metrics.successes;
  const humanEscalations = metrics.humanEscalations;

  const autonomyRate =
    runs > 0 ? Math.max(0, Math.round(((runs - humanEscalations) / runs) * 100)) : 100;
  const successRate = runs > 0 ? Math.min(100, Math.round((successes / runs) * 100)) : 0;
  const avgMs = metrics.completedRuns > 0 ? Math.round(metrics.totalMs / metrics.completedRuns) : 0;
  const auditEvents = snapshot?.session.auditEntries.length ?? 0;

  return (
    <section className="metrics-strip">
      <div className="metric">
        <div className="label">Autonomy Rate</div>
        <div className="value cyan">
          <Gauge size={16} style={{ marginRight: 6, verticalAlign: "-2px" }} />
          {autonomyRate}%
        </div>
      </div>
      <div className="metric">
        <div className="label">Avg Resolution Time</div>
        <div className="value">
          <Timer size={16} style={{ marginRight: 6, verticalAlign: "-2px" }} />
          {avgMs > 0 ? `${(avgMs / 1000).toFixed(1)}s` : "—"}
        </div>
      </div>
      <div className="metric">
        <div className="label">Success Rate</div>
        <div className="value green">
          <CircleCheck size={16} style={{ marginRight: 6, verticalAlign: "-2px" }} />
          {successRate}%
        </div>
      </div>
      <div className="metric">
        <div className="label">Human Escalations</div>
        <div className="value" style={{ color: "var(--amber)" }}>
          <Handshake size={16} style={{ marginRight: 6, verticalAlign: "-2px" }} />
          {humanEscalations}
        </div>
      </div>
      <div className="metric">
        <div className="label">Audit Events</div>
        <div className="value">
          <ScrollText size={16} style={{ marginRight: 6, verticalAlign: "-2px" }} />
          {auditEvents}
        </div>
      </div>
    </section>
  );
}
