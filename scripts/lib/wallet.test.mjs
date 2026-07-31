import assert from "node:assert/strict";
import test from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import {
  assertUsdcGasBuffer,
  computeBufferedGas,
  loadOwnerAddress,
  normalizePrivateKey,
  usdcErc20ToNative,
} from "./wallet.mjs";

// Generate an ephemeral test-only key so no raw private key is stored in Git.
const TEST_VECTOR_KEY = generatePrivateKey();
const TEST_VECTOR_ADDRESS = privateKeyToAccount(TEST_VECTOR_KEY).address;

test("private keys normalize and validate", () => {
  assert.equal(normalizePrivateKey(TEST_VECTOR_KEY), TEST_VECTOR_KEY);
  assert.equal(
    normalizePrivateKey(TEST_VECTOR_KEY.slice(2)),
    TEST_VECTOR_KEY,
  );
  assert.throws(() => normalizePrivateKey(""), /missing/u);
  assert.throws(() => normalizePrivateKey("0x1234"), /32-byte/u);
  assert.throws(() => normalizePrivateKey(`${TEST_VECTOR_KEY}ff`), /32-byte/u);
});

test("owner address derives from the environment key", () => {
  assert.equal(
    loadOwnerAddress({ OWNER_PRIVATE_KEY: TEST_VECTOR_KEY }),
    TEST_VECTOR_ADDRESS,
  );
  assert.throws(() => loadOwnerAddress({}), /missing/u);
});

test("gas buffering adds 20 percent rounded up", () => {
  assert.equal(computeBufferedGas(100n), 120n);
  assert.equal(computeBufferedGas(101n), 122n);
  assert.equal(computeBufferedGas(1n), 2n);
  assert.throws(() => computeBufferedGas(0n));
  assert.throws(() => computeBufferedGas(-5n));
  assert.throws(() => computeBufferedGas(100));
});

test("USDC precision conversion scales 6 to 18 decimals", () => {
  assert.equal(usdcErc20ToNative(0n), 0n);
  assert.equal(usdcErc20ToNative(1_000_000n), 10n ** 18n);
  assert.throws(() => usdcErc20ToNative(-1n));
  assert.throws(() => usdcErc20ToNative(1.5));
});

test("USDC gas buffer accounts for deposit, gas, and reserve", () => {
  const oneUsdcNative = 10n ** 18n;
  const base = {
    plannedUsdcErc20: 1_000_000n,
    projectedGasCost: 10n ** 15n,
    bufferNative: oneUsdcNative,
    label: "unit test",
  };

  assert.doesNotThrow(() =>
    assertUsdcGasBuffer({
      ...base,
      nativeBalance: 2n * oneUsdcNative + 10n ** 15n,
    }),
  );
  assert.throws(
    () =>
      assertUsdcGasBuffer({
        ...base,
        nativeBalance: 2n * oneUsdcNative + 10n ** 15n - 1n,
      }),
    /gas buffer/u,
  );
});
