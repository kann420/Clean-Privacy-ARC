import { describe, expect, it } from "vitest";
import {
  SCREEN_PATHS,
  isPlainLeftClick,
  pathForScreen,
  screenFromPath,
  titleForScreen,
} from "./routing";

describe("screen paths", () => {
  it("gives every tab the path the deployed domain will serve", () => {
    expect(SCREEN_PATHS).toEqual({
      landing: "/",
      account: "/account",
      deposit: "/deposit",
      transfer: "/transfer",
      swap: "/swap",
      evidence: "/evidence",
    });
  });

  it("round-trips every screen through its path", () => {
    for (const screen of Object.keys(SCREEN_PATHS) as (keyof typeof SCREEN_PATHS)[]) {
      expect(screenFromPath(pathForScreen(screen))).toBe(screen);
    }
  });

  it("accepts trailing slashes and mixed case from hosts and typed URLs", () => {
    expect(screenFromPath("/deposit/")).toBe("deposit");
    expect(screenFromPath("/Evidence")).toBe("evidence");
    expect(screenFromPath("/SWAP//")).toBe("swap");
    expect(screenFromPath("")).toBe("landing");
    expect(screenFromPath("/")).toBe("landing");
  });

  it("reports an unknown path so the caller can fall back to the landing page", () => {
    expect(screenFromPath("/accounts")).toBeNull();
    expect(screenFromPath("/deposit/usdc")).toBeNull();
    expect(screenFromPath("/api/health")).toBeNull();
  });

  it("titles each tab, so a bookmark says where it points", () => {
    expect(titleForScreen("landing")).toBe("Clean Privacy for Arc");
    expect(titleForScreen("swap")).toBe("Swap · Clean Privacy for Arc");
  });
});

describe("isPlainLeftClick", () => {
  const plain = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
  };

  it("handles an unmodified left click in the app", () => {
    expect(isPlainLeftClick(plain)).toBe(true);
  });

  it("leaves every click the browser has its own meaning for alone", () => {
    // Open in a new tab, new window, download, or a middle-click paste target:
    // intercepting any of these would break a link the user meant to keep.
    expect(isPlainLeftClick({ ...plain, metaKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...plain, ctrlKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...plain, shiftKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...plain, altKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...plain, button: 1 })).toBe(false);
    expect(isPlainLeftClick({ ...plain, defaultPrevented: true })).toBe(false);
  });
});
