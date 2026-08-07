import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAIN } from "../config/arc";

/**
 * `wagmi.ts` reads `VITE_WALLETCONNECT_PROJECT_ID` once, at module load, and
 * builds `wagmiConfig` as a module constant. Importing it at the top of this
 * file therefore froze whatever the developer's gitignored `web/.env.local`
 * happened to contain: the suite passed on a machine that had the id and failed
 * on every clean checkout and in CI, which is exactly backwards for a test
 * guarding a wallet-selection regression.
 *
 * Both branches are stubbed explicitly instead, so the result depends on the
 * code under test rather than on the developer's environment.
 */
const PROJECT_ID = "0123456789abcdef0123456789abcdef";

async function loadWagmiConfig(projectId: string) {
  vi.resetModules();
  vi.stubEnv("VITE_WALLETCONNECT_PROJECT_ID", projectId);
  const { wagmiConfig } = await import("./wagmi");
  return wagmiConfig;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("RainbowKit wagmi configuration", () => {
  it("targets only Arc Testnet", async () => {
    const config = await loadWagmiConfig(PROJECT_ID);
    expect(config.chains.map((chain) => chain.id)).toEqual([CHAIN.id]);
  });

  it("keeps a generic injected connector for unnamed extensions", async () => {
    const config = await loadWagmiConfig(PROJECT_ID);
    expect(
      config.connectors.some((connector) => connector.type === "injected"),
    ).toBe(true);
  });

  it("registers named wallets, not WalletConnect alone", async () => {
    // RainbowKit builds its "Get a Wallet" screen from each wallet's
    // downloadUrls, and WalletConnect carries none. Registering it by itself
    // left a visitor with no extension facing an empty screen, so this guards
    // the named wallets that give that screen something to offer.
    const config = await loadWagmiConfig(PROJECT_ID);
    expect(config.connectors.length).toBeGreaterThanOrEqual(6);
  });

  it("registers only wallet connectors this app supports", async () => {
    // Outside a browser RainbowKit swaps every WalletConnect-backed wallet for
    // an SSR-safe "mock" connector, which is exactly this test environment.
    const config = await loadWagmiConfig(PROJECT_ID);
    expect(
      config.connectors.every((connector) =>
        ["injected", "walletConnect", "coinbaseWallet", "mock"].includes(
          connector.type,
        ),
      ),
    ).toBe(true);
  });

  it("falls back to injected-only when no project id is configured", async () => {
    // The documented behaviour: every RainbowKit wallet needs a WalletConnect
    // project id, so without one the app keeps its original EIP-6963 injected
    // discovery rather than offering wallets that cannot open a session. This
    // is the path a clean checkout takes, and it must stay deliberate.
    const config = await loadWagmiConfig("");
    expect(config.connectors.map((connector) => connector.type)).toEqual([
      "injected",
    ]);
    expect(config.chains.map((chain) => chain.id)).toEqual([CHAIN.id]);
  });
});
