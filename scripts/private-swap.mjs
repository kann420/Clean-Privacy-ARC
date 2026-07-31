import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { ExecuteRecoveryError } from "@unlink-xyz/sdk/advanced";
import {
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  parseAbi,
} from "viem";

import {
  ROOT_URL,
  createEvidenceWriter,
  formatPublicError,
  loadChainConfig,
  loadLocalEnv,
  parseChainFlag,
  parseDecimalAmount,
} from "./lib/config.mjs";
import { createCheckpointStore } from "./lib/checkpoint.mjs";
import {
  captureCircleSwapPlan,
  createCircleViemAdapter,
  estimateCircleSwap,
  requireCircleKitKey,
} from "./lib/circle.mjs";
import {
  assertProcessedExecution,
  createPrefundGuard,
  prepareAccountCallExecution,
  prepareFundedExecution,
  resumePersistedExecution,
  submitPreparedAccountCall,
  submitPreparedExecution,
} from "./lib/execute.mjs";
import {
  PRIVATE_SWAP_AMOUNT,
  archiveRolledBackPhaseAWith,
  assertPhase3Contracts,
  assertPrivateSwapBudget,
  readTokenAllowance,
  readTokenBalance,
  runPhaseBWithRetry,
} from "./lib/phase3.mjs";
import {
  applyMiniDexMargin,
  assertPairInvariant,
  getUniswapV2AmountOut,
  resolveSwapEntryGate,
} from "./lib/swap.mjs";
import { createPrivateSwapState } from "./lib/swap-checkpoint.mjs";
import { describeFee, feeFromInput, feePolicy } from "./lib/fees.mjs";
import { verifyBalanceDeltas } from "./lib/transfer.mjs";
import { UNISWAP_V2_PAIR_ARTIFACT } from "./lib/uniswap-v2.mjs";
import {
  SENDER_APP_ID,
  createUnlinkContext,
  getCurrentPrivateBalance,
  getRegisteredEnvironment,
} from "./lib/unlink.mjs";
import {
  createWalletContext,
  sleep,
  withRpcRetry,
} from "./lib/wallet.mjs";

const APPROVE_ABI = parseAbi([
  "function approve(address spender,uint256 amount) returns (bool)",
]);
const TRANSFER_ABI = parseAbi([
  "function transfer(address to,uint256 amount) returns (bool)",
]);

function parseArgs(argv) {
  const result = {
    amount: PRIVATE_SWAP_AMOUNT,
    tokenOut: null,
    confirmLive: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") result.help = true;
    else if (arg === "--confirm-live") result.confirmLive = true;
    else if (arg === "--amount" || arg === "--token-out") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--amount") result.amount = value;
      else result.tokenOut = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!result.help && !["EURC", "cirBTC"].includes(result.tokenOut)) {
    throw new Error("--token-out must be EURC or cirBTC");
  }
  if (!result.help && result.amount !== PRIVATE_SWAP_AMOUNT) {
    throw new Error("live private swap amount must be exactly 0.1 USDC");
  }
  if (!result.help && !result.confirmLive) {
    throw new Error("--confirm-live is required for a private swap");
  }
  return result;
}

function readMiniDexManifest(config) {
  const url = new URL("deployments/arc-testnet.uniswap-v2-mini.json", ROOT_URL);
  if (!existsSync(url)) {
    throw new Error("verified mini DEX manifest is missing; run dex:deploy first");
  }
  const value = JSON.parse(readFileSync(url, "utf8"));
  if (
    value?.version !== 1 ||
    value?.chainId !== config.chainId ||
    !value.verifiedAt ||
    typeof value.factory !== "string" ||
    typeof value.pair !== "string" ||
    value.usdc?.toLowerCase() !== config.tokens.USDC.address.toLowerCase() ||
    value.cirbtc?.toLowerCase() !==
      config.tokens.cirBTC.address.toLowerCase()
  ) {
    throw new Error("mini DEX manifest is invalid for Arc Testnet");
  }
  return {
    ...value,
    factory: getAddress(value.factory),
    pair: getAddress(value.pair),
  };
}

async function verifyOutputBand(options) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const balance = await getCurrentPrivateBalance(
        options.client,
        options.token,
        "private swap output verification",
      );
      const delta = balance - options.before;
      if (delta >= options.min && delta <= options.max) {
        return { balance, delta };
      }
    } catch (error) {
      if (!/sync status/iu.test(error instanceof Error ? error.message : "")) {
        throw error;
      }
    }
    if (attempt < 9) await sleep(3_000);
  }
  throw new Error("private output delta did not converge; hard stop");
}

function fallbackFingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function runPhaseA(context) {
  let current = context.state.read().phaseA;
  if (current == null) {
    const calls =
      context.tokenOut === "EURC"
        ? [
            {
              target: context.config.tokens.USDC.address,
              value: "0",
              data: encodeFunctionData({
                abi: APPROVE_ABI,
                functionName: "approve",
                args: [
                  context.config.protocol.circleAdapter,
                  context.amountIn,
                ],
              }),
              label: "approve exact Circle input",
            },
          ]
        : [
            {
              target: context.config.tokens.USDC.address,
              value: "0",
              data: encodeFunctionData({
                abi: APPROVE_ABI,
                functionName: "approve",
                args: [context.manifest.pair, 0n],
              }),
              label: "assert zero Pair allowance",
            },
          ];
    // The protocol fee leaves the ExecutionAccount in the same UserOperation
    // that funds it, so the account holds exactly the venue amount afterwards.
    // A swap is already public, so paying this fee to the owner EOA reveals
    // nothing the swap did not already reveal.
    if (context.feeAmount > 0n) {
      calls.push({
        target: context.config.tokens.USDC.address,
        value: "0",
        data: encodeFunctionData({
          abi: TRANSFER_ABI,
          functionName: "transfer",
          args: [getAddress(context.feeOwner), context.feeAmount],
        }),
        label: "pay protocol swap fee",
      });
    }
    const callbacks = context.state.callbacks("phase_a");
    const prepared = await prepareFundedExecution({
      unlink: context.unlink,
      environment: context.environment,
      withdrawFromPool: [
        {
          token: context.config.tokens.USDC.address,
          amount: context.grossIn.toString(),
        },
      ],
      calls,
      returnToPool: [],
      ...callbacks,
    });
    const result = await submitPreparedExecution({
      prepared,
      beforeSubmit: context.beforeSubmit,
      onStatus: callbacks.onStatus,
    });
    context.state.persistStatus(
      "phase_a",
      result.status,
      result.executionId,
      result.execution,
    );
    return result;
  }
  const callbacks = context.state.callbacks("phase_a");
  const result = await resumePersistedExecution({
    unlink: context.unlink,
    environment: context.environment,
    execution: current,
    kind: "funded",
    beforeSubmit: context.beforeSubmit,
    onStatus: callbacks.onStatus,
    onRecoveryPayload: callbacks.onRecoveryPayload,
  });
  context.state.persistStatus(
    "phase_a",
    result.status,
    result.executionId,
    result.execution,
  );
  return result;
}

async function archiveRolledBackPhaseA(context) {
  const saved = context.state.read();
  const accountAddress = () => getAddress(saved.phaseA.accountAddress);
  await archiveRolledBackPhaseAWith({
    saved,
    hasPairRoute: context.manifest != null,
    resume: async () => {
      const callbacks = context.state.callbacks("phase_a");
      const result = await resumePersistedExecution({
        unlink: context.unlink,
        environment: context.environment,
        execution: saved.phaseA,
        kind: "funded",
        beforeSubmit: context.beforeSubmit,
        onStatus: callbacks.onStatus,
        onRecoveryPayload: callbacks.onRecoveryPayload,
      });
      context.state.persistStatus(
        "phase_a",
        result.status,
        result.executionId,
        result.execution,
      );
      return result;
    },
    readPrivateInput: () =>
      getCurrentPrivateBalance(
        context.unlink.client,
        context.config.tokens.USDC.address,
        "Phase A retry private input",
      ),
    readPrivateOutput: () =>
      getCurrentPrivateBalance(
        context.unlink.client,
        context.outputToken.address,
        "Phase A retry private output",
      ),
    readExecutionInput: () =>
      readTokenBalance(
        context.wallet.publicClient,
        context.config.tokens.USDC.address,
        accountAddress(),
      ),
    readExecutionOutput: () =>
      readTokenBalance(
        context.wallet.publicClient,
        context.outputToken.address,
        accountAddress(),
      ),
    readCircleAllowance: () =>
      readTokenAllowance(
        context.wallet.publicClient,
        context.config.tokens.USDC.address,
        accountAddress(),
        context.config.protocol.circleAdapter,
      ),
    readPairAllowance: () =>
      readTokenAllowance(
        context.wallet.publicClient,
        context.config.tokens.USDC.address,
        accountAddress(),
        context.manifest.pair,
      ),
    archive: (executionId) =>
      context.state.archiveTerminalPhaseA(executionId),
  });
}

async function buildCirclePhaseB(context, accountAddress, forceFresh = false) {
  const kitKey = requireCircleKitKey(context.env);
  const publicCheckpoint = createCheckpointStore({
    chainKey: context.config.chainKey,
    flow: "public_circle_swap",
  }).read().operations.publicCircle;
  if (!publicCheckpoint?.verifiedAt) {
    throw new Error("public Circle proof must be verified before private EURC");
  }
  let saved = context.state.read();
  const now = BigInt(Math.floor(Date.now() / 1_000));
  if (
    forceFresh ||
    saved.plan == null ||
    saved.plan.executionAccount !== getAddress(accountAddress) ||
    (saved.phaseBAttempts.length === 0 &&
      BigInt(saved.plan.deadline ?? "0") - now < 480n)
  ) {
    const adapter = createCircleViemAdapter({
      config: context.config,
      address: accountAddress,
      publicClient: context.wallet.publicClient,
    });
    const quote = await estimateCircleSwap({
      config: context.config,
      executionAccount: accountAddress,
      amountHuman: context.amountHuman,
      kitKey,
      adapter,
    });
    const plan = await captureCircleSwapPlan({
      config: context.config,
      executionAccount: accountAddress,
      amountHuman: context.amountHuman,
      amountIn: context.amountIn,
      kitKey,
      estimate: quote,
      baseAdapter: adapter,
    });
    context.state.persistQuote({
      plan,
      quoteFingerprint: plan.fingerprint,
    });
    saved = context.state.read();
  }
  const plan = saved.plan;
  if (
    plan.fingerprint !== saved.quoteFingerprint ||
    plan.executionAccount !== getAddress(accountAddress) ||
    plan.amountIn !== context.amountIn.toString() ||
    getAddress(plan.swapCall.target) !==
      getAddress(context.config.protocol.circleAdapter) ||
    plan.swapCall.value !== "0" ||
    BigInt(plan.minOut) <= 0n
  ) {
    throw new Error("persisted Circle plan is malformed or mismatched");
  }
  const maxOut = context.amountIn * 2n;
  if (BigInt(plan.minOut) > maxOut) {
    throw new Error("Circle minimum output exceeds the economic safety cap");
  }
  return {
    calls: [
      {
        target: plan.swapCall.target,
        value: "0",
        data: plan.swapCall.data,
        label: "Circle adapter swap",
      },
    ],
    returnToPool: [
      {
        token: context.config.tokens.EURC.address,
        sweep: true,
        baseline: "0",
        min_total: plan.minOut,
        max_total: maxOut.toString(),
      },
    ],
    minOut: BigInt(plan.minOut),
    maxOut,
    plan,
  };
}

async function buildCirbtcPhaseB(
  context,
  accountAddress,
  manifest,
  forceFresh = false,
) {
  const saved = context.state.read();
  if (
    !forceFresh &&
    saved.phaseBAttempts.length > 0 &&
    saved.plan != null &&
    saved.reserveSnapshot != null &&
    saved.deterministicOutput != null
  ) {
    const persisted = saved.plan;
    const exactOut = BigInt(saved.deterministicOutput);
    return {
      calls: [
        {
          target: context.config.tokens.USDC.address,
          value: "0",
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "transfer",
            args: [manifest.pair, context.amountIn],
          }),
          label: "transfer exact USDC to Pair",
        },
        {
          target: manifest.pair,
          value: "0",
          data: encodeFunctionData({
            abi: UNISWAP_V2_PAIR_ARTIFACT.abi,
            functionName: "swap",
            args: [
              BigInt(persisted.amount0Out),
              BigInt(persisted.amount1Out),
              getAddress(accountAddress),
              "0x",
            ],
          }),
          label: "direct Pair exact-output swap",
        },
      ],
      returnToPool: [
        {
          token: context.config.tokens.cirBTC.address,
          sweep: true,
          baseline: "0",
          min_total: exactOut.toString(),
          max_total: exactOut.toString(),
        },
      ],
      minOut: exactOut,
      maxOut: exactOut,
      plan: persisted,
      reserveSnapshot: saved.reserveSnapshot,
    };
  }
  const [token0, reserves, blockNumber] = await Promise.all([
    withRpcRetry(() =>
      context.wallet.publicClient.readContract({
        address: manifest.pair,
        abi: UNISWAP_V2_PAIR_ARTIFACT.abi,
        functionName: "token0",
      }),
    ),
    withRpcRetry(() =>
      context.wallet.publicClient.readContract({
        address: manifest.pair,
        abi: UNISWAP_V2_PAIR_ARTIFACT.abi,
        functionName: "getReserves",
      }),
    ),
    withRpcRetry(() => context.wallet.publicClient.getBlockNumber()),
  ]);
  const usdcIsToken0 =
    token0.toLowerCase() === context.config.tokens.USDC.address.toLowerCase();
  const reserveIn = usdcIsToken0 ? reserves[0] : reserves[1];
  const reserveOut = usdcIsToken0 ? reserves[1] : reserves[0];
  const quote = getUniswapV2AmountOut(
    context.amountIn,
    reserveIn,
    reserveOut,
  );
  const exactOut = applyMiniDexMargin(quote);
  const reserveSnapshot = {
    reserve0: reserves[0].toString(),
    reserve1: reserves[1].toString(),
    blockNumber: blockNumber.toString(),
  };
  const plan = {
    pair: manifest.pair,
    executionAccount: getAddress(accountAddress),
    amountIn: context.amountIn.toString(),
    exactOut: exactOut.toString(),
    amount0Out: (usdcIsToken0 ? 0n : exactOut).toString(),
    amount1Out: (usdcIsToken0 ? exactOut : 0n).toString(),
  };
  const fingerprint = fallbackFingerprint({ plan, reserveSnapshot });
  context.state.persistQuote({
    plan,
    quoteFingerprint: fingerprint,
    reserveSnapshot,
    deterministicOutput: exactOut.toString(),
  });
  return {
    calls: [
      {
        target: context.config.tokens.USDC.address,
        value: "0",
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [manifest.pair, context.amountIn],
        }),
        label: "transfer exact USDC to Pair",
      },
      {
        target: manifest.pair,
        value: "0",
        data: encodeFunctionData({
          abi: UNISWAP_V2_PAIR_ARTIFACT.abi,
          functionName: "swap",
          args: [
            BigInt(plan.amount0Out),
            BigInt(plan.amount1Out),
            getAddress(accountAddress),
            "0x",
          ],
        }),
        label: "direct Pair exact-output swap",
      },
    ],
    returnToPool: [
      {
        token: context.config.tokens.cirBTC.address,
        sweep: true,
        baseline: "0",
        min_total: exactOut.toString(),
        max_total: exactOut.toString(),
      },
    ],
    minOut: exactOut,
    maxOut: exactOut,
    plan,
    reserveSnapshot,
  };
}

async function executePhaseB(context, phaseBPlan, accountAddress) {
  const saved = context.state.read();
  let attemptIndex = saved.phaseBAttempts.length - 1;
  let current =
    attemptIndex >= 0 ? saved.phaseBAttempts[attemptIndex] : null;
  if (current == null || current.status === "user_op_reverted") {
    attemptIndex = saved.phaseBAttempts.length;
    const callbacks = context.state.callbacks("phase_b", attemptIndex);
    const prepared = await prepareAccountCallExecution({
      unlink: context.unlink,
      environment: context.environment,
      accountIndex: saved.phaseA.accountIndices.accountIdx,
      expectedAccountAddress: accountAddress,
      calls: phaseBPlan.calls,
      returnToPool: phaseBPlan.returnToPool,
      ...callbacks,
    });
    const result = await submitPreparedAccountCall({
      prepared,
      beforeSubmit: context.beforeSubmit,
      onStatus: callbacks.onStatus,
    });
    context.state.persistStatus(
      "phase_b",
      result.status,
      result.executionId,
      result.execution,
      attemptIndex,
    );
    return { result, attemptIndex };
  }
  const callbacks = context.state.callbacks("phase_b", attemptIndex);
  const result = await resumePersistedExecution({
    unlink: context.unlink,
    environment: context.environment,
    execution: current,
    kind: "account_call",
    beforeSubmit: context.beforeSubmit,
    onStatus: callbacks.onStatus,
    onRecoveryPayload: callbacks.onRecoveryPayload,
  });
  context.state.persistStatus(
    "phase_b",
    result.status,
    result.executionId,
    result.execution,
    attemptIndex,
  );
  return { result, attemptIndex };
}

async function assertRetryIsUnambiguous(context, accountAddress) {
  const saved = context.state.read();
  const [publicInput, publicOutput, privateInput, privateOutput] =
    await Promise.all([
      readTokenBalance(
        context.wallet.publicClient,
        context.config.tokens.USDC.address,
        accountAddress,
      ),
      readTokenBalance(
        context.wallet.publicClient,
        context.outputToken.address,
        accountAddress,
      ),
      getCurrentPrivateBalance(
        context.unlink.client,
        context.config.tokens.USDC.address,
        "retry private input",
      ),
      getCurrentPrivateBalance(
        context.unlink.client,
        context.outputToken.address,
        "retry private output",
      ),
    ]);
  if (
    publicInput !== context.amountIn ||
    publicOutput !== 0n ||
    privateInput !== BigInt(saved.beforeBalances.input) - context.grossIn ||
    privateOutput !== BigInt(saved.beforeBalances.output)
  ) {
    throw new Error(
      "reverted Phase B balances are ambiguous; hard stop without retry",
    );
  }
}

async function main() {
  const chainArgs = parseChainFlag(process.argv.slice(2));
  const args = parseArgs(chainArgs.rest);
  if (args.help) {
    console.log(
      "Usage: npm run swap:private -- --token-out <EURC|cirBTC> --amount 0.1 --confirm-live",
    );
    return;
  }
  const config = loadChainConfig(chainArgs.chainKey);
  const env = loadLocalEnv();
  const grossIn = parseDecimalAmount(
    args.amount,
    config.tokens.USDC.decimals,
  );
  const policy = feePolicy(config);
  // The fee comes out of the input: --amount is what leaves the private
  // balance, and the venue only ever sees the remainder.
  const feeSplit = feeFromInput(grossIn, policy.swapBps);
  const amountIn = feeSplit.net;
  const outputToken = config.tokens[args.tokenOut];
  const state = createPrivateSwapState({
    chainKey: config.chainKey,
    tokenOut: args.tokenOut,
  });
  const entryGate = resolveSwapEntryGate(state.read());
  if (entryGate === "verified") {
    console.log(
      `Private ${args.tokenOut} swap already verified; no execution created.`,
    );
    return;
  }
  if (entryGate === "recovered") {
    console.log(
      `Private ${args.tokenOut} swap recovery already returned the assets; no automatic action remains. A new swap requires deliberately archiving the route checkpoint.`,
    );
    return;
  }
  if (args.tokenOut === "EURC") requireCircleKitKey(env);
  const wallet = createWalletContext(config, {
    checkpointFlow: `private_swap_${args.tokenOut.toLowerCase()}_eoa`,
    env,
  });
  const unlink = await createUnlinkContext({
    config,
    wallet,
    appId: SENDER_APP_ID,
  });
  const environment = await getRegisteredEnvironment(unlink.client, config);
  const beforeSubmit = createPrefundGuard({
    publicClient: wallet.publicClient,
    environment,
  });
  let manifest = null;
  if (args.tokenOut === "cirBTC") manifest = readMiniDexManifest(config);
  await assertPhase3Contracts({
    config,
    publicClient: wallet.publicClient,
    requireCircle: args.tokenOut === "EURC",
    extraContracts: manifest ? [manifest.factory, manifest.pair] : [],
  });
  await assertPrivateSwapBudget({
    client: unlink.client,
    token: config.tokens.USDC.address,
    minimum: parseDecimalAmount("0.2", config.tokens.USDC.decimals),
  });
  if (state.read() == null) {
    const [beforeInput, beforeOutput] = await Promise.all([
      getCurrentPrivateBalance(
        unlink.client,
        config.tokens.USDC.address,
        "pre-swap private USDC",
      ),
      getCurrentPrivateBalance(
        unlink.client,
        outputToken.address,
        `pre-swap private ${args.tokenOut}`,
      ),
    ]);
    state.initialize({
      operation: {
        chainId: config.chainId,
        unlinkAddress: unlink.unlinkAddress,
        amountIn: amountIn.toString(),
        grossIn: grossIn.toString(),
        feeAmount: feeSplit.fee.toString(),
        tokenIn: config.tokens.USDC.address,
        outputToken: outputToken.address,
      },
      beforeBalances: {
        input: beforeInput.toString(),
        output: beforeOutput.toString(),
      },
    });
  }
  // A resume must run the amount the checkpoint was built with. Re-splitting a
  // different --amount would change the venue input and the fee underneath an
  // already accepted Phase A.
  const savedOperation = state.read().operation;
  if (savedOperation.amountIn !== amountIn.toString()) {
    throw new Error(
      `saved swap input ${savedOperation.amountIn} does not match the requested ` +
        `${amountIn}; re-run with the original --amount`,
    );
  }
  console.log(
    `Private ${args.tokenOut} swap of ${args.amount} USDC; ${describeFee({
      fee: feeSplit.fee,
      bps: policy.swapBps,
      symbol: "USDC",
      decimals: config.tokens.USDC.decimals,
    })} paid publicly from the execution account`,
  );
  const context = {
    config,
    env,
    wallet,
    unlink,
    environment,
    state,
    tokenOut: args.tokenOut,
    outputToken,
    manifest,
    // Circle is quoted on what actually reaches the venue. Quoting the gross
    // amount would prepare an approval for more than Phase A granted, and the
    // exact-approval validator would reject the captured plan.
    amountHuman: formatUnits(amountIn, config.tokens.USDC.decimals),
    grossHuman: args.amount,
    amountIn,
    grossIn: BigInt(savedOperation.grossIn),
    feeAmount: BigInt(savedOperation.feeAmount),
    feeOwner: policy.owner,
    feeBps: policy.swapBps,
    beforeSubmit,
  };
  await archiveRolledBackPhaseA(context);
  let phaseA;
  try {
    phaseA = await runPhaseA(context);
  } catch (error) {
    if (error instanceof ExecuteRecoveryError) {
      throw new Error(
        `Phase A accepted execution ${error.executionId}; rerun to recover the persisted ID`,
        { cause: error },
      );
    }
    throw error;
  }
  assertProcessedExecution(phaseA, "private swap Phase A");
  const savedAfterA = state.read();
  const accountAddress = getAddress(savedAfterA.phaseA.accountAddress);
  await verifyBalanceDeltas({
    tokenAddress: config.tokens.USDC.address,
    participants: [
      {
        client: unlink.client,
        label: "Phase A private USDC verification",
        before: BigInt(savedAfterA.beforeBalances.input),
        expectedDelta: -context.grossIn,
      },
    ],
  });
  const [eaInput, eaAllowance, pairAllowance] = await Promise.all([
    readTokenBalance(
      wallet.publicClient,
      config.tokens.USDC.address,
      accountAddress,
    ),
    readTokenAllowance(
      wallet.publicClient,
      config.tokens.USDC.address,
      accountAddress,
      config.protocol.circleAdapter,
    ),
    args.tokenOut === "cirBTC"
      ? readTokenAllowance(
          wallet.publicClient,
          config.tokens.USDC.address,
          accountAddress,
          manifest.pair,
        )
      : Promise.resolve(0n),
  ]);
  if (eaInput !== amountIn) {
    throw new Error("Phase A ExecutionAccount input balance is not exact");
  }
  if (
    (args.tokenOut === "EURC" && eaAllowance !== amountIn) ||
    (args.tokenOut === "cirBTC" && eaAllowance !== 0n)
  ) {
    throw new Error("Phase A allowance post-condition is invalid");
  }
  if (pairAllowance !== 0n) {
    throw new Error("Phase A Pair allowance post-condition is invalid");
  }

  let phaseBPlan;
  let phaseB;
  try {
    const routed = await runPhaseBWithRetry({
      lastAttemptStatus:
        state.read().phaseBAttempts.at(-1)?.status ?? null,
      disambiguate: () =>
        assertRetryIsUnambiguous(context, accountAddress),
      buildPlan: (forceFresh) =>
        args.tokenOut === "EURC"
          ? buildCirclePhaseB(context, accountAddress, forceFresh)
          : buildCirbtcPhaseB(
              context,
              accountAddress,
              manifest,
              forceFresh,
            ),
      execute: (plan) =>
        executePhaseB(context, plan, accountAddress),
    });
    phaseBPlan = routed.plan;
    phaseB = routed.outcome;
  } catch (error) {
    if (error instanceof ExecuteRecoveryError) {
      throw new Error(
        `Phase B accepted execution ${error.executionId}; rerun to recover the persisted ID`,
        { cause: error },
      );
    }
    throw error;
  }
  assertProcessedExecution(phaseB.result, "private swap Phase B");

  const saved = state.read();
  const [afterInput] = await verifyBalanceDeltas({
    tokenAddress: config.tokens.USDC.address,
    participants: [
      {
        client: unlink.client,
        label: "final private USDC verification",
        before: BigInt(saved.beforeBalances.input),
        expectedDelta: -context.grossIn,
      },
    ],
  });
  const output = await verifyOutputBand({
    client: unlink.client,
    token: outputToken.address,
    before: BigInt(saved.beforeBalances.output),
    min: phaseBPlan.minOut,
    max: phaseBPlan.maxOut,
  });
  const [eaFinalInput, eaFinalOutput, finalAllowance] = await Promise.all([
    readTokenBalance(
      wallet.publicClient,
      config.tokens.USDC.address,
      accountAddress,
    ),
    readTokenBalance(
      wallet.publicClient,
      outputToken.address,
      accountAddress,
    ),
    readTokenAllowance(
      wallet.publicClient,
      config.tokens.USDC.address,
      accountAddress,
      config.protocol.circleAdapter,
    ),
  ]);
  if (
    eaFinalInput !== 0n ||
    eaFinalOutput !== 0n ||
    finalAllowance !== 0n
  ) {
    throw new Error("ExecutionAccount residue or allowance is nonzero");
  }
  let finalReserves = null;
  if (args.tokenOut === "cirBTC") {
    finalReserves = await withRpcRetry(() =>
      wallet.publicClient.readContract({
        address: manifest.pair,
        abi: UNISWAP_V2_PAIR_ARTIFACT.abi,
        functionName: "getReserves",
      }),
    );
    assertPairInvariant({
      reserve0Before: BigInt(phaseBPlan.reserveSnapshot.reserve0),
      reserve1Before: BigInt(phaseBPlan.reserveSnapshot.reserve1),
      reserve0After: finalReserves[0],
      reserve1After: finalReserves[1],
    });
    if (output.delta !== phaseBPlan.minOut) {
      throw new Error("private cirBTC output is not the deterministic exact amount");
    }
  }
  const evidence = createEvidenceWriter({
    chainKey: config.chainKey,
    flow: `private_swap_${args.tokenOut.toLowerCase()}`,
  });
  const verifiedAt = new Date().toISOString();
  evidence("private_swap_verified", {
    status: phaseB.result.status,
    confirmationStatus: phaseB.result.execution.confirmation_status,
    provider:
      args.tokenOut === "EURC"
        ? "circle_app_kit"
        : "uniswap_v2_direct_pair",
    route: `USDC_${args.tokenOut}`,
    unlinkAddress: unlink.unlinkAddress,
    executionId: phaseB.result.executionId,
    withdrawalTxIds: phaseA.withdrawalTxIds,
    handleOpsTxHash: phaseB.result.handleOpsTxHash,
    accountIndex: saved.phaseA.accountIndices.accountIdx,
    executionAccountAddress: accountAddress,
    tokenIn: config.tokens.USDC.address,
    tokenOut: outputToken.address,
    amountIn,
    feeAmount: context.feeAmount,
    feeBps: context.feeBps,
    feeRecipient: context.feeOwner,
    minOut: phaseBPlan.minOut,
    maxOut: phaseBPlan.maxOut,
    quoteFingerprint: saved.quoteFingerprint,
    beforeBalance: saved.beforeBalances.output,
    afterBalance: output.balance,
    delta: output.delta,
    allowance: finalAllowance,
    reserve0: finalReserves?.[0] ?? null,
    reserve1: finalReserves?.[1] ?? null,
    verifiedAt,
  });
  state.markVerified();
  console.log(
    `Private ${args.tokenOut} swap verified: ${phaseB.result.executionId}`,
  );
  void afterInput;
}

main().catch((error) => {
  process.exitCode = error instanceof ExecuteRecoveryError ? 2 : 1;
  console.error(formatPublicError(error, "private swap failed"));
});
