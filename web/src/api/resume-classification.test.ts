import { describe, expect, it } from "vitest";
import {
  RETRYABLE_RPC_ERROR,
  UnlinkBrowserBackend,
  classifyExecution,
  isTerminalTransactionFailure,
} from "./unlinkBackend";
import {
  createJournalStore,
  reconcileIntent,
  type JournalEntry,
} from "./journal";
import { FEES } from "../config/arc";

/**
 * The resume paths are where a bug costs money: misread a status and the app
 * submits a second execution while the first is still live. These cover the
 * decision functions those paths are built on.
 */

const entry = (): JournalEntry => ({
  id: "operation-1",
  kind: "transfer",
  state: "intent",
  createdAt: "2026-07-30T12:00:00.000Z",
  updatedAt: "2026-07-30T12:00:00.000Z",
  token: "0x3600000000000000000000000000000000000000",
  amountUnits: "50000",
  feeUnits: "50",
  recipient: "unlink1recipient",
  registryFingerprint: "fingerprint",
  beforeBalances: { private: "100000" },
  attempts: [],
});

describe("execution classification", () => {
  it("treats only completed and processed as success", () => {
    expect(classifyExecution({ status: "completed" })).toBe("success");
    expect(classifyExecution({ status: "processed" })).toBe("success");
    expect(classifyExecution({ execution: { status: "completed" } })).toBe(
      "success",
    );
  });

  it("treats every non-terminal status as pending, never as a revert", () => {
    for (const status of [
      "pending",
      "prepared",
      "submitted",
      "signing",
      undefined,
    ]) {
      expect(classifyExecution({ status })).toBe("pending");
    }
  });

  it("routes only genuinely terminal failures into the single retry", () => {
    expect(classifyExecution({ status: "failed" })).toBe("retryable-failure");
    expect(classifyExecution({ status: "user_op_reverted" })).toBe(
      "retryable-failure",
    );
  });

  it("keeps manual recovery separate from a retryable failure", () => {
    expect(classifyExecution({ status: "manual_recovery_required" })).toBe(
      "manual",
    );
  });
});

describe("transaction failure classification", () => {
  it("recognises the terminal transaction statuses", () => {
    expect(isTerminalTransactionFailure("failed")).toBe(true);
    expect(isTerminalTransactionFailure("processed")).toBe(false);
    expect(isTerminalTransactionFailure(undefined)).toBe(false);
  });
});

describe("retryable RPC errors", () => {
  it("matches the browser's opaque CORS-blocked rate limit", () => {
    // A tripped Arc limit answers 429 without CORS headers, so the browser only
    // ever sees "Failed to fetch" (Phase 4 G4 live finding).
    for (const message of [
      "request limit reached",
      "HTTP request failed.",
      "TypeError: Failed to fetch",
      "fetch failed",
      "the server responded with status: 429",
    ]) {
      expect(RETRYABLE_RPC_ERROR.test(message)).toBe(true);
    }
  });

  it("does not swallow a genuine contract or validation error", () => {
    for (const message of [
      "execution reverted: insufficient allowance",
      "Circle plan fingerprint does not match its public fields",
      "Insufficient private balance",
    ]) {
      expect(RETRYABLE_RPC_ERROR.test(message)).toBe(false);
    }
  });
});

describe("resume reconciliation decisions", () => {
  const history = (overrides: Record<string, unknown> = {}) => ({
    id: "tx-1",
    type: "transfer",
    token: "0x3600000000000000000000000000000000000000",
    amount: "50050",
    recipient_addresses: ["unlink1recipient", FEES.collector],
    created_at: "2026-07-30T12:00:10.000Z",
    status: "processed",
    ...overrides,
  });

  const call = (transactions: ReturnType<typeof history>[], balance: string) =>
    reconcileIntent({
      entry: entry(),
      transactions,
      currentBalance: balance,
      beforeBalance: "100000",
      type: "transfer",
      amountUnits: "50000",
      feeUnits: "50",
      recipientAddresses: ["unlink1recipient", FEES.collector],
    });

  it("adopts a match at any status, including still-pending", () => {
    expect(call([history()], "49950")).toMatchObject({ decision: "adopt" });
    expect(call([history({ status: "accepted" })], "100000")).toMatchObject({
      decision: "adopt",
    });
  });

  it("discards only when nothing matched and the balance never moved", () => {
    expect(call([], "100000")).toEqual({ decision: "discard" });
  });

  it("hard-stops when the balance moved without a match", () => {
    expect(call([], "99999")).toEqual({ decision: "manual" });
  });

  it("hard-stops on an ambiguous double match", () => {
    expect(call([history(), history({ id: "tx-2" })], "49950")).toEqual({
      decision: "manual",
    });
  });

  it("ignores a same-shaped transaction from before this intent", () => {
    // A repeat of the same token/amount/recipient from an earlier run must not
    // be adopted as this intent's broadcast.
    expect(
      call([history({ created_at: "2026-07-30T11:00:00.000Z" })], "100000"),
    ).toEqual({ decision: "discard" });
  });

  it("keeps a match whose timestamp cannot be parsed", () => {
    // Fail-safe: an unparseable server timestamp must not silently drop the
    // only evidence that a transaction exists.
    expect(call([history({ created_at: undefined })], "49950")).toMatchObject({
      decision: "adopt",
    });
  });
});

describe("resumeTransaction reconciliation wiring", () => {
  it("adopts a total-amount transfer row using the journal's stored fee", async () => {
    const values = new Map<string, string>();
    const journal = createJournalStore({
      chainId: 5042002,
      unlinkAddress: "unlink1testaccount",
      storage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => void values.set(key, value),
        removeItem: (key) => void values.delete(key),
      },
      uuid: () => "operation-wiring",
      now: () => "2026-07-30T12:00:00.000Z",
    });
    const pending = journal.create({
      kind: "transfer",
      token: "0x3600000000000000000000000000000000000000",
      amountUnits: "50000",
      feeUnits: "50",
      recipient: "unlink1recipient",
      registryFingerprint: "fingerprint",
      beforeBalances: { private: "100000" },
    });
    const backend = Object.create(UnlinkBrowserBackend.prototype) as any;
    backend.privateSnapshot = async () => ({
      balances: { USDC: "100000", EURC: "0", cirBTC: "0" },
      syncStatus: "current",
    });
    const queries: unknown[] = [];
    const client = {
      async getTransactions(query: unknown) {
        queries.push(query);
        return {
          transactions: [
            {
              id: "tx-total",
              type: "transfer",
              token: pending.token.toLowerCase(),
              amount: "50050",
              recipient_addresses: [pending.recipient, FEES.collector],
              status: "accepted",
              created_at: "2026-07-30T12:00:10.000Z",
            },
          ],
        };
      },
      async pollTransactionStatus() {
        throw new Error("stop after adoption");
      },
    };

    await expect(
      backend.resumeTransaction(pending, client, journal),
    ).rejects.toThrow("stop after adoption");
    expect(queries).toEqual([{ type: "transfer", limit: 100 }]);
    expect(journal.read()[0]).toMatchObject({
      state: "accepted",
      txId: "tx-total",
    });
  });
});
