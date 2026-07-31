import { erc20Abi, getAddress, isAddress } from "viem";

import { sleep as defaultSleep, withRpcRetry } from "./wallet.mjs";

/**
 * Helpers for moving value out of the Unlink pool to a public EVM address.
 *
 * A withdrawal is the one flow where the destination, token, and amount become
 * public, so the verification here is deliberately two-sided: the private
 * balance must fall by exactly the amount, and the destination's public ERC-20
 * balance must rise by exactly the same number of base units.
 */

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * @param {unknown} value
 * @returns {`0x${string}`}
 */
export function assertEvmRecipient(value) {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new Error("withdrawal recipient must be a 20-byte 0x EVM address");
  }
  const address = getAddress(value);
  if (address === ZERO_ADDRESS) {
    throw new Error("withdrawal recipient must not be the zero address");
  }
  return address;
}

/**
 * Privacy hygiene gate. Withdrawing to the same EOA that funded the deposits
 * republishes the link the pool was supposed to break, so it requires an
 * explicit opt-in rather than a warning nobody reads.
 *
 * @param {{recipient: string, depositor: string, allowSelf?: boolean}} options
 */
export function assertRecipientHygiene(options) {
  const recipient = assertEvmRecipient(options.recipient);
  const depositor = assertEvmRecipient(options.depositor);
  if (recipient === depositor && options.allowSelf !== true) {
    throw new Error(
      "withdrawal destination is the same EOA that funds this pool account; " +
        "on-chain this re-links the deposit to the withdrawal. Pass " +
        "--allow-self-withdrawal to proceed anyway",
    );
  }
  return { recipient, depositor, selfWithdrawal: recipient === depositor };
}

/**
 * @param {{
 *   publicClient: {readContract: (options: any) => Promise<bigint>},
 *   token: string,
 *   address: string,
 * }} options
 */
export function readPublicBalance(options) {
  return withRpcRetry(() =>
    options.publicClient.readContract({
      address: getAddress(options.token),
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [getAddress(options.address)],
    }),
  );
}

/**
 * Bounded retries because the RPC's view can trail the Unlink relayer's
 * broadcast by a block or two. Anything other than the exact expected delta
 * eventually hard-stops.
 *
 * @param {{
 *   publicClient: {readContract: (options: any) => Promise<bigint>},
 *   token: string,
 *   address: string,
 *   before: bigint,
 *   expectedDelta: bigint,
 *   attempts?: number,
 *   delayMs?: number,
 *   sleep?: (milliseconds: number) => Promise<void>,
 * }} options
 * @returns {Promise<bigint>} the post-withdrawal public balance
 */
export async function verifyPublicBalanceDelta(options) {
  const attempts = options.attempts ?? 10;
  const delayMs = options.delayMs ?? 3_000;
  const wait = options.sleep ?? defaultSleep;
  if (!Number.isSafeInteger(attempts) || attempts <= 0) {
    throw new Error("public balance verification attempts must be positive");
  }
  if (typeof options.before !== "bigint" || typeof options.expectedDelta !== "bigint") {
    throw new Error("public balance verification requires bigint amounts");
  }

  let last = options.before;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await readPublicBalance(options);
    if (last - options.before === options.expectedDelta) {
      return last;
    }
    if (attempt + 1 < attempts) {
      await wait(delayMs);
    }
  }
  throw new Error(
    "public recipient balance delta did not converge; hard stop " +
      `(expected ${options.expectedDelta}, saw ${last - options.before})`,
  );
}
