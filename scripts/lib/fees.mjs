/**
 * Protocol fee arithmetic.
 *
 * Every value here is a base-unit bigint. Fees are basis points of the amount,
 * rounded DOWN, so the protocol can never take more than the stated rate and a
 * dust-sized operation simply pays nothing instead of being blocked.
 *
 * Where the fee is taken differs per flow, and the difference is deliberate:
 *
 * - transfer and withdrawal: `feeOnTop`. The sender pays `amount + fee` so the
 *   recipient receives exactly the amount they were promised.
 * - swap: `feeFromInput`. The user chooses what leaves their private balance,
 *   so the fee comes out of that input and the quote is taken on the remainder.
 */

export const BPS_DENOMINATOR = 10_000n;

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 */
export function assertBps(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100) {
    throw new Error(`${label} must be an integer between 0 and 100 basis points`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {bigint}
 */
function assertUnits(value, label) {
  if (typeof value !== "bigint" || value < 0n) {
    throw new Error(`${label} must be a non-negative base-unit bigint`);
  }
  return value;
}

/**
 * Fee for an amount, rounded down.
 *
 * @param {bigint} amountUnits
 * @param {number} bps
 * @returns {bigint}
 */
export function computeFeeUnits(amountUnits, bps) {
  const amount = assertUnits(amountUnits, "fee base amount");
  assertBps(bps, "fee bps");
  return (amount * BigInt(bps)) / BPS_DENOMINATOR;
}

/**
 * Transfers and withdrawals: the recipient gets `amount`, the sender pays
 * `total`.
 *
 * @param {bigint} amountUnits
 * @param {number} bps
 * @returns {{amount: bigint, fee: bigint, total: bigint}}
 */
export function feeOnTop(amountUnits, bps) {
  const amount = assertUnits(amountUnits, "transfer amount");
  if (amount === 0n) {
    throw new Error("transfer amount must be greater than zero");
  }
  const fee = computeFeeUnits(amount, bps);
  return { amount, fee, total: amount + fee };
}

/**
 * Swaps: `input` leaves the private balance, `fee` is taken from it, and `net`
 * is what actually reaches the venue.
 *
 * @param {bigint} inputUnits
 * @param {number} bps
 * @returns {{input: bigint, fee: bigint, net: bigint}}
 */
export function feeFromInput(inputUnits, bps) {
  const input = assertUnits(inputUnits, "swap input");
  if (input === 0n) {
    throw new Error("swap input must be greater than zero");
  }
  const fee = computeFeeUnits(input, bps);
  const net = input - fee;
  if (net <= 0n) {
    throw new Error("swap input is too small to cover the protocol fee");
  }
  return { input, fee, net };
}

/**
 * Read the validated fee policy off a chain config.
 *
 * @param {{fees: {owner: string, transferBps: number, swapBps: number}}} config
 */
export function feePolicy(config) {
  const fees = config?.fees;
  if (!fees || typeof fees.owner !== "string") {
    throw new Error("chain config is missing its fees section");
  }
  return {
    owner: fees.owner,
    transferBps: assertBps(fees.transferBps, "fees.transferBps"),
    swapBps: assertBps(fees.swapBps, "fees.swapBps"),
  };
}

/**
 * Human-readable fee summary for console output and confirmation prompts.
 *
 * @param {{fee: bigint, bps: number, symbol: string, decimals: number}} options
 */
export function describeFee(options) {
  const rate = (options.bps / 100).toFixed(2).replace(/\.?0+$/u, "");
  if (options.fee === 0n) {
    return `fee ${rate}% rounds to zero for this amount`;
  }
  const units = options.fee.toString().padStart(options.decimals + 1, "0");
  const whole = units.slice(0, units.length - options.decimals);
  const fraction = units.slice(units.length - options.decimals);
  const formatted = options.decimals === 0 ? whole : `${whole}.${fraction}`;
  return `fee ${rate}% = ${formatted} ${options.symbol}`;
}
