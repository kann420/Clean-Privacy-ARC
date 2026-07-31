import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  getContractAddress,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { loadLocalEnv, resolveRpcUrl } from "./config.mjs";
import {
  createCheckpointStore,
  reconcilePendingIntent,
} from "./checkpoint.mjs";

export const GENEROUS_WRITE_GAS = 500_000n;
const GAS_BUFFER_NUMERATOR = 120n;
const GAS_BUFFER_DENOMINATOR = 100n;
const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/u;

// The public Arc Testnet RPC rate-limits bursts, so retry with a generous
// delay instead of failing the whole flow on "request limit reached".
const RPC_TRANSPORT_OPTIONS = { retryCount: 6, retryDelay: 1_500 };

/**
 * @param {number} milliseconds
 */
export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * The public RPC returns "request limit reached" as a JSON-RPC error, which
 * transport-level retries do not cover. Retry those with a fixed delay.
 *
 * @template T
 * @param {() => Promise<T>} run
 * @param {{attempts?: number, delayMs?: number}} [options]
 */
export async function withRpcRetry(run, options = {}) {
  const attempts = options.attempts ?? 8;
  const delayMs = options.delayMs ?? 2_000;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/request limit reached|429|rate limit/iu.test(message)) {
        throw error;
      }
      lastError = error;
      await sleep(delayMs);
    }
  }
  throw lastError;
}

// Arc exposes one USDC balance through two precisions: 18-decimal native gas
// and 6-decimal ERC-20 units. These helpers keep the two views typed apart.
const NATIVE_PER_ERC20_USDC = 10n ** 12n;

/**
 * @param {string} value
 * @param {string} label
 */
export function normalizePrivateKey(value, label = "OWNER_PRIVATE_KEY") {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is missing`);
  }
  const candidate = value.startsWith("0x") ? value : `0x${value}`;
  if (!PRIVATE_KEY_PATTERN.test(candidate)) {
    throw new Error(`${label} must be a 32-byte hex private key`);
  }
  return /** @type {`0x${string}`} */ (candidate);
}

/**
 * Buffer a gas estimate by 20%, rounding up.
 *
 * @param {bigint} estimated
 */
export function computeBufferedGas(estimated) {
  if (typeof estimated !== "bigint" || estimated <= 0n) {
    throw new Error("transaction gas estimate is invalid");
  }
  return (
    (estimated * GAS_BUFFER_NUMERATOR + GAS_BUFFER_DENOMINATOR - 1n) /
    GAS_BUFFER_DENOMINATOR
  );
}

/**
 * Convert 6-decimal ERC-20 USDC base units into 18-decimal native units.
 *
 * @param {bigint} erc20Amount
 */
export function usdcErc20ToNative(erc20Amount) {
  if (typeof erc20Amount !== "bigint" || erc20Amount < 0n) {
    throw new Error("ERC-20 USDC amount must be a non-negative bigint");
  }
  return erc20Amount * NATIVE_PER_ERC20_USDC;
}

/**
 * Gas and ERC-20 USDC draw on the same underlying Arc balance, so a planned
 * USDC deposit must leave the projected gas cost plus a buffer untouched.
 *
 * @param {{
 *   nativeBalance: bigint,
 *   projectedGasCost: bigint,
 *   plannedUsdcErc20: bigint,
 *   bufferNative: bigint,
 *   label: string,
 * }} options
 */
export function assertUsdcGasBuffer(options) {
  const required =
    usdcErc20ToNative(options.plannedUsdcErc20) +
    options.projectedGasCost +
    options.bufferNative;
  if (options.nativeBalance < required) {
    throw new Error(
      `USDC balance cannot cover the deposit plus gas buffer before ${options.label}`,
    );
  }
}

/**
 * @param {{publicClient: {getBalance: Function, getGasPrice: Function}, account: {address: `0x${string}`}}} wallet
 * @param {bigint} gas
 * @param {bigint} value
 * @param {string} label
 */
export async function assertTransactionBudget(wallet, gas, value, label) {
  const [balance, gasPrice] = await Promise.all([
    withRpcRetry(() =>
      wallet.publicClient.getBalance({ address: wallet.account.address }),
    ),
    withRpcRetry(() => wallet.publicClient.getGasPrice()),
  ]);
  const required = value + gas * gasPrice;
  if (balance < required) {
    throw new Error(`native balance is insufficient before ${label}`);
  }
}

/**
 * @param {ReturnType<import("./config.mjs").loadChainConfig>} config
 */
function defineConfiguredChain(config) {
  return defineChain({
    id: config.chainId,
    name: config.network,
    nativeCurrency: config.nativeCurrency,
    rpcUrls: { default: { http: [config.rpc] } },
    blockExplorers: {
      default: { name: `${config.network} explorer`, url: config.explorer },
    },
  });
}

/**
 * @param {ReturnType<import("./config.mjs").loadChainConfig>} config
 * @param {{checkpointFlow?: string, env?: Record<string, string>}} [options]
 */
export function createWalletContext(config, options = {}) {
  const env = options.env ?? loadLocalEnv();
  const account = privateKeyToAccount(
    normalizePrivateKey(env.OWNER_PRIVATE_KEY),
  );

  const chain = defineConfiguredChain(config);
  // Transport-only override: `config.rpc` stays the canonical public endpoint
  // that evidence records, while ARC_RPC_URL decides who is actually dialled.
  const rpcUrl = resolveRpcUrl(config, env);
  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl, RPC_TRANSPORT_OPTIONS),
  });
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl, RPC_TRANSPORT_OPTIONS),
  });
  const checkpointStore = createCheckpointStore({
    chainKey: config.chainKey,
    flow: options.checkpointFlow ?? "wallet",
  });

  /**
   * Crash-safe broadcast: reserve the nonce, persist the intent, broadcast,
   * persist the hash. A restart reconciles the stored intent and never
   * double-sends.
   *
   * @template {`0x${string}`} Hash
   * @param {(nonce: number) => Promise<Hash>} sendTransaction
   * @param {string} label
   * @param {{
   *   kind: "create" | "call",
   *   gas: bigint,
   *   to?: string,
   *   selector?: string,
   *   stateCheck?: () => Promise<boolean>,
   * }} intent
   */
  async function sendHash(sendTransaction, label, intent) {
    const current = checkpointStore.read().pendingIntents[label];
    let nonce;
    if (current) {
      const reconciled = await reconcilePendingIntent({
        intent: current,
        publicClient,
        address: account.address,
        stateCheck: intent.stateCheck,
      });
      if (reconciled.state === "confirmed") {
        checkpointStore.update((checkpoint) => {
          delete checkpoint.pendingIntents[label];
        });
        return {
          hash: current.txHash,
          receipt: reconciled.receipt,
          reconciled: true,
        };
      }
      if (reconciled.state === "reverted") {
        throw new Error(`${label} previously reverted: ${current.txHash}`);
      }
      if (reconciled.state !== "not_broadcast") {
        throw new Error(
          `${label} pending intent is ${reconciled.state}; ${reconciled.reason}; hard stop without resubmission`,
        );
      }
      nonce = current.nonce;
    } else {
      nonce = await withRpcRetry(() =>
        publicClient.getTransactionCount({
          address: account.address,
          blockTag: "pending",
        }),
      );
      const predictedAddress =
        intent.kind === "create"
          ? getContractAddress({ from: account.address, nonce: BigInt(nonce) })
          : null;
      checkpointStore.update((checkpoint) => {
        checkpoint.pendingIntents[label] = {
          label,
          nonce,
          kind: intent.kind,
          predictedAddress,
          to: intent.to ? getAddress(intent.to) : null,
          selector: intent.selector ?? null,
          txHash: null,
          createdAt: new Date().toISOString(),
        };
      });
    }
    await assertTransactionBudget(
      { publicClient, account },
      intent.gas,
      0n,
      label,
    );
    const hash = await sendTransaction(nonce);
    checkpointStore.update((checkpoint) => {
      const pending = checkpoint.pendingIntents[label];
      if (!pending || pending.nonce !== nonce) {
        throw new Error(`pending intent changed while broadcasting ${label}`);
      }
      pending.txHash = hash;
      pending.broadcastAt = new Date().toISOString();
    });
    return { hash, receipt: null, reconciled: false };
  }

  /**
   * @param {`0x${string}`} hash
   * @param {string} [label]
   */
  async function confirm(hash, label) {
    if (!label) {
      const entries = Object.entries(checkpointStore.read().pendingIntents);
      label = entries.find(([, pending]) => pending.txHash === hash)?.[0];
    }
    if (!label) {
      throw new Error(`no pending intent matches transaction ${hash}`);
    }
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    checkpointStore.update((checkpoint) => {
      const pending = checkpoint.pendingIntents[label];
      if (pending?.txHash === hash) {
        delete checkpoint.pendingIntents[label];
      }
    });
    if (receipt.status !== "success") {
      throw new Error(`${label} reverted: ${hash}`);
    }
    return receipt;
  }

  /**
   * @template {`0x${string}`} Hash
   * @param {(nonce: number) => Promise<Hash>} sendTransaction
   * @param {string} label
   * @param {Parameters<typeof sendHash>[2]} intent
   */
  async function send(sendTransaction, label, intent) {
    const broadcast = await sendHash(sendTransaction, label, intent);
    if (broadcast.receipt) {
      return broadcast.receipt;
    }
    return confirm(broadcast.hash, label);
  }

  return {
    account,
    chain,
    publicClient,
    walletClient,
    checkpointStore,
    send,
    sendHash,
    confirm,
  };
}

/**
 * Public address of the configured owner key, for read-only scripts.
 */
export function loadOwnerAddress(env = loadLocalEnv()) {
  return privateKeyToAccount(normalizePrivateKey(env.OWNER_PRIVATE_KEY))
    .address;
}

/**
 * @param {ReturnType<import("./config.mjs").loadChainConfig>} config
 */
export function createReadOnlyContext(config) {
  const chain = defineConfiguredChain(config);
  return createPublicClient({
    chain,
    transport: http(resolveRpcUrl(config), RPC_TRANSPORT_OPTIONS),
  });
}
