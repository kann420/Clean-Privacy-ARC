import { getAddress } from "viem";
import { createUnlinkAdmin } from "@unlink-xyz/sdk/admin";
import {
  account as unlinkAccounts,
  createUnlinkClient,
  evm,
} from "@unlink-xyz/sdk/client";
import { buildDeriveSeedMessage } from "@unlink-xyz/sdk/crypto";

import { DEFAULT_CHAIN_KEY, loadLocalEnv } from "./config.mjs";
import { assertTransactionBudget, computeBufferedGas } from "./wallet.mjs";

// Permanent derivation constants; changing either creates different private
// accounts (ARCHITECTURE.md section 4.1).
export const SENDER_APP_ID = "clean-privacy-arc";
export const RECIPIENT_APP_ID = "clean-privacy-arc-recipient";
/**
 * Protocol fees are collected into an Unlink account, never into a public EVM
 * address. Paying a percentage fee publicly would publish a transaction whose
 * amount is exactly 1/1000 of a private transfer, at the same moment, which
 * would defeat the privacy the transfer just bought.
 */
export const FEE_APP_ID = "clean-privacy-arc-fees";

/**
 * Hosted names add deployment suffixes such as "-production". Require either
 * the exact configured name or a suffix separated by a hyphen.
 *
 * @template {{name: string, chain_id: number}} Environment
 * @param {Environment} environment
 * @param {{unlinkEnvironment: string, chainId: number}} config
 * @returns {Environment}
 */
export function assertUnlinkEnvironment(environment, config) {
  const prefix = config.unlinkEnvironment;
  if (
    environment.chain_id !== config.chainId ||
    (environment.name !== prefix &&
      !environment.name.startsWith(`${prefix}-`))
  ) {
    throw new Error("Unlink environment does not match chain config");
  }
  return environment;
}

/**
 * This is the only helper scripts use for authenticated environment reads, so
 * registration ordering stays structural instead of relying on call-site care.
 *
 * @param {import("@unlink-xyz/sdk/client").UnlinkClient} client
 * @param {{unlinkEnvironment: string, chainId: number}} config
 */
export async function getRegisteredEnvironment(client, config) {
  await client.ensureRegistered();
  return assertUnlinkEnvironment(await client.getEnvironmentInfo(), config);
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} chainKey
 */
export function selectApiKey(env, chainKey) {
  const specificName = `UNLINK_API_KEY_${chainKey
    .replace(/-/gu, "_")
    .toUpperCase()}`;
  const apiKey = env[specificName] || env.UNLINK_API_KEY;
  if (!apiKey) {
    throw new Error(
      `${specificName} or UNLINK_API_KEY is missing from the environment`,
    );
  }
  return apiKey;
}

/**
 * @param {string} chainKey
 */
export function loadApiKey(chainKey) {
  return selectApiKey(loadLocalEnv(), chainKey);
}

/**
 * @param {ReturnType<import("./wallet.mjs").createWalletContext>} wallet
 * @param {number} chainId
 * @param {string} appId
 */
export async function deriveUnlinkAccount(wallet, chainId, appId) {
  const message = buildDeriveSeedMessage({ appId, chainId });
  const signature = await wallet.account.signMessage({ message });
  return unlinkAccounts.fromEthereumSignature({
    signature,
    appId,
    chainId,
  });
}

/**
 * Wrap the stock viem adapter but replace its transaction sender so every
 * Unlink-initiated EOA transaction uses buffered estimates, a pre-broadcast
 * budget assertion, and the crash-safe checkpointed nonce path.
 *
 * @param {ReturnType<import("./wallet.mjs").createWalletContext>} wallet
 */
export function createExplicitGasEvmProvider(wallet) {
  const base = evm.fromViem({
    walletClient: wallet.walletClient,
    publicClient: wallet.publicClient,
  });

  return {
    ...base,
    async sendTransaction(tx) {
      const estimateRequest = {
        account: wallet.account,
        to: getAddress(tx.to),
        data: /** @type {`0x${string}`} */ (tx.data),
        value: tx.value ?? 0n,
      };
      const gas = computeBufferedGas(
        await wallet.publicClient.estimateGas(estimateRequest),
      );
      const request = {
        ...estimateRequest,
        chain: wallet.chain,
        gas,
      };
      await assertTransactionBudget(
        wallet,
        gas,
        estimateRequest.value,
        "Unlink EOA transaction",
      );
      const label = `Unlink EOA ${estimateRequest.to}:${estimateRequest.data.slice(0, 10)}`;
      const broadcast = await wallet.sendHash(
        (nonce) =>
          wallet.walletClient.sendTransaction(
            /** @type {any} */ ({ ...request, nonce }),
          ),
        label,
        {
          kind: "call",
          gas,
          to: estimateRequest.to,
          selector: estimateRequest.data.slice(0, 10),
        },
      );
      if (broadcast.receipt) {
        return broadcast.receipt.transactionHash;
      }
      return broadcast.hash;
    },
  };
}

/**
 * @param {{
 *   config: ReturnType<import("./config.mjs").loadChainConfig>,
 *   wallet: ReturnType<import("./wallet.mjs").createWalletContext>,
 *   appId: string,
 *   admin?: ReturnType<typeof createUnlinkAdmin>,
 * }} options
 */
export async function createUnlinkContext(options) {
  const admin =
    options.admin ??
    createUnlinkAdmin({
      environment: options.config.unlinkEnvironment,
      apiKey: loadApiKey(options.config.chainKey ?? DEFAULT_CHAIN_KEY),
    });
  const unlinkAccount = await deriveUnlinkAccount(
    options.wallet,
    options.config.chainId,
    options.appId,
  );
  const evmProvider = createExplicitGasEvmProvider(options.wallet);
  const client = createUnlinkClient({
    environment: options.config.unlinkEnvironment,
    account: unlinkAccount,
    register: (payload) => admin.users.register(payload),
    authorizationToken: {
      provider: ({ unlinkAddress }) =>
        admin.authorizationTokens.issue({ unlinkAddress }),
    },
    evm: evmProvider,
  });
  const unlinkAddress = await client.getAddress();

  return {
    admin,
    client,
    evmProvider,
    unlinkAccount,
    unlinkAddress,
  };
}

/**
 * @param {import("@unlink-xyz/sdk/client").TransactionResult} result
 * @param {string} label
 */
export function assertProcessedTransaction(result, label) {
  if (result.status !== "processed") {
    throw new Error(`${label} status is ${result.status}, expected processed`);
  }
  if (result.confirmationStatus !== "processed") {
    throw new Error(
      `${label} confirmation status is ${result.confirmationStatus}, expected processed`,
    );
  }
  if (result.fundsUsable !== true) {
    throw new Error(`${label} funds are not usable`);
  }
}

/**
 * Wait once, then recover only by polling the already-accepted transaction
 * id. This function never resubmits a deposit or transfer.
 *
 * @param {import("@unlink-xyz/sdk/client").UnlinkClient} client
 * @param {import("@unlink-xyz/sdk/client").TransactionHandle} handle
 * @param {{onStatus?: (status: string, txId: string) => void}} [options]
 */
export async function waitForProcessedTransaction(client, handle, options = {}) {
  try {
    return await handle.wait({
      until: "processed",
      onStatus: options.onStatus,
    });
  } catch {
    return client.pollTransactionStatus(handle.txId, {
      until: "processed",
      onStatus: options.onStatus,
    });
  }
}

/**
 * @param {import("@unlink-xyz/sdk/client").UnlinkClient} client
 * @param {string} token
 * @param {string} label
 */
export async function getCurrentPrivateBalance(client, token, label) {
  const snapshot = await client.getBalances();
  if (snapshot.sync_status !== "current") {
    throw new Error(`${label} balance sync status is ${snapshot.sync_status}`);
  }
  const normalizedToken = getAddress(token);
  const balance = snapshot.balances.find(
    (item) => getAddress(item.token) === normalizedToken,
  );
  return BigInt(balance?.amount ?? "0");
}

// Server history timestamps come from the server clock while checkpoint
// timestamps are local, so the resume window tolerates bounded skew.
const RECONCILE_CLOCK_SKEW_MS = 10 * 60 * 1000;

/**
 * Reconcile an interrupted private operation using both saved balance
 * snapshots and participant-aware server history. Anything other than one
 * exact processed match is deliberately ambiguous and must stop.
 *
 * `createdAfter` (the checkpoint's local `createdAt`) excludes completed
 * operations from earlier runs that reused the same token, amount, and
 * recipient; a transaction without a parseable `created_at` is retained so
 * a server omission can never promote a retry into a double-send.
 *
 * @param {{
 *   client: import("@unlink-xyz/sdk/client").UnlinkClient,
 *   type: "deposit" | "transfer" | "withdraw",
 *   token: string,
 *   amount: string,
 *   feeAmount?: string,
 *   beforeBalance: string,
 *   expectedDelta: bigint,
 *   recipientAddress?: string,
 *   recipientAddresses?: string[],
 *   createdAfter?: string,
 * }} options
 */
export async function reconcilePrivateOperation(options) {
  const createdAfterMs =
    options.createdAfter === undefined
      ? undefined
      : Date.parse(options.createdAfter);
  if (createdAfterMs !== undefined && !Number.isFinite(createdAfterMs)) {
    throw new Error("reconciliation createdAfter must be a parseable date");
  }
  const [current, history] = await Promise.all([
    getCurrentPrivateBalance(options.client, options.token, "reconciliation"),
    options.client.getTransactions({
      type: options.type,
      limit: 100,
    }),
  ]);
  const normalizedToken = getAddress(options.token);
  const expectedAmount =
    options.type === "transfer"
      ? (
          BigInt(options.amount) + BigInt(options.feeAmount ?? "0")
        ).toString()
      : options.amount;
  const expectedRecipients =
    options.type === "transfer"
      ? new Set(
          options.recipientAddresses ??
            (options.recipientAddress === undefined
              ? []
              : [options.recipientAddress]),
        )
      : new Set();
  const matches = history.transactions.filter((transaction) => {
    if (
      transaction.type !== options.type ||
      transaction.token === null ||
      transaction.token === undefined ||
      getAddress(transaction.token) !== normalizedToken ||
      transaction.amount !== expectedAmount
    ) {
      return false;
    }
    if (createdAfterMs !== undefined) {
      const createdAtMs = Date.parse(transaction.created_at ?? "");
      if (
        Number.isFinite(createdAtMs) &&
        createdAtMs < createdAfterMs - RECONCILE_CLOCK_SKEW_MS
      ) {
        return false;
      }
    }
    const plural = transaction.recipient_addresses;
    const singular = transaction.recipient_address;
    let recipients;
    if (plural !== undefined) {
      if (!Array.isArray(plural)) {
        return false;
      }
      if (singular != null && !plural.includes(singular)) {
        return false;
      }
      recipients = new Set(plural);
    } else {
      recipients = new Set(singular == null ? [] : [singular]);
    }
    return (
      recipients.size === expectedRecipients.size &&
      [...expectedRecipients].every((recipient) => recipients.has(recipient))
    );
  });
  if (matches.length !== 1 || matches[0].status !== "processed") {
    throw new Error(
      `${options.type} reconciliation is ambiguous; hard stop without resubmission`,
    );
  }
  const delta = current - BigInt(options.beforeBalance);
  if (delta !== options.expectedDelta) {
    throw new Error(
      `${options.type} history and private balance snapshot disagree; hard stop`,
    );
  }
  return { transaction: matches[0], currentBalance: current, delta };
}
