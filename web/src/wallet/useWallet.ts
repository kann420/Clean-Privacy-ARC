import { useCallback, useEffect, useState } from "react";
import type { WalletKind } from "../api/types";
import {
  injectedAccounts,
  injectedProvider,
  providerChainOk,
  switchToArc,
  type Eip1193Provider,
} from "./provider";

export type WalletView = {
  kind: WalletKind | null;
  address: string | null;
  chainOk: boolean;
  connected: boolean;
};

const EMPTY: WalletView = {
  kind: null,
  address: null,
  chainOk: false,
  connected: false,
};

export function useWallet(onInvalidate?: () => void) {
  const [wallet, setWallet] = useState<WalletView>(EMPTY);
  const [provider, setProvider] = useState<Eip1193Provider | null>(null);

  const refreshInjected = useCallback(
    async (candidate: Eip1193Provider) => {
      onInvalidate?.();
      const accounts = await injectedAccounts(candidate);
      setWallet({
        kind: accounts[0] ? "injected" : null,
        address: accounts[0] ?? null,
        chainOk: accounts[0] ? await providerChainOk(candidate) : false,
        connected: Boolean(accounts[0]),
      });
    },
    [onInvalidate],
  );

  useEffect(() => {
    if (!provider?.on) return;
    const changed = () => void refreshInjected(provider);
    const disconnected = () => {
      onInvalidate?.();
      setWallet(EMPTY);
    };
    provider.on("accountsChanged", changed);
    provider.on("chainChanged", changed);
    provider.on("disconnect", disconnected);
    return () => {
      provider.removeListener?.("accountsChanged", changed);
      provider.removeListener?.("chainChanged", changed);
      provider.removeListener?.("disconnect", disconnected);
    };
  }, [onInvalidate, provider, refreshInjected]);

  const connect = useCallback(
    async (kind: WalletKind) => {
      onInvalidate?.();
      const next = injectedProvider();
      const accounts = await injectedAccounts(next, true);
      setProvider(next);
      setWallet({
        kind,
        address: accounts[0] ?? null,
        chainOk: await providerChainOk(next),
        connected: Boolean(accounts[0]),
      });
    },
    [onInvalidate],
  );

  const switchChain = useCallback(async () => {
    if (!provider) return;
    await switchToArc(provider);
    await refreshInjected(provider);
  }, [provider, refreshInjected]);

  const disconnect = useCallback(() => {
    onInvalidate?.();
    setProvider(null);
    setWallet(EMPTY);
  }, [onInvalidate]);

  return { wallet, provider, connect, disconnect, switchChain };
}
