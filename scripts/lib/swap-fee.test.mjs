import assert from "node:assert/strict";
import test from "node:test";

import { feeFromInput } from "./fees.mjs";
import { validatePrivateSwapCheckpoint } from "./swap.mjs";
import { loadChainConfig } from "./config.mjs";

const BASE = {
  version: 1,
  route: "private_swap_eurc",
  tokenOut: "EURC",
  operation: {
    chainId: 5_042_002,
    unlinkAddress: "unlink1qqp4mxgu8ytq",
    tokenIn: "0x3600000000000000000000000000000000000000",
    outputToken: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
  },
  beforeBalances: { input: "400000", output: "0" },
  phaseBAttempts: [],
};

test("a fee-bearing swap checkpoint keeps the gross and net amounts apart", () => {
  const split = feeFromInput(50_000n, loadChainConfig("arc-testnet").fees.swapBps);
  const checkpoint = validatePrivateSwapCheckpoint(
    {
      ...BASE,
      operation: {
        ...BASE.operation,
        amountIn: split.net.toString(),
        grossIn: split.input.toString(),
        feeAmount: split.fee.toString(),
      },
    },
    "EURC",
  );
  assert.equal(checkpoint.operation.amountIn, "49975");
  assert.equal(checkpoint.operation.grossIn, "50000");
  assert.equal(checkpoint.operation.feeAmount, "25");
  assert.equal(
    BigInt(checkpoint.operation.amountIn) + BigInt(checkpoint.operation.feeAmount),
    BigInt(checkpoint.operation.grossIn),
  );
});

test("a pre-fee checkpoint normalizes to a zero fee and an equal gross amount", () => {
  const checkpoint = validatePrivateSwapCheckpoint(
    { ...BASE, operation: { ...BASE.operation, amountIn: "100000" } },
    "EURC",
  );
  assert.equal(checkpoint.operation.grossIn, "100000");
  assert.equal(checkpoint.operation.feeAmount, "0");
});

test("a malformed fee amount is rejected before any bigint conversion", () => {
  assert.throws(
    () =>
      validatePrivateSwapCheckpoint(
        {
          ...BASE,
          operation: { ...BASE.operation, amountIn: "50000", feeAmount: "2.5" },
        },
        "EURC",
      ),
    /operation\.feeAmount/u,
  );
  assert.throws(
    () =>
      validatePrivateSwapCheckpoint(
        {
          ...BASE,
          operation: { ...BASE.operation, amountIn: "50000", grossIn: "-1" },
        },
        "EURC",
      ),
    /operation\.grossIn/u,
  );
});

test("the Arc swap fee never exceeds the input it is taken from", () => {
  const policy = loadChainConfig("arc-testnet").fees;
  for (const input of [1_000n, 50_000n, 100_000n, 5_000_000n]) {
    const split = feeFromInput(input, policy.swapBps);
    assert.equal(split.fee + split.net, split.input);
    assert.ok(split.net > 0n);
    assert.ok(split.fee * 10_000n <= input * BigInt(policy.swapBps));
  }
});
