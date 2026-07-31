import { createConfig } from "wagmi";
import { injected } from "wagmi/connectors";
import { arcChain, arcTransport } from "./provider";

/**
 * RainbowKit reads this wagmi config and displays only injected browser
 * wallets. Wagmi's EIP-6963 discovery separates installed extensions such as
 * OKX, MetaMask, Rabby, and Coinbase without a WalletConnect project id.
 */
export const wagmiConfig = createConfig({
  chains: [arcChain],
  connectors: [injected({ shimDisconnect: true })],
  multiInjectedProviderDiscovery: true,
  transports: {
    [arcChain.id]: arcTransport(),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
