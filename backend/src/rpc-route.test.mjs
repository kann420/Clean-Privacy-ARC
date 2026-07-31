import assert from "node:assert/strict";
import test from "node:test";

import { ALLOWED_RPC_METHODS, createRpcRelay } from "./rpc-route.mjs";

/**
 * The relay exists because the public Arc RPC rate-limits hard and, once
 * tripped, answers 429 without CORS headers — which a browser can only report
 * as an opaque failure. Relaying lets one process pace, retry and cache.
 */
const noSleep = async () => {};

function fakeFetch(responses) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      const next = responses.shift() ?? { status: 200, body: { result: "0x1" } };
      return {
        ok: next.status === 200,
        status: next.status,
        json: async () => ({ jsonrpc: "2.0", id: body.id, ...next.body }),
      };
    },
  };
}

test("relays an allowlisted method and returns its result", async () => {
  const { fetchImpl, calls } = fakeFetch([
    { status: 200, body: { result: "0x4cef52" } },
  ]);
  const relay = createRpcRelay({
    rpcUrl: "https://rpc.example",
    fetchImpl,
    sleepImpl: noSleep,
  });
  const answer = await relay.call({ id: 7, method: "eth_chainId", params: [] });
  assert.equal(answer.result, "0x4cef52");
  assert.equal(answer.id, 7);
  assert.equal(calls.length, 1);
});

test("refuses any method outside the allowlist", async () => {
  const relay = createRpcRelay({
    rpcUrl: "https://rpc.example",
    fetchImpl: async () => assert.fail("must not reach upstream"),
    sleepImpl: noSleep,
  });
  await assert.rejects(
    () => relay.call({ method: "personal_sign", params: [] }),
    /not relayed/u,
  );
  await assert.rejects(
    () => relay.call({ method: "eth_accounts" }),
    /not relayed/u,
  );
});

test("never becomes an open proxy for signing or key methods", () => {
  for (const method of [
    "personal_sign",
    "eth_sign",
    "eth_signTypedData_v4",
    "eth_accounts",
    "eth_sendTransaction",
    "debug_traceTransaction",
  ]) {
    assert.equal(ALLOWED_RPC_METHODS.has(method), false, method);
  }
  // An already-signed transaction is a pass-through: no key is involved.
  assert.equal(ALLOWED_RPC_METHODS.has("eth_sendRawTransaction"), true);
});

test("rejects batched requests rather than forwarding them", async () => {
  const relay = createRpcRelay({
    rpcUrl: "https://rpc.example",
    fetchImpl: async () => assert.fail("must not reach upstream"),
    sleepImpl: noSleep,
  });
  await assert.rejects(
    () => relay.call([{ method: "eth_chainId" }]),
    /not relayed/u,
  );
});

test("caches immutable bytecode so the readiness sweep stops re-asking", async () => {
  const { fetchImpl, calls } = fakeFetch([
    { status: 200, body: { result: "0x6080" } },
  ]);
  const relay = createRpcRelay({
    rpcUrl: "https://rpc.example",
    fetchImpl,
    sleepImpl: noSleep,
  });
  const params = ["0x3600000000000000000000000000000000000000", "latest"];
  const first = await relay.call({ id: 1, method: "eth_getCode", params });
  const second = await relay.call({ id: 2, method: "eth_getCode", params });
  assert.equal(first.result, "0x6080");
  assert.equal(second.result, "0x6080");
  assert.equal(second.id, 2, "the cached answer keeps the caller's id");
  assert.equal(calls.length, 1, "the second call was served from cache");
});

test("never caches empty bytecode, which would fail readiness forever", async () => {
  const { fetchImpl, calls } = fakeFetch([
    { status: 200, body: { result: "0x" } },
    { status: 200, body: { result: "0x6080" } },
  ]);
  const relay = createRpcRelay({
    rpcUrl: "https://rpc.example",
    fetchImpl,
    sleepImpl: noSleep,
  });
  const params = ["0x00000000000000000000000000000000000000ff", "latest"];
  assert.equal((await relay.call({ method: "eth_getCode", params })).result, "0x");
  assert.equal(
    (await relay.call({ method: "eth_getCode", params })).result,
    "0x6080",
  );
  assert.equal(calls.length, 2);
});

test("never caches an error answer", async () => {
  const { fetchImpl, calls } = fakeFetch([
    { status: 200, body: { error: { code: -32011, message: "request limit reached" } } },
    { status: 200, body: { result: "0x4cef52" } },
  ]);
  const relay = createRpcRelay({
    rpcUrl: "https://rpc.example",
    fetchImpl,
    sleepImpl: noSleep,
  });
  assert.ok((await relay.call({ method: "eth_chainId" })).error);
  assert.equal((await relay.call({ method: "eth_chainId" })).result, "0x4cef52");
  assert.equal(calls.length, 2);
});

test("retries a 429 upstream instead of surfacing it", async () => {
  const { fetchImpl, calls } = fakeFetch([
    { status: 429, body: {} },
    { status: 429, body: {} },
    { status: 200, body: { result: "0x1" } },
  ]);
  const relay = createRpcRelay({
    rpcUrl: "https://rpc.example",
    fetchImpl,
    sleepImpl: noSleep,
  });
  const answer = await relay.call({ method: "eth_blockNumber" });
  assert.equal(answer.result, "0x1");
  assert.equal(calls.length, 3);
});

test("gives up with a service-unavailable status when 429 persists", async () => {
  const { fetchImpl } = fakeFetch([
    { status: 429, body: {} },
    { status: 429, body: {} },
    { status: 429, body: {} },
    { status: 429, body: {} },
  ]);
  const relay = createRpcRelay({
    rpcUrl: "https://rpc.example",
    fetchImpl,
    sleepImpl: noSleep,
  });
  await assert.rejects(
    () => relay.call({ method: "eth_blockNumber" }),
    (error) => error.statusCode === 503,
  );
});

test("serializes concurrent callers so a burst cannot reach upstream at once", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const relay = createRpcRelay({
    rpcUrl: "https://rpc.example",
    sleepImpl: noSleep,
    fetchImpl: async (_url, init) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      const body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: "2.0", id: body.id, result: "0x1" }),
      };
    },
  });
  await Promise.all(
    Array.from({ length: 6 }, (_value, index) =>
      relay.call({ id: index, method: "eth_getBalance", params: ["0x1", "latest"] }),
    ),
  );
  assert.equal(maxInFlight, 1);
});

test("the RPC endpoint override is opt-in, https-only and never a chain change", async () => {
  const { selectRpcEndpoint } = await import("./server.mjs");
  const config = { rpc: "https://rpc.testnet.arc.network" };
  assert.equal(selectRpcEndpoint({}, config), config.rpc);
  assert.equal(selectRpcEndpoint({ ARC_RPC_URL: "   " }, config), config.rpc);
  assert.equal(
    selectRpcEndpoint({ ARC_RPC_URL: "https://provider.example/token" }, config),
    "https://provider.example/token",
  );
  assert.throws(
    () => selectRpcEndpoint({ ARC_RPC_URL: "http://provider.example" }, config),
    /must use HTTPS/u,
  );
  assert.throws(
    () => selectRpcEndpoint({ ARC_RPC_URL: "not-a-url" }, config),
    /valid URL/u,
  );
});
