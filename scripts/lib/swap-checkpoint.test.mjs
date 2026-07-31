import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPrivateSwapState } from "./swap-checkpoint.mjs";

const usdc = "0x3600000000000000000000000000000000000000";
const eurc = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";
const account = "0x1111111111111111111111111111111111111111";

function createState() {
  const directory = mkdtempSync(join(tmpdir(), "arc-swap-state-"));
  return createPrivateSwapState({
    chainKey: "arc-testnet",
    tokenOut: "EURC",
    target: join(directory, "checkpoint.json"),
  });
}

function initialize(state) {
  state.initialize({
    operation: {
      chainId: 5_042_002,
      unlinkAddress: "unlink1qqqqqqqq",
      amountIn: "100000",
      tokenIn: usdc,
      outputToken: eurc,
    },
    beforeBalances: { input: "500000", output: "500000" },
  });
}

const accepted = {
  executionId: "exec_a",
  withdrawalTxIds: ["withdraw_a"],
  status: "prepared",
  accountIndices: { tenantIdx: 1, chainIdx: 2, accountIdx: 3 },
  accountAddress: account,
};

test("accepted ID is durable before signatures or submit payload", () => {
  const state = createState();
  initialize(state);
  state.persistAccepted("phase_a", accepted);
  const loaded = state.read();
  assert.equal(loaded.phaseA.executionId, "exec_a");
  assert.equal(loaded.phaseA.recovery, null);
  assert.match(readFileSync(state.target, "utf8"), /exec_a/u);
});

test("rerun cannot append a second Phase A execution", () => {
  const state = createState();
  initialize(state);
  state.persistAccepted("phase_a", accepted);
  assert.throws(
    () =>
      state.persistAccepted("phase_a", {
        ...accepted,
        executionId: "exec_duplicate",
      }),
    /already persisted/u,
  );
  assert.equal(state.read().phaseA.executionId, "exec_a");
});

test("terminal reverted Phase A is archived before one safe replacement", () => {
  const state = createState();
  initialize(state);
  state.persistAccepted("phase_a", accepted);
  assert.throws(
    () => state.archiveTerminalPhaseA("exec_a"),
    /terminal reverted/u,
  );
  state.persistStatus(
    "phase_a",
    "user_op_reverted",
    "exec_a",
    { confirmation_status: "failed", handle_ops_tx_hash: "0xabc" },
  );
  state.archiveTerminalPhaseA("exec_a");
  assert.equal(state.read().phaseA, null);
  assert.equal(state.read().phaseAFailures.length, 1);
  assert.equal(state.read().phaseAFailures[0].executionId, "exec_a");
  state.persistAccepted("phase_a", {
    ...accepted,
    executionId: "exec_retry",
  });
  assert.equal(state.read().phaseA.executionId, "exec_retry");
  assert.equal(state.read().phaseAFailures.length, 1);
});

test("recovery signature payload stays local and follows the same ID", () => {
  const state = createState();
  initialize(state);
  state.persistAccepted("phase_a", accepted);
  state.persistRecovery("phase_a", {
    executionId: "exec_a",
    withdrawalSignatures: ["0xsensitive-local-signature"],
  });
  assert.deepEqual(state.read().phaseA.recovery.withdrawalSignatures, [
    "0xsensitive-local-signature",
  ]);
  assert.throws(
    () =>
      state.persistRecovery("phase_a", {
        executionId: "exec_other",
        withdrawalSignatures: [],
      }),
    /persisted execution/u,
  );
});

test("Phase B attempts append deterministically and verifiedAt is one-way", () => {
  const state = createState();
  initialize(state);
  state.persistAccepted("phase_a", accepted);
  state.persistAccepted(
    "phase_b",
    {
      ...accepted,
      executionId: "exec_b",
      withdrawalTxIds: [],
    },
    0,
  );
  assert.equal(state.read().phaseBAttempts.length, 1);
  state.markVerified();
  assert.ok(state.read().verifiedAt);
  assert.throws(() => state.markVerified(), /already verified/u);
});

test("recovery-created attempts carry the origin marker", () => {
  const state = createState();
  initialize(state);
  state.persistAccepted("phase_a", accepted);
  state.callbacks("phase_b", 0, "recovery").onAccepted({
    ...accepted,
    executionId: "exec_recovery",
    withdrawalTxIds: [],
  });
  const loaded = state.read();
  assert.equal(loaded.phaseA.origin, null);
  assert.equal(loaded.phaseBAttempts[0].origin, "recovery");
});

test("crash boundary after evidence but before verifiedAt remains resumable", () => {
  const state = createState();
  initialize(state);
  state.persistAccepted("phase_a", accepted);
  state.persistStatus(
    "phase_a",
    "completed",
    "exec_a",
    { confirmation_status: "processed", handle_ops_tx_hash: "0xabc" },
  );
  const loaded = state.read();
  assert.equal(loaded.phaseA.confirmationStatus, "processed");
  assert.equal(loaded.verifiedAt, null);
});
