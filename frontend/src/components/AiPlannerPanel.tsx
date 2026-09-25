import { Sparkles } from "lucide-react";
import type { SessionSnapshot } from "../api/client";

/**
 * AiPlannerPanel — proposed tool + reasoning + context chips,
 * derived from the latest PLAN_PROPOSED audit entry.
 */
export default function AiPlannerPanel({ snapshot }: { snapshot: SessionSnapshot | null }) {
  const entries = snapshot?.session.auditEntries ?? [];
  const plan = [...entries].reverse().find((e) => e.stage === "PLAN_PROPOSED");

  return (
    <section className="panel span-6">
      <h2>
        <Sparkles size={14} /> AI Planner
      </h2>

      {!plan ? (
        <div className="empty">No plan proposed yet — the planner runs after context gathering.</div>
      ) : (
        <>
          <div className="kv">
            <span className="k">Proposed tool</span>
            <span className="v tool-name">{String(plan.details.toolName ?? "—")}</span>
          </div>
          <div className="kv">
            <span className="k">Planner</span>
            <span className="v">
              <span className={`badge ${plan.details.planner === "gemini" ? "info" : ""}`}>
                {String(plan.details.planner ?? "offline")} planner
              </span>
            </span>
          </div>

          <div className="reasoning">
            <strong style={{ color: "var(--cyan)" }}>Reasoning:</strong>{" "}
            {String(plan.details.reasoning ?? plan.decisionSummary ?? "—")}
          </div>

          <div className="chips" aria-label="Planner context">
            {Object.entries((plan.details.params ?? {}) as Record<string, unknown>).map(([k, v]) => (
              <span className="chip" key={k}>
                {k}={String(v).slice(0, 42)}
              </span>
            ))}
            <span className="chip">hasRetryInTrace={String(plan.contextReferences?.hasRetryInTrace ?? "—")}</span>
            <span className="chip">planner={String(plan.details.planner ?? "offline")}</span>
          </div>

          <div className="kv" style={{ marginTop: 10 }}>
            <span className="k">Timestamp</span>
            <span className="v mono">{new Date(plan.timestamp).toLocaleTimeString()}</span>
          </div>
        </>
      )}
    </section>
  );
}
