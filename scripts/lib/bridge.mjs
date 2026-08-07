import * as CircleChains from "@circle-fin/app-kit/chains";

import { requireHttpsUrl } from "./config.mjs";

/**
 * Steps CCTP V2 reports for a burn-and-mint transfer, in order. `approve` is
 * skipped when the source allowance already covers the amount, so the observed
 * sequence is a subsequence of this list, never a superset.
 */
export const BRIDGE_STEP_NAMES = Object.freeze([
  "approve",
  "burn",
  "fetchAttestation",
  "mint",
]);

const TRANSFER_SPEEDS = Object.freeze(["FAST", "SLOW"]);

/**
 * Index Circle's exported chain definitions by their `chain` identifier
 * (`Ethereum_Sepolia`), which is what the registry allowlist and the App Kit
 * bridge parameters both use.
 *
 * @param {Record<string, unknown>} [module]
 */
export function indexCircleChains(module = CircleChains) {
  /** @type {Record<string, any>} */
  const byIdentifier = {};
  for (const value of Object.values(module)) {
    if (
      typeof value !== "object" ||
      value === null ||
      typeof (/** @type {any} */ (value).chain) !== "string" ||
      typeof (/** @type {any} */ (value).chainId) !== "number"
    ) {
      continue;
    }
    byIdentifier[/** @type {any} */ (value).chain] = value;
  }
  return byIdentifier;
}

/**
 * @param {any} definition
 * @param {string} label
 */
function requireChainDefinition(definition, label) {
  if (!definition) {
    throw new Error(`${label} is not a Circle chain definition`);
  }
  if (typeof definition.usdcAddress !== "string") {
    throw new Error(`${label} has no USDC address in its chain definition`);
  }
  if (typeof definition.cctp?.domain !== "number") {
    throw new Error(`${label} has no CCTP domain in its chain definition`);
  }
  return definition;
}

/**
 * Resolve one bridge route into Arc, reading every chain fact from Circle's own
 * chain definitions so no address is duplicated into this repository.
 *
 * The destination is asserted against the local registry: identifier, chain id
 * and USDC address must all agree, otherwise the configured Arc entry and
 * Circle's view of Arc have drifted and no transfer should be attempted.
 *
 * @param {{
 *   config: ReturnType<import("./config.mjs").loadChainConfig>,
 *   source: string,
 *   chains?: Record<string, any>,
 * }} options
 */
export function resolveBridgeRoute(options) {
  const config = options.config;
  const allowlist = config.bridgeSources ?? [];
  if (!allowlist.includes(options.source)) {
    throw new Error(
      `unsupported bridge source: ${options.source}. Configured sources are ${allowlist.join(", ")}`,
    );
  }
  const chains = options.chains ?? indexCircleChains();

  const destination = requireChainDefinition(
    chains[config.circleChain],
    `destination chain ${config.circleChain}`,
  );
  if (destination.chainId !== config.chainId) {
    throw new Error(
      `Circle reports chain id ${destination.chainId} for ${config.circleChain}; the registry says ${config.chainId}`,
    );
  }
  if (
    destination.usdcAddress.toLowerCase() !==
    config.tokens.USDC.address.toLowerCase()
  ) {
    throw new Error(
      `Circle's USDC address for ${config.circleChain} does not match the configured registry address`,
    );
  }

  const source = requireChainDefinition(
    chains[options.source],
    `source chain ${options.source}`,
  );
  if (source.chainId === destination.chainId) {
    throw new Error("bridge source and destination must be different chains");
  }
  if (source.cctp.domain === destination.cctp.domain) {
    throw new Error("bridge source and destination share a CCTP domain");
  }
  if (source.isTestnet !== destination.isTestnet) {
    throw new Error("bridge source and destination must both be testnets");
  }

  return Object.freeze({
    // The adapter's `supportedChains` capability requires the full Circle chain
    // definition objects, not identifiers, so both are carried through.
    definitions: Object.freeze([source, destination]),
    source: Object.freeze({
      chain: source.chain,
      name: source.name,
      chainId: source.chainId,
      usdc: source.usdcAddress,
      cctpDomain: source.cctp.domain,
      nativeSymbol: source.nativeCurrency?.symbol ?? null,
      explorer: source.explorerUrl ?? null,
      rpcEndpoints: Object.freeze([...(source.rpcEndpoints ?? [])]),
    }),
    destination: Object.freeze({
      chain: destination.chain,
      name: destination.name,
      chainId: destination.chainId,
      usdc: destination.usdcAddress,
      cctpDomain: destination.cctp.domain,
      explorer: destination.explorerUrl ?? null,
    }),
  });
}

/**
 * Decide which endpoint each leg of the bridge dials.
 *
 * Arc reuses the existing `ARC_RPC_URL` transport override so one setting still
 * governs every Arc call in the repository. The source leg has its own optional
 * override and otherwise falls back to Circle's published endpoint. Both
 * overrides are HTTPS-only and belong in the gitignored `.env.local`, because a
 * provider URL usually embeds a token.
 *
 * @param {{
 *   config: {chainId: number, rpc: string},
 *   route: ReturnType<typeof resolveBridgeRoute>,
 *   env?: Record<string, string | undefined>,
 * }} options
 */
export function createBridgeRpcResolver(options) {
  const env = options.env ?? {};
  const arcOverride = (env.ARC_RPC_URL ?? "").trim();
  const arcUrl = arcOverride
    ? requireHttpsUrl(arcOverride, "ARC_RPC_URL")
    : options.config.rpc;

  const sourceOverride = (env.BRIDGE_SOURCE_RPC_URL ?? "").trim();
  const sourceFallback = options.route.source.rpcEndpoints[0];
  if (!sourceOverride && !sourceFallback) {
    throw new Error(
      `no RPC endpoint is available for ${options.route.source.chain}; set BRIDGE_SOURCE_RPC_URL`,
    );
  }
  const sourceUrl = sourceOverride
    ? requireHttpsUrl(sourceOverride, "BRIDGE_SOURCE_RPC_URL")
    : sourceFallback;

  /**
   * @param {number} chainId
   */
  return function resolveEndpoint(chainId) {
    if (chainId === options.config.chainId) return arcUrl;
    if (chainId === options.route.source.chainId) return sourceUrl;
    throw new Error(`bridge route does not cover chain id ${chainId}`);
  };
}

/**
 * @param {unknown} value
 */
export function requireTransferSpeed(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !TRANSFER_SPEEDS.includes(value)) {
    throw new Error(
      `transfer speed must be one of ${TRANSFER_SPEEDS.join(", ")}`,
    );
  }
  return value;
}

/**
 * Reduce one Bridge Kit step or lifecycle event to the public scalars evidence
 * is allowed to carry. Everything else in the payload — receipts, gas figures,
 * raw service responses — is deliberately dropped.
 *
 * @param {any} step
 */
export function normalizeBridgeStep(step) {
  const source = step?.values ?? step;
  if (typeof source?.name !== "string") {
    throw new Error("bridge step has no name");
  }
  const txHash = source.txHash ?? source.data?.txHash ?? null;
  if (txHash !== null && !/^[0-9a-zA-Z]+$/u.test(String(txHash))) {
    throw new Error(`bridge step ${source.name} has a malformed hash`);
  }
  return Object.freeze({
    name: source.name,
    state: typeof source.state === "string" ? source.state : "unknown",
    txHash: txHash === null ? null : String(txHash),
    explorerUrl:
      typeof source.explorerUrl === "string" ? source.explorerUrl : null,
  });
}

/**
 * @param {any} result
 */
export function summarizeBridgeResult(result) {
  const steps = Array.isArray(result?.steps)
    ? result.steps.map(normalizeBridgeStep)
    : [];
  return Object.freeze({
    state: typeof result?.state === "string" ? result.state : "unknown",
    steps: Object.freeze(steps),
    stepNames: Object.freeze(steps.map((step) => step.name)),
    stepStates: Object.freeze(steps.map((step) => step.state)),
    txHashes: Object.freeze(
      steps.map((step) => step.txHash).filter((hash) => hash !== null),
    ),
  });
}

/**
 * A bridge is only complete when the SDK reports success AND a mint step
 * actually succeeded on the destination chain. A `success` state with no
 * settled mint is treated as incomplete rather than trusted.
 *
 * @param {ReturnType<typeof summarizeBridgeResult>} summary
 * @param {string} label
 */
export function assertBridgeSucceeded(summary, label) {
  if (summary.state !== "success") {
    const failed = summary.steps.find((step) => step.state === "error");
    throw new Error(
      `${label} did not succeed: state ${summary.state}` +
        (failed ? `, failed step ${failed.name}` : ""),
    );
  }
  const mint = summary.steps.find((step) => step.name === "mint");
  if (!mint || mint.state !== "success") {
    throw new Error(
      `${label} reported success without a settled mint step; do not treat the funds as arrived`,
    );
  }
  return mint;
}
