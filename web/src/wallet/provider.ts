import {
  defineChain,
  http,
  type Address,
  type Transport,
} from "viem";
import { ARC_REGISTRY, CHAIN } from "../config/arc";

export type Eip1193Provider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
};

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

let selectedInjectedProvider: Eip1193Provider | null = null;

export function setInjectedProvider(
  provider: Eip1193Provider | null,
): void {
  selectedInjectedProvider = provider;
}

/**
 * The public Arc RPC rate-limits bursts and reports it as a JSON-RPC error in a
 * 200 response body ("request limit reached"), which viem's transport retry does
 * not treat as retryable. Every client in the app shares this transport so an
 * SDK-driven burst self-heals instead of aborting a live operation.
 *
 * Once the limit is actually tripped the endpoint answers 429 WITHOUT CORS
 * headers. The browser therefore cannot read the status at all and surfaces the
 * opaque `TypeError: Failed to fetch`, which viem rethrows as "HTTP request
 * failed." (Phase 4 G4 live finding). Matching only the readable wording missed
 * that symptom entirely, so SDK-internal confirmation reads — which do NOT go
 * through the app's own paced gate — aborted live resume attempts. Reads are the
 * only thing this transport retries into, so a retry cannot double-submit.
 */
const RATE_LIMIT =
  /request limit|rate limit|too many request|status: 429|failed to fetch|http request failed|fetch failed|network ?error|load failed/iu;

/**
 * Where the browser sends JSON-RPC.
 *
 * In live mode it is the loopback backend's relay, NOT the public endpoint
 * directly. The relay is same-origin (so a rate-limited answer can never
 * present as an opaque CORS failure), it serializes and paces every upstream
 * call across tabs, and it caches `eth_chainId` and `eth_getCode` — which is
 * what the readiness gate spends nine calls on at every page load.
 *
 * Demo mode performs no live reads, so it keeps the registry URL and needs no
 * backend at all. `config/chains.json` therefore remains the single source of
 * truth for the real endpoint; this only chooses who dials it.
 */
export function selectRpcUrl(
  env: Record<string, string | undefined> = import.meta.env as never,
): string {
  const mode = env.VITE_BACKEND_MODE;
  const base = (env.VITE_API_BASE_URL ?? "").replace(/\/$/u, "");
  if (mode === "demo" || (mode !== "live" && !env.VITE_API_BASE_URL)) {
    return ARC_REGISTRY.rpc;
  }
  return `${base}/api/rpc`;
}

export function arcTransport(): Transport {
  // A tripped limit blocks for seconds: viem's own 2 x 400 ms budget is far too
  // short to ride it out, so give the inner transport a longer one too.
  const inner = http(selectRpcUrl(), { retryCount: 3, retryDelay: 800 });
  const wrapped: Transport = (config) => {
    const transport = inner(config as never);
    const request = transport.request;
    return {
      ...transport,
      request: (async (args: unknown) => {
        for (let attempt = 0; ; attempt += 1) {
          try {
            return await (request as (input: unknown) => Promise<unknown>)(args);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            if (attempt >= 5 || !RATE_LIMIT.test(message)) throw error;
            await new Promise((resolve) =>
              setTimeout(resolve, 1_000 * 2 ** attempt),
            );
          }
        }
      }) as typeof transport.request,
    };
  };
  return wrapped;
}

export const arcChain = defineChain({
  id: CHAIN.id,
  name: CHAIN.name,
  nativeCurrency: ARC_REGISTRY.nativeCurrency,
  rpcUrls: { default: { http: [ARC_REGISTRY.rpc] } },
  blockExplorers: {
    default: { name: "ArcScan", url: ARC_REGISTRY.explorer },
  },
  testnet: true,
});

export function injectedProvider(): Eip1193Provider {
  const provider = selectedInjectedProvider ?? window.ethereum;
  if (!provider) {
    throw new Error("No injected EIP-1193 wallet was found.");
  }
  return provider;
}

export async function injectedAccounts(
  provider: Eip1193Provider,
  request = false,
): Promise<Address[]> {
  const result = await provider.request({
    method: request ? "eth_requestAccounts" : "eth_accounts",
  });
  if (!Array.isArray(result)) return [];
  return result.filter(
    (value): value is Address =>
      typeof value === "string" && /^0x[0-9a-fA-F]{40}$/u.test(value),
  );
}

export async function providerChainOk(
  provider: Eip1193Provider,
): Promise<boolean> {
  const value = await provider.request({ method: "eth_chainId" });
  return typeof value === "string" && Number(BigInt(value)) === CHAIN.id;
}

export async function switchToArc(provider: Eip1193Provider): Promise<void> {
  const chainId = `0x${CHAIN.id.toString(16)}`;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId }],
    });
  } catch (error) {
    const code =
      typeof error === "object" && error && "code" in error
        ? Number(error.code)
        : 0;
    if (code !== 4902) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: CHAIN.name,
          nativeCurrency: ARC_REGISTRY.nativeCurrency,
          rpcUrls: [ARC_REGISTRY.rpc],
          blockExplorerUrls: [ARC_REGISTRY.explorer],
        },
      ],
    });
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId }],
    });
  }
}
