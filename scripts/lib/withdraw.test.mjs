import assert from "node:assert/strict";
import test from "node:test";

import {
  assertEvmRecipient,
  assertRecipientHygiene,
  verifyPublicBalanceDelta,
} from "./withdraw.mjs";

const DEPOSITOR = "0xD7E004CBda24E079aA3A657Ba7f8E2915192a966";
const OTHER = "0x5f68f040ce9c7e4980b3a4d3a5dde17ea9db9fb6";

test("withdrawal recipients must be real EVM addresses", () => {
  assert.equal(assertEvmRecipient(OTHER), "0x5F68f040cE9C7E4980b3a4D3A5DDe17eA9db9fb6");
  assert.throws(() => assertEvmRecipient("unlink1qqp4mxgu8ytq"), /0x EVM address/u);
  assert.throws(() => assertEvmRecipient("0x1234"), /0x EVM address/u);
  assert.throws(() => assertEvmRecipient(""), /0x EVM address/u);
  assert.throws(
    () => assertEvmRecipient("0x0000000000000000000000000000000000000000"),
    /zero address/u,
  );
});

test("withdrawing to the depositing EOA requires an explicit opt-in", () => {
  assert.throws(
    () => assertRecipientHygiene({ recipient: DEPOSITOR, depositor: DEPOSITOR }),
    /re-links the deposit to the withdrawal/u,
  );
  const allowed = assertRecipientHygiene({
    recipient: DEPOSITOR,
    depositor: DEPOSITOR,
    allowSelf: true,
  });
  assert.equal(allowed.selfWithdrawal, true);
});

test("a different destination passes the hygiene gate", () => {
  const checked = assertRecipientHygiene({
    recipient: OTHER,
    depositor: DEPOSITOR,
  });
  assert.equal(checked.selfWithdrawal, false);
  assert.equal(checked.recipient, "0x5F68f040cE9C7E4980b3a4D3A5DDe17eA9db9fb6");
});

test("the hygiene gate compares addresses by value, not by casing", () => {
  // A pasted lowercase address and the wallet's checksummed one are the same
  // account, so the gate must still fire.
  assert.throws(
    () =>
      assertRecipientHygiene({
        recipient: DEPOSITOR.toLowerCase(),
        depositor: DEPOSITOR,
      }),
    /re-links the deposit to the withdrawal/u,
  );
});

test("public delta verification accepts the exact credit", async () => {
  let reads = 0;
  const publicClient = {
    async readContract() {
      reads += 1;
      return reads < 3 ? 1_000n : 51_000n;
    },
  };
  const after = await verifyPublicBalanceDelta({
    publicClient,
    token: "0x3600000000000000000000000000000000000000",
    address: OTHER,
    before: 1_000n,
    expectedDelta: 50_000n,
    attempts: 5,
    delayMs: 0,
    sleep: async () => {},
  });
  assert.equal(after, 51_000n);
  assert.equal(reads, 3);
});

test("a short or excess public credit hard-stops", async () => {
  const publicClient = {
    async readContract() {
      return 1_400n;
    },
  };
  await assert.rejects(
    verifyPublicBalanceDelta({
      publicClient,
      token: "0x3600000000000000000000000000000000000000",
      address: OTHER,
      before: 1_000n,
      expectedDelta: 50_000n,
      attempts: 3,
      delayMs: 0,
      sleep: async () => {},
    }),
    /did not converge/u,
  );
});

test("public delta verification requires bigint amounts", async () => {
  await assert.rejects(
    verifyPublicBalanceDelta({
      publicClient: { async readContract() { return 0n; } },
      token: "0x3600000000000000000000000000000000000000",
      address: OTHER,
      before: 1_000,
      expectedDelta: 50_000n,
    }),
    /bigint amounts/u,
  );
});
