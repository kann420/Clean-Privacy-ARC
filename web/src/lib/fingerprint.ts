import { getAddress, toFunctionSelector } from "viem";
import { ADDR, CHAIN, TOK, TOKENS } from "../config/arc";

/**
 * The public projection of a captured Circle plan. Every field here is decoded
 * from the real adapter calldata or taken from the Circle estimate; the backend
 * never echoes a request field back as verified data, because a client check
 * against its own input proves nothing.
 *
 * Two values are deliberately absent from the wire and computed locally
 * instead: the adapter selector (a protocol constant) and the economic
 * `maxOut` cap (a pure function of the net amount).
 */
export type CirclePublicPlan = {
  chainId: number;
  executionAccount: string;
  amountIn: string;
  tokenIn: string;
  tokenOut: string;
  adapter: string;
  swapCall: { target: string; value: string; data: string };
  /** Decoded EURC beneficiary from the adapter calldata. */
  beneficiary: string;
  circleExecutionId: string;
  /** Decoded on-chain minimum output. */
  minOut: string;
  /** Economic floor from the Circle estimate, base units. */
  stopLimit: string;
  /** Circle's expected output, base units. */
  estimatedOutput: string;
  deadline: string;
  fingerprint: string;
  quote: unknown;
};

/** `Adapter.execute(params, tokenInputs, signature)` — the only call we submit. */
export const CIRCLE_EXECUTE_SELECTOR = toFunctionSelector(
  "execute(((address,bytes,uint256,address,uint256,address,uint256)[],(address,address)[],uint256,uint256,bytes),(uint8,address,uint256,bytes)[],bytes)",
);

/**
 * The output can never plausibly exceed twice the input; mirrors the CLI cap.
 *
 * The 2x headroom is a value bound, so it has to be rescaled when the input and
 * output tokens carry different decimals — otherwise the cap silently means
 * something else on a route whose output token is not 6-decimal. Same-decimal
 * routes (USDC/EURC, both directions) are unaffected.
 */
export const economicMaxOut = (
  netUnits: bigint,
  inDecimals = 6,
  outDecimals = 6,
): bigint =>
  (netUnits * 2n * 10n ** BigInt(outDecimals)) / 10n ** BigInt(inDecimals);

function canonical(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

export async function sha256Hex(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function sameAddress(left: string, right: string): boolean {
  try {
    return getAddress(left) === getAddress(right);
  } catch {
    return false;
  }
}

/** Registry decimals for a token address; unknown addresses fall back to 6. */
function decimalsForAddress(address: string): number {
  return (
    TOKENS.find((token) => sameAddress(token.address, address))?.dec ?? 6
  );
}

export type PlanExpectation = {
  executionAccount: string;
  amountIn: string;
  /** Route input/output token addresses. Default to the USDC -> EURC route. */
  tokenIn?: string;
  tokenOut?: string;
  nowSeconds?: bigint;
};

/** Bounds a validated plan carries into Phase B. */
export type ValidatedPlan = CirclePublicPlan & { maxOut: string };

export async function validateCirclePublicPlan(
  plan: CirclePublicPlan,
  expected: PlanExpectation,
): Promise<ValidatedPlan> {
  if (plan.chainId !== CHAIN.id) {
    throw new Error("Circle plan chainId does not match Arc Testnet");
  }
  if (!sameAddress(plan.executionAccount, expected.executionAccount)) {
    throw new Error("Circle plan ExecutionAccount does not match Phase A");
  }
  if (plan.amountIn !== expected.amountIn) {
    throw new Error("Circle plan amountIn does not match the journal");
  }
  const expectedTokenIn = expected.tokenIn ?? TOK("USDC").address;
  const expectedTokenOut = expected.tokenOut ?? TOK("EURC").address;
  if (
    !sameAddress(plan.tokenIn, expectedTokenIn) ||
    !sameAddress(plan.tokenOut, expectedTokenOut)
  ) {
    throw new Error("Circle plan token pair does not match the requested route");
  }
  if (
    !sameAddress(plan.adapter, ADDR.circleAdapter) ||
    !sameAddress(plan.swapCall.target, ADDR.circleAdapter)
  ) {
    throw new Error("Circle plan target is not the configured adapter");
  }
  if (plan.swapCall.value !== "0") {
    throw new Error("Circle plan native call value must be zero");
  }
  // Compared against the protocol constant, not against a server-supplied
  // selector derived from this same calldata.
  if (
    plan.swapCall.data.slice(0, 10).toLowerCase() !==
    CIRCLE_EXECUTE_SELECTOR.toLowerCase()
  ) {
    throw new Error("Circle plan calldata is not Adapter.execute");
  }
  // Decoded beneficiary: the swap output must land back in our own account.
  if (!sameAddress(plan.beneficiary, expected.executionAccount)) {
    throw new Error("Circle plan beneficiary is not the ExecutionAccount");
  }
  if (!/^\d+$/u.test(plan.circleExecutionId)) {
    throw new Error("Circle plan execution id is malformed");
  }

  const minOut = BigInt(plan.minOut);
  const stopLimit = BigInt(plan.stopLimit);
  const estimatedOutput = BigInt(plan.estimatedOutput);
  const net = BigInt(expected.amountIn);
  const maxOut = economicMaxOut(
    net,
    decimalsForAddress(expectedTokenIn),
    decimalsForAddress(expectedTokenOut),
  );
  if (minOut <= 0n) {
    throw new Error("Circle plan minimum output must be positive");
  }
  // Cross-source consistency: the decoded on-chain minimum, the quoted floor,
  // and the quoted estimate come from different places and must agree.
  if (stopLimit <= 0n || estimatedOutput <= 0n) {
    throw new Error("Circle plan quote bounds must be positive");
  }
  if (stopLimit > estimatedOutput) {
    throw new Error("Circle plan stop limit exceeds its estimated output");
  }
  if (minOut > estimatedOutput) {
    throw new Error("Circle plan minimum output exceeds its estimated output");
  }
  if (estimatedOutput > maxOut) {
    throw new Error("Circle plan estimated output exceeds the economic cap");
  }

  const now = expected.nowSeconds ?? BigInt(Math.floor(Date.now() / 1_000));
  if (BigInt(plan.deadline) - now < 480n) {
    throw new Error("Circle plan deadline is too close or expired");
  }
  const { fingerprint, ...withoutFingerprint } = plan;
  if ((await sha256Hex(withoutFingerprint)) !== fingerprint) {
    throw new Error("Circle plan fingerprint does not match its public fields");
  }
  return Object.freeze({
    ...plan,
    maxOut: maxOut.toString(),
    swapCall: Object.freeze({ ...plan.swapCall }),
  });
}
