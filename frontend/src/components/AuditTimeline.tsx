import { ScrollText } from "lucide-react";
import type { SessionSnapshot } from "../api/client";

/**
 * AuditTimeline — vertical append-only list of audit entries
 * (time, stage, summary).
 */
export default function AuditTimeline({ snapshot }: { snapshot: SessionSnapshot | null }) {
  const entries = snapshot?.session.auditEntries ?? [];

  return (
    <section className="panel span-6">
      <h2>
        <ScrollText size={14} /> Audit Timeline
        <span className="badge" style={{ marginLeft: "auto" }}>
          {entries.length} entries · append-only
        </span>
      </h2>

      {entries.length === 0 ? (
        <div className="empty">No audit entries yet.</div>
      ) : (
        <ul className="timeline">
          {entries.map((entry) => (
            <li key={entry.id} className={`stage-${entry.stage}`}>
              <span className="ts">{new Date(entry.timestamp).toLocaleTimeString()}</span>
              <span className="stage">{entry.stage}</span>
              <div className="summary">{entry.decisionSummary ?? "—"}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
