import { describe, expect, it } from "vitest";

import { isTerminalTransactionFailure } from "./unlinkBackend";
import { reconcileIntent, transitionEntry } from "./journal";
import type { JournalEntry } from "./journal";

/**
 * Live G4 finding: the withdrawal fee transaction failed terminally on Unlink,
 * but the app only knew how to wait for "processed". It polled a dead id
 * forever, surfaced no error, and its pending banner blocked every mutation
 * while the Unlink dashboard already showed FAILED.
 */
const entry = (over: Partial<JournalEntry> = {}): JournalEntry => ({
  id: "entry-1",
  kind: "withdraw",
  state: "fee_intent",
  createdAt: "2026-07-30T16:00:00.000Z",
  updatedAt: "2026-07-30T16:00:00.000Z",
  token: "0x3600000000000000000000000000000000000000",
  amountUnits: "20000",
  feeUnits: "20",
  registryFingerprint: "fp",
  beforeBalances: { private: "99900" },
  attempts: [],
  ...over,
});

describe("terminal transaction failure", () => {
  it("treats only \"failed\" as terminal", () => {
    expect(isTerminalTransactionFailure("failed")).toBe(true);
    for (const status of ["pending", "relayed", "confirmed", "processed"]) {
      expect(isTerminalTransactionFailure(status)).toBe(false);
    }
  });

  it("re-arms a failed leg so one replacement can be submitted", () => {
    expect(
      transitionEntry(entry({ state: "fee_accepted" }), "fee_intent", {
        feeTxId: undefined,
      }).feeTxId,
    ).toBeUndefined();
    expect(transitionEntry(entry({ state: "accepted" }), "intent").state).toBe(
      "intent",
    );
  });
});

describe("reconcileIntent and failed transactions", () => {
  const failed = {
    id: "7a3d6082",
    type: "transfer",
    token: "0x3600000000000000000000000000000000000000",
    amount: "20",
    recipient_address: "unlink1collector",
    recipient_addresses: ["unlink1collector"],
    created_at: "2026-07-30T16:01:00.000Z",
    status: "failed",
  };

  it("does not adopt a terminally failed transaction", () => {
    // Balance still equals the post-withdrawal figure, so nothing moved.
    expect(
      reconcileIntent({
        entry: entry(),
        transactions: [failed],
        currentBalance: "79900",
        beforeBalance: "79900",
        type: "transfer",
        amountUnits: "20",
        feeUnits: "0",
        recipientAddresses: ["unlink1collector"],
      }).decision,
    ).toBe("discard");
  });

  it("still adopts a pending broadcast so it is never sent twice", () => {
    expect(
      reconcileIntent({
        entry: entry(),
        transactions: [{ ...failed, id: "live", status: "pending" }],
        currentBalance: "79900",
        beforeBalance: "79900",
        type: "transfer",
        amountUnits: "20",
        feeUnits: "0",
        recipientAddresses: ["unlink1collector"],
      }).decision,
    ).toBe("adopt");
  });

  it("refuses to act when a failed and a live attempt coexist", () => {
    expect(
      reconcileIntent({
        entry: entry(),
        transactions: [
          failed,
          { ...failed, id: "live-a", status: "pending" },
          { ...failed, id: "live-b", status: "processed" },
        ],
        currentBalance: "79900",
        beforeBalance: "79900",
        type: "transfer",
        amountUnits: "20",
        feeUnits: "0",
        recipientAddresses: ["unlink1collector"],
      }).decision,
    ).toBe("manual");
  });

  it("refuses to discard when the balance shows funds already moved", () => {
    expect(
      reconcileIntent({
        entry: entry(),
        transactions: [failed],
        currentBalance: "79880",
        beforeBalance: "79900",
        type: "transfer",
        amountUnits: "20",
        feeUnits: "0",
        recipientAddresses: ["unlink1collector"],
      }).decision,
    ).toBe("manual");
  });
});
