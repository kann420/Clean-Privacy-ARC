import assert from "node:assert/strict";
import test from "node:test";

import {
  assertBps,
  computeFeeUnits,
  describeFee,
  feeFromInput,
  feeOnTop,
  feePolicy,
} from "./fees.mjs";
import { loadChainConfig, validateChainRegistry } from "./config.mjs";

test("fee is basis points of the amount, rounded down", () => {
  // 0.05 USDC at 10 bps is exactly 50 base units.
  assert.equal(computeFeeUnits(50_000n, 10), 50n);
  // 0.05 USDC at 5 bps is exactly 25 base units.
  assert.equal(computeFeeUnits(50_000n, 5), 25n);
  // Rounding never favours the protocol: 999 * 10 / 10000 = 0.999 -> 0.
  assert.equal(computeFeeUnits(999n, 10), 0n);
  assert.equal(computeFeeUnits(1_000n, 10), 1n);
  assert.equal(computeFeeUnits(1_999n, 10), 1n);
});

test("fee math stays exact at cirBTC precision", () => {
  // 0.00005 cirBTC is 5000 base units at 8 decimals.
  assert.equal(computeFeeUnits(5_000n, 10), 5n);
  assert.equal(computeFeeUnits(4_999n, 10), 4n);
});

test("a dust amount pays no fee instead of being blocked", () => {
  const split = feeOnTop(9n, 10);
  assert.deepEqual(split, { amount: 9n, fee: 0n, total: 9n });
});

test("feeOnTop leaves the recipient amount untouched", () => {
  const split = feeOnTop(50_000n, 10);
  assert.deepEqual(split, { amount: 50_000n, fee: 50n, total: 50_050n });
});

test("feeFromInput takes the fee out of the input", () => {
  const split = feeFromInput(50_000n, 5);
  assert.deepEqual(split, { input: 50_000n, fee: 25n, net: 49_975n });
  assert.equal(split.fee + split.net, split.input);
});

test("zero amounts are rejected on both paths", () => {
  assert.throws(() => feeOnTop(0n, 10), /greater than zero/u);
  assert.throws(() => feeFromInput(0n, 5), /greater than zero/u);
});

test("non-bigint or negative amounts are rejected before any arithmetic", () => {
  assert.throws(() => computeFeeUnits(50_000, 10), /base-unit bigint/u);
  assert.throws(() => computeFeeUnits(-1n, 10), /base-unit bigint/u);
});

test("basis points are bounded so a registry typo cannot overcharge", () => {
  assert.throws(() => assertBps(101, "bps"), /between 0 and 100/u);
  assert.throws(() => assertBps(1.5, "bps"), /between 0 and 100/u);
  assert.throws(() => assertBps(-1, "bps"), /between 0 and 100/u);
  assert.equal(assertBps(0, "bps"), 0);
  assert.equal(assertBps(100, "bps"), 100);
});

test("the Arc registry carries the approved fee policy", () => {
  const policy = feePolicy(loadChainConfig("arc-testnet"));
  assert.equal(policy.transferBps, 10);
  assert.equal(policy.swapBps, 5);
  assert.equal(policy.owner, "0xD7E004CBda24E079aA3A657Ba7f8E2915192a966");
  assert.equal(
    loadChainConfig("arc-testnet").fees.collector,
    "unlink1qqvmup67xy2mezvjds0whta4xskl373qgfz9vrrz8xfesg6c7y9g5r029xeyjyzs7fp22htzqzvcjt5wf8zl9lc4pmheg2d4kt95vfr2m522uh",
  );
});

test("the registry rejects malformed fee collector addresses", () => {
  const config = structuredClone(loadChainConfig("arc-testnet"));
  delete config.network;
  delete config.chainKey;
  for (const token of Object.values(config.tokens)) delete token.symbol;
  config.fees.collector = "unlink1invalid";
  assert.throws(
    () => validateChainRegistry({ "arc-testnet": config }),
    /bech32m/u,
  );
});

test("fee descriptions format at the token's own precision", () => {
  assert.equal(
    describeFee({ fee: 50n, bps: 10, symbol: "USDC", decimals: 6 }),
    "fee 0.1% = 0.000050 USDC",
  );
  assert.equal(
    describeFee({ fee: 5n, bps: 10, symbol: "cirBTC", decimals: 8 }),
    "fee 0.1% = 0.00000005 cirBTC",
  );
  assert.equal(
    describeFee({ fee: 0n, bps: 5, symbol: "USDC", decimals: 6 }),
    "fee 0.05% rounds to zero for this amount",
  );
});
