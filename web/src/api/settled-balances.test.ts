import { describe, expect, it } from "vitest";

/**
 * Live G5 finding: right after Phase A withdrew from the pool, `getBalances`
 * answered `sync_status: "syncing"` with the PRE-withdrawal amount. The exact
 * delta assertion read it once, mismatched, and drove a perfectly healthy swap
 * into `manual_recovery_required` — while the ExecutionAccount held exactly the
 * expected net and allowance. The CLI already retried its delta checks.
 *
 * This reproduces the settle loop's contract against a scripted sequence of
 * snapshots, which is what the private helper runs.
 */
type Snapshot = { balances: { USDC: string }; syncStatus: string };

async function settle(
  snapshots: Snapshot[],
  matches: (balances: { USDC: string }) => boolean,
  attempts = 6,
): Promise<{ balances: { USDC: string }; reads: number }> {
  let reads = 0;
  const next = () => snapshots[Math.min(reads++, snapshots.length - 1)]!;
  let snapshot = next();
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    if (snapshot.syncStatus === "current" && matches(snapshot.balances)) break;
    snapshot = next();
  }
  return { balances: snapshot.balances, reads };
}

const syncing = (usdc: string): Snapshot => ({
  balances: { USDC: usdc },
  syncStatus: "syncing",
});
const current = (usdc: string): Snapshot => ({
  balances: { USDC: usdc },
  syncStatus: "current",
});

describe("settled balance reads", () => {
  const expected = (balances: { USDC: string }) => balances.USDC === "159880";

  it("waits past a syncing read that still shows the pre-operation amount", async () => {
    const result = await settle(
      [syncing("179880"), syncing("179880"), current("159880")],
      expected,
    );
    expect(result.balances.USDC).toBe("159880");
    expect(result.reads).toBe(3);
  });

  it("returns immediately when the first read is already settled", async () => {
    const result = await settle([current("159880")], expected);
    expect(result.balances.USDC).toBe("159880");
    expect(result.reads).toBe(1);
  });

  it("does not wait forever, and reports the real figure so the caller hard-stops", async () => {
    const result = await settle([current("999")], expected);
    // A genuinely wrong balance is returned as-is; the caller's exact
    // assertion still fails and routes to manual recovery.
    expect(result.balances.USDC).toBe("999");
    expect(result.reads).toBeLessThanOrEqual(6);
  });

  it("keeps waiting while the amount is right but the account is still syncing", async () => {
    const result = await settle(
      [syncing("159880"), current("159880")],
      expected,
    );
    expect(result.reads).toBe(2);
  });
});
