import assert from "node:assert/strict";
import test from "node:test";

import {
  BRIDGE_STEP_NAMES,
  assertBridgeSucceeded,
  createBridgeRpcResolver,
  indexCircleChains,
  normalizeBridgeStep,
  requireTransferSpeed,
  resolveBridgeRoute,
  summarizeBridgeResult,
} from "./bridge.mjs";
import { loadChainConfig } from "./config.mjs";

const CONFIG = loadChainConfig();

function chainDefinition(overrides) {
  return {
    type: "evm",
    chain: "Ethereum_Sepolia",
    name: "Ethereum Sepolia",
    chainId: 11_155_111,
    isTestnet: true,
    usdcAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    explorerUrl: "https://sepolia.etherscan.io",
    rpcEndpoints: ["https://ethereum-sepolia-rpc.publicnode.com"],
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    cctp: { domain: 0 },
    ...overrides,
  };
}

function arcDefinition(overrides) {
  return chainDefinition({
    chain: "Arc_Testnet",
    name: "Arc Testnet",
    chainId: CONFIG.chainId,
    usdcAddress: CONFIG.tokens.USDC.address,
    rpcEndpoints: [CONFIG.rpc],
    nativeCurrency: { name: "Arc Testnet USDC", symbol: "USDC", decimals: 18 },
    cctp: { domain: 26 },
    ...overrides,
  });
}

function chainsFor(source, destination) {
  return {
    [source.chain]: source,
    [destination.chain]: destination,
  };
}

test("the registry allowlist matches Circle's published chain definitions", () => {
  const chains = indexCircleChains();
  assert.ok(CONFIG.bridgeSources.length > 0);
  for (const identifier of CONFIG.bridgeSources) {
    const definition = chains[identifier];
    assert.ok(definition, `${identifier} is not a Circle chain definition`);
    assert.equal(definition.isTestnet, true);
    assert.equal(typeof definition.usdcAddress, "string");
    assert.equal(typeof definition.cctp.domain, "number");
    assert.notEqual(definition.chain, CONFIG.circleChain);
  }
});

test("a live route reads every chain fact from Circle, not from this repository", () => {
  const route = resolveBridgeRoute({ config: CONFIG, source: "Base_Sepolia" });

  assert.equal(route.source.chain, "Base_Sepolia");
  assert.equal(route.source.chainId, 84_532);
  assert.equal(route.source.cctpDomain, 6);
  assert.equal(route.destination.chain, "Arc_Testnet");
  assert.equal(route.destination.chainId, CONFIG.chainId);
  assert.equal(route.destination.cctpDomain, 26);
  // Arc's CCTP domain is 26 and its USDC is the configured registry address.
  assert.equal(
    route.destination.usdc.toLowerCase(),
    CONFIG.tokens.USDC.address.toLowerCase(),
  );
  assert.deepEqual(
    route.definitions.map((definition) => definition.chain),
    ["Base_Sepolia", "Arc_Testnet"],
  );
});

test("a source outside the configured allowlist is refused", () => {
  assert.throws(
    () => resolveBridgeRoute({ config: CONFIG, source: "Ethereum" }),
    /unsupported bridge source/u,
  );
});

test("a destination that drifts from the registry hard stops before any burn", () => {
  const source = chainDefinition();

  assert.throws(
    () =>
      resolveBridgeRoute({
        config: CONFIG,
        source: source.chain,
        chains: chainsFor(source, arcDefinition({ chainId: 1 })),
      }),
    /Circle reports chain id 1/u,
  );

  assert.throws(
    () =>
      resolveBridgeRoute({
        config: CONFIG,
        source: source.chain,
        chains: chainsFor(
          source,
          arcDefinition({
            usdcAddress: "0x0000000000000000000000000000000000000001",
          }),
        ),
      }),
    /USDC address for Arc_Testnet does not match/u,
  );
});

test("a mainnet source cannot be bridged into the Arc testnet", () => {
  assert.throws(
    () =>
      resolveBridgeRoute({
        config: CONFIG,
        source: "Ethereum_Sepolia",
        chains: chainsFor(
          chainDefinition({ isTestnet: false }),
          arcDefinition(),
        ),
      }),
    /both be testnets/u,
  );
});

test("a source sharing the destination's CCTP domain is refused", () => {
  assert.throws(
    () =>
      resolveBridgeRoute({
        config: CONFIG,
        source: "Ethereum_Sepolia",
        chains: chainsFor(
          chainDefinition({ cctp: { domain: 26 } }),
          arcDefinition(),
        ),
      }),
    /share a CCTP domain/u,
  );
});

test("each leg dials its own endpoint and overrides are HTTPS-only", () => {
  const route = resolveBridgeRoute({
    config: CONFIG,
    source: "Ethereum_Sepolia",
  });

  const plain = createBridgeRpcResolver({ config: CONFIG, route, env: {} });
  assert.equal(plain(CONFIG.chainId), CONFIG.rpc);
  assert.equal(plain(route.source.chainId), route.source.rpcEndpoints[0]);
  assert.throws(() => plain(1), /does not cover chain id 1/u);

  const overridden = createBridgeRpcResolver({
    config: CONFIG,
    route,
    env: {
      ARC_RPC_URL: "https://arc.example/rpc",
      BRIDGE_SOURCE_RPC_URL: "https://source.example/rpc",
    },
  });
  assert.equal(overridden(CONFIG.chainId), "https://arc.example/rpc");
  assert.equal(overridden(route.source.chainId), "https://source.example/rpc");

  assert.throws(
    () =>
      createBridgeRpcResolver({
        config: CONFIG,
        route,
        env: { BRIDGE_SOURCE_RPC_URL: "http://source.example/rpc" },
      }),
    /must use HTTPS/u,
  );
});

test("transfer speed accepts only the two documented values", () => {
  assert.equal(requireTransferSpeed(undefined), undefined);
  assert.equal(requireTransferSpeed("FAST"), "FAST");
  assert.equal(requireTransferSpeed("SLOW"), "SLOW");
  assert.throws(() => requireTransferSpeed("fast"), /transfer speed must be/u);
  assert.throws(() => requireTransferSpeed("INSTANT"), /transfer speed must be/u);
});

test("a step keeps only public scalars, from either a step or a lifecycle event", () => {
  const fromStep = normalizeBridgeStep({
    name: "burn",
    state: "success",
    txHash: "0xabc",
    explorerUrl: "https://sepolia.etherscan.io/tx/0xabc",
    data: { gasUsed: 38_617n, effectiveGasPrice: 1_037_232n },
  });
  assert.deepEqual(fromStep, {
    name: "burn",
    state: "success",
    txHash: "0xabc",
    explorerUrl: "https://sepolia.etherscan.io/tx/0xabc",
  });

  const fromEvent = normalizeBridgeStep({
    protocol: "cctp",
    version: "v2",
    traceId: "550afd44ba4c6d1d1bf4880b9ded3840",
    values: { name: "mint", state: "success", data: { txHash: "0xdef" } },
    method: "mint",
  });
  assert.deepEqual(fromEvent, {
    name: "mint",
    state: "success",
    txHash: "0xdef",
    explorerUrl: null,
  });

  assert.throws(() => normalizeBridgeStep({ state: "success" }), /no name/u);
  assert.throws(
    () => normalizeBridgeStep({ name: "burn", txHash: "0x ; rm -rf" }),
    /malformed hash/u,
  );
});

test("a summary collects names, states and hashes in order", () => {
  const summary = summarizeBridgeResult({
    state: "success",
    steps: [
      { name: "approve", state: "success", txHash: "0x1" },
      { name: "burn", state: "success", txHash: "0x2" },
      { name: "fetchAttestation", state: "success" },
      { name: "mint", state: "success", txHash: "0x3" },
    ],
  });

  assert.equal(summary.state, "success");
  assert.deepEqual([...summary.stepNames], [...BRIDGE_STEP_NAMES]);
  assert.deepEqual([...summary.txHashes], ["0x1", "0x2", "0x3"]);
});

test("success is only accepted when the mint itself settled", () => {
  const mint = assertBridgeSucceeded(
    summarizeBridgeResult({
      state: "success",
      steps: [{ name: "mint", state: "success", txHash: "0x3" }],
    }),
    "bridge",
  );
  assert.equal(mint.txHash, "0x3");

  // The dangerous shape: the SDK reports overall success while the mint has
  // not landed. Funds must not be treated as arrived.
  assert.throws(
    () =>
      assertBridgeSucceeded(
        summarizeBridgeResult({
          state: "success",
          steps: [{ name: "burn", state: "success", txHash: "0x2" }],
        }),
        "bridge",
      ),
    /without a settled mint/u,
  );

  assert.throws(
    () =>
      assertBridgeSucceeded(
        summarizeBridgeResult({
          state: "error",
          steps: [{ name: "burn", state: "error" }],
        }),
        "bridge",
      ),
    /failed step burn/u,
  );
});
