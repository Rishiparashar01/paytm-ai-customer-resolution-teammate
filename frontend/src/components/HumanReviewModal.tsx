import { useState } from "react";
import { Handshake, Check, X, Pencil } from "lucide-react";
import type { HumanReview, SessionSnapshot } from "../api/client";

interface Props {
  snapshot: SessionSnapshot;
  onVerdict: (
    verdict: "APPROVED" | "REJECTED" | "MODIFIED",
    reviewerNotes: string,
    modifiedParams?: Record<string, unknown>
  ) => Promise<void>;
  busy: boolean;
}

/**
 * HumanReviewModal (inline card) — appears on REQUIRES_HUMAN.
 * Approve / Reject / Modify + reviewer notes; submits the verdict endpoint.
 */
export default function HumanReviewModal({ snapshot, onVerdict, busy }: Props) {
  const review: HumanReview | null = snapshot.pendingReview;
  const [notes, setNotes] = useState("");
  const [modifiedJson, setModifiedJson] = useState("");
  const [showModify, setShowModify] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  if (!review) return null;

  const submit = async (verdict: "APPROVED" | "REJECTED" | "MODIFIED") => {
    setLocalError(null);
    if (verdict === "MODIFIED") {
      let parsed: Record<string, unknown> = {};
      if (modifiedJson.trim()) {
        try {
          parsed = JSON.parse(modifiedJson);
        } catch {
          setLocalError("Modified params must be valid JSON.");
          return;
        }
      }
      await onVerdict(verdict, notes, parsed);
      return;
    }
    await onVerdict(verdict, notes);
  };

  return (
    <section className="human-card">
      <h2>
        <Handshake size={15} /> Human review required
      </h2>

      <div className="reason">
        <strong>{review.reason}</strong>
      </div>

      <div className="kv">
        <span className="k">Proposed tool</span>
        <span className="v tool-name">{review.proposedTool}</span>
      </div>
      <div className="kv">
        <span className="k">Proposed params</span>
        <span className="v mono" style={{ maxWidth: "70%" }}>
          {JSON.stringify(review.proposedParams)}
        </span>
      </div>
      <div className="kv">
        <span className="k">Review ID</span>
        <span className="v mono">{review.reviewId}</span>
      </div>

      <label htmlFor="reviewer-notes">Reviewer notes</label>
      <textarea
        id="reviewer-notes"
        placeholder="Why are you approving/rejecting this action?"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        disabled={busy}
      />

      {showModify && (
        <>
          <label htmlFor="modified-params">Modified params (JSON)</label>
          <textarea
            id="modified-params"
            placeholder='{"amount": 3000} or any param overrides'
            value={modifiedJson}
            onChange={(e) => setModifiedJson(e.target.value)}
            disabled={busy}
            style={{ minHeight: 74 }}
          />
        </>
      )}

      {localError && (
        <div className="error-banner" style={{ marginTop: 10 }}>
          {localError}
        </div>
      )}

      <div className="human-actions">
        <button className="approve" onClick={() => submit("APPROVED")} disabled={busy}>
          <Check size={14} style={{ verticalAlign: "-2px" }} /> Approve
        </button>
        <button className="reject" onClick={() => submit("REJECTED")} disabled={busy}>
          <X size={14} style={{ verticalAlign: "-2px" }} /> Reject
        </button>
        <button className="modify" onClick={() => setShowModify((v) => !v)} disabled={busy}>
          <Pencil size={14} style={{ verticalAlign: "-2px" }} /> Modify
        </button>
        {showModify && (
          <button className="approve" onClick={() => submit("MODIFIED")} disabled={busy}>
            Submit modification
          </button>
        )}
        {busy && (
          <span className="status-note">
            <span className="spinner" /> Submitting verdict…
          </span>
        )}
      </div>
    </section>
  );
}
