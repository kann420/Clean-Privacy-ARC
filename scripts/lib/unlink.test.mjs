import assert from "node:assert/strict";
import test from "node:test";

import {
  FEE_APP_ID,
  RECIPIENT_APP_ID,
  SENDER_APP_ID,
  assertProcessedTransaction,
  assertUnlinkEnvironment,
  reconcilePrivateOperation,
  selectApiKey,
} from "./unlink.mjs";

const ARC_CONFIG = { unlinkEnvironment: "arc-testnet", chainId: 5_042_002 };
const TOKEN = "0x3600000000000000000000000000000000000000";

test("app identifiers are the permanent Arc derivation constants", () => {
  assert.equal(SENDER_APP_ID, "clean-privacy-arc");
  assert.equal(RECIPIENT_APP_ID, "clean-privacy-arc-recipient");
  assert.equal(FEE_APP_ID, "clean-privacy-arc-fees");
  assert.equal(
    new Set([SENDER_APP_ID, RECIPIENT_APP_ID, FEE_APP_ID]).size,
    3,
    "each app id must derive a distinct private account",
  );
});

test("environment assertion accepts exact and suffixed hosted names", () => {
  assert.deepEqual(
    assertUnlinkEnvironment(
      { name: "arc-testnet", chain_id: 5_042_002 },
      ARC_CONFIG,
    ),
    { name: "arc-testnet", chain_id: 5_042_002 },
  );
  assert.deepEqual(
    assertUnlinkEnvironment(
      { name: "arc-testnet-production", chain_id: 5_042_002 },
      ARC_CONFIG,
    ),
    { name: "arc-testnet-production", chain_id: 5_042_002 },
  );
});

test("environment assertion rejects mismatches", () => {
  assert.throws(() =>
    assertUnlinkEnvironment(
      { name: "arc-testnet", chain_id: 10_143 },
      ARC_CONFIG,
    ),
  );
  assert.throws(() =>
    assertUnlinkEnvironment(
      { name: "monad-testnet", chain_id: 5_042_002 },
      ARC_CONFIG,
    ),
  );
  assert.throws(() =>
    assertUnlinkEnvironment(
      { name: "arc-testnetproduction", chain_id: 5_042_002 },
      ARC_CONFIG,
    ),
  );
});

test("API key selection prefers the chain-specific variable", () => {
  assert.equal(
    selectApiKey(
      { UNLINK_API_KEY_ARC_TESTNET: "specific", UNLINK_API_KEY: "generic" },
      "arc-testnet",
    ),
    "specific",
  );
  assert.equal(
    selectApiKey({ UNLINK_API_KEY: "generic" }, "arc-testnet"),
    "generic",
  );
  assert.throws(
    () => selectApiKey({}, "arc-testnet"),
    /UNLINK_API_KEY_ARC_TESTNET or UNLINK_API_KEY/u,
  );
});

test("processed assertions require full terminal status", () => {
  assert.doesNotThrow(() =>
    assertProcessedTransaction(
      {
        status: "processed",
        confirmationStatus: "processed",
        fundsUsable: true,
      },
      "unit",
    ),
  );
  assert.throws(() =>
    assertProcessedTransaction(
      { status: "accepted", confirmationStatus: "processed", fundsUsable: true },
      "unit",
    ),
  );
  assert.throws(() =>
    assertProcessedTransaction(
      { status: "processed", confirmationStatus: "pending", fundsUsable: true },
      "unit",
    ),
  );
  assert.throws(() =>
    assertProcessedTransaction(
      {
        status: "processed",
        confirmationStatus: "processed",
        fundsUsable: false,
      },
      "unit",
    ),
  );
});

test("withdraw reconciliation matches the observed no-recipient history shape", async () => {
  const transaction = {
    id: "tx-withdraw",
    type: "withdraw",
    token: TOKEN.toLowerCase(),
    amount: "20",
    status: "processed",
  };
  const result = await reconcilePrivateOperation({
    client: {
      async getBalances() {
        return {
          sync_status: "current",
          balances: [{ token: TOKEN, amount: "80" }],
        };
      },
      async getTransactions() {
        return { transactions: [transaction] };
      },
    },
    type: "withdraw",
    token: TOKEN,
    amount: "20",
    beforeBalance: "100",
    expectedDelta: -20n,
  });

  assert.equal(result.transaction, transaction);
  assert.equal(result.delta, -20n);
});
