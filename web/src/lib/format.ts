import { TOK, type TokenSymbol } from "../config/arc";
import { BPS_DENOMINATOR, formatUnitsString, toBaseUnits } from "./fees";

export const short = (value: string, l = 6, r = 4): string =>
  value.length <= l + r ? value : value.slice(0, l) + "…" + value.slice(-r);

/**
 * Always renders at the token's configured precision: 6 for USDC and EURC, 8 for
 * cirBTC. The mock printed seeded operations at full precision but formatted new ones
 * at four decimals, so the same balance was written two different ways.
 */
export const fmt = (value: number, symbol: string): string =>
  Number(value || 0).toFixed(TOK(symbol).dec);

export const atDec = fmt;

export const QUICK = [
  { label: "25%", f: 0.25 },
  { label: "50%", f: 0.5 },
  { label: "75%", f: 0.75 },
  { label: "Max", f: 1 },
] as const;

export type QuickPick = { label: string; on: () => void; bg: string; fg: string };

/**
 * Quick amount picks. The value is written at the token's own precision so the pill can
 * tell whether the field still holds exactly that fraction.
 *
 * `feeBps` is the on-top protocol fee of the operation the picks feed. Transfers
 * and withdrawals charge the fee on top of the amount, so "Max" against the raw
 * balance always failed validation: the amount fit, amount + fee did not. The
 * picks are therefore taken against the spendable base — the largest amount
 * whose own fee still fits — and the whole computation runs in base units with
 * BigInt so `toFixed` can never round the result back above the balance.
 */
export const quickPicks = (
  base: number,
  symbol: TokenSymbol,
  current: string,
  set: (value: string) => void,
  feeBps = 0,
): QuickPick[] => {
  const decimals = TOK(symbol).dec;
  const baseUnits = toBaseUnits(Math.max(0, base), decimals);
  const spendable =
    feeBps > 0
      ? (baseUnits * BPS_DENOMINATOR) / (BPS_DENOMINATOR + BigInt(feeBps))
      : baseUnits;
  return QUICK.map((q) => {
    // Fractions are integer percentages, so a hundredth keeps this exact.
    const value = formatUnitsString(
      (spendable * BigInt(Math.round(q.f * 100))) / 100n,
      decimals,
    );
    const selected = current === value;
    return {
      label: q.label,
      on: () => set(value),
      bg: selected ? "var(--navy)" : "var(--cloud)",
      fg: selected ? "#FFFFFF" : "var(--ink)",
    };
  });
};

/** Explorer link for an address. */
export const addressLink = (explorer: string, address: string): string =>
  explorer + "/address/" + address;

/** Explorer link for a transaction hash. */
export const txLink = (explorer: string, hash: string): string =>
  explorer + "/tx/" + hash;

/** Operation ids are shown the way the CLI evidence records them: head…tail. */
export const shortId = (id: string): string => (id.length <= 13 ? id : id.slice(0, 8) + "…" + id.slice(-4));
