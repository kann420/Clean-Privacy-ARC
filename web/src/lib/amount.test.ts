import { describe, expect, it } from "vitest";
import {
  detectRecipient,
  parseAmount,
  sanitizeAmountInput,
  validateRecipient,
  withdrawalWarnings,
} from "./amount";
import { FEES, ROUTES, SLIPPAGE, TOK } from "../config/arc";
import { bpsLabel, feeFromInput, feeOnTop } from "./fees";
import { fmt } from "./format";

const usdc = { symbol: "USDC", decimals: 6, available: 17.996877, kind: "public" as const };

describe("sanitizeAmountInput", () => {
  it("keeps a single decimal point", () => {
    expect(sanitizeAmountInput("1.2.3", 6)).toBe("1.23");
  });
  it("drops anything that is not a digit or a dot", () => {
    expect(sanitizeAmountInput("1e9-x2", 6)).toBe("192");
  });
  it("clamps the fraction to the token precision", () => {
    expect(sanitizeAmountInput("0.123456789", 6)).toBe("0.123456");
    expect(sanitizeAmountInput("0.123456789", 8)).toBe("0.12345678");
  });
});

describe("parseAmount", () => {
  it("rejects an empty field", () => {
    expect(parseAmount("", usdc)).toEqual({ ok: false, error: "Enter an amount." });
  });

  it("rejects a malformed number instead of treating NaN as zero", () => {
    const result = parseAmount("1.2.3", usdc);
    expect(result.ok).toBe(false);
  });

  it("rejects zero", () => {
    const result = parseAmount("0", usdc);
    expect(result).toEqual({ ok: false, error: "Amount must be greater than zero." });
  });

  it("rejects more decimals than the token has", () => {
    const result = parseAmount("0.1234567", usdc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("6 decimals");
  });

  it("rejects an amount above the spendable balance", () => {
    const result = parseAmount("999", usdc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("exceeds the spendable public balance");
  });

  it("rejects any amount when nothing is spendable", () => {
    const result = parseAmount("0.1", { ...usdc, available: 0, kind: "private" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("No spendable private USDC balance");
  });

  it("accepts an amount exactly at the balance", () => {
    expect(parseAmount("17.996877", usdc)).toEqual({ ok: true, value: 17.996877 });
  });

  it("accepts cirBTC at eight decimals", () => {
    const result = parseAmount("0.00005000", {
      symbol: "cirBTC",
      decimals: TOK("cirBTC").dec,
      available: 0.00005,
      kind: "private",
    });
    expect(result).toEqual({ ok: true, value: 0.00005 });
  });
});

describe("validateRecipient", () => {
  const valid =
    "unlink1qq5hyn92dvk0wsu44qq22y7hag5gykx90fvxd4085hzd49sqvsg4lrrkvr9ayf4dj55rdr4txqhksdzam3mgx9v3fxn5drgjsefwm02kg3z0y3";
  const evm = "0x5f68f040ce9c7e4980b3a4d3a5dde17ea9db9fb6";
  const checksummed = "0x5F68f040cE9C7E4980b3a4D3A5DDe17eA9db9fb6";

  it("rejects an empty recipient", () => {
    expect(validateRecipient("")).toContain("Enter a recipient");
  });
  it("accepts an all-lowercase EVM address, which means a withdrawal", () => {
    expect(validateRecipient(evm)).toBeNull();
    expect(detectRecipient(evm)).toBe("evm");
  });
  it("accepts a valid checksummed EVM address", () => {
    expect(validateRecipient(checksummed)).toBeNull();
  });
  it("accepts an all-uppercase EVM address", () => {
    expect(validateRecipient(evm.toUpperCase().replace("0X", "0x"))).toBeNull();
  });
  it("rejects a mixed-case EVM address with a bad checksum", () => {
    expect(
      validateRecipient(
        "0x5f68F040cE9C7E4980b3a4D3A5DDe17eA9DB9fB6",
      ),
    ).toBe(
      "This address fails its EIP-55 checksum; re-copy it from the source.",
    );
  });
  it("rejects a malformed EVM address", () => {
    expect(validateRecipient("0x1234")).toContain("40 hex characters");
    expect(validateRecipient("0x" + "0".repeat(40))).toContain("zero address");
  });
  it("rejects something that is neither", () => {
    expect(validateRecipient("alice.eth")).toContain("neither");
  });
  it("rejects a truncated unlink1 address", () => {
    expect(validateRecipient("unlink1qq5hyn92")).toContain("too short");
  });
  it("rejects sending to yourself", () => {
    expect(validateRecipient(valid, valid)).toContain("your own account");
  });
  it("accepts a well-formed unlink1 recipient", () => {
    expect(validateRecipient(valid)).toBeNull();
    expect(detectRecipient(valid)).toBe("unlink");
  });
});

describe("protocol fees", () => {
  it("charges 10 bps on top of a transfer, rounded down", () => {
    expect(feeOnTop(50_000n, FEES.transferBps)).toEqual({ amount: 50_000n, fee: 50n, total: 50_050n });
    expect(feeOnTop(999n, FEES.transferBps).fee).toBe(0n);
  });

  it("takes 5 bps out of a swap input", () => {
    const split = feeFromInput(50_000n, FEES.swapBps);
    expect(split).toEqual({ input: 50_000n, fee: 25n, net: 49_975n });
    expect(split.fee + split.net).toBe(split.input);
  });

  it("rejects an amount whose fee no longer fits the balance", () => {
    const balance = 1;
    const fee = Number(feeOnTop(1_000_000n, FEES.transferBps).fee) / 1e6;
    const result = parseAmount("1", { symbol: "USDC", decimals: 6, available: balance, kind: "private", fee });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("protocol fee is charged on top");
  });

  it("accepts an amount that leaves room for the fee", () => {
    const result = parseAmount("0.9", {
      symbol: "USDC",
      decimals: 6,
      available: 1,
      kind: "private",
      fee: 0.0009,
    });
    expect(result).toEqual({ ok: true, value: 0.9 });
  });

  it("renders basis points as a percentage", () => {
    expect(bpsLabel(FEES.transferBps)).toBe("0.1%");
    expect(bpsLabel(FEES.swapBps)).toBe("0.05%");
  });
});

describe("withdrawal privacy warnings", () => {
  const wallet = "0xD7E004CBda24E079aA3A657Ba7f8E2915192a966";

  it("warns when the destination is the depositing wallet", () => {
    const warnings = withdrawalWarnings({
      recipient: wallet.toLowerCase(),
      wallet,
      amount: 0.1,
      recentDeposits: [],
    });
    expect(warnings.some((w) => w.includes("re-links"))).toBe(true);
  });

  it("warns when the amount matches a deposit from this session", () => {
    const warnings = withdrawalWarnings({
      recipient: "0x5f68f040ce9c7e4980b3a4d3a5dde17ea9db9fb6",
      wallet,
      amount: 1,
      recentDeposits: [1],
    });
    expect(warnings.some((w) => w.includes("Matching amounts"))).toBe(true);
  });

  it("stays quiet for an unrelated destination and amount", () => {
    expect(
      withdrawalWarnings({
        recipient: "0x5f68f040ce9c7e4980b3a4d3a5dde17ea9db9fb6",
        wallet,
        amount: 0.37,
        recentDeposits: [1],
      }),
    ).toEqual([]);
  });
});

describe("swap quotes", () => {
  it("keeps the EURC minimum out strictly below the quote", () => {
    const quote = ROUTES.eurc.quote(0.1);
    const min = ROUTES.eurc.min(0.1);
    expect(min).toBeLessThan(quote);
    expect(min).toBeCloseTo(quote * (1 - SLIPPAGE), 12);
  });

  it("reproduces the live Circle capture: 0.1 USDC -> 0.077592 EURC, min 0.075264", () => {
    expect(fmt(ROUTES.eurc.quote(0.1), "EURC")).toBe("0.077592");
    expect(fmt(ROUTES.eurc.min(0.1), "EURC")).toBe("0.075264");
  });

  it("formats every token at its configured precision", () => {
    expect(fmt(1, "USDC")).toBe("1.000000");
    expect(fmt(1, "EURC")).toBe("1.000000");
    expect(fmt(0.0001, "cirBTC")).toBe("0.00010000");
  });
});
