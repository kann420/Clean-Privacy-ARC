import { describe, expect, it } from "vitest";
import { quickPicks } from "./format";
import { FEES, TOK, type TokenSymbol } from "../config/arc";
import { feeOnTop, parseDecimalUnits } from "./fees";

/**
 * The pick a user reaches for most is "Max", and on a fee-on-top operation it
 * used to produce the one amount the form always rejected: the balance itself,
 * whose fee no longer fits. These tests pin the invariant that makes it sendable
 * — amount + fee never exceeds the balance — including at the precisions where
 * a rounded decimal would push it one unit over.
 */
/** The pills carry their value through `on`, so read it back the way a click would. */
const maxValue = (balance: number, symbol: TokenSymbol, feeBps: number): string => {
  let captured = "";
  const picks = quickPicks(balance, symbol, "", (v) => (captured = v), feeBps);
  picks.find((p) => p.label === "Max")!.on();
  return captured;
};

describe("quickPicks with an on-top fee", () => {
  it("keeps Max spendable: amount + fee fits the balance", () => {
    const balances = ["4.244634", "6.361189", "0.000002", "1", "999999.999999"];
    for (const balance of balances) {
      const decimals = TOK("EURC").dec;
      const balanceUnits = parseDecimalUnits(balance, decimals);
      const value = maxValue(Number(balance), "EURC", FEES.transferBps);
      const split = feeOnTop(parseDecimalUnits(value, decimals), FEES.transferBps);
      expect(split.total).toBeLessThanOrEqual(balanceUnits);
    }
  });

  it("leaves no more than the fee unspent", () => {
    const decimals = TOK("EURC").dec;
    const balanceUnits = parseDecimalUnits("4.244634", decimals);
    const value = maxValue(4.244634, "EURC", FEES.transferBps);
    const split = feeOnTop(parseDecimalUnits(value, decimals), FEES.transferBps);
    // Within one base unit of the balance: the pick is the largest sendable amount.
    expect(balanceUnits - split.total).toBeLessThanOrEqual(1n);
  });

  it("holds at cirBTC precision", () => {
    const decimals = TOK("cirBTC").dec;
    const balanceUnits = parseDecimalUnits("0.10000001", decimals);
    const value = maxValue(0.10000001, "cirBTC", FEES.transferBps);
    const split = feeOnTop(parseDecimalUnits(value, decimals), FEES.transferBps);
    expect(split.total).toBeLessThanOrEqual(balanceUnits);
  });

  it("scales the smaller picks against the same spendable base", () => {
    let half = "";
    const picks = quickPicks(4.244634, "EURC", "", (v) => (half = v), FEES.transferBps);
    picks.find((p) => p.label === "50%")!.on();
    const max = maxValue(4.244634, "EURC", FEES.transferBps);
    const decimals = TOK("EURC").dec;
    const difference =
      parseDecimalUnits(max, decimals) - parseDecimalUnits(half, decimals) * 2n;
    expect(difference).toBeLessThanOrEqual(1n);
  });

  it("without a fee the picks still spend the whole balance", () => {
    expect(maxValue(17.996877, "USDC", 0)).toBe("17.996877");
    expect(maxValue(0, "USDC", 0)).toBe("0.000000");
  });

  it("marks the pick that matches the current input", () => {
    const max = maxValue(4.244634, "EURC", FEES.transferBps);
    const picks = quickPicks(4.244634, "EURC", max, () => {}, FEES.transferBps);
    expect(picks.find((p) => p.label === "Max")!.bg).toBe("var(--navy)");
    expect(picks.find((p) => p.label === "25%")!.bg).toBe("var(--cloud)");
  });
});
