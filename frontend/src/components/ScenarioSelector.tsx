import { Play, Loader2 } from "lucide-react";
import type { ScenarioDescriptor } from "../api/client";

interface Props {
  scenarios: ScenarioDescriptor[];
  selected: string | null;
  running: boolean;
  onSelect: (key: string) => void;
  onRun: () => void;
}

export default function ScenarioSelector({ scenarios, selected, running, onSelect, onRun }: Props) {
  return (
    <>
      <section className="scenarios">
        {scenarios.length === 0 && (
          <div className="scenario-card" style={{ cursor: "default" }}>
            <p>Loading scenarios…</p>
          </div>
        )}
        {scenarios.map((s) => (
          <button
            key={s.scenario}
            className={`scenario-card ${selected === s.scenario ? "selected" : ""}`}
            onClick={() => onSelect(s.scenario)}
            disabled={running}
          >
            <span className="key">{s.scenario}</span>
            <h3>{s.title}</h3>
            <p>{s.description}</p>
            <div className="expected">Expected → {s.expectedOutcome}</div>
          </button>
        ))}
      </section>

      <div className="run-row">
        <button className="primary" onClick={onRun} disabled={!selected || running}>
          {running ? <Loader2 size={16} className="spinner" /> : <Play size={16} />}
          {running ? "Running workflow…" : "Run Workflow"}
        </button>
        {selected && !running && (
          <span className="status-note">
            Seeds fresh synthetic data, then drives the orchestrator state machine end-to-end.
          </span>
        )}
      </div>
    </>
  );
}
