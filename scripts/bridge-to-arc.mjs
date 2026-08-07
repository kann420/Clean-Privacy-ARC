import { AppKit } from "@circle-fin/app-kit";
import { createViemAdapterFromPrivateKey } from "@circle-fin/adapter-viem-v2";
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  getAddress,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  createEvidenceWriter,
  formatPublicError,
  loadChainConfig,
  loadLocalEnv,
  parseChainFlag,
  parseDecimalAmount,
  toBaseUnitString,
} from "./lib/config.mjs";
import {
  assertBridgeSucceeded,
  createBridgeRpcResolver,
  normalizeBridgeStep,
  requireTransferSpeed,
  resolveBridgeRoute,
  summarizeBridgeResult,
} from "./lib/bridge.mjs";
import { createCheckpointStore } from "./lib/checkpoint.mjs";
import { normalizePrivateKey, sleep, withRpcRetry } from "./lib/wallet.mjs";

const USDC_DECIMALS = 6;
const ARRIVAL_ATTEMPTS = 20;
const ARRIVAL_DELAY_MS = 3_000;
const RPC_TRANSPORT_OPTIONS = { retryCount: 6, retryDelay: 1_500 };

function printHelp() {
  console.log(`Usage: node scripts/bridge-to-arc.mjs --source <chain> --amount <human USDC>
       [--chain <key>] [--speed FAST|SLOW] [--use-forwarder] [--dry-run] [--help]

Moves native USDC onto Arc with Circle's Cross-Chain Transfer Protocol (CCTP V2)
through Circle App Kit, so a treasury holding USDC on another chain can fund the
private pool without an intermediate exchange. This is the public funding leg
that runs BEFORE scripts/private-deposit.mjs; it hides nothing and is not
intended to.

CCTP is burn-and-mint: USDC is burned on the source chain, Circle attests the
burn, and native USDC is minted on Arc. There is no wrapped asset and no bridge
custodian.

Gas: the mint step is a transaction on Arc, and Arc pays gas in USDC. A wallet
with a zero Arc balance therefore cannot pay for its own mint. Either keep a
small USDC balance on Arc, or pass --use-forwarder to let Circle's Forwarding
Service submit the mint and take its fee from the transferred amount.

--dry-run resolves the route, asserts both endpoints really are the chains the
route claims, and reports the balances, then stops before writing a checkpoint
or burning anything.

Both legs accept an HTTPS-only RPC override from the gitignored .env.local:
ARC_RPC_URL for Arc, BRIDGE_SOURCE_RPC_URL for the source chain.`);
}

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const args = {
    help: false,
    source: undefined,
    amount: undefined,
    speed: undefined,
    useForwarder: false,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      args.help = true;
      continue;
    }
    if (arg === "--use-forwarder") {
      args.useForwarder = true;
      continue;
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--source" || arg === "--amount" || arg === "--speed") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === "--source") {
        args.source = value;
      } else if (arg === "--amount") {
        args.amount = value;
      } else {
        args.speed = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.help && (!args.source || !args.amount)) {
    throw new Error("both --source and --amount are required");
  }
  requireTransferSpeed(args.speed);
  return args;
}

/**
 * The saved record blocks a second run outright. A CCTP burn is irreversible,
 * so an unfinished transfer must never be replayed on the operator's behalf:
 * the funds are already gone from the source chain and a blind retry would burn
 * a second time.
 *
 * @param {any} previous
 * @param {string} target
 */
function assertResumable(previous, target) {
  if (!previous || previous.verifiedAt) {
    return;
  }
  const burn = (previous.steps ?? []).find(
    (/** @type {any} */ step) => step.name === "burn",
  );
  const detail = burn?.txHash
    ? `The burn was broadcast as ${burn.txHash} on ${previous.sourceChain}.`
    : "No burn transaction was recorded, so the transfer may not have started.";
  throw new Error(
    `a previous ${previous.sourceChain} bridge of ${previous.amount} base units is unfinished. ${detail} ` +
      "A CCTP burn cannot be replayed: check the destination balance and the burn " +
      "transaction before doing anything else. If the mint already landed, or the burn " +
      `never happened, archive the checkpoint by hand (${target}). This command will ` +
      "not retry it for you",
  );
}

async function main() {
  const chainArgs = parseChainFlag(process.argv.slice(2));
  const args = parseArgs(chainArgs.rest);
  if (args.help) {
    printHelp();
    return;
  }

  const config = loadChainConfig(chainArgs.chainKey);
  const env = loadLocalEnv();
  const route = resolveBridgeRoute({ config, source: args.source });
  const resolveEndpoint = createBridgeRpcResolver({ config, route, env });
  const speed = requireTransferSpeed(args.speed);

  const amountUnits = parseDecimalAmount(args.amount, USDC_DECIMALS);
  if (amountUnits === 0n) {
    throw new Error("--amount must be greater than zero");
  }
  const amount = toBaseUnitString(amountUnits);
  const privateKey = normalizePrivateKey(env.OWNER_PRIVATE_KEY);

  const checkpoint = createCheckpointStore({
    chainKey: config.chainKey,
    flow: "cctp_bridge_usdc",
  });
  assertResumable(checkpoint.read().operations.bridge, checkpoint.target);

  const evidence = createEvidenceWriter({
    chainKey: config.chainKey,
    flow: "cctp_bridge",
  });

  const adapter = createViemAdapterFromPrivateKey({
    privateKey,
    capabilities: {
      addressContext: "user-controlled",
      supportedChains: [...route.definitions],
    },
    getPublicClient: ({ chain }) =>
      createPublicClient({
        chain,
        transport: http(resolveEndpoint(chain.id), RPC_TRANSPORT_OPTIONS),
      }),
    getWalletClient: ({ chain, account }) =>
      createWalletClient({
        account,
        chain,
        transport: http(resolveEndpoint(chain.id), RPC_TRANSPORT_OPTIONS),
      }),
  });
  const owner = getAddress(privateKeyToAccount(privateKey).address);

  // Preflight. Assert the endpoints really are the chains the route claims
  // before anything is burned, then prove the source can cover the transfer.
  const sourceClient = createPublicClient({
    transport: http(resolveEndpoint(route.source.chainId), RPC_TRANSPORT_OPTIONS),
  });
  const arcClient = createPublicClient({
    transport: http(resolveEndpoint(config.chainId), RPC_TRANSPORT_OPTIONS),
  });
  const [sourceChainId, arcChainId] = await Promise.all([
    withRpcRetry(() => sourceClient.getChainId()),
    withRpcRetry(() => arcClient.getChainId()),
  ]);
  if (sourceChainId !== route.source.chainId) {
    throw new Error(
      `the source endpoint reports chain ${sourceChainId}, not ${route.source.chainId}`,
    );
  }
  if (arcChainId !== config.chainId) {
    throw new Error(
      `the Arc endpoint reports chain ${arcChainId}, not ${config.chainId}`,
    );
  }

  const sourceUsdc = getAddress(route.source.usdc);
  const arcUsdc = getAddress(config.tokens.USDC.address);
  const [sourceBalance, sourceNative, arcBefore] = await Promise.all([
    withRpcRetry(() =>
      sourceClient.readContract({
        address: sourceUsdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
      }),
    ),
    withRpcRetry(() => sourceClient.getBalance({ address: owner })),
    withRpcRetry(() =>
      arcClient.readContract({
        address: arcUsdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
      }),
    ),
  ]);
  if (sourceBalance < amountUnits) {
    throw new Error(
      `${route.source.name} USDC balance is insufficient for the transfer`,
    );
  }
  if (sourceNative === 0n) {
    throw new Error(
      `${route.source.name} native ${route.source.nativeSymbol ?? "gas"} balance is zero; the approve and burn transactions cannot be paid for`,
    );
  }
  if (arcBefore === 0n && !args.useForwarder) {
    throw new Error(
      "the Arc USDC balance is zero, so this wallet cannot pay gas for its own mint. " +
        "Fund it with a small amount of USDC first, or re-run with --use-forwarder",
    );
  }

  console.log(
    `Bridging ${args.amount} USDC ${route.source.name} (CCTP domain ${route.source.cctpDomain}) -> ${route.destination.name} (domain ${route.destination.cctpDomain})`,
  );

  if (args.dryRun) {
    console.log(`  owner              ${owner}`);
    console.log(`  source USDC        ${sourceUsdc} (${route.source.chain})`);
    console.log(`  source balance     ${sourceBalance} base units`);
    console.log(
      `  source gas         ${sourceNative} wei ${route.source.nativeSymbol ?? ""}`.trimEnd(),
    );
    console.log(`  Arc USDC           ${arcUsdc}`);
    console.log(`  Arc balance        ${arcBefore} base units`);
    console.log(`  transfer speed     ${speed ?? "default"}`);
    console.log(`  forwarding service ${args.useForwarder ? "on" : "off"}`);
    console.log("Dry run only. Nothing was burned and no checkpoint was written.");
    return;
  }

  checkpoint.update((state) => {
    state.operations.bridge = {
      status: "prepared",
      sourceChain: route.source.chain,
      destinationChain: route.destination.chain,
      owner,
      amount,
      transferSpeed: speed ?? null,
      useForwarder: args.useForwarder,
      arcBeforeBalance: arcBefore.toString(),
      steps: [],
      createdAt: new Date().toISOString(),
    };
  });
  evidence("bridge_started", {
    sourceChain: route.source.chain,
    sourceChainId: route.source.chainId,
    sourceCctpDomain: route.source.cctpDomain,
    sourceToken: sourceUsdc,
    destinationChain: route.destination.chain,
    destinationCctpDomain: route.destination.cctpDomain,
    chainId: config.chainId,
    token: arcUsdc,
    tokenSymbol: "USDC",
    tokenDecimals: USDC_DECIMALS,
    amount,
    transferSpeed: speed ?? null,
    beforeBalance: arcBefore,
  });

  const kit = new AppKit();
  // Persist every step the moment Circle reports it. A crash after the burn
  // then still leaves the burn hash on disk, which is the one fact an operator
  // needs to find the funds.
  kit.on("*", (payload) => {
    let step;
    try {
      step = normalizeBridgeStep(payload);
    } catch {
      return;
    }
    checkpoint.update((state) => {
      const record = state.operations.bridge;
      const steps = record.steps.filter(
        (/** @type {any} */ saved) => saved.name !== step.name,
      );
      steps.push({ ...step, observedAt: new Date().toISOString() });
      record.steps = steps;
    });
    console.log(
      `  ${step.name}: ${step.state}${step.txHash ? ` ${step.txHash}` : ""}`,
    );
  });

  const result = await kit.bridge({
    from: { adapter, chain: route.source.chain, address: owner },
    to: {
      adapter,
      chain: route.destination.chain,
      recipientAddress: owner,
      ...(args.useForwarder ? { useForwarder: true } : {}),
    },
    token: "USDC",
    amount: args.amount,
    ...(speed ? { config: { transferSpeed: speed } } : {}),
  });

  const summary = summarizeBridgeResult(result);
  checkpoint.update((state) => {
    state.operations.bridge = {
      ...state.operations.bridge,
      status: summary.state,
      steps: summary.steps.map((step) => ({ ...step })),
      settledAt: new Date().toISOString(),
    };
  });
  assertBridgeSucceeded(summary, `${route.source.name} to Arc bridge`);

  // CCTP charges a protocol fee, and the Forwarding Service charges another, so
  // the credited amount is deliberately NOT asserted to equal the amount sent.
  // Only "something arrived, and no more than was sent" is a safe assertion.
  let arcAfter = arcBefore;
  for (let attempt = 0; attempt < ARRIVAL_ATTEMPTS; attempt += 1) {
    arcAfter = await withRpcRetry(() =>
      arcClient.readContract({
        address: arcUsdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
      }),
    );
    if (arcAfter > arcBefore) break;
    if (attempt + 1 < ARRIVAL_ATTEMPTS) await sleep(ARRIVAL_DELAY_MS);
  }
  const delta = arcAfter - arcBefore;
  if (delta <= 0n) {
    throw new Error(
      "the mint step reported success but the Arc USDC balance has not increased; " +
        "do NOT re-run this command, inspect the mint transaction first",
    );
  }
  if (delta > amountUnits) {
    throw new Error(
      "the Arc USDC balance grew by more than was bridged; an unrelated credit " +
        "landed during the transfer and the delta cannot be attributed",
    );
  }

  evidence("bridge_completed", {
    sourceChain: route.source.chain,
    destinationChain: route.destination.chain,
    state: summary.state,
    stepNames: [...summary.stepNames],
    stepStates: [...summary.stepStates],
    txHashes: [...summary.txHashes],
    token: arcUsdc,
    tokenSymbol: "USDC",
    tokenDecimals: USDC_DECIMALS,
    amount,
    beforeBalance: arcBefore,
    afterBalance: arcAfter,
    delta,
  });
  checkpoint.update((state) => {
    state.operations.bridge = {
      ...state.operations.bridge,
      arcAfterBalance: arcAfter.toString(),
      delta: delta.toString(),
      verifiedAt: new Date().toISOString(),
    };
  });

  const fee = amountUnits - delta;
  console.log(
    `Bridge completed. Arc USDC credited: ${delta} base units (fees ${fee}).`,
  );
  console.log(
    `Next: node scripts/private-deposit.mjs --token USDC --amount <human> to shield it.`,
  );
}

main().catch((error) => {
  process.exitCode = 1;
  console.error(formatPublicError(error, "CCTP bridge to Arc failed"));
});
