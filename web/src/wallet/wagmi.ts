import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  coinbaseWallet,
  injectedWallet,
  metaMaskWallet,
  okxWallet,
  rabbyWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { createConfig } from "wagmi";
import { injected } from "wagmi/connectors";
import { arcChain, arcTransport } from "./provider";

/**
 * RainbowKit's connect modal only ever lists two kinds of connector: those
 * wagmi discovered over EIP-6963, and those carrying RainbowKit's own
 * `rkDetails` marker. A bare wagmi connector has neither, so it is dropped
 * from the modal entirely — which is why every wallet offered here goes
 * through `connectorsForWallets`.
 *
 * Naming real wallets rather than WalletConnect alone is what populates the
 * "Get a Wallet" screen: that list is built from each wallet's `downloadUrls`,
 * and WalletConnect has none, so registering it by itself leaves a visitor
 * without an extension staring at an empty screen and no way to pick one.
 * These entries also carry the `qrCode` metadata the modal needs to draw a
 * pairing code itself.
 *
 * Nothing here duplicates an installed extension: RainbowKit drops a named
 * wallet whose `rdns` already arrived over EIP-6963, so an installed MetaMask
 * shows once, under "Installed", and an absent one shows as an install link.
 */
const walletConnectProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as
  | string
  | undefined;

/**
 * Every RainbowKit wallet needs a WalletConnect project id, because each one
 * falls back to a WalletConnect session when its extension is absent. Without
 * the id the app keeps its original behaviour: injected extensions only,
 * discovered over EIP-6963.
 */
const connectors = walletConnectProjectId
  ? connectorsForWallets(
      [
        {
          groupName: "Recommended",
          wallets: [metaMaskWallet, rabbyWallet, okxWallet, coinbaseWallet],
        },
        {
          groupName: "Other",
          wallets: [walletConnectWallet, injectedWallet],
        },
      ],
      {
        projectId: walletConnectProjectId,
        appName: "Clean Privacy for Arc",
        appDescription:
          "Private transfers and unlinkable DeFi execution for Arc's supported assets, powered by Unlink.",
        appUrl: "https://arc.cleanprivacy.org",
        appIcon:
          "https://arc.cleanprivacy.org/assets/brand/cleanprivacy-mark-arc.png",
      },
    )
  : [injected({ shimDisconnect: true })];

export const wagmiConfig = createConfig({
  chains: [arcChain],
  connectors,
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
