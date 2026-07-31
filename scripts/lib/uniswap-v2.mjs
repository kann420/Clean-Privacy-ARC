import { readFileSync } from "node:fs";

import {
  concatHex,
  encodePacked,
  getAddress,
  keccak256,
  sliceHex,
} from "viem";

import { sortPairTokens } from "./swap.mjs";

export const UNISWAP_V2_PAIR_INIT_CODE_HASH =
  "0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f";

function loadArtifact(name) {
  const url = new URL(
    `../../node_modules/@uniswap/v2-core/build/${name}.json`,
    import.meta.url,
  );
  const artifact = JSON.parse(readFileSync(url, "utf8"));
  if (
    !Array.isArray(artifact.abi) ||
    typeof artifact.bytecode !== "string" ||
    !/^[0-9a-fA-F]+$/u.test(artifact.bytecode)
  ) {
    throw new Error(`invalid ${name} artifact`);
  }
  return Object.freeze({
    abi: artifact.abi,
    bytecode: /** @type {`0x${string}`} */ (`0x${artifact.bytecode}`),
  });
}

export const UNISWAP_V2_FACTORY_ARTIFACT = loadArtifact(
  "UniswapV2Factory",
);
export const UNISWAP_V2_PAIR_ARTIFACT = loadArtifact("UniswapV2Pair");

export function assertCanonicalUniswapArtifacts() {
  const pairHash = keccak256(UNISWAP_V2_PAIR_ARTIFACT.bytecode);
  if (pairHash !== UNISWAP_V2_PAIR_INIT_CODE_HASH) {
    throw new Error("Uniswap V2 Pair artifact hash is not canonical");
  }
  const factoryHash = keccak256(UNISWAP_V2_FACTORY_ARTIFACT.bytecode);
  if (factoryHash === `0x${"0".repeat(64)}`) {
    throw new Error("Uniswap V2 Factory artifact hash is invalid");
  }
  return { factoryHash, pairHash };
}

/**
 * @param {string} factory
 * @param {string} tokenA
 * @param {string} tokenB
 */
export function computeUniswapV2PairAddress(factory, tokenA, tokenB) {
  const [token0, token1] = sortPairTokens(tokenA, tokenB);
  const salt = keccak256(
    encodePacked(["address", "address"], [token0, token1]),
  );
  const digest = keccak256(
    concatHex([
      "0xff",
      getAddress(factory),
      salt,
      UNISWAP_V2_PAIR_INIT_CODE_HASH,
    ]),
  );
  return getAddress(sliceHex(digest, 12));
}

/**
 * Resume one-sided liquidity safely. Only zero or the exact intended seed is
 * unambiguous; every partial or surplus amount hard-stops.
 *
 * @param {bigint} current
 * @param {bigint} intended
 * @param {string} symbol
 */
export function decideSeedTransfer(current, intended, symbol) {
  if (
    typeof current !== "bigint" ||
    typeof intended !== "bigint" ||
    current < 0n ||
    intended <= 0n
  ) {
    throw new Error("seed balances must be valid bigints");
  }
  if (current === 0n) return "transfer";
  if (current === intended) return "already_transferred";
  throw new Error(
    `${symbol} Pair balance is partial or unexpected; hard stop without transfer`,
  );
}
