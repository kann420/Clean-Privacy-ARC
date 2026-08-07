import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DEFAULT_CHAIN_KEY,
  loadChainConfig,
  loadChainRegistry,
  parseDecimalAmount,
  parseTokenAmount,
  validateChainRegistry,
} from "./config.mjs";

function cloneRegistry() {
  return JSON.parse(
    readFileSync(new URL("../../config/chains.json", import.meta.url), "utf8"),
  );
}

test("the default Arc config matches the verified deployment", () => {
  const config = loadChainConfig();

  assert.equal(DEFAULT_CHAIN_KEY, "arc-testnet");
  assert.equal(config.chainId, 5_042_002);
  assert.equal(config.rpc, "https://rpc.testnet.arc.network");
  assert.equal(config.explorer, "https://testnet.arcscan.app");
  assert.equal(config.unlinkEnvironment, "arc-testnet");
  assert.equal(config.circleChain, "Arc_Testnet");
  assert.deepEqual(config.nativeCurrency, {
    name: "Arc Testnet USDC",
    symbol: "USDC",
    decimals: 18,
  });
  assert.deepEqual(config.tokens, {
    USDC: {
      symbol: "USDC",
      address: "0x3600000000000000000000000000000000000000",
      decimals: 6,
    },
    EURC: {
      symbol: "EURC",
      address: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
      decimals: 6,
    },
    cirBTC: {
      symbol: "cirBTC",
      address: "0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF",
      decimals: 8,
    },
  });
  assert.deepEqual(config.protocol, {
    unlinkPool: "0x075b8d19b214cd939a0aa6b1eb8e2152b9a5dcda",
    permit2: "0x000000000022d473030f116dDEE9F6B43aC78BA3",
    entryPoint: "0x0000000071727De22E5E9d8BAf0eDac6f37da032",
    executionAccountFactory:
      "0xc92ac4f6599482d45416e2f9e6ea450cf8c2e410",
    executionAccountImplementation:
      "0xc4f5e6d48eb336bd3f5a54bdfb794da5e20b5069",
    circleAdapter: "0xBBD70b01a1CAbc96d5b7b129Ae1AAabdf50dd40b",
    circleBridge: "0xC5567a5E3370d4DBfB0540025078e283e36A363d",
    erc4337Version: "v0.7",
    executionAccountsEnabled: true,
  });
});

test("all configured addresses are valid and globally unique", () => {
  const config = loadChainConfig();
  const addresses = [
    ...Object.values(config.tokens).map((token) => token.address),
    ...Object.entries(config.protocol)
      .filter(([field]) => !field.startsWith("erc"))
      .filter(([field]) => field !== "executionAccountsEnabled")
      .map(([, value]) => value),
  ];

  assert.ok(
    addresses.every((address) => /^0x[0-9a-fA-F]{40}$/u.test(address)),
  );
  assert.equal(
    new Set(addresses.map((address) => address.toLowerCase())).size,
    addresses.length,
  );
});

test("token amounts use the selected token decimals exactly once", () => {
  assert.equal(parseTokenAmount("USDC", "1.5"), 1_500_000n);
  assert.equal(parseTokenAmount("EURC", "0.000001"), 1n);
  assert.equal(parseTokenAmount("cirBTC", "0.00000001"), 1n);
  assert.throws(() => parseTokenAmount("USDC", "0.0000001"));
  assert.throws(() => parseTokenAmount("UNKNOWN", "1"));
});

test("decimal parsing rejects ambiguous and imprecise values", () => {
  assert.equal(parseDecimalAmount("0", 6), 0n);
  assert.throws(() => parseDecimalAmount("1e6", 6));
  assert.throws(() => parseDecimalAmount("-1", 6));
  assert.throws(() => parseDecimalAmount("01", 6));
  assert.throws(() => parseDecimalAmount("1.0000001", 6));
});

test("loaded config is deeply frozen", () => {
  const config = loadChainConfig();
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.tokens.USDC), true);
  assert.throws(() => {
    config.tokens.USDC.decimals = 18;
  }, TypeError);
});

test("registry validation rejects unknown fields and malformed addresses", () => {
  const withUnknownField = cloneRegistry();
  withUnknownField["arc-testnet"].cleanverseChain = "arc";
  assert.throws(
    () => validateChainRegistry(withUnknownField),
    /must contain exactly/u,
  );

  const withMalformedAddress = cloneRegistry();
  withMalformedAddress["arc-testnet"].tokens.USDC.address = "0x1234";
  assert.throws(
    () => validateChainRegistry(withMalformedAddress),
    /20-byte 0x-prefixed address/u,
  );
});

test("the bridge source allowlist is validated and carries no addresses", () => {
  const config = loadChainConfig();
  assert.deepEqual(config.bridgeSources, [
    "Ethereum_Sepolia",
    "Base_Sepolia",
    "Avalanche_Fuji",
    "Arbitrum_Sepolia",
  ]);
  assert.equal(Object.isFrozen(config.bridgeSources), true);

  const empty = cloneRegistry();
  empty["arc-testnet"].bridgeSources = [];
  assert.throws(() => validateChainRegistry(empty), /non-empty array/u);

  const malformed = cloneRegistry();
  malformed["arc-testnet"].bridgeSources = ["ethereum sepolia"];
  assert.throws(
    () => validateChainRegistry(malformed),
    /Circle chain identifier/u,
  );

  const duplicated = cloneRegistry();
  duplicated["arc-testnet"].bridgeSources = [
    "Base_Sepolia",
    "Base_Sepolia",
  ];
  assert.throws(() => validateChainRegistry(duplicated), /duplicate entry/u);

  // Bridging Arc to itself is not a transfer; the burn would have nowhere to go.
  const selfReferential = cloneRegistry();
  selfReferential["arc-testnet"].bridgeSources = ["Arc_Testnet"];
  assert.throws(
    () => validateChainRegistry(selfReferential),
    /must not contain the destination chain/u,
  );
});

test("registry validation rejects duplicate addresses", () => {
  const registry = cloneRegistry();
  registry["arc-testnet"].tokens.EURC.address =
    registry["arc-testnet"].tokens.USDC.address;
  assert.throws(
    () => validateChainRegistry(registry),
    /duplicate configured address/u,
  );
});
