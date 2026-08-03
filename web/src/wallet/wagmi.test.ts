import { describe, expect, it } from "vitest";
import { CHAIN } from "../config/arc";
import { wagmiConfig } from "./wagmi";

describe("RainbowKit wagmi configuration", () => {
  it("targets only Arc Testnet", () => {
    expect(wagmiConfig.chains.map((chain) => chain.id)).toEqual([CHAIN.id]);
  });

  it("keeps a generic injected connector for unnamed extensions", () => {
    expect(
      wagmiConfig.connectors.some((connector) => connector.type === "injected"),
    ).toBe(true);
  });

  it("registers named wallets, not WalletConnect alone", () => {
    // RainbowKit builds its "Get a Wallet" screen from each wallet's
    // downloadUrls, and WalletConnect carries none. Registering it by itself
    // left a visitor with no extension facing an empty screen, so this guards
    // the named wallets that give that screen something to offer.
    expect(wagmiConfig.connectors.length).toBeGreaterThanOrEqual(6);
  });

  it("registers only wallet connectors this app supports", () => {
    // Outside a browser RainbowKit swaps every WalletConnect-backed wallet for
    // an SSR-safe "mock" connector, which is exactly this test environment.
    expect(
      wagmiConfig.connectors.every((connector) =>
        ["injected", "walletConnect", "coinbaseWallet", "mock"].includes(
          connector.type,
        ),
      ),
    ).toBe(true);
  });
});
