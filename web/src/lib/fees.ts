/**
 * Fee arithmetic, mirrored from scripts/lib/fees.mjs. Everything is done in base
 * units with BigInt so a percentage never introduces a floating-point remainder,
 * and the fee is always rounded down.
 *
 * Transfers and withdrawals charge on top: the recipient receives exactly the
 * amount, the sender pays amount + fee. Swaps take the fee out of the input.
 */

export const BPS_DENOMINATOR = 10_000n;

export type FeeSplit = { amount: bigint; fee: bigint; total: bigint };
export type InputSplit = { input: bigint; fee: bigint; net: bigint };

export function parseDecimalUnits(value: string, decimals: number): bigint {
  const text = value.trim();
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/u.exec(text);
  if (!match) throw new Error("Amount must be a plain positive decimal.");
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    throw new Error(`Amount has more than ${decimals} decimal places.`);
  }
  return (
    BigInt(match[1]!) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0")
  );
}

export function formatUnitsString(value: string | bigint, decimals: number): string {
  const units = BigInt(value);
  const negative = units < 0n;
  const digits = (negative ? -units : units)
    .toString()
    .padStart(decimals + 1, "0");
  const whole = decimals === 0 ? digits : digits.slice(0, -decimals);
  const fraction = decimals === 0 ? "" : digits.slice(-decimals);
  return `${negative ? "-" : ""}${whole}${decimals === 0 ? "" : `.${fraction}`}`;
}

export const toBaseUnits = (value: number, decimals: number): bigint =>
  BigInt(Math.round(value * 10 ** decimals));

export const fromBaseUnits = (value: bigint, decimals: number): number =>
  Number(value) / 10 ** decimals;

export const computeFeeUnits = (amountUnits: bigint, bps: number): bigint =>
  (amountUnits * BigInt(bps)) / BPS_DENOMINATOR;

/** Transfers and withdrawals. */
export function feeOnTop(amountUnits: bigint, bps: number): FeeSplit {
  const fee = computeFeeUnits(amountUnits, bps);
  return { amount: amountUnits, fee, total: amountUnits + fee };
}

/** Swaps: the fee is deducted from what leaves the private balance. */
export function feeFromInput(inputUnits: bigint, bps: number): InputSplit {
  const fee = computeFeeUnits(inputUnits, bps);
  return { input: inputUnits, fee, net: inputUnits - fee };
}

/** Basis points as a display percentage: 10 -> "0.1%". */
export const bpsLabel = (bps: number): string =>
  `${(bps / 100).toFixed(2).replace(/\.?0+$/u, "")}%`;
