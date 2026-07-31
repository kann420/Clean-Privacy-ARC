import { getAddress, zeroAddress } from "viem";

import {
  ROOT_URL,
  createEvidenceWriter,
  formatPublicError,
  loadChainConfig,
  parseChainFlag,
  parseDecimalAmount,
} from "./lib/config.mjs";
import {
  createCheckpointStore,
  writeJsonAtomic,
} from "./lib/checkpoint.mjs";
import {
  MINI_DEX_SEED_CIRBTC,
  MINI_DEX_SEED_USDC,
  assertPhase3Contracts,
  assertPhase3PublicBudget,
  readTokenBalance,
} from "./lib/phase3.mjs";
import {
  UNISWAP_V2_FACTORY_ARTIFACT,
  UNISWAP_V2_PAIR_ARTIFACT,
  assertCanonicalUniswapArtifacts,
  computeUniswapV2PairAddress,
  decideSeedTransfer,
} from "./lib/uniswap-v2.mjs";
import {
  GENEROUS_WRITE_GAS,
  createWalletContext,
  withRpcRetry,
} from "./lib/wallet.mjs";

const DEPLOY_GAS = 5_000_000n;
const CREATE_PAIR_GAS = 3_000_000n;

function parseArgs(argv) {
  const result = {
    seedUsdc: MINI_DEX_SEED_USDC,
    seedCirbtc: MINI_DEX_SEED_CIRBTC,
    confirmLive: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") result.help = true;
    else if (arg === "--confirm-live") result.confirmLive = true;
    else if (arg === "--seed-usdc" || arg === "--seed-cirbtc") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--seed-usdc") result.seedUsdc = value;
      else result.seedCirbtc = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (
    result.seedUsdc !== MINI_DEX_SEED_USDC ||
    result.seedCirbtc !== MINI_DEX_SEED_CIRBTC
  ) {
    throw new Error("live fallback seed must be exactly 5 USDC and 0.00005 cirBTC");
  }
  if (!result.help && !result.confirmLive) {
    throw new Error("--confirm-live is required for DEX deployment");
  }
  return result;
}

async function sendDeploymentStep(options) {
  const existing =
    options.checkpoint.read().operations.miniDex.txHashes[options.key];
  if (existing) {
    const receipt = await withRpcRetry(() =>
      options.wallet.publicClient.waitForTransactionReceipt({
        hash: existing,
      }),
    );
    if (receipt.status !== "success") {
      throw new Error(`${options.label} previously reverted: ${existing}`);
    }
    return receipt;
  }
  const broadcast = await options.wallet.sendHash(
    options.sendTransaction,
    options.label,
    options.intent,
  );
  options.checkpoint.update((value) => {
    value.operations.miniDex.txHashes[options.key] = broadcast.hash;
  });
  return (
    broadcast.receipt ??
    options.wallet.confirm(broadcast.hash, options.label)
  );
}

async function main() {
  const chainArgs = parseChainFlag(process.argv.slice(2));
  const args = parseArgs(chainArgs.rest);
  if (args.help) {
    console.log(
      "Usage: npm run dex:deploy -- --seed-usdc 5 --seed-cirbtc 0.00005 --confirm-live",
    );
    return;
  }
  const config = loadChainConfig(chainArgs.chainKey);
  const wallet = createWalletContext(config, {
    checkpointFlow: "univ2_mini_deployment_eoa",
  });
  const artifactHashes = assertCanonicalUniswapArtifacts();
  const seedUsdc = parseDecimalAmount(
    args.seedUsdc,
    config.tokens.USDC.decimals,
  );
  const seedCirbtc = parseDecimalAmount(
    args.seedCirbtc,
    config.tokens.cirBTC.decimals,
  );
  const checkpoint = createCheckpointStore({
    chainKey: config.chainKey,
    flow: "univ2_mini_deployment",
  });
  let deployment = checkpoint.read().operations.miniDex ?? {
    version: 1,
    chainId: config.chainId,
    owner: getAddress(wallet.account.address),
    seedUsdc: seedUsdc.toString(),
    seedCirbtc: seedCirbtc.toString(),
    factory: null,
    pair: null,
    txHashes: {},
    verifiedAt: null,
  };
  if (
    deployment.version !== 1 ||
    deployment.chainId !== config.chainId ||
    deployment.owner !== getAddress(wallet.account.address) ||
    deployment.seedUsdc !== seedUsdc.toString() ||
    deployment.seedCirbtc !== seedCirbtc.toString()
  ) {
    throw new Error("mini DEX checkpoint does not match the locked deployment");
  }
  if (deployment.verifiedAt) {
    console.log(`Mini DEX already verified: ${deployment.pair}`);
    return;
  }
  await assertPhase3Contracts({
    config,
    publicClient: wallet.publicClient,
  });
  await assertPhase3PublicBudget({
    config,
    publicClient: wallet.publicClient,
    owner: wallet.account.address,
  });
  if (checkpoint.read().operations.miniDex == null) {
    checkpoint.update((value) => {
      value.operations.miniDex = deployment;
    });
  }

  if (deployment.factory == null) {
    const receipt = await sendDeploymentStep({
      wallet,
      checkpoint,
      key: "factory",
      label: "Phase 3 Uniswap V2 Factory deployment",
      sendTransaction: (nonce) =>
        wallet.walletClient.deployContract({
          account: wallet.account,
          chain: wallet.chain,
          abi: UNISWAP_V2_FACTORY_ARTIFACT.abi,
          bytecode: UNISWAP_V2_FACTORY_ARTIFACT.bytecode,
          args: [wallet.account.address],
          nonce,
          gas: DEPLOY_GAS,
        }),
      intent: { kind: "create", gas: DEPLOY_GAS },
    });
    if (!receipt.contractAddress) {
      throw new Error("Factory deployment receipt has no contract address");
    }
    checkpoint.update((value) => {
      value.operations.miniDex.factory = getAddress(receipt.contractAddress);
    });
  }
  deployment = checkpoint.read().operations.miniDex;
  await assertPhase3Contracts({
    config,
    publicClient: wallet.publicClient,
    extraContracts: [deployment.factory],
  });

  let pair = await withRpcRetry(() =>
    wallet.publicClient.readContract({
      address: deployment.factory,
      abi: UNISWAP_V2_FACTORY_ARTIFACT.abi,
      functionName: "getPair",
      args: [config.tokens.USDC.address, config.tokens.cirBTC.address],
    }),
  );
  if (pair === zeroAddress) {
    await sendDeploymentStep({
      wallet,
      checkpoint,
      key: "createPair",
      label: "Phase 3 create USDC cirBTC Pair",
      sendTransaction: (nonce) =>
        wallet.walletClient.writeContract({
          account: wallet.account,
          chain: wallet.chain,
          address: deployment.factory,
          abi: UNISWAP_V2_FACTORY_ARTIFACT.abi,
          functionName: "createPair",
          args: [config.tokens.USDC.address, config.tokens.cirBTC.address],
          nonce,
          gas: CREATE_PAIR_GAS,
        }),
      intent: {
        kind: "call",
        gas: CREATE_PAIR_GAS,
        to: deployment.factory,
        selector: "createPair",
      },
    });
    pair = await withRpcRetry(() =>
      wallet.publicClient.readContract({
        address: deployment.factory,
        abi: UNISWAP_V2_FACTORY_ARTIFACT.abi,
        functionName: "getPair",
        args: [config.tokens.USDC.address, config.tokens.cirBTC.address],
      }),
    );
  }
  pair = getAddress(pair);
  const expectedPair = computeUniswapV2PairAddress(
    deployment.factory,
    config.tokens.USDC.address,
    config.tokens.cirBTC.address,
  );
  if (pair !== expectedPair) {
    throw new Error("Factory Pair address does not match canonical CREATE2");
  }
  const [token0, token1] = await Promise.all([
    withRpcRetry(() =>
      wallet.publicClient.readContract({
        address: pair,
        abi: UNISWAP_V2_PAIR_ARTIFACT.abi,
        functionName: "token0",
      }),
    ),
    withRpcRetry(() =>
      wallet.publicClient.readContract({
        address: pair,
        abi: UNISWAP_V2_PAIR_ARTIFACT.abi,
        functionName: "token1",
      }),
    ),
  ]);
  const configuredTokens = new Set([
    config.tokens.USDC.address.toLowerCase(),
    config.tokens.cirBTC.address.toLowerCase(),
  ]);
  if (
    !configuredTokens.has(token0.toLowerCase()) ||
    !configuredTokens.has(token1.toLowerCase()) ||
    token0.toLowerCase() === token1.toLowerCase()
  ) {
    throw new Error("Pair token ordering does not match USDC/cirBTC");
  }
  await assertPhase3Contracts({
    config,
    publicClient: wallet.publicClient,
    extraContracts: [deployment.factory, pair],
  });
  checkpoint.update((value) => {
    value.operations.miniDex.pair = pair;
  });

  for (const [symbol, intended] of [
    ["USDC", seedUsdc],
    ["cirBTC", seedCirbtc],
  ]) {
    const token = config.tokens[symbol];
    const current = await readTokenBalance(
      wallet.publicClient,
      token.address,
      pair,
    );
    if (decideSeedTransfer(current, intended, symbol) === "transfer") {
      await sendDeploymentStep({
        wallet,
        checkpoint,
        key: `seed${symbol}`,
        label: `Phase 3 seed Pair ${symbol}`,
        sendTransaction: (nonce) =>
          wallet.walletClient.writeContract({
            account: wallet.account,
            chain: wallet.chain,
            address: token.address,
            abi: [
              {
                type: "function",
                name: "transfer",
                stateMutability: "nonpayable",
                inputs: [
                  { name: "to", type: "address" },
                  { name: "amount", type: "uint256" },
                ],
                outputs: [{ name: "", type: "bool" }],
              },
            ],
            functionName: "transfer",
            args: [pair, intended],
            nonce,
            gas: GENEROUS_WRITE_GAS,
          }),
        intent: {
          kind: "call",
          gas: GENEROUS_WRITE_GAS,
          to: token.address,
          selector: "transfer",
        },
      });
    }
  }

  let lpBalance = await withRpcRetry(() =>
    wallet.publicClient.readContract({
      address: pair,
      abi: UNISWAP_V2_PAIR_ARTIFACT.abi,
      functionName: "balanceOf",
      args: [wallet.account.address],
    }),
  );
  if (lpBalance === 0n) {
    await sendDeploymentStep({
      wallet,
      checkpoint,
      key: "mint",
      label: "Phase 3 mint recoverable LP",
      sendTransaction: (nonce) =>
        wallet.walletClient.writeContract({
          account: wallet.account,
          chain: wallet.chain,
          address: pair,
          abi: UNISWAP_V2_PAIR_ARTIFACT.abi,
          functionName: "mint",
          args: [wallet.account.address],
          nonce,
          gas: GENEROUS_WRITE_GAS,
        }),
      intent: {
        kind: "call",
        gas: GENEROUS_WRITE_GAS,
        to: pair,
        selector: "mint",
      },
    });
    lpBalance = await withRpcRetry(() =>
      wallet.publicClient.readContract({
        address: pair,
        abi: UNISWAP_V2_PAIR_ARTIFACT.abi,
        functionName: "balanceOf",
        args: [wallet.account.address],
      }),
    );
  }
  const reserves = await withRpcRetry(() =>
    wallet.publicClient.readContract({
      address: pair,
      abi: UNISWAP_V2_PAIR_ARTIFACT.abi,
      functionName: "getReserves",
    }),
  );
  const expectedReserve0 =
    token0.toLowerCase() === config.tokens.USDC.address.toLowerCase()
      ? seedUsdc
      : seedCirbtc;
  const expectedReserve1 =
    token1.toLowerCase() === config.tokens.USDC.address.toLowerCase()
      ? seedUsdc
      : seedCirbtc;
  if (
    reserves[0] !== expectedReserve0 ||
    reserves[1] !== expectedReserve1 ||
    lpBalance <= 0n
  ) {
    throw new Error("final Pair reserves or recoverable LP balance are invalid");
  }
  const verifiedAt = new Date().toISOString();
  const manifest = {
    version: 1,
    network: config.chainKey,
    chainId: config.chainId,
    factory: deployment.factory,
    pair,
    token0: getAddress(token0),
    token1: getAddress(token1),
    usdc: config.tokens.USDC.address,
    cirbtc: config.tokens.cirBTC.address,
    seedUsdc: seedUsdc.toString(),
    seedCirbtc: seedCirbtc.toString(),
    reserve0: reserves[0].toString(),
    reserve1: reserves[1].toString(),
    lpOwner: getAddress(wallet.account.address),
    lpBalance: lpBalance.toString(),
    factoryArtifactHash: artifactHashes.factoryHash,
    pairInitCodeHash: artifactHashes.pairHash,
    txHashes: checkpoint.read().operations.miniDex.txHashes,
    verifiedAt,
  };
  writeJsonAtomic(
    new URL("deployments/arc-testnet.uniswap-v2-mini.json", ROOT_URL),
    manifest,
  );
  const evidence = createEvidenceWriter({
    chainKey: config.chainKey,
    flow: "uniswap_v2_mini",
  });
  evidence("deployment_verified", {
    status: "verified",
    pairFactory: deployment.factory,
    pair,
    tokenIn: config.tokens.USDC.address,
    tokenOut: config.tokens.cirBTC.address,
    reserve0: reserves[0],
    reserve1: reserves[1],
    lpBalance,
    txHashes: Object.values(manifest.txHashes),
    verifiedAt,
  });
  checkpoint.update((value) => {
    value.operations.miniDex.verifiedAt = verifiedAt;
  });
  console.log(`Mini DEX verified: ${pair}`);
}

main().catch((error) => {
  process.exitCode = 1;
  console.error(formatPublicError(error, "mini DEX deployment failed"));
});
