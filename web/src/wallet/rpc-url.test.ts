import { describe, expect, it } from "vitest";

import { selectRpcUrl } from "./provider";
import { ARC_REGISTRY } from "../config/arc";

/**
 * Live finding: the browser talked to the public Arc RPC directly, so a
 * rate-limited answer arrived as a 429 with no CORS headers and the tab could
 * only report an opaque failure. Live mode now dials the loopback relay, which
 * paces, retries and caches on the app's behalf.
 */
describe("browser RPC endpoint selection", () => {
  it("uses the loopback relay in live mode", () => {
    expect(selectRpcUrl({ VITE_BACKEND_MODE: "live" })).toBe("/api/rpc");
  });

  it("respects an explicit API base URL", () => {
    expect(
      selectRpcUrl({
        VITE_BACKEND_MODE: "live",
        VITE_API_BASE_URL: "http://127.0.0.1:8787/",
      }),
    ).toBe("http://127.0.0.1:8787/api/rpc");
  });

  it("keeps the registry endpoint in demo mode, which needs no backend", () => {
    expect(selectRpcUrl({ VITE_BACKEND_MODE: "demo" })).toBe(ARC_REGISTRY.rpc);
    expect(selectRpcUrl({})).toBe(ARC_REGISTRY.rpc);
  });

  it("concatenates exactly like readJson, so the dev convention is unchanged", () => {
    // Internal paths already carry `/api`, so VITE_API_BASE_URL must stay empty
    // in development or every path doubles. This mirrors readJson rather than
    // inventing a second rule — the doubling below is the same known footgun,
    // not a special case.
    expect(selectRpcUrl({ VITE_API_BASE_URL: "/api" })).toBe("/api/api/rpc");
  });
});
