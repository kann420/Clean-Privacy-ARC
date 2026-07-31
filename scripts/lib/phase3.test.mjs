import assert from "node:assert/strict";
import test from "node:test";

import {
  archiveRolledBackPhaseAWith,
  assertPhaseARetryState,
  assertPublicCircleRetryState,
  assertPhase3Contracts,
  assertPhase3PublicBudget,
  assertPrivateSwapBudget,
  buildRecoveryPlan,
  runPhaseBWithRetry,
} from "./phase3.mjs";
import { loadChainConfig } from "./config.mjs";

const config = loadChainConfig();

test("Phase 3 contract gate checks chain and every required bytecode target", async () => {
  const checked = [];
  await assertPhase3Contracts({
    config,
    requireCircle: true,
    paceMs: 0,
    publicClient: {
      getChainId: async () => config.chainId,
      getCode: async ({ address }) => {
        checked.push(address);
        return "0x01";
      },
      readContract: async ({ address }) =>
        address.toLowerCase() === config.tokens.cirBTC.address.toLowerCase()
          ? 8
          : 6,
    },
  });
  const normalized = checked.map((address) => address.toLowerCase());
  assert.ok(normalized.includes(config.protocol.circleAdapter.toLowerCase()));
  assert.ok(normalized.includes(config.protocol.entryPoint.toLowerCase()));
  assert.ok(normalized.includes(config.tokens.cirBTC.address.toLowerCase()));
});

test("Phase 3 contract gate rejects wrong chain and missing code", async () => {
  await assert.rejects(
    () =>
      assertPhase3Contracts({
        config,
        paceMs: 0,
        publicClient: {
          getChainId: async () => 1,
          getCode: async () => "0x01",
          readContract: async () => 6,
        },
      }),
    /chain ID/u,
  );
  await assert.rejects(
    () =>
      assertPhase3Contracts({
        config,
        paceMs: 0,
        publicClient: {
          getChainId: async () => config.chainId,
          getCode: async () => "0x",
          readContract: async () => 6,
        },
      }),
    /no bytecode/u,
  );
});

test("public budget gate preserves 10 USDC after all projected costs", async () => {
  const owner = "0x1111111111111111111111111111111111111111";
  let reads = 0;
  const enough = await assertPhase3PublicBudget({
    config,
    owner,
    publicClient: {
      readContract: async () => {
        reads += 1;
        return reads === 1 ? 16_100_000n : 5_000n;
      },
    },
  });
  assert.equal(enough.requiredUsdc, 16_100_000n);

  reads = 0;
  await assert.rejects(
    () =>
      assertPhase3PublicBudget({
        config,
        owner,
        publicClient: {
          readContract: async () => {
            reads += 1;
            return reads === 1 ? 16_099_999n : 5_000n;
          },
        },
      }),
    /10 USDC/u,
  );
});

test("private budget gate requires current sync and 0.2 USDC", async () => {
  assert.equal(
    await assertPrivateSwapBudget({
      client: {
        getBalances: async () => ({
          sync_status: "current",
          balances: [{ token: config.tokens.USDC.address, amount: "200000" }],
        }),
      },
      token: config.tokens.USDC.address,
      minimum: 200_000n,
    }),
    200_000n,
  );
  await assert.rejects(
    () =>
      assertPrivateSwapBudget({
        client: {
          getBalances: async () => ({
            sync_status: "syncing",
            balances: [],
          }),
        },
        token: config.tokens.USDC.address,
        minimum: 200_000n,
      }),
    /sync/u,
  );
});

test("public Circle retry requires a terminal revert with unchanged state", () => {
  const valid = {
    receiptStatus: "reverted",
    beforeOutput: 10n,
    currentOutput: 10n,
    expectedAllowance: 100_000n,
    currentAllowance: 100_000n,
  };
  assert.equal(assertPublicCircleRetryState(valid), true);
  assert.throws(
    () =>
      assertPublicCircleRetryState({
        ...valid,
        receiptStatus: "success",
      }),
    /terminal reverted/u,
  );
  assert.throws(
    () =>
      assertPublicCircleRetryState({
        ...valid,
        currentOutput: 11n,
      }),
    /output balance changed/u,
  );
  assert.throws(
    () =>
      assertPublicCircleRetryState({
        ...valid,
        currentAllowance: 0n,
      }),
    /input allowance changed/u,
  );
});

test("Phase A retry requires terminal rollback across private and public state", () => {
  const valid = {
    status: "user_op_reverted",
    confirmationStatus: "failed",
    beforePrivateInput: 400_000n,
    currentPrivateInput: 400_000n,
    beforePrivateOutput: 0n,
    currentPrivateOutput: 0n,
    executionInput: 0n,
    executionOutput: 0n,
    allowances: [0n, 0n],
  };
  assert.equal(assertPhaseARetryState(valid), true);
  assert.throws(
    () => assertPhaseARetryState({ ...valid, status: "completed" }),
    /terminal reverted/u,
  );
  assert.throws(
    () => assertPhaseARetryState({ ...valid, executionInput: 1n }),
    /ambiguous/u,
  );
  assert.throws(
    () => assertPhaseARetryState({ ...valid, currentPrivateInput: 399_999n }),
    /ambiguous/u,
  );
  assert.throws(
    () => assertPhaseARetryState({ ...valid, allowances: [0n, 1n] }),
    /ambiguous/u,
  );
});

const usdc = config.tokens.USDC.address;
const eurc = config.tokens.EURC.address;
const circleAdapter = config.protocol.circleAdapter;

function recoveryPlan(overrides) {
  return buildRecoveryPlan({
    classification: "input_only",
    allowance: 0n,
    inputBalance: 100n,
    outputBalance: 0n,
    usdcAddress: usdc,
    outputTokenAddress: eurc,
    circleAdapter,
    ...overrides,
  });
}

test("recovery plan revokes a positive allowance before sweeping input", () => {
  const plan = recoveryPlan({ allowance: 100n });
  assert.equal(plan.calls.length, 1);
  assert.equal(plan.calls[0].label, "revoke Circle allowance");
  assert.equal(plan.recoveryToken, usdc);
  assert.equal(plan.recoveryAmount, 100n);
  assert.deepEqual(plan.returnToPool, [
    {
      token: usdc,
      sweep: true,
      baseline: "0",
      min_total: "100",
      max_total: "100",
    },
  ]);
});

test("recovery plan supports a revoke-only empty account", () => {
  const plan = recoveryPlan({
    classification: "empty",
    allowance: 1n,
    inputBalance: 0n,
  });
  assert.equal(plan.calls[0].label, "revoke Circle allowance");
  assert.deepEqual(plan.returnToPool, []);
  assert.equal(plan.recoveryAmount, 0n);
});

test("recovery plan anchors a zero-allowance USDC sweep", () => {
  const plan = recoveryPlan({});
  assert.equal(
    plan.calls[0].label,
    "assert zero allowance (gas-tier anchor)",
  );
  assert.equal(plan.recoveryToken, usdc);
  assert.equal(plan.returnToPool[0].min_total, "100");
});

test("recovery plan anchors a zero-allowance output sweep", () => {
  const plan = recoveryPlan({
    classification: "output_only",
    inputBalance: 0n,
    outputBalance: 75n,
  });
  assert.equal(
    plan.calls[0].label,
    "assert zero allowance (gas-tier anchor)",
  );
  assert.equal(plan.recoveryToken, eurc);
  assert.equal(plan.recoveryAmount, 75n);
  assert.equal(plan.returnToPool[0].max_total, "75");
});

test("recovery plan rejects ambiguous assets", () => {
  assert.throws(
    () =>
      recoveryPlan({
        classification: "ambiguous",
        inputBalance: 1n,
        outputBalance: 1n,
      }),
    /both input and output/u,
  );
});

test("recovery plan rejects an empty zero-allowance account", () => {
  assert.throws(
    () =>
      recoveryPlan({
        classification: "empty",
        inputBalance: 0n,
      }),
    /no recoverable token or allowance/u,
  );
});

test("every accepted recovery sweep contains a gas-tier call", () => {
  const accepted = [
    recoveryPlan({ allowance: 1n }),
    recoveryPlan({}),
    recoveryPlan({
      classification: "output_only",
      inputBalance: 0n,
      outputBalance: 1n,
    }),
    recoveryPlan({
      classification: "empty",
      allowance: 1n,
      inputBalance: 0n,
    }),
  ];
  for (const plan of accepted) {
    assert.equal(
      plan.returnToPool.length > 0 && plan.calls.length === 0,
      false,
    );
  }
});

test("persisted Phase B revert disambiguates before a fresh plan", async () => {
  const calls = [];
  const freshPlan = { fresh: true };
  const result = await runPhaseBWithRetry({
    lastAttemptStatus: "user_op_reverted",
    disambiguate: async () => calls.push("disambiguate"),
    buildPlan: async (fresh) => {
      calls.push(`buildPlan(${fresh})`);
      return freshPlan;
    },
    execute: async (plan) => {
      calls.push("execute");
      assert.equal(plan, freshPlan);
      return { result: { status: "completed" } };
    },
  });
  assert.deepEqual(calls, [
    "disambiguate",
    "buildPlan(true)",
    "execute",
  ]);
  assert.equal(result.plan, freshPlan);
});

test("persisted non-terminal Phase B attempt resumes without refresh", async () => {
  const calls = [];
  await runPhaseBWithRetry({
    lastAttemptStatus: "submitted",
    disambiguate: async () => calls.push("disambiguate"),
    buildPlan: async (fresh) => {
      calls.push(`buildPlan(${fresh})`);
      return {};
    },
    execute: async () => {
      calls.push("execute");
      return { result: { status: "completed" } };
    },
  });
  assert.deepEqual(calls, ["buildPlan(false)", "execute"]);
});

test("new Phase B attempt starts without disambiguation or refresh", async () => {
  const calls = [];
  await runPhaseBWithRetry({
    lastAttemptStatus: null,
    disambiguate: async () => calls.push("disambiguate"),
    buildPlan: async (fresh) => {
      calls.push(`buildPlan(${fresh})`);
      return {};
    },
    execute: async () => {
      calls.push("execute");
      return { result: { status: "completed" } };
    },
  });
  assert.deepEqual(calls, ["buildPlan(false)", "execute"]);
});

test("in-run Phase B revert disambiguates and retries a fresh plan", async () => {
  const calls = [];
  let executes = 0;
  const result = await runPhaseBWithRetry({
    lastAttemptStatus: null,
    disambiguate: async () => calls.push("disambiguate"),
    buildPlan: async (fresh) => {
      calls.push(`buildPlan(${fresh})`);
      return { fresh };
    },
    execute: async (plan) => {
      calls.push(`execute(${plan.fresh})`);
      executes += 1;
      return {
        result: {
          status: executes === 1 ? "user_op_reverted" : "completed",
        },
      };
    },
  });
  assert.deepEqual(calls, [
    "buildPlan(false)",
    "execute(false)",
    "disambiguate",
    "buildPlan(true)",
    "execute(true)",
  ]);
  assert.equal(result.plan.fresh, true);
  assert.equal(result.outcome.result.status, "completed");
});

test("double Phase B revert stops after two disambiguated attempts", async () => {
  let disambiguations = 0;
  let executes = 0;
  const result = await runPhaseBWithRetry({
    lastAttemptStatus: "user_op_reverted",
    disambiguate: async () => {
      disambiguations += 1;
    },
    buildPlan: async (fresh) => ({ fresh }),
    execute: async () => {
      executes += 1;
      return { result: { status: "user_op_reverted" } };
    },
  });
  assert.equal(executes, 2);
  assert.equal(disambiguations, 2);
  assert.equal(result.outcome.result.status, "user_op_reverted");
});

test("Phase B disambiguation failure prevents capture and execution", async () => {
  let buildCount = 0;
  let executeCount = 0;
  await assert.rejects(
    () =>
      runPhaseBWithRetry({
        lastAttemptStatus: "user_op_reverted",
        disambiguate: async () => {
          throw new Error("ambiguous");
        },
        buildPlan: async () => {
          buildCount += 1;
        },
        execute: async () => {
          executeCount += 1;
        },
      }),
    /ambiguous/u,
  );
  assert.equal(buildCount, 0);
  assert.equal(executeCount, 0);
});

function phaseAArchiveOptions(overrides = {}) {
  const archived = [];
  const calls = [];
  return {
    archived,
    calls,
    options: {
      saved: {
        phaseA: { status: "user_op_reverted" },
        phaseBAttempts: [],
        beforeBalances: { input: "400000", output: "20" },
      },
      hasPairRoute: false,
      resume: async () => {
        calls.push("resume");
        return {
          status: "user_op_reverted",
          executionId: "exec_reverted",
          execution: { confirmation_status: "failed" },
        };
      },
      readPrivateInput: async () => 400_000n,
      readPrivateOutput: async () => 20n,
      readExecutionInput: async () => 0n,
      readExecutionOutput: async () => 0n,
      readCircleAllowance: async () => {
        calls.push("circle");
        return 0n;
      },
      readPairAllowance: async () => {
        calls.push("pair");
        return 0n;
      },
      archive: (executionId) => archived.push(executionId),
      ...overrides,
    },
  };
}

test("EURC Phase A rollback archives without reading Pair allowance", async () => {
  const fixture = phaseAArchiveOptions({
    readPairAllowance: async () => {
      throw new Error("Pair allowance must not be read");
    },
  });
  await archiveRolledBackPhaseAWith(fixture.options);
  assert.deepEqual(fixture.archived, ["exec_reverted"]);
  assert.deepEqual(fixture.calls, ["resume", "circle"]);
});

test("cirBTC Phase A rollback proves both allowances before archive", async () => {
  const fixture = phaseAArchiveOptions({ hasPairRoute: true });
  await archiveRolledBackPhaseAWith(fixture.options);
  assert.deepEqual(fixture.archived, ["exec_reverted"]);
  assert.ok(fixture.calls.includes("circle"));
  assert.ok(fixture.calls.includes("pair"));
});

test("non-reverted Phase A performs no archival work", async () => {
  const fixture = phaseAArchiveOptions();
  fixture.options.saved.phaseA.status = "completed";
  fixture.options.resume = async () => {
    throw new Error("must not resume");
  };
  await archiveRolledBackPhaseAWith(fixture.options);
  assert.deepEqual(fixture.archived, []);
  assert.deepEqual(fixture.calls, []);
});

test("dirty Phase A rollback state never archives", async () => {
  const dirtyReads = [
    { readPrivateInput: async () => 399_999n },
    { readPrivateOutput: async () => 21n },
    { readExecutionInput: async () => 1n },
    { readExecutionOutput: async () => 1n },
    { readCircleAllowance: async () => 1n },
    { hasPairRoute: true, readPairAllowance: async () => 1n },
  ];
  for (const override of dirtyReads) {
    const fixture = phaseAArchiveOptions(override);
    await assert.rejects(
      () => archiveRolledBackPhaseAWith(fixture.options),
      /ambiguous/u,
    );
    assert.deepEqual(fixture.archived, []);
  }
});

test("Phase A rollback with Phase B attempts stops before resume", async () => {
  const fixture = phaseAArchiveOptions();
  fixture.options.saved.phaseBAttempts.push({ status: "submitted" });
  await assert.rejects(
    () => archiveRolledBackPhaseAWith(fixture.options),
    /unexpected Phase B attempts/u,
  );
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(fixture.archived, []);
});
