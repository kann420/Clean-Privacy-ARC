import { describe, expect, it } from "vitest";
import {
  createJournalStore,
  reconcileIntent,
  withMutationLock,
  type JournalEntry,
  type JournalStorage,
} from "./journal";
import { FEES } from "../config/arc";

function memoryStorage(): JournalStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

function store() {
  return createJournalStore({
    chainId: 5042002,
    unlinkAddress: "unlink1testaccount",
    storage: memoryStorage(),
    uuid: () => "operation-1",
    now: () => "2026-07-30T12:00:00.000Z",
  });
}

function intent(): JournalEntry {
  return store().create({
    kind: "transfer",
    token: "0x3600000000000000000000000000000000000000",
    amountUnits: "50000",
    feeUnits: "50",
    recipient: "unlink1recipient",
    registryFingerprint: "fingerprint",
    beforeBalances: { private: "100000" },
  });
}

describe("journal state machines", () => {
  it("persists the complete happy transfer path", () => {
    const journal = store();
    const created = journal.create({
      kind: "transfer",
      token: "0x3600000000000000000000000000000000000000",
      amountUnits: "50000",
      feeUnits: "50",
      recipient: "unlink1recipient",
      registryFingerprint: "fingerprint",
      beforeBalances: { private: "100000" },
    });
    journal.transition(created.id, "accepted", { txId: "tx-1" });
    journal.transition(created.id, "processed");
    journal.transition(created.id, "verified", {
      verifiedAt: "2026-07-30T12:01:00.000Z",
    });
    expect(journal.read()[0]).toMatchObject({
      state: "verified",
      txId: "tx-1",
    });
  });

  it("rejects an invalid state transition", () => {
    const journal = store();
    const created = journal.create({
      kind: "deposit",
      token: "0x3600000000000000000000000000000000000000",
      amountUnits: "1",
      feeUnits: "0",
      registryFingerprint: "fingerprint",
      beforeBalances: { private: "0" },
    });
    expect(() => journal.transition(created.id, "verified")).toThrow(
      /Invalid deposit journal transition/u,
    );
  });

  it("walks the withdrawal fee lane and keeps both ids", () => {
    // The fee is a SEPARATE transaction after the withdrawal settles, so the
    // entry must carry two independent ids through to verification.
    const journal = store();
    const created = journal.create({
      kind: "withdraw",
      token: "0x3600000000000000000000000000000000000000",
      amountUnits: "20000",
      feeUnits: "20",
      recipient: "0x5f68f040ce9c7e4980b3a4d3a5dde17ea9db9fb6",
      registryFingerprint: "fingerprint",
      beforeBalances: { private: "200000" },
    });
    journal.transition(created.id, "accepted", { txId: "tx-withdraw" });
    journal.transition(created.id, "processed");
    journal.transition(created.id, "fee_intent");
    journal.transition(created.id, "fee_accepted", { feeTxId: "tx-fee" });
    journal.transition(created.id, "fee_processed");
    journal.transition(created.id, "verified", {
      verifiedAt: "2026-07-30T12:02:00.000Z",
    });
    expect(journal.read()[0]).toMatchObject({
      state: "verified",
      txId: "tx-withdraw",
      feeTxId: "tx-fee",
    });
  });

  it("re-arms a terminally failed fee exactly once without losing the id", () => {
    const journal = store();
    const created = journal.create({
      kind: "withdraw",
      token: "0x3600000000000000000000000000000000000000",
      amountUnits: "20000",
      feeUnits: "20",
      registryFingerprint: "fingerprint",
      beforeBalances: { private: "200000" },
    });
    journal.transition(created.id, "accepted", { txId: "tx-withdraw" });
    journal.transition(created.id, "processed");
    journal.transition(created.id, "fee_intent");
    journal.transition(created.id, "fee_accepted", { feeTxId: "tx-fee-1" });
    // The fee transaction failed terminally: no funds moved, so exactly one
    // replacement is allowed.
    journal.transition(created.id, "fee_intent");
    journal.transition(created.id, "fee_accepted", { feeTxId: "tx-fee-2" });
    journal.transition(created.id, "fee_processed");
    expect(journal.read()[0]).toMatchObject({
      state: "fee_processed",
      feeTxId: "tx-fee-2",
    });
  });

  it("walks the two-phase swap lane and refuses to mutate an accepted plan", () => {
    const journal = store();
    const created = journal.create({
      kind: "swap",
      token: "0x3600000000000000000000000000000000000000",
      amountUnits: "99950",
      feeUnits: "50",
      grossUnits: "100000",
      netUnits: "99950",
      registryFingerprint: "fingerprint",
      beforeBalances: { input: "200000", out: "0" },
    });
    const plan = { minOut: "75264", maxOut: "199900" } as never;
    journal.transition(created.id, "phaseA_accepted", {
      phaseAExecutionId: "exec-a",
    });
    journal.transition(created.id, "phaseA_processed", {
      accountIndex: 3,
      accountAddress: "0x3e6726e800000000000000000000000000000000",
    });
    journal.transition(created.id, "plan_captured", { plan });
    journal.transition(created.id, "phaseB_accepted", {
      phaseBExecutionId: "exec-b",
    });
    // The captured plan is frozen once Phase B is live.
    expect(() =>
      journal.transition(created.id, "phaseB_processed", {
        plan: { minOut: "1", maxOut: "2" } as never,
      }),
    ).toThrow(/plan is immutable/u);
    journal.transition(created.id, "phaseB_processed");
    journal.transition(created.id, "verified", {
      verifiedAt: "2026-07-30T12:03:00.000Z",
    });
    expect(journal.read()[0]).toMatchObject({
      state: "verified",
      phaseAExecutionId: "exec-a",
      phaseBExecutionId: "exec-b",
      accountIndex: 3,
    });
  });

  it("allows the documented archive exit from manual recovery", () => {
    // The exit is guarded on-chain by the backend; the state machine only has
    // to permit it, and archiving must settle the entry so the lock clears.
    const journal = store();
    const created = journal.create({
      kind: "swap",
      token: "0x3600000000000000000000000000000000000000",
      amountUnits: "99950",
      feeUnits: "50",
      registryFingerprint: "fingerprint",
      beforeBalances: { input: "200000" },
    });
    journal.transition(created.id, "manual_recovery_required", {
      error: "ambiguous",
    });
    expect(journal.pending("fingerprint")?.state).toBe(
      "manual_recovery_required",
    );
    journal.transition(created.id, "failed", { error: "archived" });
    expect(journal.pending("fingerprint")).toBeNull();
  });

  it("hard-stops a pending entry when the registry fingerprint changes", () => {
    const journal = store();
    journal.create({
      kind: "deposit",
      token: "0x3600000000000000000000000000000000000000",
      amountUnits: "1",
      feeUnits: "0",
      registryFingerprint: "old",
      beforeBalances: { private: "0" },
    });
    expect(journal.pending("new")?.state).toBe(
      "manual_recovery_required",
    );
  });
});

describe("crash-gap reconciliation", () => {
  it("adopts a withdraw row with no recipient fields", () => {
    const entry = {
      ...intent(),
      kind: "withdraw" as const,
      amountUnits: "20000",
      feeUnits: "20",
      recipient: "0x5f68f040ce9c7e4980b3a4d3a5dde17ea9db9fb6",
    };
    const result = reconcileIntent({
      entry,
      transactions: [
        {
          id: "tx-withdraw",
          type: "withdraw",
          token: entry.token.toLowerCase(),
          amount: entry.amountUnits,
          created_at: "2026-07-30T12:00:10.000Z",
          status: "processed",
        },
      ],
      currentBalance: "80000",
      beforeBalance: "100000",
      type: "withdraw",
      amountUnits: entry.amountUnits,
      feeUnits: entry.feeUnits,
      recipientAddresses: [],
    });
    expect(result).toMatchObject({
      decision: "adopt",
      transaction: { id: "tx-withdraw" },
    });
  });

  it("adopts a fee-bearing transfer by total amount and exact recipient set", () => {
    const entry = intent();
    const result = reconcileIntent({
      entry,
      transactions: [
        {
          id: "tx-1",
          type: "transfer",
          token: entry.token.toLowerCase(),
          amount: "50050",
          recipient_addresses: [FEES.collector, entry.recipient!],
          created_at: "2026-07-30T12:00:10.000Z",
          status: "processed",
        },
      ],
      currentBalance: "49950",
      beforeBalance: "100000",
      type: "transfer",
      amountUnits: "50000",
      feeUnits: "50",
      recipientAddresses: [entry.recipient!, FEES.collector],
    });
    expect(result).toMatchObject({ decision: "adopt" });
  });

  it("adopts an accepted total-amount transfer before its balance moves", () => {
    // Opus mandatory fix 1: a broadcast that has not reached "processed" yet
    // is still this intent's transaction. Filtering it out routed a live
    // operation into the discard branch and invited a duplicate submission.
    const entry = intent();
    const result = reconcileIntent({
      entry,
      transactions: [
        {
          id: "tx-pending",
          type: "transfer",
          token: entry.token.toLowerCase(),
          amount: "50050",
          recipient_addresses: [entry.recipient!, FEES.collector],
          created_at: "2026-07-30T12:00:10.000Z",
          status: "accepted",
        },
      ],
      // The balance has not moved yet — exactly the state that used to discard.
      currentBalance: "100000",
      beforeBalance: "100000",
      type: "transfer",
      amountUnits: "50000",
      feeUnits: "50",
      recipientAddresses: [entry.recipient!, FEES.collector],
    });
    expect(result).toMatchObject({
      decision: "adopt",
      transaction: { id: "tx-pending" },
    });
  });

  it("does not adopt a transfer with a wrong extra co-recipient", () => {
    const entry = intent();
    const wrongRow = {
      id: "tx-wrong-recipient",
      type: "transfer",
      token: entry.token.toLowerCase(),
      amount: "50050",
      recipient_addresses: [
        entry.recipient!,
        FEES.collector,
        "unlink1unexpected",
      ],
      created_at: "2026-07-30T12:00:10.000Z",
      status: "processed",
    };
    expect(
      reconcileIntent({
        entry,
        transactions: [wrongRow],
        currentBalance: "49950",
        beforeBalance: "100000",
        type: "transfer",
        amountUnits: "50000",
        feeUnits: "50",
        recipientAddresses: [entry.recipient!, FEES.collector],
      }),
    ).toEqual({ decision: "manual" });
    expect(
      reconcileIntent({
        entry,
        transactions: [wrongRow],
        currentBalance: "100000",
        beforeBalance: "100000",
        type: "transfer",
        amountUnits: "50000",
        feeUnits: "50",
        recipientAddresses: [entry.recipient!, FEES.collector],
      }),
    ).toEqual({ decision: "discard" });
  });

  it("keeps two plausible new-shape matches manual even before balance movement", () => {
    const entry = intent();
    const transaction = {
      id: "tx-1",
      type: "transfer",
      token: entry.token.toLowerCase(),
      amount: "50050",
      recipient_addresses: [entry.recipient!, FEES.collector],
      created_at: "2026-07-30T12:00:10.000Z",
      status: "processed",
    };
    expect(
      reconcileIntent({
        entry,
        transactions: [transaction, { ...transaction, id: "tx-2" }],
        currentBalance: "100000",
        beforeBalance: "100000",
        type: "transfer",
        amountUnits: "50000",
        feeUnits: "50",
        recipientAddresses: [entry.recipient!, FEES.collector],
      }),
    ).toEqual({ decision: "manual" });
  });

  it("excludes failed withdrawal rows", () => {
    const entry = {
      ...intent(),
      kind: "withdraw" as const,
      amountUnits: "20000",
      feeUnits: "20",
    };
    expect(
      reconcileIntent({
        entry,
        transactions: [
          {
            id: "tx-failed",
            type: "withdraw",
            token: entry.token.toLowerCase(),
            amount: "20000",
            status: "failed",
          },
        ],
        currentBalance: "100000",
        beforeBalance: "100000",
        type: "withdraw",
        amountUnits: "20000",
        feeUnits: "20",
        recipientAddresses: [],
      }),
    ).toEqual({ decision: "discard" });
  });

  it("adopts a withdrawal fee leg using the reconciled transfer type", () => {
    const entry = {
      ...intent(),
      kind: "withdraw" as const,
      amountUnits: "20000",
      feeUnits: "20",
    };
    const result = reconcileIntent({
      entry,
      transactions: [
        {
          id: "tx-fee",
          type: "transfer",
          token: entry.token.toLowerCase(),
          amount: "20",
          recipient_address: FEES.collector,
          recipient_addresses: [FEES.collector],
          status: "processed",
        },
      ],
      currentBalance: "79980",
      beforeBalance: "80000",
      type: "transfer",
      amountUnits: "20",
      feeUnits: "0",
      recipientAddresses: [FEES.collector],
    });
    expect(result).toMatchObject({
      decision: "adopt",
      transaction: { id: "tx-fee" },
    });
  });

  it("excludes a row whose singular recipient contradicts its plural field", () => {
    const entry = intent();
    expect(
      reconcileIntent({
        entry,
        transactions: [
          {
            id: "tx-inconsistent",
            type: "transfer",
            token: entry.token.toLowerCase(),
            amount: "50050",
            recipient_address: "unlink1contradiction",
            recipient_addresses: [entry.recipient!, FEES.collector],
            status: "processed",
          },
        ],
        currentBalance: "49950",
        beforeBalance: "100000",
        type: "transfer",
        amountUnits: "50000",
        feeUnits: "50",
        recipientAddresses: [entry.recipient!, FEES.collector],
      }),
    ).toEqual({ decision: "manual" });
  });

  it("never discards while an inconsistent candidate row exists, even with an unchanged balance", () => {
    const entry = intent();
    expect(
      reconcileIntent({
        entry,
        transactions: [
          {
            id: "tx-inconsistent",
            type: "transfer",
            token: entry.token.toLowerCase(),
            amount: "50050",
            recipient_address: "unlink1contradiction",
            recipient_addresses: [entry.recipient!, FEES.collector],
            status: "accepted",
          },
        ],
        currentBalance: "100000",
        beforeBalance: "100000",
        type: "transfer",
        amountUnits: "50000",
        feeUnits: "50",
        recipientAddresses: [entry.recipient!, FEES.collector],
      }),
    ).toEqual({ decision: "manual" });
  });

  it("treats a malformed non-array recipient_addresses as manual, not discard", () => {
    const entry = intent();
    expect(
      reconcileIntent({
        entry,
        transactions: [
          {
            id: "tx-malformed",
            type: "transfer",
            token: entry.token.toLowerCase(),
            amount: "50050",
            recipient_addresses: null as unknown as string[],
            status: "accepted",
          },
        ],
        currentBalance: "100000",
        beforeBalance: "100000",
        type: "transfer",
        amountUnits: "50000",
        feeUnits: "50",
        recipientAddresses: [entry.recipient!, FEES.collector],
      }),
    ).toEqual({ decision: "manual" });
  });

  it("adopts a still-pending withdraw row while the balance is unchanged", () => {
    const entry = {
      ...intent(),
      kind: "withdraw" as const,
      amountUnits: "20000",
      feeUnits: "20",
      recipient: "0x5f68f040ce9c7e4980b3a4d3a5dde17ea9db9fb6",
    };
    const result = reconcileIntent({
      entry,
      transactions: [
        {
          id: "tx-withdraw-pending",
          type: "withdraw",
          token: entry.token.toLowerCase(),
          amount: entry.amountUnits,
          created_at: "2026-07-30T12:00:10.000Z",
          status: "accepted",
        },
      ],
      currentBalance: "100000",
      beforeBalance: "100000",
      type: "withdraw",
      amountUnits: entry.amountUnits,
      feeUnits: entry.feeUnits,
      recipientAddresses: [],
    });
    expect(result).toMatchObject({
      decision: "adopt",
      transaction: { id: "tx-withdraw-pending" },
    });
  });

  it("discards zero matches only when the balance is unchanged", () => {
    const entry = intent();
    expect(
      reconcileIntent({
        entry,
        transactions: [],
        currentBalance: "100000",
        beforeBalance: "100000",
        type: "transfer",
        amountUnits: "50000",
        feeUnits: "50",
        recipientAddresses: [entry.recipient!, FEES.collector],
      }),
    ).toEqual({ decision: "discard" });
    expect(
      reconcileIntent({
        entry,
        transactions: [],
        currentBalance: "99999",
        beforeBalance: "100000",
        type: "transfer",
        amountUnits: "50000",
        feeUnits: "50",
        recipientAddresses: [entry.recipient!, FEES.collector],
      }),
    ).toEqual({ decision: "manual" });
  });
});

describe("storage-authoritative submission guards", () => {
  it("requireState re-reads storage and refuses a stale in-memory state", () => {
    // Opus mandatory fix 3: the entry immediately before an SDK submission
    // must come from storage, not from a possibly stale in-memory copy.
    const journal = store();
    const created = journal.create({
      kind: "swap",
      token: "0x3600000000000000000000000000000000000000",
      amountUnits: "99950",
      feeUnits: "50",
      registryFingerprint: "fingerprint",
      beforeBalances: { input: "1000000" },
    });
    journal.transition(created.id, "phaseA_accepted", {
      phaseAExecutionId: "exec-a",
    });
    expect(() =>
      journal.requireState(created.id, ["plan_captured"]),
    ).toThrow(/refusing to submit/u);
    expect(
      journal.requireState(created.id, ["phaseA_accepted"]).state,
    ).toBe("phaseA_accepted");
    expect(() => journal.requireState("missing", ["intent"])).toThrow(
      /disappeared/u,
    );
  });

  it("recordAttempt persists a write-ahead id without a state transition", () => {
    // Opus mandatory fix 2: the return-to-pool execution id must survive a
    // crash even though the state machine stays in recovery_pending.
    const journal = store();
    const created = journal.create({
      kind: "swap",
      token: "0x3600000000000000000000000000000000000000",
      amountUnits: "99950",
      feeUnits: "50",
      registryFingerprint: "fingerprint",
      beforeBalances: { input: "1000000" },
    });
    journal.transition(created.id, "phaseA_accepted", {});
    journal.transition(created.id, "phaseA_processed", {});
    journal.transition(created.id, "recovery_pending", {});
    const updated = journal.recordAttempt(created.id, {
      at: "2026-07-30T12:01:00.000Z",
      action: "return_to_pool",
      id: "exec-return",
    });
    expect(updated.state).toBe("recovery_pending");
    const persisted = journal.read().find((item) => item.id === created.id);
    expect(persisted?.attempts).toContainEqual({
      at: "2026-07-30T12:01:00.000Z",
      action: "return_to_pool",
      id: "exec-return",
    });
  });
});

describe("cross-tab mutation lock", () => {
  it("uses the exact exclusive lock namespace", async () => {
    const calls: Array<[string, { mode: "exclusive" }]> = [];
    const locks = {
      async request<T>(
        name: string,
        options: { mode: "exclusive" },
        callback: () => Promise<T>,
      ): Promise<T> {
        calls.push([name, options]);
        return callback();
      },
    };
    await expect(
      withMutationLock(
        locks,
        5042002,
        "unlink1account",
        async () => "done",
      ),
    ).resolves.toBe("done");
    expect(calls).toEqual([
      [
        "cleanprivacy-arc:mutate:5042002:unlink1account",
        { mode: "exclusive" },
      ],
    ]);
  });

  it("refuses live mutation when Web Locks are missing", async () => {
    await expect(
      withMutationLock(undefined, 5042002, "unlink1account", async () => {}),
    ).rejects.toThrow(/Web Locks are unavailable/u);
  });
});

/**
 * Live QA, 2026-07-31: an already hard-stopped swap was hard-stopped again by a
 * second recovery attempt. The transition table has no self-edge on
 * `manual_recovery_required`, so the journal threw "Invalid swap journal
 * transition: manual_recovery_required -> manual_recovery_required" — and that
 * message replaced the real diagnosis in the UI, leaving no way to see what had
 * actually failed.
 *
 * The self-edge must stay absent (adding one would weaken every state), so the
 * repeat is absorbed in `hardStop`. These tests pin both halves of that
 * contract.
 */
describe("re-stopping an already stopped entry", () => {
  const stopped = (): { journal: ReturnType<typeof store>; id: string } => {
    const journal = store();
    const entry = journal.create({
      kind: "swap",
      token: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
      amountUnits: "268152",
      feeUnits: "134",
      registryFingerprint: "fingerprint",
      beforeBalances: { input: "268152", out: "0" },
    });
    journal.transition(entry.id, "manual_recovery_required", {
      error: "first failure",
    });
    return { journal, id: entry.id };
  };

  it("still refuses the self-transition at the journal level", () => {
    const { journal, id } = stopped();
    expect(() =>
      journal.transition(id, "manual_recovery_required", { error: "second" }),
    ).toThrow(/Invalid swap journal transition/u);
  });

  it("records a newer reason through save without changing state", () => {
    // This is what hardStop does instead of transitioning.
    const { journal, id } = stopped();
    const current = journal.read().find((entry) => entry.id === id)!;
    journal.save({
      ...current,
      error: "Return-to-pool verification mismatched.",
      updatedAt: "2026-07-31T13:30:00.000Z",
    });
    const after = journal.read().find((entry) => entry.id === id)!;
    expect(after.state).toBe("manual_recovery_required");
    expect(after.error).toBe("Return-to-pool verification mismatched.");
    // The operator must see the latest cause, not the first one.
    expect(after.error).not.toBe("first failure");
  });

  it("keeps the documented exits open from the stopped state", () => {
    // Absorbing the repeat must not strand the entry: archive and the
    // return-to-pool retry both have to remain reachable.
    for (const next of ["failed", "recovery_pending", "verified"] as const) {
      const { journal, id } = stopped();
      expect(() => journal.transition(id, next)).not.toThrow();
      expect(journal.read().find((entry) => entry.id === id)!.state).toBe(next);
    }
  });
});
