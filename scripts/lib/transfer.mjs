import { getCurrentPrivateBalance } from "./unlink.mjs";
import { sleep as defaultSleep } from "./wallet.mjs";

const UNLINK_ADDRESS_PATTERN = /^unlink1[02-9ac-hj-np-z]{8,}$/u;

/**
 * @param {unknown} value
 * @returns {string}
 */
export function assertUnlinkAddress(value) {
  if (typeof value !== "string" || !UNLINK_ADDRESS_PATTERN.test(value)) {
    throw new Error("recipient Unlink address is invalid");
  }
  return value;
}

/**
 * Verify exact private balance deltas for one or more participants with
 * bounded retries. Sync-status errors and not-yet-visible deltas retry;
 * any other read failure rethrows immediately.
 *
 * @param {{
 *   tokenAddress: string,
 *   participants: {
 *     client: import("@unlink-xyz/sdk/client").UnlinkClient,
 *     label: string,
 *     before: bigint,
 *     expectedDelta: bigint,
 *   }[],
 *   attempts?: number,
 *   delayMs?: number,
 *   sleep?: (milliseconds: number) => Promise<void>,
 * }} options
 * @returns {Promise<bigint[]>} post-operation balances, in participant order
 */
export async function verifyBalanceDeltas(options) {
  const attempts = options.attempts ?? 10;
  const delayMs = options.delayMs ?? 3_000;
  const wait = options.sleep ?? defaultSleep;
  if (!Number.isSafeInteger(attempts) || attempts <= 0) {
    throw new Error("balance verification attempts must be positive");
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
    throw new Error("balance verification delay must be non-negative");
  }
  if (!Array.isArray(options.participants) || options.participants.length === 0) {
    throw new Error("balance verification requires at least one participant");
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const reads = await Promise.allSettled(
      options.participants.map((participant) =>
        getCurrentPrivateBalance(
          participant.client,
          options.tokenAddress,
          participant.label,
        ),
      ),
    );
    const hardFailure = reads.find(
      (result) =>
        result.status === "rejected" &&
        !/sync status/iu.test(
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
        ),
    );
    if (hardFailure?.status === "rejected") {
      throw hardFailure.reason;
    }

    if (reads.every((result) => result.status === "fulfilled")) {
      const balances = reads.map((result) => result.value);
      if (
        options.participants.every(
          (participant, index) =>
            balances[index] - participant.before === participant.expectedDelta,
        )
      ) {
        return balances;
      }
    }

    if (attempt + 1 < attempts) {
      await wait(delayMs);
    }
  }

  throw new Error(
    "private balance delta verification did not converge; hard stop",
  );
}

/**
 * Verify a private transfer. With a protocol fee the transfer carries two
 * recipients in one transaction, so all three balances are checked together:
 * the sender pays `amount + fee`, the recipient receives exactly `amount`, and
 * the fee account receives exactly `fee`.
 *
 * @param {{
 *   senderClient: import("@unlink-xyz/sdk/client").UnlinkClient,
 *   recipientClient: import("@unlink-xyz/sdk/client").UnlinkClient,
 *   tokenAddress: string,
 *   senderBefore: bigint,
 *   recipientBefore: bigint,
 *   amount: bigint,
 *   fee?: bigint,
 *   feeClient?: import("@unlink-xyz/sdk/client").UnlinkClient,
 *   feeBefore?: bigint,
 *   attempts?: number,
 *   delayMs?: number,
 *   sleep?: (milliseconds: number) => Promise<void>,
 * }} options
 */
export async function verifyTransferDeltas(options) {
  const fee = options.fee ?? 0n;
  if (typeof fee !== "bigint" || fee < 0n) {
    throw new Error("transfer fee must be a non-negative bigint");
  }
  const collectsFee = fee > 0n;
  if (collectsFee && (!options.feeClient || options.feeBefore === undefined)) {
    throw new Error("a non-zero transfer fee requires the fee account snapshot");
  }

  const participants = [
    {
      client: options.senderClient,
      label: "sender transfer verification",
      before: options.senderBefore,
      expectedDelta: -(options.amount + fee),
    },
    {
      client: options.recipientClient,
      label: "recipient transfer verification",
      before: options.recipientBefore,
      expectedDelta: options.amount,
    },
  ];
  if (collectsFee) {
    participants.push({
      client: options.feeClient,
      label: "fee account transfer verification",
      before: options.feeBefore,
      expectedDelta: fee,
    });
  }

  const [senderAfter, recipientAfter, feeAfter] = await verifyBalanceDeltas({
    tokenAddress: options.tokenAddress,
    participants,
    attempts: options.attempts,
    delayMs: options.delayMs,
    sleep: options.sleep,
  });
  return collectsFee
    ? { senderAfter, recipientAfter, feeAfter }
    : { senderAfter, recipientAfter };
}

/**
 * Route a checkpointed private operation resume. `verifiedAt` is the only
 * done gate; an SDK status alone never marks an operation complete.
 *
 * @param {Record<string, unknown> | null | undefined} operation
 * @returns {"fresh" | "poll" | "reconcile" | "done"}
 */
export function resolveOperationResume(operation) {
  if (!operation) {
    return "fresh";
  }
  if (operation.verifiedAt) {
    return "done";
  }
  if (operation.txId) {
    return "poll";
  }
  return "reconcile";
}

/**
 * Normalize a participant-aware history transaction into the camel-case
 * result shape `assertProcessedTransaction` expects.
 *
 * @param {{
 *   id: string,
 *   tx_hash?: string | null,
 *   status: string,
 *   confirmation_status: string,
 *   funds_usable: boolean,
 * }} transaction
 */
export function resultFromHistory(transaction) {
  return {
    txId: transaction.id,
    txHash: transaction.tx_hash ?? null,
    status: transaction.status,
    confirmationStatus: transaction.confirmation_status,
    fundsUsable: transaction.funds_usable,
  };
}
