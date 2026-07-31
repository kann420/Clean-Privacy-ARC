import { describe, expect, it } from "vitest";
import { CHAIN } from "../config/arc";
import { wagmiConfig } from "./wagmi";

describe("RainbowKit wagmi configuration", () => {
  it("targets only Arc Testnet", () => {
    expect(wagmiConfig.chains.map((chain) => chain.id)).toEqual([CHAIN.id]);
  });

  it("registers injected connectors only", () => {
    expect(wagmiConfig.connectors.length).toBeGreaterThan(0);
    expect(
      wagmiConfig.connectors.every(
        (connector) => connector.type === "injected",
      ),
    ).toBe(true);
  });
});
