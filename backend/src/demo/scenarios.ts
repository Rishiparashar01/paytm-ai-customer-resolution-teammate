/**
 * §13 Demo data (exact).
 */
export type ScenarioKey = "SCENARIO_A" | "SCENARIO_B" | "SCENARIO_C";

export interface ScenarioDescriptor {
  scenario: ScenarioKey;
  title: string;
  description: string;
  expectedOutcome: string;
  customer: {
    name: string;
    phone: string;
    accountStatus: "ACTIVE" | "SUSPENDED" | "FROZEN";
    syntheticBalance: number;
  };
  transaction: {
    amount: number;
    billerOrMerchant: string;
    status: "SUCCESS" | "FAILED_AT_BANK" | "PENDING_CLEARING" | "REVERSED";
    failureReason: string | null;
  };
}

export const DEMO_SCENARIOS: ScenarioDescriptor[] = [
  {
    scenario: "SCENARIO_A",
    title: "₹1,250 failed recharge (autonomous)",
    description:
      "Aarav Sharma's ₹1,250 Airtel Postpaid recharge failed at the bank while the account is ACTIVE. The agent retries fully autonomously (amount is under the ₹2,000 cap) and verifies success from the database.",
    expectedOutcome: "VERIFIED_SUCCESS — fully autonomous retry",
    customer: {
      name: "Aarav Sharma",
      phone: "+91 98XXX 41200",
      accountStatus: "ACTIVE",
      syntheticBalance: 3200,
    },
    transaction: {
      amount: 1250,
      billerOrMerchant: "Airtel Postpaid",
      status: "FAILED_AT_BANK",
      failureReason: "BANK_DECLINED_INSUFFICIENT_FUNDS",
    },
  },
  {
    scenario: "SCENARIO_B",
    title: "₹3,500 failed payment (human approval)",
    description:
      "Meera Iyer's ₹3,500 Tata Power payment exceeds the ₹2,000 autonomous cap. RP_006 pauses the run for a supervisor. On approval, the action re-enters policy with a fresh idempotency key, executes and verifies success.",
    expectedOutcome: "HUMAN_REVIEW → approved → VERIFIED_SUCCESS",
    customer: {
      name: "Meera Iyer",
      phone: "+91 98XXX 41201",
      accountStatus: "ACTIVE",
      syntheticBalance: 6500,
    },
    transaction: {
      amount: 3500,
      billerOrMerchant: "Tata Power Electricity",
      status: "FAILED_AT_BANK",
      failureReason: "BANK_DECLINED_INSUFFICIENT_FUNDS",
    },
  },
  {
    scenario: "SCENARIO_C",
    title: "FROZEN account (policy blocks)",
    description:
      "Rohan Mehta's account is FROZEN. The planner still proposes a retry, but policy rule RP_002 blocks it before any mutation. The session ends in VERIFIED_FAILURE and is escalated to human support.",
    expectedOutcome: "BLOCKED at RP_002 → VERIFIED_FAILURE (no mutation)",
    customer: {
      name: "Rohan Mehta",
      phone: "+91 98XXX 41202",
      accountStatus: "FROZEN",
      syntheticBalance: 1000,
    },
    transaction: {
      amount: 890,
      billerOrMerchant: "Mumbai Metro Card",
      status: "PENDING_CLEARING",
      failureReason: null,
    },
  },
];

export function findScenario(key: string): ScenarioDescriptor | undefined {
  return DEMO_SCENARIOS.find((s) => s.scenario === key);
}
