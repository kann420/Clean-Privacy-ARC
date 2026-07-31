import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ROOT_URL, assertChainKey } from "./config.mjs";

const FLOW_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/u;

/**
 * @param {URL | string} target
 * @param {unknown} value
 */
export function writeJsonAtomic(target, value) {
  const path = target instanceof URL ? fileURLToPath(target) : target;
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

/**
 * Local, gitignored recovery state under `checkpoints/`. Committed evidence
 * lives only under `deployments/evidence/`.
 *
 * @param {{
 *   chainKey: string,
 *   flow: string,
 *   target?: URL | string,
 * }} options
 */
export function createCheckpointStore(options) {
  const chainKey = assertChainKey(options.chainKey);
  if (!FLOW_PATTERN.test(options.flow)) {
    throw new Error(`invalid checkpoint flow: ${options.flow}`);
  }
  const target =
    options.target ??
    new URL(
      `checkpoints/${chainKey}.${options.flow}.checkpoint.json`,
      ROOT_URL,
    );

  function fresh() {
    return {
      version: 1,
      chainKey,
      flow: options.flow,
      pendingIntents: {},
      executions: {},
      operations: {},
    };
  }

  function read() {
    if (!existsSync(target)) {
      return fresh();
    }
    const value = JSON.parse(readFileSync(target, "utf8"));
    if (
      value?.version !== 1 ||
      value?.chainKey !== chainKey ||
      value?.flow !== options.flow ||
      typeof value.pendingIntents !== "object" ||
      value.pendingIntents === null ||
      typeof value.executions !== "object" ||
      value.executions === null ||
      typeof value.operations !== "object" ||
      value.operations === null
    ) {
      throw new Error(`checkpoint is invalid for ${chainKey}/${options.flow}`);
    }
    return value;
  }

  /**
   * @param {(value: ReturnType<typeof fresh>) => void} mutate
   */
  function update(mutate) {
    const value = read();
    mutate(value);
    writeJsonAtomic(target, value);
    return value;
  }

  return { target, read, update };
}

/**
 * Build an SDK `onStatus` callback that durably records the transaction id
 * and every reported status before returning to the SDK.
 *
 * @param {{
 *   store: ReturnType<typeof createCheckpointStore>,
 *   label: string,
 *   onPersist?: (status: string, txId: string) => void,
 * }} options
 */
export function createTransactionStatusPersister(options) {
  return function persistTransactionStatus(status, txId) {
    options.store.update((checkpoint) => {
      const current = checkpoint.operations[options.label] ?? {};
      checkpoint.operations[options.label] = {
        ...current,
        txId,
        status,
        updatedAt: new Date().toISOString(),
      };
    });
    options.onPersist?.(status, txId);
  };
}

/**
 * Reconcile a pending EOA broadcast without guessing. A known receipt is
 * authoritative. Without a hash, an unchanged pending nonce proves no
 * transaction was accepted; an advanced nonce requires CREATE bytecode or a
 * caller-supplied state check and still hard-stops when the hash is
 * unavailable.
 *
 * @param {{
 *   intent: {
 *     nonce: number,
 *     txHash?: `0x${string}` | null,
 *     kind: "create" | "call",
 *     predictedAddress?: `0x${string}` | null,
 *   },
 *   publicClient: {
 *     getTransactionReceipt: (options: {hash: `0x${string}`}) => Promise<any>,
 *     getTransactionCount: (options: {address: `0x${string}`, blockTag: "pending"}) => Promise<number>,
 *     getCode: (options: {address: `0x${string}`}) => Promise<string | undefined>,
 *   },
 *   address: `0x${string}`,
 *   stateCheck?: () => Promise<boolean>,
 * }} options
 */
export async function reconcilePendingIntent(options) {
  if (options.intent.txHash) {
    try {
      const receipt = await options.publicClient.getTransactionReceipt({
        hash: options.intent.txHash,
      });
      return receipt.status === "success"
        ? { state: "confirmed", receipt }
        : { state: "reverted", receipt };
    } catch {
      return { state: "ambiguous", reason: "known hash has no receipt" };
    }
  }
  const pendingNonce = await options.publicClient.getTransactionCount({
    address: options.address,
    blockTag: "pending",
  });
  if (pendingNonce <= options.intent.nonce) {
    return { state: "not_broadcast" };
  }
  if (options.intent.kind === "create" && options.intent.predictedAddress) {
    const code = await options.publicClient.getCode({
      address: options.intent.predictedAddress,
    });
    if (code && code !== "0x") {
      return {
        state: "confirmed_without_hash",
        reason: "predicted CREATE address has bytecode",
      };
    }
  }
  if (options.stateCheck && (await options.stateCheck())) {
    return {
      state: "confirmed_without_hash",
      reason: "caller state check confirms the intended effect",
    };
  }
  return {
    state: "ambiguous",
    reason: "sender nonce advanced without a recoverable transaction hash",
  };
}
