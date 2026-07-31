import { decodeFunctionData, erc20Abi } from "viem";
import { describe, expect, it } from "vitest";
import { FEES, TOK, TOKENS } from "../config/arc";
import { feeOnTop, parseDecimalUnits } from "../lib/fees";
import {
  buildPrivateTransferLegs,
  buildSwapPhaseACalls,
} from "./unlinkBackend";

describe("fee leg construction", () => {
  it("puts the private fee in the same multi-recipient transfer", () => {
    const legs = buildPrivateTransferLegs(
      "unlink1recipient",
      50_000n,
      50n,
    );
    expect(legs).toEqual([
      { recipientAddress: "unlink1recipient", amount: "50000" },
      { recipientAddress: FEES.collector, amount: "50" },
    ]);
  });

  it("omits a rounded-to-zero private fee leg", () => {
    expect(buildPrivateTransferLegs("unlink1recipient", 9n, 0n)).toHaveLength(1);
  });

  it("builds exact approval and public owner transfer for Swap Phase A", () => {
    const calls = buildSwapPhaseACalls(99_950n, 50n);
    expect(calls).toHaveLength(2);
    const approval = decodeFunctionData({ abi: erc20Abi, data: calls[0]!.data });
    const fee = decodeFunctionData({ abi: erc20Abi, data: calls[1]!.data });
    expect(approval.functionName).toBe("approve");
    expect(approval.args).toEqual([
      expect.any(String),
      99_950n,
    ]);
    expect(fee.functionName).toBe("transfer");
    expect(fee.args).toEqual([FEES.owner, 50n]);
  });
});

describe("token-generic flows cover every configured token", () => {
  it("keeps all three tokens available for deposit, transfer and withdrawal", () => {
    // Only the swap venue is EURC-only; the value-moving flows are generic.
    expect(TOKENS.map((token) => token.symbol)).toEqual([
      "USDC",
      "EURC",
      "cirBTC",
    ]);
  });

  it("builds a cirBTC transfer fee leg at eight decimals", () => {
    // 0.00050000 cirBTC is 50000 base units; 10 bps of that is exactly 50.
    const amount = parseDecimalUnits("0.0005", TOK("cirBTC").dec);
    expect(amount).toBe(50_000n);
    const split = feeOnTop(amount, FEES.transferBps);
    expect(split.fee).toBe(50n);
    expect(split.total).toBe(50_050n);
    expect(buildPrivateTransferLegs("unlink1recipient", split.amount, split.fee)).toEqual([
      { recipientAddress: "unlink1recipient", amount: "50000" },
      { recipientAddress: FEES.collector, amount: "50" },
    ]);
  });

  it("rounds a dust cirBTC fee to zero and drops the leg", () => {
    // 0.00000999 cirBTC is 999 base units; 10 bps rounds down to nothing.
    const amount = parseDecimalUnits("0.00000999", TOK("cirBTC").dec);
    expect(amount).toBe(999n);
    const split = feeOnTop(amount, FEES.transferBps);
    expect(split.fee).toBe(0n);
    expect(
      buildPrivateTransferLegs("unlink1recipient", split.amount, split.fee),
    ).toHaveLength(1);
  });
});
