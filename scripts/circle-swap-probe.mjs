import {
  createEvidenceWriter,
  formatPublicError,
  loadChainConfig,
  loadLocalEnv,
  parseChainFlag,
  parseDecimalAmount,
} from "./lib/config.mjs";
import {
  captureCircleSwapPlan,
  createCircleViemAdapter,
  estimateCircleSwap,
  requireCircleKitKey,
} from "./lib/circle.mjs";
import { assertPhase3Contracts } from "./lib/phase3.mjs";
import { createReadOnlyContext, loadOwnerAddress } from "./lib/wallet.mjs";

function parseArgs(argv) {
  const result = { amount: "0.1", tokenOut: "EURC", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      result.help = true;
      continue;
    }
    if (arg === "--amount" || arg === "--token-out") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--amount") result.amount = value;
      else result.tokenOut = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (result.tokenOut !== "EURC") {
    throw new Error("Circle probe supports only --token-out EURC");
  }
  return result;
}

async function main() {
  const chainArgs = parseChainFlag(process.argv.slice(2));
  const args = parseArgs(chainArgs.rest);
  if (args.help) {
    console.log(
      "Usage: npm run swap:probe -- --token-out EURC --amount 0.1",
    );
    return;
  }
  const config = loadChainConfig(chainArgs.chainKey);
  const env = loadLocalEnv();
  const kitKey = requireCircleKitKey(env);
  const owner = loadOwnerAddress(env);
  const publicClient = createReadOnlyContext(config);
  await assertPhase3Contracts({
    config,
    publicClient,
    requireCircle: true,
  });
  const amountIn = parseDecimalAmount(
    args.amount,
    config.tokens.USDC.decimals,
  );
  if (amountIn <= 0n) throw new Error("--amount must be greater than zero");
  const adapter = createCircleViemAdapter({
    config,
    address: owner,
    publicClient,
  });
  const quote = await estimateCircleSwap({
    config,
    executionAccount: owner,
    amountHuman: args.amount,
    kitKey,
    adapter,
  });
  const plan = await captureCircleSwapPlan({
    config,
    executionAccount: owner,
    amountHuman: args.amount,
    amountIn,
    kitKey,
    estimate: quote,
    baseAdapter: adapter,
  });
  const evidence = createEvidenceWriter({
    chainKey: config.chainKey,
    flow: "circle_swap_probe",
  });
  evidence("capture_only_verified", {
    status: "capture_only",
    provider: "circle_app_kit",
    route: "USDC_EURC",
    tokenIn: plan.tokenIn,
    tokenOut: plan.tokenOut,
    amountIn: plan.amountIn,
    estimatedOutput: plan.estimatedOutput,
    stopLimit: plan.stopLimit,
    minOut: plan.minOut,
    circleExecutionId: plan.circleExecutionId,
    quoteFingerprint: plan.fingerprint,
  });
  console.log(
    `Circle capture-only plan verified: ${plan.fingerprint} (${plan.minOut} minimum EURC base units)`,
  );
}

main().catch((error) => {
  process.exitCode = 1;
  console.error(formatPublicError(error, "Circle swap probe failed"));
});

