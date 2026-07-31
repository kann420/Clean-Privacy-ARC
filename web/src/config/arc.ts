import { ARC_REGISTRY } from "./chains.generated";

export { ARC_REGISTRY };

export const EXPLORER = ARC_REGISTRY.explorer;

export const CHAIN = {
  id: ARC_REGISTRY.chainId,
  name: "Arc Testnet",
  rpc: ARC_REGISTRY.rpc,
  env: ARC_REGISTRY.unlinkEnvironment,
  appId: "clean-privacy-arc",
} as const;

export const ADDR = {
  pool: ARC_REGISTRY.protocol.unlinkPool,
  permit2: ARC_REGISTRY.protocol.permit2,
  entryPoint: ARC_REGISTRY.protocol.entryPoint,
  eaFactory: ARC_REGISTRY.protocol.executionAccountFactory,
  eaImplementation: ARC_REGISTRY.protocol.executionAccountImplementation,
  circleAdapter: ARC_REGISTRY.protocol.circleAdapter,
  usdc: ARC_REGISTRY.tokens.USDC.address,
  eurc: ARC_REGISTRY.tokens.EURC.address,
  cirbtc: ARC_REGISTRY.tokens.cirBTC.address,
} as const;

/**
 * The registry's fee owner doubles as the demo wallet address. Every other
 * sample value lives in `src/api/demoFixtures.ts`: this module is the generated
 * projection of `config/chains.json` and stays free of hand-written literals.
 */
export const WALLET = ARC_REGISTRY.fees.owner;

export type TokenSymbol = keyof typeof ARC_REGISTRY.tokens;

export type TokenMeta = {
  symbol: TokenSymbol;
  dec: number;
  address: `0x${string}`;
  icon: string;
  tint: string;
};

export const TOKENS: readonly TokenMeta[] = [
  {
    symbol: "USDC",
    dec: ARC_REGISTRY.tokens.USDC.decimals,
    address: ARC_REGISTRY.tokens.USDC.address,
    icon: "/assets/tokens/usdc.webp",
    tint: "var(--mist)",
  },
  {
    symbol: "EURC",
    dec: ARC_REGISTRY.tokens.EURC.decimals,
    address: ARC_REGISTRY.tokens.EURC.address,
    icon: "/assets/tokens/eurc.png",
    tint: "var(--sand)",
  },
  {
    symbol: "cirBTC",
    dec: ARC_REGISTRY.tokens.cirBTC.decimals,
    address: ARC_REGISTRY.tokens.cirBTC.address,
    icon: "/assets/tokens/cirbtc.svg",
    tint: "var(--peach)",
  },
];

export const TOK = (symbol: string): TokenMeta =>
  TOKENS.find((token) => token.symbol === symbol) ?? TOKENS[0]!;

export const USDC_GAS_BUFFER = 1;
export const FEES = ARC_REGISTRY.fees;
export const SLIPPAGE = 0.03;

// A route is keyed by its OUTPUT token, so "eurc" buys EURC and "usdc" sells it
// back. The `in` symbol drives the withdrawal, the protocol fee and the venue
// approval; `out` drives returnToPool. Both must be read from the route rather
// than assumed, or the reverse direction silently pays fees in the wrong asset.
export type RouteId = "eurc" | "usdc";

export type Route = {
  id: RouteId;
  in: "USDC" | "EURC";
  out: "EURC" | "USDC";
  label: string;
  venue: string;
  target: string;
  targetLabel: string;
  quote: (amountIn: number) => number;
  min: (amountIn: number) => number;
  call: string;
  provider: string;
};

export const ROUTES: Record<RouteId, Route> = {
  eurc: {
    id: "eurc",
    in: "USDC",
    out: "EURC",
    label: "USDC → EURC",
    venue: "Circle App Kit",
    target: ADDR.circleAdapter,
    targetLabel: "Circle Adapter",
    quote: (amount) => amount * 0.77592,
    min: (amount) => amount * 0.77592 * (1 - SLIPPAGE),
    call: "approve exact net input + validated Circle Adapter swap",
    provider: "indicative quote · final bounds come from the captured plan",
  },
  usdc: {
    id: "usdc",
    in: "EURC",
    out: "USDC",
    label: "EURC → USDC",
    venue: "Circle App Kit",
    target: ADDR.circleAdapter,
    targetLabel: "Circle Adapter",
    quote: (amount) => amount * 1.3149,
    min: (amount) => amount * 1.3149 * (1 - SLIPPAGE),
    call: "approve exact net input + validated Circle Adapter swap",
    provider: "indicative quote · final bounds come from the captured plan",
  },
};

export const REVERSE_ROUTE: Record<RouteId, RouteId> = {
  eurc: "usdc",
  usdc: "eurc",
};

export const DEMO_VIDEO_URL =
  import.meta.env.VITE_DEMO_VIDEO_URL ?? "/media/clean-privacy-arc-demo.mp4";
