import { describe, expect, it } from "vitest";

/**
 * Live finding on an extension deposit made right after registration: the
 * account still answered `sync_status: "syncing"` with a stale amount, so the
 * operation recorded a wrong `before` baseline. The deposit then succeeded
 * on-chain but its exact delta check could never pass, and the entry landed in
 * `manual_recovery_required` with the funds safe but every later mutation
 * blocked.
 *
 * Reproduces the guard's contract: a baseline is only ever taken from a synced
 * snapshot, and it fails closed rather than recording a wrong one.
 */
type Snapshot = { balances: { USDC: string }; syncStatus: string };

async function syncedBaseline(
  snapshots: Snapshot[],
  attempts = 6,
): Promise<{ balances: { USDC: string }; reads: number }> {
  let reads = 0;
  const next = () => snapshots[Math.min(reads++, snapshots.length - 1)]!;
  let snapshot = next();
  for (
    let attempt = 1;
    attempt < attempts && snapshot.syncStatus !== "current";
    attempt += 1
  ) {
    snapshot = next();
  }
  if (snapshot.syncStatus !== "current") {
    throw new Error("Private balance is still syncing");
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

describe("starting balance baseline", () => {
  it("never records the stale zero a freshly registered account reports", async () => {
    const result = await syncedBaseline([
      syncing("0"),
      syncing("0"),
      current("999900"),
    ]);
    expect(result.balances.USDC).toBe("999900");
  });

  it("takes a settled first read immediately", async () => {
    const result = await syncedBaseline([current("999900")]);
    expect(result.reads).toBe(1);
  });

  it("refuses to start rather than baking in a wrong baseline", async () => {
    await expect(syncedBaseline([syncing("0")])).rejects.toThrow(
      /still syncing/u,
    );
  });
});
