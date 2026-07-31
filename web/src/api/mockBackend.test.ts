import { describe, expect, it } from "vitest";
import { MockBackend } from "./mockBackend";
import { BackendError } from "./types";

const registered = () =>
  new MockBackend({ status: "registered", delayScale: 0 });
const fresh = (status: "none" | "derived" = "none") =>
  new MockBackend({ status, delayScale: 0 });
const noop = () => {};

describe("private balances before registration", () => {
  it("reports zero private units and no history while not derived", async () => {
    const session = await fresh().getSession();
    expect(session.status).toBe("none");
    expect(session.privateBalances).toEqual({
      USDC: "0",
      EURC: "0",
      cirBTC: "0",
    });
    expect(session.operations).toEqual([]);
    expect(session.activity).toEqual([]);
  });

  it("still reports zero after derivation", async () => {
    const session = await fresh().deriveAccount();
    expect(session.status).toBe("derived");
    expect(session.privateBalances.USDC).toBe("0");
  });

  it("loads balances and history once registered", async () => {
    const backend = fresh("derived");
    const session = await backend.registerAccount();
    expect(session.status).toBe("registered");
    expect(BigInt(session.privateBalances.USDC)).toBeGreaterThan(0n);
    expect(session.operations.length).toBeGreaterThan(0);
  });

  it("refuses every operation until registered", async () => {
    await expect(
      fresh().deposit({ token: "USDC", amount: "1" }, noop),
    ).rejects.toBeInstanceOf(BackendError);
  });
});

describe("wallet and v2 session", () => {
  it("connects and disconnects an explicit wallet kind", async () => {
    const backend = fresh();
    expect((await backend.connectWallet("burner")).walletKind).toBe("burner");
    const disconnected = await backend.disconnectWallet();
    expect(disconnected.wallet).toBeNull();
    expect(disconnected.walletKind).toBeNull();
  });

  it("uses base-unit strings in every session balance", async () => {
    const session = await registered().getSession();
    expect(session.publicBalances.USDC).toMatch(/^\d+$/u);
    expect(session.privateBalances.EURC).toMatch(/^\d+$/u);
  });
});

describe("deposit", () => {
  it("moves the exact base units from public to private", async () => {
    const backend = registered();
    const before = await backend.getSession();
    await backend.deposit({ token: "EURC", amount: "1.5" }, noop);
    const after = await backend.getSession();
    expect(
      BigInt(before.publicBalances.EURC) - BigInt(after.publicBalances.EURC),
    ).toBe(1_500_000n);
    expect(
      BigInt(after.privateBalances.EURC) - BigInt(before.privateBalances.EURC),
    ).toBe(1_500_000n);
  });

  it("rejects a deposit above the public balance without movement", async () => {
    const backend = registered();
    const before = await backend.getSession();
    await expect(
      backend.deposit({ token: "USDC", amount: "999" }, noop),
    ).rejects.toThrow(/Insufficient public balance/u);
    expect((await backend.getSession()).publicBalances).toEqual(
      before.publicBalances,
    );
  });

  it("reserves the USDC gas buffer", async () => {
    const backend = registered();
    const units = (await backend.getSession()).publicBalances.USDC;
    await expect(
      backend.deposit({
        token: "USDC",
        amount: (Number(units) / 1e6).toString(),
      }, noop),
    ).rejects.toThrow(/Insufficient public balance/u);
  });

  it("returns distinct persisted ids and token precision", async () => {
    const backend = registered();
    const first = await backend.deposit(
      { token: "cirBTC", amount: "0.0001" },
      noop,
    );
    const second = await backend.deposit(
      { token: "cirBTC", amount: "0.0001" },
      noop,
    );
    expect(first.id).not.toBe(second.id);
    expect(first.amountUnits).toBe("10000");
    expect(first.decimals).toBe(8);
  });
});

describe("private transfer", () => {
  const recipient = `unlink1${"q".repeat(60)}`;

  it("debits amount plus fee and returns base-unit receipt fields", async () => {
    const backend = registered();
    const before = await backend.getSession();
    const receipt = await backend.transfer(
      { recipient, token: "USDC", amount: "0.25" },
      noop,
    );
    const after = await backend.getSession();
    expect(receipt.feeUnits).toBe("250");
    expect(
      BigInt(before.privateBalances.USDC) -
        BigInt(after.privateBalances.USDC),
    ).toBe(250_250n);
  });

  it("rejects an amount whose on-top fee does not fit", async () => {
    const backend = registered();
    const available = (await backend.getSession()).privateBalances.USDC;
    await expect(
      backend.transfer(
        {
          recipient,
          token: "USDC",
          amount: (Number(available) / 1e6).toString(),
        },
        noop,
      ),
    ).rejects.toThrow(/Insufficient private balance/u);
  });

  it("rejects malformed recipients", async () => {
    await expect(
      registered().transfer(
        { recipient: "", token: "USDC", amount: "0.1" },
        noop,
      ),
    ).rejects.toThrow(/Invalid recipient/u);
  });
});

describe("swap", () => {
  it("quotes net after fee and debits the whole gross input", async () => {
    const backend = registered();
    const quote = await backend.getQuote("eurc", "0.1");
    expect(quote.feeUnits).toBe("50");
    expect(quote.netUnits).toBe("99950");
    const before = await backend.getSession();
    const receipt = await backend.swap(
      { route: "eurc", grossAmount: "0.1" },
      noop,
    );
    const after = await backend.getSession();
    expect(receipt.feeUnits).toBe("50");
    expect(
      BigInt(before.privateBalances.USDC) -
        BigInt(after.privateBalances.USDC),
    ).toBe(100_000n);
    expect(
      BigInt(after.privateBalances.EURC) -
        BigInt(before.privateBalances.EURC),
    ).toBe(BigInt(receipt.outUnits));
  });

  it("rejects a swap above the private balance", async () => {
    await expect(
      registered().swap(
        { route: "eurc", grossAmount: "999" },
        noop,
      ),
    ).rejects.toThrow(/Insufficient private balance/u);
  });

  it("surfaces injected failure without moving balances", async () => {
    const backend = registered();
    backend.setFailureInjection(true);
    const before = await backend.getSession();
    await expect(
      backend.swap({ route: "eurc", grossAmount: "0.1" }, noop),
    ).rejects.toThrow(/Phase A accepted/u);
    expect((await backend.getSession()).privateBalances).toEqual(
      before.privateBalances,
    );
  });
});

describe("withdrawal to a public EVM address", () => {
  const destination = "0x5f68f040ce9c7e4980b3a4d3a5dde17ea9db9fb6";

  it("debits amount and fee with the fee stage after withdrawal", async () => {
    const backend = registered();
    const before = await backend.getSession();
    const stages: string[] = [];
    const receipt = await backend.withdraw(
      { recipient: destination, token: "USDC", amount: "0.05" },
      (stage) => stages.push(stage),
    );
    const after = await backend.getSession();
    expect(receipt.feeUnits).toBe("50");
    expect(receipt.recipient).toBe(destination);
    expect(stages).toEqual(["withdrawing", "fee"]);
    expect(
      BigInt(before.privateBalances.USDC) -
        BigInt(after.privateBalances.USDC),
    ).toBe(50_050n);
    expect(after.operations[0]?.amountUnits).toBe("50000");
  });

  it("rejects an unlink1 address and over-balance amount", async () => {
    const backend = registered();
    await expect(
      backend.withdraw(
        {
          recipient: `unlink1${"q".repeat(60)}`,
          token: "USDC",
          amount: "0.05",
        },
        noop,
      ),
    ).rejects.toThrow(/Invalid destination/u);
    await expect(
      backend.withdraw(
        { recipient: destination, token: "USDC", amount: "999" },
        noop,
      ),
    ).rejects.toThrow(/Insufficient private balance/u);
  });
});

describe("live-only compatibility methods in demo", () => {
  it("supports faucet and pending resume without special UI branches", async () => {
    const backend = registered();
    const before = BigInt((await backend.getSession()).publicBalances.EURC);
    await backend.requestFaucet("EURC");
    await backend.resumePending();
    const after = BigInt((await backend.getSession()).publicBalances.EURC);
    expect(after - before).toBe(10_000_000n);
  });

  it("reset returns the demo to its unregistered starting point", async () => {
    const backend = registered();
    await backend.deposit({ token: "EURC", amount: "1" }, noop);
    expect((await backend.reset()).privateBalances.EURC).toBe("0");
    expect((await backend.setAccountStatus("registered")).publicBalances.EURC)
      .toBe("4000000");
  });
});
