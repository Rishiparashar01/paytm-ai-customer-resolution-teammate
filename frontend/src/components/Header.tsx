import { Activity, Bot, ShieldCheck } from "lucide-react";
import { apiBase } from "../api/client";

interface Props {
  health: "checking" | "ok" | "down";
  environment: string;
}

export default function Header({ health, environment }: Props) {
  const healthBadge =
    health === "ok" ? (
      <span className="badge ok">
        <span className="dot" /> API healthy
      </span>
    ) : health === "down" ? (
      <span className="badge err">
        <span className="dot" /> API unreachable
      </span>
    ) : (
      <span className="badge info">
        <span className="spinner" /> Checking API…
      </span>
    );

  return (
    <header className="app-header">
      <div className="brand">
        <div className="brand-mark">AI</div>
        <div>
          <h1>Paytm AI · Customer Resolution Teammate</h1>
          <div className="subtitle">
            Autonomous resolution control room · {environment} · <code className="mono">{apiBase()}</code>
          </div>
        </div>
      </div>
      <div className="header-status">
        <span className="badge info">
          <ShieldCheck size={13} /> Policy-gated
        </span>
        <span className="badge">
          <Bot size={13} /> AI planner
        </span>
        <span className="badge">
          <Activity size={13} /> Append-only audit
        </span>
        {healthBadge}
      </div>
    </header>
  );
}
