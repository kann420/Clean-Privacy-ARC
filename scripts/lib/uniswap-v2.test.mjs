import assert from "node:assert/strict";
import test from "node:test";

import {
  UNISWAP_V2_PAIR_INIT_CODE_HASH,
  assertCanonicalUniswapArtifacts,
  computeUniswapV2PairAddress,
  decideSeedTransfer,
} from "./uniswap-v2.mjs";

test("official Uniswap V2 artifacts match the canonical Pair init hash", () => {
  const hashes = assertCanonicalUniswapArtifacts();
  assert.equal(hashes.pairHash, UNISWAP_V2_PAIR_INIT_CODE_HASH);
  assert.match(hashes.factoryHash, /^0x[0-9a-f]{64}$/u);
});

test("CREATE2 Pair address is independent of input token order", () => {
  const factory = "0x1111111111111111111111111111111111111111";
  const usdc = "0x3600000000000000000000000000000000000000";
  const cirbtc = "0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF";
  assert.equal(
    computeUniswapV2PairAddress(factory, usdc, cirbtc),
    computeUniswapV2PairAddress(factory, cirbtc, usdc),
  );
});

test("CREATE2 Pair address matches the canonical mainnet USDC WETH vector", () => {
  assert.equal(
    computeUniswapV2PairAddress(
      "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
      "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    ),
    "0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc",
  );
});

test("deployment resume transfers only a completely missing seed leg", () => {
  assert.equal(decideSeedTransfer(0n, 5_000_000n, "USDC"), "transfer");
  assert.equal(
    decideSeedTransfer(5_000_000n, 5_000_000n, "USDC"),
    "already_transferred",
  );
  assert.throws(
    () => decideSeedTransfer(1n, 5_000_000n, "USDC"),
    /hard stop/u,
  );
  assert.throws(
    () => decideSeedTransfer(6_000_000n, 5_000_000n, "USDC"),
    /hard stop/u,
  );
});
