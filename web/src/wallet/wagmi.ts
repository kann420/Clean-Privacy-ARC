import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import { walletConnectWallet } from "@rainbow-me/rainbowkit/wallets";
import { createConfig } from "wagmi";
import { injected } from "wagmi/connectors";
import { arcChain, arcTransport } from "./provider";

/**
 * RainbowKit reads this wagmi config. Wagmi's EIP-6963 discovery separates
 * installed extensions such as OKX, MetaMask, Rabby, and Coinbase without a
 * WalletConnect project id; WalletConnect itself (for mobile wallets and any
 * wallet without a browser extension) only registers when a project id is
 * configured, since a v2 project id is required to open a session.
 *
 * WalletConnect is wired through RainbowKit's own `connectorsForWallets`
 * rather than wagmi's bare `walletConnect()` connector: only a RainbowKit
 * wallet function attaches the `qrCode`/`walletConnectModalConnector`
 * metadata RainbowKit's connect modal needs to render the pairing QR code
 * itself, so a bare wagmi connector shows in the list but never opens a
 * session when clicked.
 */
const walletConnectProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as
  | string
  | undefined;

export const wagmiConfig = createConfig({
  chains: [arcChain],
  connectors: [
    injected({ shimDisconnect: true }),
    ...(walletConnectProjectId
      ? connectorsForWallets(
          [{ groupName: "WalletConnect", wallets: [walletConnectWallet] }],
          {
            projectId: walletConnectProjectId,
            appName: "Clean Privacy for Arc",
            appDescription:
              "Private transfers and unlinkable DeFi execution for Arc's supported assets, powered by Unlink.",
            appUrl: "https://arc.cleanprivacy.org",
            appIcon: "https://arc.cleanprivacy.org/assets/brand/cleanprivacy-mark-arc.png",
          },
        )
      : []),
  ],
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
