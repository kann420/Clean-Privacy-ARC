import { erc20Abi, formatUnits, getAddress } from "viem";
import { createUnlinkAdmin } from "@unlink-xyz/sdk/admin";

import {
  createEvidenceWriter,
  formatPublicError,
  loadChainConfig,
  parseChainFlag,
} from "./lib/config.mjs";
import { assertUnlinkEnvironment, loadApiKey } from "./lib/unlink.mjs";
import {
  createReadOnlyContext,
  loadOwnerAddress,
  sleep,
  withRpcRetry,
} from "./lib/wallet.mjs";

const RPC_PACING_MS = 400;

/**
 * Read-only Arc Testnet smoke checks. Runs before registration and never
 * broadcasts, so it needs no checkpoint store and no wallet client.
 */
async function main() {
  const { chainKey } = parseChainFlag(process.argv.slice(2));
  const config = loadChainConfig(chainKey);
  const publicClient = createReadOnlyContext(config);
  const evidence = createEvidenceWriter({
    chainKey: config.chainKey,
    flow: "smoke",
  });

  const rpcChainId = await withRpcRetry(() => publicClient.getChainId());
  if (rpcChainId !== config.chainId) {
    throw new Error(
      `RPC returned chain ${rpcChainId}, expected ${config.chainId}`,
    );
  }
  evidence("rpc_checked", {
    chainId: rpcChainId,
    rpc: config.rpc,
    status: "ok",
  });
  console.log(`RPC chain id ${rpcChainId} matches ${config.chainKey}`);

  const contractChecks = [
    ...Object.values(config.tokens).map((token) => ({
      label: token.symbol,
      address: token.address,
    })),
    { label: "unlinkPool", address: config.protocol.unlinkPool },
    { label: "permit2", address: config.protocol.permit2 },
    { label: "entryPoint", address: config.protocol.entryPoint },
    {
      label: "executionAccountFactory",
      address: config.protocol.executionAccountFactory,
    },
    {
      label: "executionAccountImplementation",
      address: config.protocol.executionAccountImplementation,
    },
  ];
  for (const check of contractChecks) {
    await sleep(RPC_PACING_MS);
    const code = await withRpcRetry(() =>
      publicClient.getCode({ address: getAddress(check.address) }),
    );
    if (!code || code === "0x") {
      throw new Error(`${check.label} has no bytecode at ${check.address}`);
    }
  }
  evidence("bytecode_checked", {
    status: "ok",
    address: contractChecks.map((check) => check.address),
  });
  console.log(`Bytecode present at ${contractChecks.length} configured contracts`);

  for (const token of Object.values(config.tokens)) {
    await sleep(RPC_PACING_MS);
    const symbol = await withRpcRetry(() =>
      publicClient.readContract({
        address: getAddress(token.address),
        abi: erc20Abi,
        functionName: "symbol",
      }),
    );
    await sleep(RPC_PACING_MS);
    const decimals = await withRpcRetry(() =>
      publicClient.readContract({
        address: getAddress(token.address),
        abi: erc20Abi,
        functionName: "decimals",
      }),
    );
    if (decimals !== token.decimals) {
      throw new Error(
        `${token.symbol} reports ${decimals} decimals, config says ${token.decimals}`,
      );
    }
    evidence("token_metadata_checked", {
      token: token.address,
      tokenSymbol: symbol,
      tokenDecimals: decimals,
      status: "ok",
    });
    console.log(`${token.symbol}: on-chain symbol ${symbol}, decimals ${decimals}`);
  }

  // Smoke runs before Unlink registration, so it must not construct an
  // authenticated client: authorization tokens can only be issued for
  // registered addresses. admin.environment() carries every field the
  // assertion needs.
  const admin = createUnlinkAdmin({
    environment: config.unlinkEnvironment,
    apiKey: loadApiKey(config.chainKey),
  });
  const adminEnvironment = assertUnlinkEnvironment(
    await admin.environment(),
    config,
  );
  if (
    getAddress(adminEnvironment.pool_address) !==
    getAddress(config.protocol.unlinkPool)
  ) {
    throw new Error("Unlink pool address does not match chain config");
  }
  if (adminEnvironment.execution_account.enabled !== true) {
    throw new Error("Unlink ExecutionAccounts are not enabled");
  }
  const executionAccount = adminEnvironment.execution_account;
  const expectations = [
    [executionAccount.entry_point_address, config.protocol.entryPoint, "entry point"],
    [
      executionAccount.factory_address,
      config.protocol.executionAccountFactory,
      "factory",
    ],
    [
      executionAccount.account_implementation_address,
      config.protocol.executionAccountImplementation,
      "account implementation",
    ],
  ];
  for (const [reported, configured, label] of expectations) {
    if (getAddress(reported) !== getAddress(configured)) {
      throw new Error(`Unlink ${label} does not match chain config`);
    }
  }
  evidence("unlink_environment_checked", {
    environment: adminEnvironment.name,
    chainId: adminEnvironment.chain_id,
    pool: adminEnvironment.pool_address,
    entryPoint: executionAccount.entry_point_address,
    factory: executionAccount.factory_address,
    accountImplementation: executionAccount.account_implementation_address,
    status: "ok",
  });
  console.log(
    `Unlink environment ${adminEnvironment.name} matches config; ExecutionAccounts enabled`,
  );

  const owner = loadOwnerAddress();
  const nativeBalance = await withRpcRetry(() =>
    publicClient.getBalance({ address: owner }),
  );
  if (nativeBalance === 0n) {
    throw new Error("owner wallet has no native USDC for gas");
  }
  console.log(
    `Owner ${owner} native USDC (gas view): ${formatUnits(nativeBalance, config.nativeCurrency.decimals)}`,
  );
  for (const token of Object.values(config.tokens)) {
    await sleep(RPC_PACING_MS);
    const balance = await withRpcRetry(() =>
      publicClient.readContract({
        address: getAddress(token.address),
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
      }),
    );
    evidence("balances_checked", {
      address: owner,
      token: token.address,
      tokenSymbol: token.symbol,
      amount: balance,
      status: balance === 0n ? "empty" : "funded",
    });
    const formatted = formatUnits(balance, token.decimals);
    if (balance === 0n) {
      console.warn(`WARNING: ${token.symbol} balance is zero`);
    } else {
      console.log(`${token.symbol} balance: ${formatted}`);
    }
  }

  console.log("Arc smoke checks passed");
}

main().catch((error) => {
  process.exitCode = 1;
  console.error(formatPublicError(error, "arc smoke checks failed"));
});
