import { describe, expect, it } from "vitest";

import { asBackendError, BackendError } from "./types";

/**
 * Phase 4 live finding: an injected-wallet deposit failed with
 * "The backend returned an unexpected error." EIP-1193 providers reject with
 * plain objects rather than `Error` instances, so every wallet failure — even a
 * plain user rejection — lost its reason and its code.
 */
describe("non-Error rejections", () => {
  it("keeps the message and code of an EIP-1193 rejection", () => {
    const failure = asBackendError({
      code: 4001,
      message: "User rejected the request.",
    });
    expect(failure.body).toBe("User rejected the request. (code 4001)");
  });

  it("reads viem-style short messages and reasons", () => {
    expect(
      asBackendError({ shortMessage: "Insufficient funds for gas" }).body,
    ).toBe("Insufficient funds for gas");
    expect(asBackendError({ reason: "execution reverted" }).body).toBe(
      "execution reverted",
    );
  });

  it("names the code even when no message is present", () => {
    expect(asBackendError({ code: -32603 }).body).toContain("code -32603");
  });

  it("handles a thrown string", () => {
    expect(asBackendError("relayer timed out").body).toBe("relayer timed out");
  });

  it("still strips request bodies out of provider text", () => {
    const failure = asBackendError({
      message: "HTTP request failed.\nRequest body: {\"secret\":\"x\"}",
    });
    expect(failure.body).toBe("HTTP request failed.");
    expect(failure.body).not.toContain("secret");
  });

  it("falls back only when there is genuinely nothing to report", () => {
    expect(asBackendError({}).body).toBe(
      "The backend returned an unexpected error.",
    );
    expect(asBackendError(null).body).toBe(
      "The backend returned an unexpected error.",
    );
  });

  it("passes an existing BackendError through untouched", () => {
    const original = new BackendError("Pending operation exists", "body");
    expect(asBackendError(original)).toBe(original);
  });
});
