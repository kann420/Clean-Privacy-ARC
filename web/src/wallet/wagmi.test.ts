import { describe, expect, it } from "vitest";
import { CHAIN } from "../config/arc";
import { wagmiConfig } from "./wagmi";

describe("RainbowKit wagmi configuration", () => {
  it("targets only Arc Testnet", () => {
    expect(wagmiConfig.chains.map((chain) => chain.id)).toEqual([CHAIN.id]);
  });

  it("always registers the injected connector", () => {
    expect(
      wagmiConfig.connectors.some((connector) => connector.type === "injected"),
    ).toBe(true);
  });

  it("registers only injected and WalletConnect connectors", () => {
    // RainbowKit's connectorsForWallets swaps the real WalletConnect
    // connector for an SSR-safe "mock" one outside a browser (no `window`),
    // which is exactly the environment this test runs in.
    expect(wagmiConfig.connectors.length).toBeGreaterThan(0);
    expect(
      wagmiConfig.connectors.every((connector) =>
        ["injected", "walletConnect", "mock"].includes(connector.type),
      ),
    ).toBe(true);
  });
});
