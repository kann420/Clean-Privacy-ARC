import assert from "node:assert/strict";
import test from "node:test";

import { createEvidenceWriter } from "./config.mjs";
import { reconcilePrivateOperation } from "./unlink.mjs";
import { reconcilePreparedTransfer } from "../private-transfer.mjs";
import {
  assertUnlinkAddress,
  resolveOperationResume,
  resultFromHistory,
  verifyBalanceDeltas,
  verifyTransferDeltas,
} from "./transfer.mjs";

const TOKEN = "0x3600000000000000000000000000000000000000";
const RECIPIENT = "unlink1qqqqqqqq";
const FEE_RECIPIENT = "unlink1pppppppp";

/**
 * @param {(bigint | Error | {sync_status: string})[]} values
 */
function createBalanceClient(values) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async getBalances() {
      const value = values[Math.min(calls, values.length - 1)];
      calls += 1;
      if (value instanceof Error) {
        throw value;
      }
      if (typeof value === "object") {
        return { ...value, balances: [] };
      }
      return {
        sync_status: "current",
        balances: [{ token: TOKEN, amount: value.toString() }],
      };
    },
  };
}

test("Unlink address assertion accepts the required lowercase shape", () => {
  assert.equal(assertUnlinkAddress(RECIPIENT), RECIPIENT);
  assert.equal(assertUnlinkAddress("unlink1023456789"), "unlink1023456789");
});

test("Unlink address assertion rejects invalid values", () => {
  for (const value of [
    "",
    "unlink1short",
    "Unlink1qqqqqqqq",
    "unlink1bbbbbbbb",
    "unlink1iiiiiiii",
    "unlink1oooooooo",
    " unlink1qqqqqqqq",
    null,
  ]) {
    assert.throws(
      () => assertUnlinkAddress(value),
      /recipient Unlink address is invalid/u,
    );
  }
});

test("transfer delta verification succeeds immediately on exact dual deltas", async () => {
  const senderClient = createBalanceClient([60n]);
  const recipientClient = createBalanceClient([50n]);

  const result = await verifyTransferDeltas({
    senderClient,
    recipientClient,
    tokenAddress: TOKEN,
    senderBefore: 100n,
    recipientBefore: 10n,
    amount: 40n,
    sleep: async () => assert.fail("sleep should not be called"),
  });

  assert.deepEqual(result, { senderAfter: 60n, recipientAfter: 50n });
  assert.equal(senderClient.calls, 1);
  assert.equal(recipientClient.calls, 1);
  assert.equal("transfer" in senderClient, false);
});

test("a fee-bearing transfer verifies all three balances at once", async () => {
  // 40 to the recipient plus a 4 fee: the sender pays 44, and each side must
  // move by exactly its own share.
  const senderClient = createBalanceClient([56n]);
  const recipientClient = createBalanceClient([50n]);
  const feeClient = createBalanceClient([9n]);

  const result = await verifyTransferDeltas({
    senderClient,
    recipientClient,
    feeClient,
    tokenAddress: TOKEN,
    senderBefore: 100n,
    recipientBefore: 10n,
    feeBefore: 5n,
    amount: 40n,
    fee: 4n,
    sleep: async () => assert.fail("sleep should not be called"),
  });

  assert.deepEqual(result, { senderAfter: 56n, recipientAfter: 50n, feeAfter: 9n });
});

test("a fee-bearing transfer hard-stops when the fee account does not move", async () => {
  const senderClient = createBalanceClient([56n]);
  const recipientClient = createBalanceClient([50n]);
  const feeClient = createBalanceClient([5n]);

  await assert.rejects(
    verifyTransferDeltas({
      senderClient,
      recipientClient,
      feeClient,
      tokenAddress: TOKEN,
      senderBefore: 100n,
      recipientBefore: 10n,
      feeBefore: 5n,
      amount: 40n,
      fee: 4n,
      attempts: 2,
      delayMs: 0,
      sleep: async () => {},
    }),
    /did not converge/u,
  );
});

test("a non-zero fee without the fee account snapshot is rejected", async () => {
  await assert.rejects(
    verifyTransferDeltas({
      senderClient: createBalanceClient([56n]),
      recipientClient: createBalanceClient([50n]),
      tokenAddress: TOKEN,
      senderBefore: 100n,
      recipientBefore: 10n,
      amount: 40n,
      fee: 4n,
    }),
    /requires the fee account snapshot/u,
  );
});

test("transfer delta verification retries a recipient-side sync status error", async () => {
  const senderClient = createBalanceClient([60n, 60n]);
  const recipientClient = createBalanceClient([
    { sync_status: "syncing" },
    50n,
  ]);
  const delays = [];

  const result = await verifyTransferDeltas({
    senderClient,
    recipientClient,
    tokenAddress: TOKEN,
    senderBefore: 100n,
    recipientBefore: 10n,
    amount: 40n,
    attempts: 2,
    delayMs: 25,
    sleep: async (milliseconds) => delays.push(milliseconds),
  });

  assert.deepEqual(result, { senderAfter: 60n, recipientAfter: 50n });
  assert.deepEqual(delays, [25]);
  assert.equal(recipientClient.calls, 2);
});

test("transfer delta verification retries a sync status error", async () => {
  const senderClient = createBalanceClient([
    { sync_status: "syncing" },
    60n,
  ]);
  const recipientClient = createBalanceClient([50n, 50n]);
  const delays = [];

  const result = await verifyTransferDeltas({
    senderClient,
    recipientClient,
    tokenAddress: TOKEN,
    senderBefore: 100n,
    recipientBefore: 10n,
    amount: 40n,
    attempts: 2,
    delayMs: 25,
    sleep: async (milliseconds) => delays.push(milliseconds),
  });

  assert.deepEqual(result, { senderAfter: 60n, recipientAfter: 50n });
  assert.deepEqual(delays, [25]);
  assert.equal(senderClient.calls, 2);
  assert.equal(recipientClient.calls, 2);
});

test("transfer delta verification retries not-yet-visible deltas", async () => {
  const senderClient = createBalanceClient([100n, 60n]);
  const recipientClient = createBalanceClient([10n, 50n]);
  let sleeps = 0;

  const result = await verifyTransferDeltas({
    senderClient,
    recipientClient,
    tokenAddress: TOKEN,
    senderBefore: 100n,
    recipientBefore: 10n,
    amount: 40n,
    attempts: 2,
    delayMs: 0,
    sleep: async () => {
      sleeps += 1;
    },
  });

  assert.deepEqual(result, { senderAfter: 60n, recipientAfter: 50n });
  assert.equal(sleeps, 1);
});

test("transfer delta verification rethrows unrelated errors immediately", async () => {
  const failure = new Error("authorization failed");
  const senderClient = createBalanceClient([failure, 60n]);
  const recipientClient = createBalanceClient([50n, 50n]);
  let sleeps = 0;

  await assert.rejects(
    verifyTransferDeltas({
      senderClient,
      recipientClient,
      tokenAddress: TOKEN,
      senderBefore: 100n,
      recipientBefore: 10n,
      amount: 40n,
      attempts: 2,
      sleep: async () => {
        sleeps += 1;
      },
    }),
    (error) => error === failure,
  );
  assert.equal(senderClient.calls, 1);
  assert.equal(recipientClient.calls, 1);
  assert.equal(sleeps, 0);
});

test("transfer delta verification hard-stops after bounded attempts", async () => {
  const senderClient = createBalanceClient([100n, 100n]);
  const recipientClient = createBalanceClient([10n, 10n]);
  let sleeps = 0;

  await assert.rejects(
    verifyTransferDeltas({
      senderClient,
      recipientClient,
      tokenAddress: TOKEN,
      senderBefore: 100n,
      recipientBefore: 10n,
      amount: 40n,
      attempts: 2,
      delayMs: 0,
      sleep: async () => {
        sleeps += 1;
      },
    }),
    /hard stop/u,
  );
  assert.equal(senderClient.calls, 2);
  assert.equal(recipientClient.calls, 2);
  assert.equal(sleeps, 1);
});

test("transfer delta verification rejects an exact dual-side mismatch", async () => {
  await assert.rejects(
    verifyTransferDeltas({
      senderClient: createBalanceClient([60n]),
      recipientClient: createBalanceClient([49n]),
      tokenAddress: TOKEN,
      senderBefore: 100n,
      recipientBefore: 10n,
      amount: 40n,
      attempts: 1,
      sleep: async () => {},
    }),
    /hard stop/u,
  );
});

test("operation resume routing uses verifiedAt as the only done gate", () => {
  assert.equal(resolveOperationResume(undefined), "fresh");
  assert.equal(resolveOperationResume(null), "fresh");
  assert.equal(
    resolveOperationResume({ txId: "tx-1", status: "accepted" }),
    "poll",
  );
  assert.equal(
    resolveOperationResume({ status: "prepared", amount: "40" }),
    "reconcile",
  );
  assert.equal(
    resolveOperationResume({ txId: "tx-1", status: "processed" }),
    "poll",
  );
  assert.equal(
    resolveOperationResume({
      txId: "tx-1",
      status: "processed",
      verifiedAt: "2026-07-29T00:00:00.000Z",
    }),
    "done",
  );
});

test("history results normalize into the processed-assertion shape", () => {
  assert.deepEqual(
    resultFromHistory({
      id: "tx-1",
      tx_hash: "0xabc",
      status: "processed",
      confirmation_status: "processed",
      funds_usable: true,
    }),
    {
      txId: "tx-1",
      txHash: "0xabc",
      status: "processed",
      confirmationStatus: "processed",
      fundsUsable: true,
    },
  );
  assert.equal(
    resultFromHistory({
      id: "tx-1",
      status: "processed",
      confirmation_status: "processed",
      funds_usable: true,
    }).txHash,
    null,
  );
});

test("single-participant delta verification covers deposit resume", async () => {
  const client = createBalanceClient([{ sync_status: "syncing" }, 140n]);
  const delays = [];

  const [after] = await verifyBalanceDeltas({
    tokenAddress: TOKEN,
    participants: [
      {
        client,
        label: "deposit verification",
        before: 100n,
        expectedDelta: 40n,
      },
    ],
    attempts: 2,
    delayMs: 25,
    sleep: async (milliseconds) => delays.push(milliseconds),
  });

  assert.equal(after, 140n);
  assert.deepEqual(delays, [25]);
  assert.equal(client.calls, 2);
});

test("delta verification requires at least one participant", async () => {
  await assert.rejects(
    verifyBalanceDeltas({
      tokenAddress: TOKEN,
      participants: [],
      sleep: async () => {},
    }),
    /at least one participant/u,
  );
});

test("outgoing transfer reconciliation requires one participant-aware match", async () => {
  const queries = [];
  const transaction = {
    id: "tx-1",
    type: "transfer",
    token: TOKEN,
    amount: "40",
    recipient_address: RECIPIENT,
    recipient_addresses: [RECIPIENT],
    status: "processed",
  };
  const client = {
    ...createBalanceClient([60n]),
    async getTransactions(params) {
      queries.push(params);
      return { transactions: [transaction] };
    },
  };

  const result = await reconcilePrivateOperation({
    client,
    type: "transfer",
    token: TOKEN,
    amount: "40",
    beforeBalance: "100",
    expectedDelta: -40n,
    recipientAddress: RECIPIENT,
  });

  assert.equal(result.transaction, transaction);
  assert.equal(result.currentBalance, 60n);
  assert.equal(result.delta, -40n);
  assert.deepEqual(queries, [{ type: "transfer", limit: 100 }]);
});

test("outgoing transfer reconciliation hard-stops on zero or multiple matches", async () => {
  const transaction = {
    id: "tx-1",
    type: "transfer",
    token: TOKEN,
    amount: "40",
    recipient_address: RECIPIENT,
    recipient_addresses: [RECIPIENT],
    status: "processed",
  };
  for (const transactions of [
    [],
    [transaction, { ...transaction, id: "tx-2" }],
  ]) {
    const client = {
      ...createBalanceClient([60n]),
      async getTransactions() {
        return { transactions };
      },
    };
    await assert.rejects(
      reconcilePrivateOperation({
        client,
        type: "transfer",
        token: TOKEN,
        amount: "40",
        beforeBalance: "100",
        expectedDelta: -40n,
        recipientAddress: RECIPIENT,
      }),
      /reconciliation is ambiguous; hard stop/u,
    );
  }
});

test("reconciliation createdAfter excludes matches from earlier runs", async () => {
  const stale = {
    id: "tx-old",
    type: "transfer",
    token: TOKEN,
    amount: "40",
    recipient_address: RECIPIENT,
    recipient_addresses: [RECIPIENT],
    status: "processed",
    created_at: "2026-07-27T00:00:00.000Z",
  };
  const fresh = {
    ...stale,
    id: "tx-new",
    created_at: "2026-07-29T12:00:05.000Z",
  };
  const client = {
    ...createBalanceClient([60n]),
    async getTransactions() {
      return { transactions: [stale, fresh] };
    },
  };

  const result = await reconcilePrivateOperation({
    client,
    type: "transfer",
    token: TOKEN,
    amount: "40",
    beforeBalance: "100",
    expectedDelta: -40n,
    recipientAddress: RECIPIENT,
    createdAfter: "2026-07-29T12:00:00.000Z",
  });

  assert.equal(result.transaction.id, "tx-new");
});

test("reconciliation retains matches without a parseable created_at", async () => {
  const undated = {
    id: "tx-undated",
    type: "transfer",
    token: TOKEN,
    amount: "40",
    recipient_address: RECIPIENT,
    recipient_addresses: [RECIPIENT],
    status: "processed",
  };
  const client = {
    ...createBalanceClient([60n]),
    async getTransactions() {
      return { transactions: [undated] };
    },
  };

  const result = await reconcilePrivateOperation({
    client,
    type: "transfer",
    token: TOKEN,
    amount: "40",
    beforeBalance: "100",
    expectedDelta: -40n,
    recipientAddress: RECIPIENT,
    createdAfter: "2026-07-29T12:00:00.000Z",
  });
  assert.equal(result.transaction.id, "tx-undated");

  await assert.rejects(
    reconcilePrivateOperation({
      client: {
        ...createBalanceClient([60n]),
        async getTransactions() {
          return { transactions: [undated] };
        },
      },
      type: "transfer",
      token: TOKEN,
      amount: "40",
      beforeBalance: "100",
      expectedDelta: -40n,
      recipientAddress: RECIPIENT,
      createdAfter: "not-a-date",
    }),
    /createdAfter must be a parseable date/u,
  );
});

test("reconciliation tolerates bounded clock skew before createdAfter", async () => {
  const slightlyEarlier = {
    id: "tx-skewed",
    type: "transfer",
    token: TOKEN,
    amount: "40",
    recipient_address: RECIPIENT,
    recipient_addresses: [RECIPIENT],
    status: "processed",
    created_at: "2026-07-29T11:55:00.000Z",
  };
  const client = {
    ...createBalanceClient([60n]),
    async getTransactions() {
      return { transactions: [slightlyEarlier] };
    },
  };

  const result = await reconcilePrivateOperation({
    client,
    type: "transfer",
    token: TOKEN,
    amount: "40",
    beforeBalance: "100",
    expectedDelta: -40n,
    recipientAddress: RECIPIENT,
    createdAfter: "2026-07-29T12:00:00.000Z",
  });
  assert.equal(result.transaction.id, "tx-skewed");
});

test("fee-bearing reconciliation adopts only an exact multi-recipient total", async () => {
  const transaction = {
    id: "tx-fee-bearing",
    type: "transfer",
    token: TOKEN.toLowerCase(),
    amount: "44",
    recipient_addresses: [FEE_RECIPIENT, RECIPIENT],
    status: "processed",
  };
  const client = {
    ...createBalanceClient([56n]),
    async getTransactions() {
      return { transactions: [transaction] };
    },
  };

  const result = await reconcilePrivateOperation({
    client,
    type: "transfer",
    token: TOKEN,
    amount: "40",
    feeAmount: "4",
    beforeBalance: "100",
    expectedDelta: -44n,
    recipientAddresses: [RECIPIENT, FEE_RECIPIENT],
  });

  assert.equal(result.transaction, transaction);
  assert.equal(result.delta, -44n);
});

test("fee-bearing reconciliation rejects an extra co-recipient", async () => {
  await assert.rejects(
    reconcilePrivateOperation({
      client: {
        ...createBalanceClient([56n]),
        async getTransactions() {
          return {
            transactions: [
              {
                id: "tx-extra",
                type: "transfer",
                token: TOKEN.toLowerCase(),
                amount: "44",
                recipient_addresses: [
                  RECIPIENT,
                  FEE_RECIPIENT,
                  "unlink1rrrrrrrr",
                ],
                status: "processed",
              },
            ],
          };
        },
      },
      type: "transfer",
      token: TOKEN,
      amount: "40",
      feeAmount: "4",
      beforeBalance: "100",
      expectedDelta: -44n,
      recipientAddresses: [RECIPIENT, FEE_RECIPIENT],
    }),
    /reconciliation is ambiguous; hard stop/u,
  );
});

test("fee-bearing reconciliation hard-stops on two exact matches", async () => {
  const transaction = {
    id: "tx-a",
    type: "transfer",
    token: TOKEN.toLowerCase(),
    amount: "44",
    recipient_addresses: [RECIPIENT, FEE_RECIPIENT],
    status: "processed",
  };
  await assert.rejects(
    reconcilePrivateOperation({
      client: {
        ...createBalanceClient([56n]),
        async getTransactions() {
          return {
            transactions: [transaction, { ...transaction, id: "tx-b" }],
          };
        },
      },
      type: "transfer",
      token: TOKEN,
      amount: "40",
      feeAmount: "4",
      beforeBalance: "100",
      expectedDelta: -44n,
      recipientAddresses: [RECIPIENT, FEE_RECIPIENT],
    }),
    /reconciliation is ambiguous; hard stop/u,
  );
});

test("prepared fee-bearing checkpoint reconciles and completes with its fee", async () => {
  const previous = {
    status: "prepared",
    token: TOKEN,
    amount: "40",
    feeAmount: "4",
    feeRecipientAddress: FEE_RECIPIENT,
    senderBefore: "100",
    recipientBefore: "10",
    feeBefore: "5",
    recipientAddress: RECIPIENT,
    createdAt: "2026-07-29T12:00:00.000Z",
  };
  const state = { operations: { transfer: { ...previous } } };
  const checkpoint = {
    update(mutate) {
      mutate(state);
      return state;
    },
  };
  const senderClient = {
    ...createBalanceClient([56n, 56n]),
    async getTransactions() {
      return {
        transactions: [
          {
            id: "tx-reconciled-fee",
            type: "transfer",
            token: TOKEN.toLowerCase(),
            amount: "44",
            recipient_addresses: [RECIPIENT, FEE_RECIPIENT],
            status: "processed",
            confirmation_status: "processed",
            funds_usable: true,
            created_at: "2026-07-29T12:00:05.000Z",
          },
        ],
      };
    },
  };
  let completion;

  const resumed = await reconcilePreparedTransfer({
    previous,
    senderClient,
    recipientClient: createBalanceClient([50n]),
    feeClient: createBalanceClient([9n]),
    tokenAddress: TOKEN,
    recipientAddress: RECIPIENT,
    feeRecipientAddress: FEE_RECIPIENT,
    checkpoint,
    attempts: 1,
    delayMs: 0,
    complete(result, senderBefore, recipientBefore, balances, amount, fee) {
      completion = {
        txId: result.txId,
        senderBefore,
        recipientBefore,
        balances,
        amount,
        fee,
      };
      checkpoint.update((current) => {
        current.operations.transfer.verifiedAt =
          "2026-07-29T12:01:00.000Z";
      });
    },
  });

  assert.equal(resumed.savedFee, 4n);
  assert.deepEqual(resumed.balances, {
    senderAfter: 56n,
    recipientAfter: 50n,
    feeAfter: 9n,
  });
  assert.deepEqual(completion, {
    txId: "tx-reconciled-fee",
    senderBefore: 100n,
    recipientBefore: 10n,
    balances: {
      senderAfter: 56n,
      recipientAfter: 50n,
      feeAfter: 9n,
    },
    amount: "40",
    fee: "4",
  });
  assert.equal(state.operations.transfer.txId, "tx-reconciled-fee");
  assert.equal(
    state.operations.transfer.verifiedAt,
    "2026-07-29T12:01:00.000Z",
  );
});

test("legacy prepared checkpoint reconciles through the same branch with fee zero", async () => {
  const previous = {
    status: "prepared",
    token: TOKEN,
    amount: "40",
    senderBefore: "100",
    recipientBefore: "10",
    recipientAddress: RECIPIENT,
    createdAt: "2026-07-29T12:00:00.000Z",
  };
  const state = { operations: { transfer: { ...previous } } };
  const checkpoint = {
    update(mutate) {
      mutate(state);
      return state;
    },
  };
  const senderClient = {
    ...createBalanceClient([60n, 60n]),
    async getTransactions() {
      return {
        transactions: [
          {
            id: "tx-reconciled-legacy",
            type: "transfer",
            token: TOKEN.toLowerCase(),
            amount: "40",
            recipient_address: RECIPIENT,
            recipient_addresses: [RECIPIENT],
            status: "processed",
            confirmation_status: "processed",
            funds_usable: true,
            created_at: "2026-07-29T12:00:05.000Z",
          },
        ],
      };
    },
  };
  let feeClientReads = 0;
  let completedFee;

  const resumed = await reconcilePreparedTransfer({
    previous,
    senderClient,
    recipientClient: createBalanceClient([50n]),
    feeClient: {
      async getBalances() {
        feeClientReads += 1;
        throw new Error("legacy reconciliation must not read the fee account");
      },
    },
    tokenAddress: TOKEN,
    recipientAddress: RECIPIENT,
    feeRecipientAddress: FEE_RECIPIENT,
    checkpoint,
    attempts: 1,
    delayMs: 0,
    complete(_result, _senderBefore, _recipientBefore, _balances, _amount, fee) {
      completedFee = fee;
    },
  });

  assert.equal(resumed.savedFee, 0n);
  assert.deepEqual(resumed.balances, {
    senderAfter: 60n,
    recipientAfter: 50n,
  });
  assert.equal(completedFee, "0");
  assert.equal(feeClientReads, 0);
  assert.equal(state.operations.transfer.txId, "tx-reconciled-legacy");
});

test("evidence allowlist accepts transfer participant balance fields", () => {
  const lines = [];
  const evidence = createEvidenceWriter({
    chainKey: "arc-testnet",
    flow: "transfer_unit_test",
    runId: "0123456789abcdef01234567",
    append: (line) => lines.push(line),
  });

  evidence("transfer_completed", {
    recipientAddress: RECIPIENT,
    senderBeforeBalance: 100n,
    senderAfterBalance: 60n,
    recipientBeforeBalance: 10n,
    recipientAfterBalance: 50n,
    senderDelta: -40n,
    recipientDelta: 40n,
  });

  const record = JSON.parse(lines[0]);
  assert.equal(record.recipientAddress, RECIPIENT);
  assert.equal(record.senderDelta, "-40");
  assert.equal(record.recipientDelta, "40");
});
