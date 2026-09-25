import { User, Wallet, Receipt, Fingerprint } from "lucide-react";
import type { SessionSnapshot } from "../api/client";

/**
 * CasePanel — customer, account status, target transaction, session ID.
 */
export default function CasePanel({ snapshot }: { snapshot: SessionSnapshot | null }) {
  if (!snapshot) {
    return (
      <section className="panel span-6">
        <h2>
          <User size={14} /> Case
        </h2>
        <div className="empty">Select a scenario and run the workflow to load a case.</div>
      </section>
    );
  }

  const { session, targetTransaction } = snapshot;
  const customer = session.customer;
  const accountClass =
    customer.accountStatus === "ACTIVE" ? "ok" : customer.accountStatus === "FROZEN" ? "err" : "warn";

  return (
    <section className="panel span-6">
      <h2>
        <User size={14} /> Case
      </h2>

      <div className="kv">
        <span className="k">Customer</span>
        <span className="v">{customer.name}</span>
      </div>
      <div className="kv">
        <span className="k">Phone</span>
        <span className="v mono">{customer.phone}</span>
      </div>
      <div className="kv">
        <span className="k">Account status</span>
        <span className="v">
          <span className={`badge ${accountClass}`}>{customer.accountStatus}</span>
        </span>
      </div>
      <div className="kv">
        <span className="k">
          <Wallet size={12} style={{ verticalAlign: "-2px" }} /> Balance
        </span>
        <span className="v">₹{customer.syntheticBalance.toLocaleString("en-IN")}</span>
      </div>

      <h2 style={{ marginTop: 16 }}>
        <Receipt size={14} /> Target transaction
      </h2>
      {targetTransaction ? (
        <>
          <div className="kv">
            <span className="k">Amount</span>
            <span className="v">₹{targetTransaction.amount.toLocaleString("en-IN")}</span>
          </div>
          <div className="kv">
            <span className="k">Biller / merchant</span>
            <span className="v">{targetTransaction.billerOrMerchant}</span>
          </div>
          <div className="kv">
            <span className="k">Status</span>
            <span className="v">
              <span
                className={`badge ${targetTransaction.status === "SUCCESS" ? "ok" : targetTransaction.status === "FAILED_AT_BANK" ? "err" : "warn"}`}
              >
                {targetTransaction.status}
              </span>
            </span>
          </div>
          {targetTransaction.failureReason && (
            <div className="kv">
              <span className="k">Failure reason</span>
              <span className="v mono" style={{ color: "var(--red)" }}>
                {targetTransaction.failureReason}
              </span>
            </div>
          )}
        </>
      ) : (
        <div className="empty">No target transaction.</div>
      )}

      <div className="kv" style={{ marginTop: 10 }}>
        <span className="k">
          <Fingerprint size={12} style={{ verticalAlign: "-2px" }} /> Session ID
        </span>
        <span className="v mono">{session.sessionId}</span>
      </div>
      <div className="kv">
        <span className="k">Objective</span>
        <span className="v" style={{ fontWeight: 500, maxWidth: "65%" }}>
          {session.statedObjective}
        </span>
      </div>
    </section>
  );
}
