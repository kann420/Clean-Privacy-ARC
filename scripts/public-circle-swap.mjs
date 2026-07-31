import { erc20Abi, getAddress } from "viem";

import {
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
  waitForCircleDone,
} from "./lib/circle.mjs";
import {
  assertPhase3Contracts,
  assertPhase3PublicBudget,
  assertPublicCircleRetryState,
  readTokenAllowance,
  readTokenBalance,
} from "./lib/phase3.mjs";
import {
  GENEROUS_WRITE_GAS,
  computeBufferedGas,
  createWalletContext,
  withRpcRetry,
} from "./lib/wallet.mjs";

function parseArgs(argv) {
  const result = {
    amount: "0.1",
    tokenOut: "EURC",
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
  if (result.tokenOut !== "EURC") {
    throw new Error("public Circle proof supports only --token-out EURC");
  }
  if (!result.help && !result.confirmLive) {
    throw new Error("--confirm-live is required for a public Circle swap");
  }
  return result;
}

function requirePublicOperation(value, config, amountIn, owner) {
  if (typeof value !== "object" || value === null) {
    throw new Error("public Circle checkpoint is malformed");
  }
  if (
    value.version !== 1 ||
    value.chainId !== config.chainId ||
    value.owner !== getAddress(owner) ||
    value.amountIn !== amountIn.toString()
  ) {
    throw new Error("public Circle checkpoint does not match this operation");
  }
  if (typeof value.beforeEurc !== "string" || !/^\d+$/u.test(value.beforeEurc)) {
    throw new Error("public Circle before balance is malformed");
  }
  return value;
}

async function main() {
  const chainArgs = parseChainFlag(process.argv.slice(2));
  const args = parseArgs(chainArgs.rest);
  if (args.help) {
    console.log(
      "Usage: npm run swap:public -- --token-out EURC --amount 0.1 --confirm-live",
    );
    return;
  }
  const config = loadChainConfig(chainArgs.chainKey);
  const env = loadLocalEnv();
  const kitKey = requireCircleKitKey(env);
  const amountIn = parseDecimalAmount(
    args.amount,
    config.tokens.USDC.decimals,
  );
  if (amountIn <= 0n) throw new Error("--amount must be greater than zero");
  const wallet = createWalletContext(config, {
    checkpointFlow: "public_circle_swap_eoa",
    env,
  });
  const checkpoint = createCheckpointStore({
    chainKey: config.chainKey,
    flow: "public_circle_swap",
  });
  let operation = checkpoint.read().operations.publicCircle;
  if (operation?.verifiedAt) {
    console.log(`Public Circle swap already verified: ${operation.swapHash}`);
    return;
  }

  await assertPhase3Contracts({
    config,
    publicClient: wallet.publicClient,
    requireCircle: true,
  });
  await assertPhase3PublicBudget({
    config,
    publicClient: wallet.publicClient,
    owner: wallet.account.address,
  });

  if (operation == null) {
    const beforeEurc = await readTokenBalance(
      wallet.publicClient,
      config.tokens.EURC.address,
      wallet.account.address,
    );
    checkpoint.update((value) => {
      value.operations.publicCircle = {
        version: 1,
        chainId: config.chainId,
        owner: getAddress(wallet.account.address),
        amountIn: amountIn.toString(),
        beforeEurc: beforeEurc.toString(),
        plan: null,
        approvalHash: null,
        swapHash: null,
        swapAttempts: [],
        circleStatus: null,
        verifiedAt: null,
        createdAt: new Date().toISOString(),
      };
    });
    operation = checkpoint.read().operations.publicCircle;
  }
  operation = requirePublicOperation(
    operation,
    config,
    amountIn,
    wallet.account.address,
  );

  if (operation.swapHash != null) {
    const existingReceipt = await withRpcRetry(() =>
      wallet.publicClient.waitForTransactionReceipt({
        hash: operation.swapHash,
      }),
    );
    if (existingReceipt.status === "reverted") {
      const [currentEurc, currentAllowance] = await Promise.all([
        readTokenBalance(
          wallet.publicClient,
          config.tokens.EURC.address,
          wallet.account.address,
        ),
        readTokenAllowance(
          wallet.publicClient,
          config.tokens.USDC.address,
          wallet.account.address,
          config.protocol.circleAdapter,
        ),
      ]);
      assertPublicCircleRetryState({
        receiptStatus: existingReceipt.status,
        beforeOutput: BigInt(operation.beforeEurc),
        currentOutput: currentEurc,
        expectedAllowance: amountIn,
        currentAllowance,
      });
      checkpoint.update((value) => {
        const current = value.operations.publicCircle;
        current.swapAttempts ??= [];
        if (
          !current.swapAttempts.some(
            (attempt) => attempt.hash === current.swapHash,
          )
        ) {
          current.swapAttempts.push({
            hash: current.swapHash,
            status: "reverted",
            blockNumber: existingReceipt.blockNumber.toString(),
            gasUsed: existingReceipt.gasUsed.toString(),
            recordedAt: new Date().toISOString(),
          });
        }
        current.swapHash = null;
        current.plan = null;
        current.recoveredAt = new Date().toISOString();
      });
      operation = requirePublicOperation(
        checkpoint.read().operations.publicCircle,
        config,
        amountIn,
        wallet.account.address,
      );
    }
  }

  if (operation.plan == null) {
    const adapter = createCircleViemAdapter({
      config,
      address: wallet.account.address,
      publicClient: wallet.publicClient,
      walletClient: wallet.walletClient,
    });
    const quote = await estimateCircleSwap({
      config,
      executionAccount: wallet.account.address,
      amountHuman: args.amount,
      kitKey,
      adapter,
    });
    const plan = await captureCircleSwapPlan({
      config,
      executionAccount: wallet.account.address,
      amountHuman: args.amount,
      amountIn,
      kitKey,
      estimate: quote,
      baseAdapter: adapter,
    });
    checkpoint.update((value) => {
      value.operations.publicCircle.plan = plan;
    });
    operation = requirePublicOperation(
      checkpoint.read().operations.publicCircle,
      config,
      amountIn,
      wallet.account.address,
    );
  }
  if (
    operation.swapHash == null &&
    (!/^\d+$/u.test(operation.plan?.deadline ?? "") ||
      BigInt(operation.plan.deadline) -
        BigInt(Math.floor(Date.now() / 1_000)) <
        480n)
  ) {
    const adapter = createCircleViemAdapter({
      config,
      address: wallet.account.address,
      publicClient: wallet.publicClient,
      walletClient: wallet.walletClient,
    });
    const quote = await estimateCircleSwap({
      config,
      executionAccount: wallet.account.address,
      amountHuman: args.amount,
      kitKey,
      adapter,
    });
    const plan = await captureCircleSwapPlan({
      config,
      executionAccount: wallet.account.address,
      amountHuman: args.amount,
      amountIn,
      kitKey,
      estimate: quote,
      baseAdapter: adapter,
    });
    checkpoint.update((value) => {
      value.operations.publicCircle.plan = plan;
    });
    operation = requirePublicOperation(
      checkpoint.read().operations.publicCircle,
      config,
      amountIn,
      wallet.account.address,
    );
  }

  const allowance = await readTokenAllowance(
    wallet.publicClient,
    config.tokens.USDC.address,
    wallet.account.address,
    config.protocol.circleAdapter,
  );
  if (operation.swapHash == null && allowance !== amountIn) {
    if (allowance !== 0n) {
      throw new Error(
        "public Circle allowance is ambiguous; hard stop without another approval",
      );
    }
    const broadcast = await wallet.sendHash(
      (nonce) =>
        wallet.walletClient.writeContract({
          account: wallet.account,
          chain: wallet.chain,
          address: config.tokens.USDC.address,
          abi: erc20Abi,
          functionName: "approve",
          args: [config.protocol.circleAdapter, amountIn],
          nonce,
          gas: GENEROUS_WRITE_GAS,
        }),
      "Phase 3 public Circle exact approval",
      {
        kind: "call",
        gas: GENEROUS_WRITE_GAS,
        to: config.tokens.USDC.address,
        selector: "approve",
      },
    );
    checkpoint.update((value) => {
      value.operations.publicCircle.approvalHash = broadcast.hash;
    });
    if (!broadcast.receipt) {
      await wallet.confirm(
        broadcast.hash,
        "Phase 3 public Circle exact approval",
      );
    }
  }

  operation = requirePublicOperation(
    checkpoint.read().operations.publicCircle,
    config,
    amountIn,
    wallet.account.address,
  );
  if (operation.swapHash == null) {
    const estimatedGas = await withRpcRetry(() =>
      wallet.publicClient.estimateGas({
        account: wallet.account.address,
        to: operation.plan.swapCall.target,
        data: operation.plan.swapCall.data,
        value: 0n,
      }),
    );
    const swapGas = computeBufferedGas(estimatedGas);
    const attemptNumber = (operation.swapAttempts?.length ?? 0) + 1;
    const attemptLabel = `Phase 3 public Circle swap attempt ${attemptNumber}`;
    const broadcast = await wallet.sendHash(
      (nonce) =>
        wallet.walletClient.sendTransaction({
          account: wallet.account,
          chain: wallet.chain,
          to: operation.plan.swapCall.target,
          data: operation.plan.swapCall.data,
          value: 0n,
          nonce,
          gas: swapGas,
        }),
      attemptLabel,
      {
        kind: "call",
        gas: swapGas,
        to: operation.plan.swapCall.target,
        selector: operation.plan.swapCall.data.slice(0, 10),
      },
    );
    checkpoint.update((value) => {
      const current = value.operations.publicCircle;
      current.swapHash = broadcast.hash;
      current.swapAttempts ??= [];
      current.swapAttempts.push({
        hash: broadcast.hash,
        status: "broadcast",
        estimatedGas: estimatedGas.toString(),
        gasLimit: swapGas.toString(),
        broadcastAt: new Date().toISOString(),
      });
    });
    if (!broadcast.receipt) {
      await wallet.confirm(broadcast.hash, attemptLabel);
    }
  }

  operation = requirePublicOperation(
    checkpoint.read().operations.publicCircle,
    config,
    amountIn,
    wallet.account.address,
  );
  const receipt = await wallet.publicClient.waitForTransactionReceipt({
    hash: operation.swapHash,
  });
  if (receipt.status !== "success") {
    throw new Error(`public Circle swap reverted: ${operation.swapHash}`);
  }
  checkpoint.update((value) => {
    const attempts = value.operations.publicCircle.swapAttempts ?? [];
    const attempt = attempts.find(
      (item) => item.hash === operation.swapHash,
    );
    if (attempt) {
      attempt.status = "success";
      attempt.blockNumber = receipt.blockNumber.toString();
      attempt.gasUsed = receipt.gasUsed.toString();
    }
  });
  const circleStatus = await waitForCircleDone({
    txHash: operation.swapHash,
    kitKey,
    chain: config.circleChain,
  });
  checkpoint.update((value) => {
    value.operations.publicCircle.circleStatus =
      circleStatus.progress.status;
  });
  const [afterEurc, finalAllowance] = await Promise.all([
    readTokenBalance(
      wallet.publicClient,
      config.tokens.EURC.address,
      wallet.account.address,
    ),
    readTokenAllowance(
      wallet.publicClient,
      config.tokens.USDC.address,
      wallet.account.address,
      config.protocol.circleAdapter,
    ),
  ]);
  const eurcDelta = afterEurc - BigInt(operation.beforeEurc);
  if (eurcDelta <= 0n) {
    throw new Error("public EURC balance did not increase");
  }
  if (finalAllowance !== 0n) {
    throw new Error("public Circle allowance was not fully consumed");
  }
  const evidence = createEvidenceWriter({
    chainKey: config.chainKey,
    flow: "public_circle_swap",
  });
  const verifiedAt = new Date().toISOString();
  evidence("public_swap_verified", {
    status: circleStatus.progress.status,
    provider: "circle_app_kit",
    route: "USDC_EURC",
    tokenIn: config.tokens.USDC.address,
    tokenOut: config.tokens.EURC.address,
    amountIn,
    estimatedOutput: operation.plan.estimatedOutput,
    minOut: operation.plan.minOut,
    circleExecutionId: operation.plan.circleExecutionId,
    quoteFingerprint: operation.plan.fingerprint,
    txHash: operation.swapHash,
    beforeBalance: operation.beforeEurc,
    afterBalance: afterEurc,
    delta: eurcDelta,
    allowance: finalAllowance,
    verifiedAt,
  });
  checkpoint.update((value) => {
    value.operations.publicCircle.verifiedAt = verifiedAt;
  });
  console.log(`Public Circle swap verified: ${operation.swapHash}`);
}

main().catch((error) => {
  process.exitCode = 1;
  console.error(formatPublicError(error, "public Circle swap failed"));
});
