import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMiniDexMargin,
  assertPairInvariant,
  decideExecutionRecovery,
  getUniswapV2AmountOut,
  resolveSwapEntryGate,
  sortPairTokens,
  validatePrivateSwapCheckpoint,
} from "./swap.mjs";

const usdc = "0x3600000000000000000000000000000000000000";
const cirbtc = "0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF";
const account = "0x1111111111111111111111111111111111111111";

function execution(status = "prepared") {
  return {
    executionId: "exec_1",
    withdrawalTxIds: ["tx_1"],
    status,
    confirmationStatus: null,
    stage: "accepted",
    accountIndices: { tenantIdx: 1, chainIdx: 2, accountIdx: 3 },
    accountAddress: account,
    handleOpsTxHash: null,
    acceptedAt: "2026-07-29T12:00:00.000Z",
    updatedAt: "2026-07-29T12:00:00.000Z",
    terminalAt: null,
    recovery: null,
  };
}

function checkpoint() {
  return {
    version: 1,
    route: "private_swap_cirbtc",
    tokenOut: "cirBTC",
    operation: {
      chainId: 5_042_002,
      unlinkAddress: "unlink1qqqqqqqq",
      amountIn: "100000",
      tokenIn: usdc,
      outputToken: cirbtc,
      createdAt: "2026-07-29T12:00:00.000Z",
    },
    beforeBalances: { input: "500000", output: "5000" },
    phaseA: execution(),
    phaseBAttempts: [],
    quoteFingerprint: null,
    reserveSnapshot: {
      reserve0: "5000000",
      reserve1: "5000",
      blockNumber: "123",
    },
    deterministicOutput: "94",
    verifiedAt: null,
  };
}

test("Uniswap quote applies 997/1000 fee and exact 3 percent margin", () => {
  const quote = getUniswapV2AmountOut(100_000n, 5_000_000n, 5_000n);
  assert.equal(quote, 97n);
  assert.equal(applyMiniDexMargin(quote), 94n);
});

test("pair ordering is deterministic and rejects identical tokens", () => {
  assert.deepEqual(sortPairTokens(cirbtc, usdc), [
    "0x3600000000000000000000000000000000000000",
    "0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF",
  ]);
  assert.throws(() => sortPairTokens(usdc, usdc), /different/u);
});

test("pair invariant accepts growth and rejects a decrease", () => {
  assert.doesNotThrow(() =>
    assertPairInvariant({
      reserve0Before: 5_000_000n,
      reserve1Before: 5_000n,
      reserve0After: 5_100_000n,
      reserve1After: 4_906n,
    }),
  );
  assert.throws(
    () =>
      assertPairInvariant({
        reserve0Before: 5_000_000n,
        reserve1Before: 5_000n,
        reserve0After: 5_100_000n,
        reserve1After: 4_000n,
      }),
    /invariant/u,
  );
});

test("checkpoint validation happens before any numeric BigInt conversion", () => {
  const valid = validatePrivateSwapCheckpoint(checkpoint(), "cirBTC");
  assert.equal(valid.operation.amountIn, "100000");

  const malformed = checkpoint();
  malformed.operation.amountIn = "1e5";
  assert.throws(
    () => validatePrivateSwapCheckpoint(malformed, "cirBTC"),
    /integer string/u,
  );

  const wrongRoute = checkpoint();
  assert.throws(
    () => validatePrivateSwapCheckpoint(wrongRoute, "EURC"),
    /route/u,
  );
});

test("recovery always polls an accepted non-terminal execution", () => {
  assert.deepEqual(decideExecutionRecovery(execution("prepared")), {
    action: "poll_existing",
    executionId: "exec_1",
  });
  assert.deepEqual(decideExecutionRecovery(execution("submitted")), {
    action: "poll_existing",
    executionId: "exec_1",
  });
});

test("terminal failures require balance disambiguation", () => {
  assert.deepEqual(decideExecutionRecovery(execution("user_op_reverted")), {
    action: "disambiguate_balances_before_retry",
  });
  assert.deepEqual(decideExecutionRecovery(execution("failed")), {
    action: "disambiguate_balances_before_retry",
  });
  assert.equal(
    decideExecutionRecovery(execution("manual_recovery_required")).action,
    "hard_stop",
  );
});

test("completion confirmation routes through the recovery decision table", () => {
  for (const confirmationStatus of ["processed", "confirmed"]) {
    const completed = execution("completed");
    completed.confirmationStatus = confirmationStatus;
    assert.deepEqual(decideExecutionRecovery(completed), {
      action: "verify_postconditions",
    });
  }
  for (const confirmationStatus of ["failed", null]) {
    const completed = execution("completed");
    completed.confirmationStatus = confirmationStatus;
    assert.deepEqual(decideExecutionRecovery(completed), {
      action: "disambiguate_balances_before_retry",
    });
  }
});

test("execution origin marker is optional and preserved", () => {
  const base = validatePrivateSwapCheckpoint(checkpoint(), "cirBTC");
  assert.equal(base.phaseA.origin, null);
  const marked = checkpoint();
  marked.phaseA.origin = "recovery";
  assert.equal(
    validatePrivateSwapCheckpoint(marked, "cirBTC").phaseA.origin,
    "recovery",
  );
  const invalid = checkpoint();
  invalid.phaseA.origin = 7;
  assert.throws(
    () => validatePrivateSwapCheckpoint(invalid, "cirBTC"),
    /origin/u,
  );
});

test("swap entry gate checks verified before recovered without network state", () => {
  assert.equal(
    resolveSwapEntryGate({
      verifiedAt: "2026-07-29T12:00:00.000Z",
      recoveredAt: null,
    }),
    "verified",
  );
  assert.equal(
    resolveSwapEntryGate({
      verifiedAt: null,
      recoveredAt: "2026-07-29T12:00:00.000Z",
    }),
    "recovered",
  );
  assert.equal(resolveSwapEntryGate({}), "proceed");
  assert.equal(resolveSwapEntryGate(null), "proceed");
  assert.equal(
    resolveSwapEntryGate({
      verifiedAt: "2026-07-29T12:00:00.000Z",
      recoveredAt: "2026-07-29T12:01:00.000Z",
    }),
    "verified",
  );
});
