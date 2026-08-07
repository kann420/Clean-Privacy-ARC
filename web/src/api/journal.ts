import type { RouteId } from "../config/arc";
import type { ValidatedPlan } from "../lib/fingerprint";

export type JournalKind = "deposit" | "transfer" | "withdraw" | "swap";
export type JournalState =
  | "intent"
  | "accepted"
  | "processed"
  | "fee_intent"
  | "fee_accepted"
  | "fee_processed"
  | "phaseA_accepted"
  | "phaseA_processed"
  | "plan_captured"
  | "phaseB_accepted"
  | "phaseB_processed"
  | "recovery_pending"
  | "manual_recovery_required"
  | "verified"
  | "failed";

export type JournalAttempt = {
  at: string;
  action: string;
  id?: string;
  outcome?: string;
};

export type JournalEntry = {
  id: string;
  kind: JournalKind;
  state: JournalState;
  createdAt: string;
  updatedAt: string;
  token: string;
  amountUnits: string;
  feeUnits: string;
  grossUnits?: string;
  netUnits?: string;
  recipient?: string;
  registryFingerprint: string;
  beforeBalances: Record<string, string>;
  txId?: string;
  txHash?: string;
  feeTxId?: string;
  phaseAExecutionId?: string;
  phaseBExecutionId?: string;
  withdrawalTxIds?: string[];
  handleOpsTxHash?: string;
  accountIndex?: number;
  accountAddress?: string;
  /**
   * Swap direction. Absent on entries written before the reverse route existed;
   * readers must treat a missing value as the original USDC -> EURC route so a
   * journal that survived the upgrade still recovers into the right tokens.
   */
  route?: RouteId;
  /** Validated plan, including the locally computed economic `maxOut` bound. */
  plan?: ValidatedPlan;
  attempts: JournalAttempt[];
  verifiedAt?: string;
  error?: string;
};

export type JournalStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

const TRANSITIONS: Record<JournalState, readonly JournalState[]> = {
  intent: [
    "accepted",
    "phaseA_accepted",
    "manual_recovery_required",
    "failed",
  ],
  // "accepted -> intent" and "fee_accepted -> fee_intent" re-arm a leg whose
  // transaction failed TERMINALLY on Unlink. A failed transaction moves no
  // funds, so a single replacement is not a double-spend — but it is only ever
  // reached after the caller proves the balance is untouched and that the one
  // permitted retry has not been used (Phase 4 G4 live finding).
  accepted: ["processed", "intent", "manual_recovery_required", "failed"],
  processed: ["fee_intent", "verified", "manual_recovery_required"],
  fee_intent: [
    "fee_accepted",
    "manual_recovery_required",
    "verified",
  ],
  fee_accepted: [
    "fee_processed",
    "fee_intent",
    "manual_recovery_required",
    "failed",
  ],
  fee_processed: ["verified", "manual_recovery_required"],
  phaseA_accepted: [
    "phaseA_processed",
    "failed",
    "manual_recovery_required",
  ],
  phaseA_processed: [
    "plan_captured",
    "recovery_pending",
    "manual_recovery_required",
    "verified",
  ],
  plan_captured: [
    "phaseB_accepted",
    "recovery_pending",
    "manual_recovery_required",
    "verified",
  ],
  phaseB_accepted: [
    "phaseB_processed",
    "recovery_pending",
    "manual_recovery_required",
  ],
  phaseB_processed: ["verified", "manual_recovery_required"],
  recovery_pending: [
    "plan_captured",
    "phaseB_accepted",
    "verified",
    "manual_recovery_required",
  ],
  // Terminal for everything EXCEPT returning already-withdrawn swap funds to
  // the pool. That action only ever sweeps the ExecutionAccount back to its
  // owner under exact [net, net] bounds and re-verifies on-chain afterwards, so
  // it cannot lose funds — and blocking it in the very state that needs it most
  // left real balances stranded (Phase 4 G5 live finding).
  // Plus "failed", the documented operator archive path. It only ever runs
  // after an on-chain check proves the ExecutionAccount holds nothing and has
  // no allowance, so archiving cannot hide stranded funds.
  manual_recovery_required: ["recovery_pending", "verified", "failed"],
  verified: [],
  failed: [],
};

export const journalKey = (chainId: number, unlinkAddress: string): string =>
  `cleanprivacy-arc:journal:v1:${chainId}:${unlinkAddress}`;

export function isSettled(entry: JournalEntry): boolean {
  return entry.state === "verified" || entry.state === "failed";
}

export function transitionEntry(
  entry: JournalEntry,
  state: JournalState,
  patch: Partial<JournalEntry> = {},
  now = new Date().toISOString(),
): JournalEntry {
  if (!TRANSITIONS[entry.state].includes(state)) {
    throw new Error(
      `Invalid ${entry.kind} journal transition: ${entry.state} -> ${state}`,
    );
  }
  if (
    entry.state === "phaseB_accepted" &&
    patch.plan &&
    JSON.stringify(patch.plan) !== JSON.stringify(entry.plan)
  ) {
    throw new Error("A Phase B accepted plan is immutable");
  }
  return { ...entry, ...patch, state, updatedAt: now };
}

export function createJournalStore(options: {
  chainId: number;
  unlinkAddress: string;
  storage?: JournalStorage;
  uuid?: () => string;
  now?: () => string;
}) {
  const storage = options.storage ?? localStorage;
  const key = journalKey(options.chainId, options.unlinkAddress);
  const uuid =
    options.uuid ??
    (() =>
      crypto.randomUUID?.() ??
      `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const now = options.now ?? (() => new Date().toISOString());

  const read = (): JournalEntry[] => {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("Journal payload is malformed");
    return parsed as JournalEntry[];
  };
  const write = (entries: JournalEntry[]): void => {
    storage.setItem(key, JSON.stringify(entries));
  };
  const save = (entry: JournalEntry): JournalEntry => {
    const entries = read();
    const index = entries.findIndex((item) => item.id === entry.id);
    if (index >= 0) entries[index] = entry;
    else entries.push(entry);
    write(entries);
    return entry;
  };

  return {
    key,
    read,
    create(
      entry: Omit<
        JournalEntry,
        "id" | "createdAt" | "updatedAt" | "state" | "attempts"
      >,
    ): JournalEntry {
      const timestamp = now();
      const created: JournalEntry = {
        ...entry,
        id: uuid(),
        state: "intent",
        createdAt: timestamp,
        updatedAt: timestamp,
        attempts: [],
      };
      return save(created);
    },
    save,
    transition(
      id: string,
      state: JournalState,
      patch: Partial<JournalEntry> = {},
    ): JournalEntry {
      const entry = read().find((item) => item.id === id);
      if (!entry) throw new Error(`Journal entry not found: ${id}`);
      return save(transitionEntry(entry, state, patch, now()));
    },
    remove(id: string): void {
      write(read().filter((entry) => entry.id !== id));
    },
    /**
     * Re-read an entry from storage and assert its state immediately before an
     * SDK submission. In-memory copies can be stale across tabs; storage is
     * the authority (Opus review, mandatory fix 3).
     */
    requireState(
      id: string,
      expected: readonly JournalState[],
    ): JournalEntry {
      const entry = read().find((item) => item.id === id);
      if (!entry) {
        throw new Error(`Journal entry disappeared before submission: ${id}`);
      }
      if (!expected.includes(entry.state)) {
        throw new Error(
          `Journal entry ${id} is in state ${entry.state}; expected ${expected.join("|")} — refusing to submit`,
        );
      }
      return entry;
    },
    /**
     * Append an attempt record without a state transition. Used to write ahead
     * of recovery submissions whose ids must survive a crash.
     */
    recordAttempt(id: string, attempt: JournalAttempt): JournalEntry {
      const entry = read().find((item) => item.id === id);
      if (!entry) throw new Error(`Journal entry not found: ${id}`);
      return save({
        ...entry,
        attempts: [...entry.attempts, attempt],
        updatedAt: now(),
      });
    },
    pending(expectedFingerprint?: string): JournalEntry | null {
      const entry = read().find((item) => !isSettled(item)) ?? null;
      if (
        entry &&
        expectedFingerprint &&
        entry.registryFingerprint !== expectedFingerprint
      ) {
        const error =
          "Registry fingerprint changed; manual recovery is required.";
        // Re-entry has to be absorbed here, exactly as `hardStop` absorbs it.
        // `manual_recovery_required` is NOT settled, so an entry already stopped
        // for a human is picked up by this same branch on every later load, and
        // the table has no self-edge. Throwing does not stop a bad operation —
        // the entry is already stopped — it only replaces the real diagnosis
        // with a message about the journal and bricks every screen that reads
        // it, on every reload, with no way out from the UI. Observed live on
        // arc.cleanprivacy.org after a registry field changed (2026-08-07).
        if (entry.state === "manual_recovery_required") {
          return save({ ...entry, error, updatedAt: now() });
        }
        return save(
          transitionEntry(entry, "manual_recovery_required", { error }, now()),
        );
      }
      return entry;
    },
    clear(): void {
      storage.removeItem(key);
    },
  };
}

export type HistoryTransaction = {
  id: string;
  type?: string;
  token?: string | null;
  amount?: string;
  recipient_address?: string | null;
  recipient_addresses?: string[];
  created_at?: string;
  status?: string;
  tx_hash?: string | null;
};

function historyRecipientSet(
  transaction: HistoryTransaction,
): Set<string> | null {
  const plural = transaction.recipient_addresses;
  const singular = transaction.recipient_address;
  if (plural !== undefined) {
    // Untrusted JSON: the field is typed string[] but a null or object here
    // must classify the row as malformed, not crash resume or read as "no
    // recipients" (Opus review, mandatory fix 2).
    if (!Array.isArray(plural)) {
      return null;
    }
    if (singular != null && !plural.includes(singular)) {
      return null;
    }
    return new Set(plural);
  }
  return new Set(singular == null ? [] : [singular]);
}

function sameRecipientSet(
  actual: Set<string>,
  expected: Set<string>,
): boolean {
  return (
    actual.size === expected.size &&
    [...expected].every((recipient) => actual.has(recipient))
  );
}

export function reconcileIntent(options: {
  entry: JournalEntry;
  transactions: HistoryTransaction[];
  currentBalance: string;
  beforeBalance: string;
  type: "deposit" | "transfer" | "withdraw";
  amountUnits: string;
  feeUnits?: string;
  recipientAddresses: string[];
}):
  | { decision: "adopt"; transaction: HistoryTransaction }
  | { decision: "discard" }
  | { decision: "manual" } {
  const earliest = Date.parse(options.entry.createdAt) - 10 * 60 * 1_000;
  // Match on identity fields WITHOUT filtering by status: an accepted but not
  // yet processed transaction is still this intent's broadcast, and treating it
  // as "no match" would route a live operation into the discard branch and
  // invite a duplicate submission (Opus review, mandatory fix 1).
  //
  // A TERMINALLY FAILED transaction is the one exception: it is not a live
  // broadcast, it moved no funds, and adopting it would put resume into an
  // endless "adopt -> poll -> fail" loop. Excluding it lets the caller reach
  // the discard branch, where an unchanged balance proves a replacement is
  // safe (Phase 4 G4 live finding).
  const expectedAmount =
    options.type === "transfer"
      ? (
          BigInt(options.amountUnits) + BigInt(options.feeUnits ?? "0")
        ).toString()
      : options.amountUnits;
  const expectedRecipients = new Set(options.recipientAddresses);
  // A row that matches every identity field but reports contradictory
  // recipient fields is malformed, not proof of absence: it may BE this
  // intent's live broadcast, so it must never license the discard branch
  // (Opus review, mandatory fix 1).
  let inconsistentCandidate = false;
  const matches = options.transactions.filter((transaction) => {
    if (
      transaction.type !== options.type ||
      transaction.token?.toLowerCase() !== options.entry.token.toLowerCase() ||
      transaction.amount !== expectedAmount ||
      transaction.status === "failed"
    ) {
      return false;
    }
    const created = Date.parse(transaction.created_at ?? "");
    if (Number.isFinite(created) && created < earliest) {
      return false;
    }
    const recipients = historyRecipientSet(transaction);
    if (recipients === null) {
      inconsistentCandidate = true;
      return false;
    }
    return sameRecipientSet(recipients, expectedRecipients);
  });
  if (matches.length === 1) {
    // A single match adopts regardless of its status: processed continues to
    // verification, anything pending is polled by id. Never resubmit.
    return { decision: "adopt", transaction: matches[0]! };
  }
  if (
    matches.length === 0 &&
    !inconsistentCandidate &&
    options.currentBalance === options.beforeBalance
  ) {
    return { decision: "discard" };
  }
  return { decision: "manual" };
}

export type LockManagerLike = {
  request<T>(
    name: string,
    options: { mode: "exclusive" },
    callback: () => Promise<T>,
  ): Promise<T>;
};

export async function withMutationLock<T>(
  locks: LockManagerLike | undefined,
  chainId: number,
  unlinkAddress: string,
  callback: () => Promise<T>,
): Promise<T> {
  if (!locks) {
    throw new Error(
      "Web Locks are unavailable; live mutations are disabled in this browser.",
    );
  }
  return locks.request(
    `cleanprivacy-arc:mutate:${chainId}:${unlinkAddress}`,
    { mode: "exclusive" },
    callback,
  );
}
