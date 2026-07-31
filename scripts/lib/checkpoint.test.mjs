import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createCheckpointStore,
  createTransactionStatusPersister,
  reconcilePendingIntent,
  writeJsonAtomic,
} from "./checkpoint.mjs";

function withTempDir(run) {
  const directory = mkdtempSync(join(tmpdir(), "arc-checkpoint-"));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("checkpoint store round-trips and validates its shape", () => {
  withTempDir((directory) => {
    const target = join(directory, "store.json");
    const store = createCheckpointStore({
      chainKey: "arc-testnet",
      flow: "unit_test",
      target,
    });

    const initial = store.read();
    assert.deepEqual(initial, {
      version: 1,
      chainKey: "arc-testnet",
      flow: "unit_test",
      pendingIntents: {},
      executions: {},
      operations: {},
    });

    store.update((value) => {
      value.operations.deposit = { status: "prepared" };
    });
    assert.equal(store.read().operations.deposit.status, "prepared");

    const raw = JSON.parse(readFileSync(target, "utf8"));
    assert.equal(raw.chainKey, "arc-testnet");

    const mismatched = createCheckpointStore({
      chainKey: "arc-testnet",
      flow: "other_flow",
      target,
    });
    assert.throws(() => mismatched.read(), /checkpoint is invalid/u);
  });
});

test("checkpoint store rejects invalid keys and flows", () => {
  assert.throws(() =>
    createCheckpointStore({ chainKey: "Bad Key", flow: "ok" }),
  );
  assert.throws(() =>
    createCheckpointStore({ chainKey: "arc-testnet", flow: "Bad-Flow" }),
  );
});

test("atomic writes create parent directories", () => {
  withTempDir((directory) => {
    const target = join(directory, "nested", "deep", "value.json");
    writeJsonAtomic(target, { ok: true });
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { ok: true });
  });
});

test("transaction status persister records id and status", () => {
  withTempDir((directory) => {
    const store = createCheckpointStore({
      chainKey: "arc-testnet",
      flow: "unit_test",
      target: join(directory, "store.json"),
    });
    const seen = [];
    const persist = createTransactionStatusPersister({
      store,
      label: "deposit",
      onPersist: (status, txId) => seen.push([status, txId]),
    });

    persist("accepted", "tx-1");
    persist("processed", "tx-1");

    const operation = store.read().operations.deposit;
    assert.equal(operation.txId, "tx-1");
    assert.equal(operation.status, "processed");
    assert.deepEqual(seen, [
      ["accepted", "tx-1"],
      ["processed", "tx-1"],
    ]);
  });
});

test("pending intents reconcile from receipts and nonces", async () => {
  const address = "0x0000000000000000000000000000000000000001";

  const confirmed = await reconcilePendingIntent({
    intent: { nonce: 5, txHash: "0xabc", kind: "call" },
    publicClient: {
      getTransactionReceipt: async () => ({ status: "success" }),
      getTransactionCount: async () => 6,
      getCode: async () => "0x",
    },
    address,
  });
  assert.equal(confirmed.state, "confirmed");

  const reverted = await reconcilePendingIntent({
    intent: { nonce: 5, txHash: "0xabc", kind: "call" },
    publicClient: {
      getTransactionReceipt: async () => ({ status: "reverted" }),
      getTransactionCount: async () => 6,
      getCode: async () => "0x",
    },
    address,
  });
  assert.equal(reverted.state, "reverted");

  const missingReceipt = await reconcilePendingIntent({
    intent: { nonce: 5, txHash: "0xabc", kind: "call" },
    publicClient: {
      getTransactionReceipt: async () => {
        throw new Error("not found");
      },
      getTransactionCount: async () => 6,
      getCode: async () => "0x",
    },
    address,
  });
  assert.equal(missingReceipt.state, "ambiguous");

  const notBroadcast = await reconcilePendingIntent({
    intent: { nonce: 5, kind: "call" },
    publicClient: {
      getTransactionReceipt: async () => ({}),
      getTransactionCount: async () => 5,
      getCode: async () => "0x",
    },
    address,
  });
  assert.equal(notBroadcast.state, "not_broadcast");

  const stateChecked = await reconcilePendingIntent({
    intent: { nonce: 5, kind: "call" },
    publicClient: {
      getTransactionReceipt: async () => ({}),
      getTransactionCount: async () => 6,
      getCode: async () => "0x",
    },
    address,
    stateCheck: async () => true,
  });
  assert.equal(stateChecked.state, "confirmed_without_hash");

  const ambiguous = await reconcilePendingIntent({
    intent: { nonce: 5, kind: "call" },
    publicClient: {
      getTransactionReceipt: async () => ({}),
      getTransactionCount: async () => 6,
      getCode: async () => "0x",
    },
    address,
  });
  assert.equal(ambiguous.state, "ambiguous");
});
