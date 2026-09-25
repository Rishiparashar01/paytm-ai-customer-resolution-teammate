import type { SessionSnapshot } from "../api/client";

/**
 * WorkflowPipeline — 7-step horizontal state machine.
 * done = green, active = cyan pulse, blocked = red, awaiting human = amber.
 */

const STEPS = [
  { key: "INTAKE", label: "Intake" },
  { key: "GATHERING_CONTEXT", label: "Gather Context" },
  { key: "FORMULATING_PLAN", label: "AI Plan" },
  { key: "POLICY_EVALUATION", label: "Policy Gate" },
  { key: "EXECUTING_STEP", label: "Execute Tool" },
  { key: "VERIFYING_OUTCOME", label: "Verify Outcome" },
  { key: "FINAL", label: "Resolution" },
];

const NORMAL_ORDER: string[] = STEPS.slice(0, 6).map((s) => s.key);

type StepState = "todo" | "done" | "active" | "blocked" | "human";

function computeStates(snapshot: SessionSnapshot | null): StepState[] {
  const states: StepState[] = STEPS.map(() => "todo");
  if (!snapshot) return states;

  const current = snapshot.session.currentState;
  const outcome = snapshot.session.outcomeStatus;

  if (current === "HUMAN_REVIEW") {
    // Paused right after the policy gate → everything up to the gate is done,
    // execution is waiting on the supervisor (amber).
    for (let i = 0; i <= 3; i++) states[i] = "done";
    states[4] = "human";
    return states;
  }

  if (current === "RESOLVED_SUCCESS" || current === "RESOLVED_FAILURE" || current === "ESCALATED") {
    for (let i = 0; i <= 5; i++) states[i] = "done";
    states[6] = outcome === "VERIFIED_SUCCESS" ? "done" : "blocked";
    return states;
  }

  const idx = NORMAL_ORDER.indexOf(current);
  if (idx >= 0) {
    for (let i = 0; i < idx; i++) states[i] = "done";
    states[idx] = "active";
  } else if (current === "GATHERING_CONTEXT") {
    states[0] = "done";
    states[1] = "active";
  }
  return states;
}

export default function WorkflowPipeline({ snapshot }: { snapshot: SessionSnapshot | null }) {
  const states = computeStates(snapshot);

  return (
    <section className="pipeline" aria-label="Workflow pipeline">
      {STEPS.map((step, i) => {
        const state = states[i];
        const cls =
          state === "done"
            ? "done"
            : state === "active"
              ? "active"
              : state === "blocked"
                ? "blocked"
                : state === "human"
                  ? "human"
                  : "";
        return (
          <div key={step.key} className={`pipe-step ${cls}`}>
            <div className="idx">0{i + 1}</div>
            <div className="name">{step.label}</div>
          </div>
        );
      })}
    </section>
  );
}
