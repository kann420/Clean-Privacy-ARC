import { getExecuteSession } from "@unlink-xyz/sdk/advanced";
import { getAddress } from "viem";

import {
  createEvidenceWriter,
  formatPublicError,
  loadChainConfig,
  loadLocalEnv,
  parseChainFlag,
} from "./lib/config.mjs";
import {
  assertProcessedExecution,
  createPrefundGuard,
  prepareAccountCallExecution,
  resumePersistedExecution,
  submitPreparedAccountCall,
} from "./lib/execute.mjs";
import {
  assertPhase3Contracts,
  buildRecoveryPlan,
  readTokenAllowance,
  readTokenBalance,
} from "./lib/phase3.mjs";
import { createPrivateSwapState } from "./lib/swap-checkpoint.mjs";
import { decideExecutionRecovery } from "./lib/swap.mjs";
import {
  SENDER_APP_ID,
  createUnlinkContext,
  getRegisteredEnvironment,
} from "./lib/unlink.mjs";
import { createWalletContext } from "./lib/wallet.mjs";

function parseArgs(argv) {
  const result = {
    tokenOut: null,
    dryRun: false,
    confirmLive: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") result.help = true;
    else if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--confirm-live") result.confirmLive = true;
    else if (arg === "--token-out") {
      const value = argv[index + 1];
      if (!value) throw new Error("--token-out requires a value");
      result.tokenOut = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!result.help && !["EURC", "cirBTC"].includes(result.tokenOut)) {
    throw new Error("--token-out must be EURC or cirBTC");
  }
  if (!result.help && result.dryRun === result.confirmLive) {
    throw new Error("choose exactly one of --dry-run or --confirm-live");
  }
  return result;
}

function classifyAssets(input, output) {
  if (input > 0n && output > 0n) return "ambiguous";
  if (input > 0n) return "input_only";
  if (output > 0n) return "output_only";
  return "empty";
}

async function main() {
  const chainArgs = parseChainFlag(process.argv.slice(2));
  const args = parseArgs(chainArgs.rest);
  if (args.help) {
    console.log(
      "Usage: npm run swap:recover -- --token-out <EURC|cirBTC> <--dry-run|--confirm-live>",
    );
    return;
  }
  const config = loadChainConfig(chainArgs.chainKey);
  const env = loadLocalEnv();
  const modeLabel = args.dryRun ? "Recovery dry-run" : "Recovery";
  const wallet = createWalletContext(config, {
    checkpointFlow: `private_swap_${args.tokenOut.toLowerCase()}_recovery_eoa`,
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
  await assertPhase3Contracts({
    config,
    publicClient: wallet.publicClient,
    requireCircle: args.tokenOut === "EURC",
  });
  const state = createPrivateSwapState({
    chainKey: config.chainKey,
    tokenOut: args.tokenOut,
  });
  const saved = state.read();
  if (saved == null) {
    console.log(`${modeLabel}: no checkpoint and no accepted execution.`);
    return;
  }
  if (saved.verifiedAt) {
    console.log(`${modeLabel}: swap is verified; no action is required.`);
    return;
  }
  if (saved.recoveredAt) {
    console.log(`${modeLabel}: assets were already recovered.`);
    return;
  }
  const active =
    saved.phaseBAttempts.at(-1) ??
    saved.phaseA;
  if (active == null) {
    console.log(`${modeLabel}: no accepted execution ID exists.`);
    return;
  }
  const rawClient = unlink.client.getApiClient();
  const session = await getExecuteSession(rawClient, active.executionId);
  const decision = decideExecutionRecovery({
    ...active,
    status: session.status,
    confirmationStatus: session.confirmation_status ?? null,
  });
  if (decision.action === "hard_stop") {
    throw new Error(
      `recovery hard stop: ${decision.reason}; no automatic action`,
    );
  }
  if (decision.action === "poll_existing") {
    if (args.dryRun) {
      console.log(
        `Recovery dry-run: poll existing execution ${active.executionId}; do not create another execution.`,
      );
      return;
    }
    const phase = saved.phaseBAttempts.length > 0 ? "phase_b" : "phase_a";
    const attemptIndex =
      phase === "phase_b" ? saved.phaseBAttempts.length - 1 : undefined;
    const callbacks = state.callbacks(phase, attemptIndex);
    const result = await resumePersistedExecution({
      unlink,
      environment,
      execution: active,
      kind: phase === "phase_a" ? "funded" : "account_call",
      beforeSubmit,
      onStatus: callbacks.onStatus,
      onRecoveryPayload: callbacks.onRecoveryPayload,
    });
    state.persistStatus(
      phase,
      result.status,
      result.executionId,
      result.execution,
      attemptIndex,
    );
    console.log(`Recovered existing execution state: ${result.executionId}`);
    return;
  }
  const accountAddress = getAddress(saved.phaseA.accountAddress);
  const outputToken = config.tokens[args.tokenOut].address;
  const readRecoveryResidue = async () => {
    const [finalInput, finalOutput, finalAllowance] = await Promise.all([
      readTokenBalance(
        wallet.publicClient,
        config.tokens.USDC.address,
        accountAddress,
      ),
      readTokenBalance(wallet.publicClient, outputToken, accountAddress),
      readTokenAllowance(
        wallet.publicClient,
        config.tokens.USDC.address,
        accountAddress,
        config.protocol.circleAdapter,
      ),
    ]);
    if (finalInput !== 0n || finalOutput !== 0n || finalAllowance !== 0n) {
      throw new Error("recovery left token residue or allowance");
    }
    return finalAllowance;
  };

  if (decision.action === "verify_postconditions") {
    if (active.origin !== "recovery") {
      console.log(
        `${modeLabel}: execution completed; rerun swap:private to verify post-conditions and set verifiedAt.`,
      );
      return;
    }
    // A recovery sweep completed but a crash landed before markRecovered.
    if (args.dryRun) {
      console.log(
        "Recovery dry-run: recovery execution completed; rerun with --confirm-live to finalize recoveredAt.",
      );
      return;
    }
    const finalAllowance = await readRecoveryResidue();
    const evidence = createEvidenceWriter({
      chainKey: config.chainKey,
      flow: `private_swap_${args.tokenOut.toLowerCase()}_recovery`,
    });
    const verifiedAt = new Date().toISOString();
    evidence("recovery_verified", {
      status: session.status,
      confirmationStatus: session.confirmation_status ?? null,
      route: `USDC_${args.tokenOut}`,
      stage: "resumed_completed",
      executionId: active.executionId,
      accountIndex: saved.phaseA.accountIndices.accountIdx,
      executionAccountAddress: accountAddress,
      allowance: finalAllowance,
      verifiedAt,
    });
    state.markRecovered();
    console.log(`Recovery completed: ${active.executionId}`);
    return;
  }

  const [inputBalance, outputBalance, allowance] = await Promise.all([
    readTokenBalance(
      wallet.publicClient,
      config.tokens.USDC.address,
      accountAddress,
    ),
    readTokenBalance(wallet.publicClient, outputToken, accountAddress),
    readTokenAllowance(
      wallet.publicClient,
      config.tokens.USDC.address,
      accountAddress,
      config.protocol.circleAdapter,
    ),
  ]);
  const classification = classifyAssets(inputBalance, outputBalance);
  if (classification === "ambiguous") {
    throw new Error("both input and output exist; recovery state is ambiguous");
  }
  if (args.dryRun) {
    console.log(
      `Recovery dry-run: ${classification}; allowance=${allowance}; no transaction sent.`,
    );
    return;
  }
  const {
    calls,
    returnToPool,
    recoveryToken,
    recoveryAmount,
  } = buildRecoveryPlan({
    classification,
    allowance,
    inputBalance,
    outputBalance,
    usdcAddress: config.tokens.USDC.address,
    outputTokenAddress: outputToken,
    circleAdapter: config.protocol.circleAdapter,
  });
  const attemptIndex = state.read().phaseBAttempts.length;
  const callbacks = state.callbacks("phase_b", attemptIndex, "recovery");
  const prepared = await prepareAccountCallExecution({
    unlink,
    environment,
    accountIndex: saved.phaseA.accountIndices.accountIdx,
    expectedAccountAddress: accountAddress,
    calls,
    returnToPool,
    ...callbacks,
  });
  const result = await submitPreparedAccountCall({
    prepared,
    beforeSubmit,
    onStatus: callbacks.onStatus,
  });
  state.persistStatus(
    "phase_b",
    result.status,
    result.executionId,
    result.execution,
    attemptIndex,
  );
  assertProcessedExecution(result, "swap recovery");
  const finalAllowance = await readRecoveryResidue();
  const evidence = createEvidenceWriter({
    chainKey: config.chainKey,
    flow: `private_swap_${args.tokenOut.toLowerCase()}_recovery`,
  });
  const verifiedAt = new Date().toISOString();
  evidence("recovery_verified", {
    status: result.status,
    confirmationStatus: result.execution.confirmation_status,
    route: `USDC_${args.tokenOut}`,
    stage: classification,
    executionId: result.executionId,
    accountIndex: saved.phaseA.accountIndices.accountIdx,
    executionAccountAddress: accountAddress,
    token: recoveryToken,
    amount: recoveryAmount,
    allowance: finalAllowance,
    verifiedAt,
  });
  state.markRecovered();
  console.log(`Recovery completed: ${result.executionId}`);
}

main().catch((error) => {
  process.exitCode = 1;
  console.error(formatPublicError(error, "swap recovery failed"));
});
