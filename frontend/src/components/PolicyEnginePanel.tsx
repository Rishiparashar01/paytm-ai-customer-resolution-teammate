import { ShieldCheck } from "lucide-react";
import type { SessionSnapshot, RuleResult, RuleStatus } from "../api/client";

/**
 * PolicyEnginePanel — RP_001…RP_007 rows with PASS/FAIL/REVIEW/SKIP
 * plus a final verdict banner. Derived from the latest POLICY_EVALUATED
 * audit entry for a retry_payment proposal.
 */

const RETRY_RULES: Array<{ rule: string; label: string }> = [
  { rule: "RP_001", label: "Idempotency — fresh unused key" },
  { rule: "RP_002", label: "Account state — must be ACTIVE" },
  { rule: "RP_003", label: "Transaction integrity" },
  { rule: "RP_004", label: "Retry eligibility (FAILED_AT_BANK)" },
  { rule: "RP_005", label: "Retry budget" },
  { rule: "RP_006", label: "Amount cap (₹2,000 autonomous)" },
  { rule: "RP_007", label: "Final gate" },
];

const ALL_RULES = [
  ...RETRY_RULES.map((r) => r.rule),
  "NOTIF_001",
  "NOTIF_002",
  "NOTIF_003",
  "NOTIF_004",
  "NOTIF_005",
];

export default function PolicyEnginePanel({ snapshot }: { snapshot: SessionSnapshot | null }) {
  const entries = snapshot?.session.auditEntries ?? [];

  // Prefer the most recent retry_payment policy evaluation; otherwise the
  // most recent policy evaluation of any kind.
  const policyEntries = [...entries].reverse().filter((e) => e.stage === "POLICY_EVALUATED");
  const retryEval =
    policyEntries.find(
      (e) => e.details.toolName === "retry_payment" && e.details.ruleResults !== undefined
    ) ?? policyEntries.find((e) => e.details.ruleResults !== undefined);

  const ruleResults: RuleResult[] = retryEval
    ? ((retryEval.details.ruleResults as RuleResult[] | undefined) ?? [])
    : [];
  const verdict = retryEval ? String(retryEval.details.verdict ?? "") : null;
  const ruleTriggered = retryEval ? (retryEval.details.ruleTriggered as string | null) : null;

  const isRetrySet = ruleResults.some((r) => r.rule.startsWith("RP_"));
  const rows = isRetrySet ? RETRY_RULES : ALL_RULES.filter((r) => !r.startsWith("RP_")).map((r) => ({ rule: r, label: r }));

  function statusFor(rule: string): RuleStatus | "—" {
    const found = ruleResults.find((r) => r.rule === rule);
    return found ? found.status : "—";
  }

  function detailFor(rule: string): string {
    const found = ruleResults.find((r) => r.rule === rule);
    return found ? found.detail : "Not evaluated in this run.";
  }

  return (
    <section className="panel span-6">
      <h2>
        <ShieldCheck size={14} /> Policy Engine · RP_001 – RP_007
      </h2>

      {!retryEval ? (
        <div className="empty">Policy evaluation appears here once the agent proposes an action.</div>
      ) : (
        <>
          <table className="policy-table">
            <thead>
              <tr>
                <th style={{ width: 78 }}>Rule</th>
                <th style={{ width: 74 }}>Result</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const status = statusFor(r.rule);
                return (
                  <tr key={r.rule}>
                    <td className="mono" style={{ fontWeight: 700 }}>
                      {r.rule}
                    </td>
                    <td>
                      <span className={`status-pill ${status}`}>{status}</span>
                    </td>
                    <td style={{ color: "var(--muted)" }}>{detailFor(r.rule)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {verdict && (
            <div className={`verdict-banner ${verdict}`}>
              Final verdict: {verdict}
              {ruleTriggered ? ` · rule ${ruleTriggered}` : ""}
              {retryEval ? ` · ${new Date(retryEval.timestamp).toLocaleTimeString()}` : ""}
            </div>
          )}
        </>
      )}
    </section>
  );
}
