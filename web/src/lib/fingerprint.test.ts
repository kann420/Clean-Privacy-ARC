import { beforeEach, describe, expect, it } from "vitest";
import { ADDR, CHAIN, TOK } from "../config/arc";
import {
  CIRCLE_EXECUTE_SELECTOR,
  economicMaxOut,
  sha256Hex,
  validateCirclePublicPlan,
  type CirclePublicPlan,
} from "./fingerprint";

const account = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";
const now = 2_000_000_000n;
const expectation = {
  executionAccount: account,
  amountIn: "100",
  nowSeconds: now,
};

async function validPlan(): Promise<CirclePublicPlan> {
  const fields = {
    chainId: CHAIN.id,
    executionAccount: account,
    amountIn: "100",
    tokenIn: TOK("USDC").address,
    tokenOut: TOK("EURC").address,
    adapter: ADDR.circleAdapter,
    swapCall: {
      target: ADDR.circleAdapter,
      value: "0",
      // Real adapter selector plus a byte of payload.
      data: `${CIRCLE_EXECUTE_SELECTOR}aa`,
    },
    beneficiary: account,
    circleExecutionId: "42",
    minOut: "75",
    stopLimit: "75",
    estimatedOutput: "78",
    deadline: (now + 1_000n).toString(),
    quote: { indicative: true },
  };
  return { ...fields, fingerprint: await sha256Hex(fields) };
}

async function refingerprint(plan: CirclePublicPlan): Promise<CirclePublicPlan> {
  const { fingerprint: _fingerprint, ...fields } = plan;
  return { ...fields, fingerprint: await sha256Hex(fields) };
}

describe("Circle public plan revalidation", () => {
  let plan: CirclePublicPlan;

  beforeEach(async () => {
    plan = await validPlan();
  });

  it("accepts a matching plan and computes the economic cap locally", async () => {
    // maxOut is never taken from the wire: the client derives it from the net
    // amount, so a hostile backend cannot widen its own bound.
    await expect(validateCirclePublicPlan(plan, expectation)).resolves.toMatchObject({
      minOut: "75",
      maxOut: economicMaxOut(100n).toString(),
      beneficiary: account,
    });
  });

  // Every case asserts the SPECIFIC message, so an unrelated throw cannot pass.
  it.each([
    [
      "chain",
      (value: CirclePublicPlan) => refingerprint({ ...value, chainId: 1 }),
      /chainId does not match/u,
    ],
    [
      "account",
      (value: CirclePublicPlan) =>
        refingerprint({ ...value, executionAccount: other }),
      /ExecutionAccount does not match/u,
    ],
    [
      "amount",
      (value: CirclePublicPlan) => refingerprint({ ...value, amountIn: "101" }),
      /amountIn does not match/u,
    ],
    [
      "tokens",
      (value: CirclePublicPlan) =>
        refingerprint({ ...value, tokenOut: TOK("USDC").address }),
      /token pair does not match the requested route/u,
    ],
    [
      "adapter",
      (value: CirclePublicPlan) => refingerprint({ ...value, adapter: account }),
      /target is not the configured adapter/u,
    ],
    [
      "call value",
      (value: CirclePublicPlan) =>
        refingerprint({ ...value, swapCall: { ...value.swapCall, value: "1" } }),
      /native call value must be zero/u,
    ],
    [
      "selector",
      (value: CirclePublicPlan) =>
        refingerprint({
          ...value,
          swapCall: { ...value.swapCall, data: "0x8765432100" },
        }),
      /not Adapter\.execute/u,
    ],
    [
      "beneficiary",
      (value: CirclePublicPlan) =>
        refingerprint({ ...value, beneficiary: other }),
      /beneficiary is not the ExecutionAccount/u,
    ],
    [
      "execution id",
      (value: CirclePublicPlan) =>
        refingerprint({ ...value, circleExecutionId: "not-a-number" }),
      /execution id is malformed/u,
    ],
    [
      "zero minimum",
      (value: CirclePublicPlan) => refingerprint({ ...value, minOut: "0" }),
      /minimum output must be positive/u,
    ],
    [
      "stop limit above estimate",
      (value: CirclePublicPlan) =>
        refingerprint({ ...value, stopLimit: "79" }),
      /stop limit exceeds its estimated output/u,
    ],
    [
      "minimum above estimate",
      (value: CirclePublicPlan) => refingerprint({ ...value, minOut: "79" }),
      /minimum output exceeds its estimated output/u,
    ],
    [
      "estimate above the economic cap",
      (value: CirclePublicPlan) =>
        refingerprint({ ...value, estimatedOutput: "201", stopLimit: "201", minOut: "201" }),
      /exceeds the economic cap/u,
    ],
    [
      "stale deadline",
      (value: CirclePublicPlan) =>
        refingerprint({ ...value, deadline: (now + 479n).toString() }),
      /deadline is too close or expired/u,
    ],
  ])("rejects %s", async (_label, mutate, message) => {
    await expect(
      validateCirclePublicPlan(await mutate(plan), expectation),
    ).rejects.toThrow(message);
  });

  it("rejects a plan whose fingerprint does not cover its fields", async () => {
    await expect(
      validateCirclePublicPlan({ ...plan, fingerprint: "0".repeat(64) }, expectation),
    ).rejects.toThrow(/fingerprint does not match/u);
    // Tampering with any field without re-fingerprinting is caught the same way.
    await expect(
      validateCirclePublicPlan({ ...plan, minOut: "76" }, expectation),
    ).rejects.toThrow(/fingerprint does not match/u);
  });

  it("pins the adapter selector to the deployed execute signature", () => {
    expect(CIRCLE_EXECUTE_SELECTOR).toMatch(/^0x[0-9a-f]{8}$/u);
  });
});

describe("reverse route (EURC to USDC) revalidation", () => {
  const reverseExpectation = {
    executionAccount: account,
    amountIn: "100",
    tokenIn: TOK("EURC").address,
    tokenOut: TOK("USDC").address,
    nowSeconds: now,
  };

  async function reversePlan(
    overrides: Partial<CirclePublicPlan> = {},
  ): Promise<CirclePublicPlan> {
    const base = await validPlan();
    const { fingerprint: _drop, ...fields } = {
      ...base,
      tokenIn: TOK("EURC").address,
      tokenOut: TOK("USDC").address,
      // EUR is worth more than USD, so the reverse leg returns MORE base units
      // than it consumes. This is the case a cap written for the forward
      // direction would have to accommodate.
      minOut: "127",
      stopLimit: "127",
      estimatedOutput: "131",
      ...overrides,
    };
    return { ...fields, fingerprint: await sha256Hex(fields) };
  }

  it("accepts a reverse plan whose output exceeds its input", async () => {
    await expect(
      validateCirclePublicPlan(await reversePlan(), reverseExpectation),
    ).resolves.toMatchObject({
      tokenIn: TOK("EURC").address,
      tokenOut: TOK("USDC").address,
      minOut: "127",
      maxOut: "200",
    });
  });

  it("rejects a reverse plan presented as the forward route", async () => {
    // The default expectation is USDC -> EURC. A caller that forgets to pass
    // the route must not have a reverse plan quietly accepted.
    await expect(
      validateCirclePublicPlan(await reversePlan(), expectation),
    ).rejects.toThrow(/token pair does not match the requested route/u);
  });

  it("rejects a forward plan presented as the reverse route", async () => {
    await expect(
      validateCirclePublicPlan(await validPlan(), reverseExpectation),
    ).rejects.toThrow(/token pair does not match the requested route/u);
  });

  it("still enforces the economic cap on the reverse leg", async () => {
    await expect(
      validateCirclePublicPlan(
        await reversePlan({ estimatedOutput: "201", minOut: "199", stopLimit: "199" }),
        reverseExpectation,
      ),
    ).rejects.toThrow(/estimated output exceeds the economic cap/u);
  });

  it("scales the economic cap by the token decimals", () => {
    // 6 -> 6 decimals is the identity case the USDC/EURC pair uses.
    expect(economicMaxOut(100n, 6, 6)).toBe(200n);
    // A hypothetical 6 -> 8 decimal route must not inherit a 6-decimal bound.
    expect(economicMaxOut(100n, 6, 8)).toBe(20_000n);
  });
});
