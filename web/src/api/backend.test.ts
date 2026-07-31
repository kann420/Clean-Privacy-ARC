import { beforeEach, describe, expect, it } from "vitest";
import {
  resetBackendForTests,
  selectBackendMode,
} from "./backend";

describe("backend mode selection", () => {
  beforeEach(() => resetBackendForTests());

  it("selects explicit demo or live mode", () => {
    expect(selectBackendMode({ VITE_BACKEND_MODE: "demo" })).toBe("demo");
    expect(selectBackendMode({ VITE_BACKEND_MODE: "live" })).toBe("live");
  });

  it("defaults to live only when an API base URL exists", () => {
    expect(selectBackendMode({ VITE_API_BASE_URL: "/api" })).toBe("live");
    expect(selectBackendMode({})).toBe("demo");
  });

  it("rejects unknown modes instead of silently falling back", () => {
    expect(() =>
      selectBackendMode({ VITE_BACKEND_MODE: "http" }),
    ).toThrow(/exactly "demo" or "live"/u);
  });
});
