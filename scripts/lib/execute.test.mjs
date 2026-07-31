import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPaymasterPrefund,
  createPrefundGuard,
  getPersistedExecutionNextAction,
  pollExistingExecution,
  requiredPrefundFromIntent,
  resumePersistedExecution,
  submitPreparedAccountCall,
  submitPreparedExecution,
} from "./execute.mjs";

test("EntryPoint v0.7 prefund unpacks all gas fields", () => {
  const pack = (high, low) => ((high << 128n) | low).toString();
  const intent = {
    accountGasLimits: pack(10n, 20n),
    paymasterGasLimits: pack(30n, 40n),
    gasFees: pack(2n, 3n),
    preVerificationGas: "5",
  };
  assert.equal(requiredPrefundFromIntent(intent), 315n);
  assert.doesNotThrow(() => assertPaymasterPrefund(500n, 315n));
  assert.throws(() => assertPaymasterPrefund(400n, 315n), /1.5x/u);
});

test("accepted execution recovery polls the exact persisted ID", async () => {
  const calls = [];
  const sdk = {
    getExecuteSession: async (_client, executionId) => {
      calls.push(["get", executionId]);
      return {
        status: "submitted",
        confirmation_status: null,
        execution_submit_accepted: true,
      };
    },
    pollExecuteStatus: async (_client, executionId) => {
      calls.push(["poll", executionId]);
      return {
        status: "completed",
        confirmation_status: "processed",
        handle_ops_tx_hash: "0xabc",
      };
    },
  };
  const result = await pollExistingExecution({
    rawClient: {},
    executionId: "exec_persisted",
    withdrawalTxIds: ["withdraw_1"],
    sdk,
  });
  assert.deepEqual(calls, [
    ["get", "exec_persisted"],
    ["poll", "exec_persisted"],
  ]);
  assert.equal(result.executionId, "exec_persisted");
});

test("manual recovery status hard-stops without polling or resubmitting", async () => {
  let pollCount = 0;
  await assert.rejects(
    () =>
      pollExistingExecution({
        rawClient: {},
        executionId: "exec_manual",
        sdk: {
          getExecuteSession: async () => ({
            status: "manual_recovery_required",
          }),
          pollExecuteStatus: async () => {
            pollCount += 1;
          },
        },
      }),
    /manual recovery/u,
  );
  assert.equal(pollCount, 0);
});

test("prepared recovery only finalizes with persisted withdrawal signatures", () => {
  const sdk = { getExecuteNextAction: () => "finalize_execution" };
  assert.equal(
    getPersistedExecutionNextAction({
      session: { status: "prepared" },
      sdk,
    }),
    "hard_stop",
  );
  assert.equal(
    getPersistedExecutionNextAction({
      session: { status: "prepared" },
      recovery: { withdrawalSignatures: ["0xsigned"] },
      sdk,
    }),
    "resume_finalize",
  );
  assert.equal(
    getPersistedExecutionNextAction({
      session: { status: "prepared" },
      recovery: {
        pendingWithdrawals: [
          { signingRequest: {}, requested: { token: "0x1", amount: "1" } },
        ],
      },
      sdk,
    }),
    "resume_sign_withdrawals",
  );
  assert.equal(
    getPersistedExecutionNextAction({
      session: { status: "prepared" },
      recovery: {
        pendingWithdrawals: [
          { signingRequest: {}, requested: {} },
          { signingRequest: {}, requested: {} },
        ],
        withdrawalSignatures: ["0xpartial"],
      },
      sdk,
    }),
    "resume_sign_withdrawals",
  );
});

test("submitted and intent-ready sessions never select a fresh execution", () => {
  assert.equal(
    getPersistedExecutionNextAction({
      session: { status: "prepared" },
      sdk: { getExecuteNextAction: () => "sign_execution_intent" },
    }),
    "resume_sign_and_submit",
  );
  assert.equal(
    getPersistedExecutionNextAction({
      session: { status: "submitted" },
      sdk: { getExecuteNextAction: () => null },
    }),
    "poll_existing",
  );
});

function preparedExecution(kind) {
  const pack = (high, low) => ((high << 128n) | low).toString();
  return {
    kind,
    executionId: `exec_${kind}`,
    withdrawalTxIds: kind === "funded" ? ["withdraw_1"] : [],
    accountIndices: { tenantIdx: 1, chainIdx: 2, accountIdx: 3 },
    accountAddress: "0x1111111111111111111111111111111111111111",
    intent: {
      accountGasLimits: pack(10n, 20n),
      paymasterGasLimits: pack(30n, 40n),
      gasFees: pack(2n, 3n),
      preVerificationGas: "5",
      paymaster: "0x4444444444444444444444444444444444444444",
    },
    executionIntentSignature: "0xsigned",
    initCode: kind === "account_call" ? "0xinit" : undefined,
    rawClient: {},
  };
}

test("direct submit hooks run before funded and account-call submits", async () => {
  for (const kind of ["funded", "account_call"]) {
    const calls = [];
    const sdk = {
      submitExecute: async () => {
        calls.push("submit");
        return {
          status: "completed",
          confirmation_status: "processed",
          execution_submit_accepted: true,
        };
      },
      submitExecuteAccountCall: async () => {
        calls.push("submit");
        return {
          status: "completed",
          confirmation_status: "processed",
          execution_submit_accepted: true,
        };
      },
    };
    const submit =
      kind === "funded"
        ? submitPreparedExecution
        : submitPreparedAccountCall;
    await submit({
      prepared: preparedExecution(kind),
      beforeSubmit: async () => calls.push("guard"),
      sdk,
    });
    assert.deepEqual(calls, ["guard", "submit"]);
  }
});

test("prefund guard blocks both direct submit kinds below 1.5x", async () => {
  const environment = {
    execution_account: {
      enabled: true,
      entry_point_address:
        "0x0000000071727De22E5E9d8BAf0eDac6f37da032",
      factory_address: "0x2222222222222222222222222222222222222222",
      account_implementation_address:
        "0x3333333333333333333333333333333333333333",
    },
  };
  for (const kind of ["funded", "account_call"]) {
    let submitCount = 0;
    const beforeSubmit = createPrefundGuard({
      environment,
      publicClient: {
        readContract: async ({ address, functionName, args }) => {
          assert.equal(
            address.toLowerCase(),
            environment.execution_account.entry_point_address.toLowerCase(),
          );
          assert.equal(functionName, "balanceOf");
          assert.deepEqual(args, [
            "0x4444444444444444444444444444444444444444",
          ]);
          return 400n;
        },
      },
    });
    const sdk = {
      submitExecute: async () => {
        submitCount += 1;
      },
      submitExecuteAccountCall: async () => {
        submitCount += 1;
      },
      getExecuteSession: async () => {
        throw new Error("must not inspect a rejected submit");
      },
    };
    const submit =
      kind === "funded"
        ? submitPreparedExecution
        : submitPreparedAccountCall;
    await assert.rejects(
      () =>
        submit({
          prepared: preparedExecution(kind),
          beforeSubmit,
          sdk,
        }),
      (error) => {
        assert.match(error.cause.message, /1.5x/u);
        return true;
      },
    );
    assert.equal(submitCount, 0);
  }
});

test("submit and resume paths require an explicit prefund guard", async () => {
  let sdkCallCount = 0;
  const sdk = {
    submitExecute: async () => {
      sdkCallCount += 1;
    },
    submitExecuteAccountCall: async () => {
      sdkCallCount += 1;
    },
    getExecuteSession: async () => {
      sdkCallCount += 1;
    },
  };
  await assert.rejects(
    () =>
      submitPreparedExecution({
        prepared: preparedExecution("funded"),
        sdk,
      }),
    /beforeSubmit prefund guard/u,
  );
  await assert.rejects(
    () =>
      submitPreparedAccountCall({
        prepared: preparedExecution("account_call"),
        sdk,
      }),
    /beforeSubmit prefund guard/u,
  );
  await assert.rejects(
    () =>
      resumePersistedExecution({
        unlink: {
          unlinkAccount: {},
          client: { getApiClient: () => ({}) },
        },
        environment: {},
        execution: {
          executionId: "exec_unguarded",
          withdrawalTxIds: [],
          accountIndices: { tenantIdx: 0, chainIdx: 0, accountIdx: 0 },
          accountAddress: "0x1111111111111111111111111111111111111111",
        },
        kind: "account_call",
        sdk,
      }),
    /beforeSubmit prefund guard/u,
  );
  assert.equal(sdkCallCount, 0);
});

test("prefund guard rejects a missing or zero paymaster", async () => {
  const guard = createPrefundGuard({
    environment: {
      execution_account: {
        enabled: true,
        entry_point_address:
          "0x0000000071727De22E5E9d8BAf0eDac6f37da032",
        factory_address: "0x2222222222222222222222222222222222222222",
        account_implementation_address:
          "0x3333333333333333333333333333333333333333",
      },
    },
    publicClient: {
      readContract: async () => {
        throw new Error("must not read");
      },
    },
  });
  await assert.rejects(
    () => guard({ intent: {} }),
    /prepared execution has no paymaster/u,
  );
  await assert.rejects(
    () =>
      guard({
        intent: {
          paymaster: "0x0000000000000000000000000000000000000000",
        },
      }),
    /prepared execution has no paymaster/u,
  );
});

test("resume helper never calls prepare and submits the persisted ID", async () => {
  const calls = [];
  const intent = {
    chainId: 5_042_002,
    entryPoint: "0x0000000071727De22E5E9d8BAf0eDac6f37da032",
    account: "0x1111111111111111111111111111111111111111",
    planHash: `0x${"11".repeat(32)}`,
  };
  const sdk = {
    getExecuteSession: async (_client, executionId) => {
      calls.push(["get", executionId]);
      return {
        status: "prepared",
        execution_intent: intent,
        execution_intent_hash: "intent_hash",
      };
    },
    getExecuteNextAction: () => "sign_execution_intent",
    createExecutionAccountClient: () => ({
      executionAccountAddress: intent.account,
      signExecutionIntent: async () => ({ signature: "0xsigned" }),
      getCreateAccountInitCode: () => "0xinit",
    }),
    fromWireExecutionIntent: (value) => value,
    hashExecutionIntent: () => "intent_hash",
    submitExecuteAccountCall: async (_client, payload) => {
      calls.push(["submit", payload.executionId]);
      return {
        status: "completed",
        confirmation_status: "processed",
        execution_submit_accepted: true,
      };
    },
  };
  const result = await resumePersistedExecution({
    unlink: {
      unlinkAccount: {},
      client: { getApiClient: () => ({}) },
    },
    environment: {
      chain_id: 5_042_002,
      execution_account: {
        enabled: true,
        entry_point_address: intent.entryPoint,
        factory_address: "0x2222222222222222222222222222222222222222",
        account_implementation_address:
          "0x3333333333333333333333333333333333333333",
      },
    },
    execution: {
      executionId: "exec_existing",
      withdrawalTxIds: [],
      accountIndices: { tenantIdx: 1, chainIdx: 2, accountIdx: 3 },
      accountAddress: intent.account,
      recovery: null,
    },
    kind: "account_call",
    beforeSubmit: async (prepared) => {
      calls.push(["guard", prepared.executionId]);
    },
    sdk,
  });
  assert.deepEqual(calls, [
    ["get", "exec_existing"],
    ["guard", "exec_existing"],
    ["submit", "exec_existing"],
  ]);
  assert.equal(result.executionId, "exec_existing");
});

test("resume prefund failure preserves the ID and never prepares or submits", async () => {
  let prepareCount = 0;
  let submitCount = 0;
  const prepared = preparedExecution("account_call");
  const intent = {
    ...prepared.intent,
    chainId: 5_042_002,
    entryPoint: "0x0000000071727De22E5E9d8BAf0eDac6f37da032",
    account: prepared.accountAddress,
    planHash: `0x${"11".repeat(32)}`,
  };
  const sdk = {
    getExecuteSession: async (_client, executionId) => {
      assert.equal(executionId, "exec_existing");
      return {
        status: "prepared",
        execution_intent: intent,
        execution_intent_hash: "intent_hash",
      };
    },
    getExecuteNextAction: () => "sign_execution_intent",
    createExecutionAccountClient: () => ({
      executionAccountAddress: intent.account,
      signExecutionIntent: async () => ({ signature: "0xsigned" }),
      getCreateAccountInitCode: () => "0xinit",
    }),
    fromWireExecutionIntent: (value) => value,
    hashExecutionIntent: () => "intent_hash",
    prepareExecute: async () => {
      prepareCount += 1;
    },
    prepareExecuteAccountCall: async () => {
      prepareCount += 1;
    },
    submitExecuteAccountCall: async () => {
      submitCount += 1;
    },
    getExecuteSessionAfterSubmit: async () => {
      throw new Error("must not inspect a rejected submit");
    },
  };
  const environment = {
    chain_id: 5_042_002,
    execution_account: {
      enabled: true,
      entry_point_address: intent.entryPoint,
      factory_address: "0x2222222222222222222222222222222222222222",
      account_implementation_address:
        "0x3333333333333333333333333333333333333333",
    },
  };
  const beforeSubmit = createPrefundGuard({
    environment,
    publicClient: { readContract: async () => 400n },
  });
  await assert.rejects(
    () =>
      resumePersistedExecution({
        unlink: {
          unlinkAccount: {},
          client: { getApiClient: () => ({}) },
        },
        environment,
        execution: {
          executionId: "exec_existing",
          withdrawalTxIds: [],
          accountIndices: { tenantIdx: 1, chainIdx: 2, accountIdx: 3 },
          accountAddress: intent.account,
          recovery: null,
        },
        kind: "account_call",
        beforeSubmit,
        sdk,
      }),
    (error) => {
      assert.equal(error.executionId, "exec_existing");
      assert.match(error.cause.message, /1.5x/u);
      return true;
    },
  );
  assert.equal(prepareCount, 0);
  assert.equal(submitCount, 0);
});
