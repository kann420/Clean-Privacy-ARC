import { describe, expect, it } from "vitest";

import { ctaAction, swapReceiptLink } from "./viewModel";

/**
 * Phase 4 live QA: the receipt button reads "Send another" / "Swap again" but
 * was wired to the run action, so a single click re-broadcast the operation
 * that had just settled. It sent a real duplicate 0.05 USDC transfer on Arc
 * Testnet. The done state must reset, never resubmit.
 */
describe("done-state call to action", () => {
  const run = () => "SUBMITTED";
  const reset = () => "RESET";

  it("resets instead of resubmitting once the operation has completed", () => {
    expect(ctaAction(true, reset, run)()).toBe("RESET");
    expect(ctaAction(true, reset, run)).not.toBe(run);
  });

  it("still runs the operation while the form is editable", () => {
    expect(ctaAction(false, reset, run)()).toBe("SUBMITTED");
    expect(ctaAction(false, reset, run)).toBe(run);
  });

  it("maps the real transfer and swap done steps", () => {
    // transferStep 2 and swapStep 3 are the receipt states.
    for (const step of [0, 1]) {
      expect(ctaAction(step === 2, reset, run)).toBe(run);
    }
    expect(ctaAction(2 === 2, reset, run)).toBe(reset);
    for (const step of [0, 1, 2]) {
      expect(ctaAction(step === 3, reset, run)).toBe(run);
    }
    expect(ctaAction(3 === 3, reset, run)).toBe(reset);
  });
});

describe("swap receipt explorer link", () => {
  const explorer = "https://explorer.example";
  const accountAddress = "0x39c3000000000000000000000000000000008b8C";
  const phaseA = `0x${"a".repeat(64)}`;
  const phaseB = `0x${"b".repeat(64)}`;

  it("links the Phase B swap when its hash is known", () => {
    expect(
      swapReceiptLink(
        { phaseBTxHash: phaseB, handleOpsTxHash: phaseA, accountAddress },
        explorer,
      ),
    ).toEqual({ hash: phaseB, href: `${explorer}/tx/${phaseB}` });
  });

  it("falls back to Phase A when the SDK reported no Phase B hash", () => {
    expect(
      swapReceiptLink({ handleOpsTxHash: phaseA, accountAddress }, explorer),
    ).toEqual({ hash: phaseA, href: `${explorer}/tx/${phaseA}` });
  });

  it("never produces a dead link when no hash exists at all", () => {
    // The demo backend has no transaction hashes; the chip must still resolve.
    const link = swapReceiptLink({ accountAddress }, explorer);
    expect(link.hash).toBeNull();
    expect(link.href).toBe(`${explorer}/address/${accountAddress}`);
  });
});
