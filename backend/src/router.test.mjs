import assert from "node:assert/strict";
import test from "node:test";

import { loadChainConfig } from "../../scripts/lib/config.mjs";
import { createBackendServer } from "./server.mjs";
import { createTokenBucket } from "./router.mjs";

const config = loadChainConfig("arc-testnet");
const allowedOrigin = "http://localhost:5173";

async function withServer(options, callback) {
  const instance = await createBackendServer({
    config,
    env: {},
    admin: {
      environment: async () => ({
        name: "arc-testnet-unit",
        chain_id: 5042002,
      }),
    },
    authRoutes: {
      register: async () => Response.json({ registered: true }),
      authorizationToken: async () =>
        Response.json({ authorizationToken: "unit-placeholder" }),
    },
    circle: {
      estimateCircleSwap: async ({ executionAccount, amountHuman }) => ({
        chainIn: "Arc_Testnet",
        chainOut: "Arc_Testnet",
        fromAddress: executionAccount,
        toAddress: executionAccount,
        tokenIn: "USDC",
        tokenOut: "EURC",
        amountIn: amountHuman,
        amountInBaseUnits: "100000",
        stopLimit: { token: "EURC", amount: "0.075264" },
        estimatedOutput: { token: "EURC", amount: "0.077592" },
        fees: [],
      }),
      captureCircleSwapPlan: async ({ executionAccount }) => ({
        swapCall: {
          target: config.protocol.circleAdapter,
          value: "0",
          data: "0x12345678aa",
        },
        minOut: "75264",
        stopLimit: "75264",
        estimatedOutput: "77592",
        circleExecutionId: "7",
        beneficiaries: [
          { token: config.tokens.EURC.address, beneficiary: executionAccount },
        ],
        deadline: String(Math.floor(Date.now() / 1_000) + 1_000),
        executionAccount,
      }),
    },
    kitKey: "unit-placeholder",
    host: "127.0.0.1",
    port: 0,
    allowedOrigins: new Set([allowedOrigin]),
    ...options,
  });
  await new Promise((resolve, reject) => {
    instance.server.once("error", reject);
    instance.server.listen(0, "127.0.0.1", resolve);
  });
  const address = instance.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await callback(base);
  } finally {
    await new Promise((resolve) => instance.server.close(resolve));
  }
}

test("backend boots with injected admin and serves health and auth routes", async () => {
  await withServer({}, async (base) => {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      ok: true,
      chainId: 5042002,
      environment: "arc-testnet-unit",
    });

    const register = await fetch(`${base}/api/unlink/register`, {
      method: "POST",
      headers: {
        origin: allowedOrigin,
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(register.status, 200);
    assert.equal(
      register.headers.get("access-control-allow-origin"),
      allowedOrigin,
    );
  });
});

test("CORS allowlist is exact and preflight has no credentials header", async () => {
  await withServer({}, async (base) => {
    const denied = await fetch(`${base}/api/health`, {
      headers: { origin: "http://evil.example" },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("access-control-allow-origin"), null);

    const preflight = await fetch(`${base}/api/swap/quote`, {
      method: "OPTIONS",
      headers: { origin: allowedOrigin },
    });
    assert.equal(preflight.status, 204);
    assert.equal(
      preflight.headers.get("access-control-allow-methods"),
      "POST, GET, OPTIONS",
    );
    assert.equal(
      preflight.headers.get("access-control-allow-headers"),
      "content-type",
    );
    assert.equal(preflight.headers.get("vary"), "Origin");
    assert.equal(
      preflight.headers.get("access-control-allow-credentials"),
      null,
    );
  });
});

test("swap quote and full Circle plan use the injected fake Circle module", async () => {
  await withServer({}, async (base) => {
    const quote = await fetch(`${base}/api/swap/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amountNetUnits: "100000" }),
    });
    assert.equal(quote.status, 200);
    assert.deepEqual(await quote.json(), {
      estimatedOutUnits: "77592",
      indicative: true,
    });

    const account = "0x1111111111111111111111111111111111111111";
    const response = await fetch(`${base}/api/swap/circle-plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        executionAccount: account,
        accountIndex: 2,
        amountNetUnits: "100000",
      }),
    });
    assert.equal(response.status, 200);
    const plan = await response.json();
    assert.equal(plan.executionAccount, account);
    assert.equal(plan.amountIn, "100000");
    // The route publishes DECODED data only. It must not echo request fields
    // back as if verified, and must not supply bounds the client derives
    // itself: a client check against server-invented data proves nothing.
    assert.equal(plan.beneficiary, account);
    assert.equal(plan.minOut, "75264");
    assert.equal(plan.stopLimit, "75264");
    assert.equal(plan.estimatedOutput, "77592");
    assert.equal(plan.circleExecutionId, "7");
    assert.equal(plan.maxOut, undefined);
    assert.equal(plan.selector, undefined);
    assert.equal(plan.decodedRecipient, undefined);
    assert.match(plan.fingerprint, /^[0-9a-f]{64}$/u);
  });
});

test("a captured plan without exactly one EURC output is refused", async () => {
  await withServer(
    {
      circle: {
        estimateCircleSwap: async ({ executionAccount, amountHuman }) => ({
          chainIn: "Arc_Testnet",
          chainOut: "Arc_Testnet",
          fromAddress: executionAccount,
          toAddress: executionAccount,
          tokenIn: "USDC",
          tokenOut: "EURC",
          amountIn: amountHuman,
          amountInBaseUnits: "100000",
          stopLimit: { token: "EURC", amount: "0.075264" },
          estimatedOutput: { token: "EURC", amount: "0.077592" },
          fees: [],
        }),
        captureCircleSwapPlan: async () => ({
          swapCall: {
            target: config.protocol.circleAdapter,
            value: "0",
            data: "0x12345678aa",
          },
          minOut: "75264",
          stopLimit: "75264",
          estimatedOutput: "77592",
          circleExecutionId: "7",
          // No EURC beneficiary at all.
          beneficiaries: [],
          deadline: String(Math.floor(Date.now() / 1_000) + 1_000),
        }),
      },
    },
    async (base) => {
      const response = await fetch(`${base}/api/swap/circle-plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          executionAccount: "0x1111111111111111111111111111111111111111",
          accountIndex: 2,
          amountNetUnits: "100000",
        }),
      });
      assert.equal(response.status, 502);
      const payload = await response.json();
      assert.match(payload.error.body, /exactly one EURC output/u);
    },
  );
});

test("swap route errors are redacted and never leak a kit key", async () => {
  await withServer(
    {
      circle: {
        estimateCircleSwap: async () => {
          throw new Error(
            'upstream rejected kitKey: super-secret-kit-value\nRequest Arguments:\n  internal detail',
          );
        },
        captureCircleSwapPlan: async () => {
          throw new Error("unreachable");
        },
      },
    },
    async (base) => {
      const response = await fetch(`${base}/api/swap/quote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountNetUnits: "100000" }),
      });
      assert.equal(response.status, 502);
      const payload = await response.json();
      assert.ok(!payload.error.body.includes("super-secret-kit-value"));
      assert.ok(!payload.error.body.includes("internal detail"));
      assert.match(payload.error.body, /\[redacted\]/u);
      // The already-redacted payload passes through instead of being wrapped
      // again into a nested JSON blob.
      assert.equal(payload.error.title, "Swap request rejected");
    },
  );
});

test("an unknown route is a clean 404 with no CORS leakage", async () => {
  await withServer({}, async (base) => {
    const response = await fetch(`${base}/api/nope`, {
      headers: { origin: allowedOrigin },
    });
    assert.equal(response.status, 404);
    const payload = await response.json();
    assert.match(payload.error.title, /Not found/u);
  });
});

test("swap quote and plan buckets are independent", async () => {
  // Quote polling must never be able to rate-limit the post-Phase-A plan
  // capture; exhausting one bucket leaves the other untouched.
  await withServer({}, async (base) => {
    let quoteStatus = 200;
    for (let attempt = 0; attempt < 11 && quoteStatus === 200; attempt += 1) {
      const response = await fetch(`${base}/api/swap/quote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountNetUnits: "100000" }),
      });
      quoteStatus = response.status;
    }
    assert.equal(quoteStatus, 429);

    const plan = await fetch(`${base}/api/swap/circle-plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        executionAccount: "0x1111111111111111111111111111111111111111",
        accountIndex: 2,
        amountNetUnits: "100000",
      }),
    });
    assert.equal(plan.status, 200);
  });
});

test("router enforces JSON and the 32 KB request cap", async () => {
  await withServer({}, async (base) => {
    const wrongType = await fetch(`${base}/api/swap/quote`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    assert.equal(wrongType.status, 415);

    const oversized = await fetch(`${base}/api/swap/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(33 * 1024) }),
    });
    assert.equal(oversized.status, 413);
  });
});

test("token bucket refills and returns a retry delay", () => {
  let now = 0;
  const consume = createTokenBucket({ now: () => now });
  assert.equal(consume("swap:local", 2).ok, true);
  assert.equal(consume("swap:local", 2).ok, true);
  const limited = consume("swap:local", 2);
  assert.equal(limited.ok, false);
  assert.equal(limited.retryAfter, 30);
  now = 30_000;
  assert.equal(consume("swap:local", 2).ok, true);
});

test("non-loopback bind fails closed without the explicit insecure flag", async () => {
  await assert.rejects(
    createBackendServer({
      config,
      env: {},
      host: "0.0.0.0",
      admin: {
        environment: async () => ({
          name: "arc-testnet",
          chain_id: 5042002,
        }),
      },
      kitKey: "unit-placeholder",
    }),
    /non-loopback bind/u,
  );
});
