import { describe, expect, it } from "vitest";

import { RETRYABLE_RPC_ERROR } from "./unlinkBackend";

/**
 * Live G4 finding: once the public Arc RPC limit is tripped it answers 429
 * without CORS headers, so the browser never sees the status and viem reports
 * "HTTP request failed." with "Failed to fetch". The original predicate matched
 * only the readable rate-limit wording, so the first blocked read aborted the
 * whole mutation instead of backing off.
 */
describe("retryable RPC errors", () => {
  it("retries the browser's opaque symptom of a blocked read", () => {
    for (const message of [
      "HTTP request failed.\nDetails: Failed to fetch",
      "TypeError: Failed to fetch",
      "fetch failed",
      "Load failed",
      "NetworkError when attempting to fetch resource.",
    ]) {
      expect(RETRYABLE_RPC_ERROR.test(message)).toBe(true);
    }
  });

  it("still retries the readable rate-limit wording", () => {
    for (const message of [
      "request limit reached",
      "rate limit exceeded",
      "Too many requests",
      "HTTP request failed. Status: 429",
    ]) {
      expect(RETRYABLE_RPC_ERROR.test(message)).toBe(true);
    }
  });

  it("does not retry a genuine contract or chain error", () => {
    for (const message of [
      "Readiness check failed: Arc Testnet chain ID",
      "execution reverted: insufficient balance",
      "Readiness check failed: Circle adapter has no bytecode",
    ]) {
      expect(RETRYABLE_RPC_ERROR.test(message)).toBe(false);
    }
  });
});
