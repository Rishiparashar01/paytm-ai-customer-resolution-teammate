/**
 * Deterministic mock biller gateway.
 * Modes: DEFAULT_SUCCESS (default), BANK_DECLINE, TIMEOUT.
 *
 * The gateway is deterministic: it succeeds for every demo scenario retry
 * unless an explicit failure mode is requested. Demo failed transactions are
 * seeded with status FAILED_AT_BANK — retries succeed so scenario A/B reach
 * VERIFIED_SUCCESS (see §1 and §13).
 */

export type GatewayMode = "DEFAULT_SUCCESS" | "BANK_DECLINE" | "TIMEOUT";

export interface GatewayTxnInput {
  amount: number;
  billerOrMerchant: string;
  /** Optional explicit override, used by tests to exercise failure paths. */
  mode?: GatewayMode;
}

export interface GatewayResult {
  ok: boolean;
  mode: GatewayMode;
  acknowledgementId?: string;
  message: string;
}

export function retry(input: GatewayTxnInput): GatewayResult {
  const mode: GatewayMode = input.mode ?? "DEFAULT_SUCCESS";

  switch (mode) {
    case "TIMEOUT":
      throw new Error("BILLER_GATEWAY_TIMEOUT");
    case "BANK_DECLINE":
      return {
        ok: false,
        mode,
        message: "BANK_DECLINED",
      };
    case "DEFAULT_SUCCESS":
    default:
      return {
        ok: true,
        mode,
        acknowledgementId: `ack_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        message: "ACCEPTED_BY_BILLER",
      };
  }
}

const mockBillerGateway = { retry };
export default mockBillerGateway;
