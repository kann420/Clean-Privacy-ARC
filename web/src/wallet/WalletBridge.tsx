import { useEffect, useRef } from "react";
import { useAccount } from "wagmi";
import type { CleanPrivacyStore } from "../state/useCleanPrivacy";
import {
  setInjectedProvider,
  type Eip1193Provider,
} from "./provider";

function asEip1193Provider(value: unknown): Eip1193Provider {
  if (
    !value ||
    typeof value !== "object" ||
    !("request" in value) ||
    typeof value.request !== "function"
  ) {
    throw new Error("The selected wallet did not expose an EIP-1193 provider.");
  }
  return value as Eip1193Provider;
}

/**
 * Keeps RainbowKit/wagmi connection state and the Unlink backend adapter in
 * lockstep. The selected EIP-6963 provider is handed to the existing signing
 * path, so multiple installed extensions never fall back to window.ethereum.
 */
export function WalletBridge({ store }: { store: CleanPrivacyStore }) {
  const { address, connector, status } = useAccount();
  const adoptedConnection = useRef<string | null>(null);

  useEffect(() => {
    if (status !== "connected" || !address || !connector) return;
    if (
      store.session.walletKind === "injected" &&
      store.session.wallet?.toLowerCase() === address.toLowerCase()
    ) {
      return;
    }

    const connectionKey = `${connector.uid}:${address.toLowerCase()}`;
    if (adoptedConnection.current === connectionKey) return;
    adoptedConnection.current = connectionKey;

    void connector
      .getProvider()
      .then((provider) => {
        setInjectedProvider(asEip1193Provider(provider));
        return store.actions.connectWallet("injected");
      })
      .catch(() => {
        setInjectedProvider(null);
      });
  }, [
    address,
    connector,
    status,
    store.actions,
    store.session.wallet,
    store.session.walletKind,
  ]);

  useEffect(() => {
    if (status !== "disconnected") return;
    adoptedConnection.current = null;
    setInjectedProvider(null);
    if (store.session.walletKind === "injected") {
      store.actions.disconnectWallet();
    }
  }, [status, store.actions, store.session.walletKind]);

  return null;
}
