import { formatPublicError } from "../../scripts/lib/config.mjs";

/**
 * Loopback JSON-RPC relay for the browser.
 *
 * The public Arc RPC rate-limits hard, and once the limit is tripped it answers
 * 429 WITHOUT CORS headers — so the browser cannot even read the status and
 * reports an opaque CORS failure instead (Phase 4 live finding). Relaying
 * through this loopback backend removes the browser's CORS exposure entirely
 * and, more importantly, lets one process do what a browser tab cannot:
 * serialize every upstream call, pace it, retry a 429 server-side, and cache
 * the answers that can never change.
 *
 * The relay holds no keys and signs nothing. Transactions arrive already signed
 * from the browser, so `eth_sendRawTransaction` is a pass-through.
 */

/**
 * Read methods plus the few a wallet needs to broadcast an already-signed
 * transaction. Anything outside this list is refused rather than forwarded, so
 * the relay can never become a general-purpose open proxy.
 */
export const ALLOWED_RPC_METHODS = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "eth_sendRawTransaction",
  "net_version",
  "web3_clientVersion",
]);

/**
 * Deployed bytecode and the chain id are immutable for the lifetime of a chain,
 * and the readiness gate asks for all eight contracts on every page load. Those
 * are the calls that were tripping the limit, so they are answered from memory
 * after the first success.
 */
const CACHEABLE_METHODS = new Set(["eth_chainId", "eth_getCode"]);

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cacheKey(method, params) {
  return `${method}:${JSON.stringify(params ?? [])}`;
}

function isCacheable(method, params) {
  if (!CACHEABLE_METHODS.has(method)) return false;
  // Only cache a pinned block tag; a historical query must stay live.
  if (method === "eth_getCode") {
    const block = Array.isArray(params) ? params[1] : undefined;
    return block === undefined || block === "latest";
  }
  return true;
}

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

/**
 * @param {{
 *   rpcUrl: string,
 *   fetchImpl?: typeof fetch,
 *   minIntervalMs?: number,
 *   maxAttempts?: number,
 *   sleepImpl?: (ms: number) => Promise<void>,
 * }} options
 */
export function createRpcRelay(options) {
  const doFetch = options.fetchImpl ?? fetch;
  const pause = options.sleepImpl ?? sleep;
  const minIntervalMs = options.minIntervalMs ?? 120;
  const maxAttempts = options.maxAttempts ?? 4;
  const cache = new Map();

  // One queue for the whole process: concurrent browser tabs and the SDK's own
  // polling all funnel through here, which is the only place a burst can
  // actually be flattened.
  let queue = Promise.resolve();

  async function callUpstream(payload) {
    for (let attempt = 0; ; attempt += 1) {
      const response = await doFetch(options.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (response.ok) {
        return await response.json();
      }
      if (!RETRYABLE_STATUS.has(response.status) || attempt >= maxAttempts - 1) {
        throw Object.assign(
          new Error(`The Arc RPC answered ${response.status}`),
          { statusCode: response.status === 429 ? 503 : 502 },
        );
      }
      await pause(250 * 2 ** attempt);
    }
  }

  function enqueue(payload) {
    const run = queue.then(() => callUpstream(payload));
    // Keep the pacing gap even when a call fails, so a failing burst cannot
    // hammer the upstream faster than a succeeding one.
    queue = run.catch(() => undefined).then(() => pause(minIntervalMs));
    return run;
  }

  return {
    async call(body) {
      if (Array.isArray(body)) {
        throw badRequest("Batched JSON-RPC requests are not relayed");
      }
      if (!body || typeof body !== "object") {
        throw badRequest("The request body must be a JSON-RPC object");
      }
      const { method, params, id } = body;
      if (typeof method !== "string" || !ALLOWED_RPC_METHODS.has(method)) {
        throw badRequest(`Method ${String(method)} is not relayed`);
      }
      if (params !== undefined && !Array.isArray(params)) {
        throw badRequest("JSON-RPC params must be an array");
      }

      const cacheable = isCacheable(method, params);
      const key = cacheable ? cacheKey(method, params) : null;
      if (key && cache.has(key)) {
        return { jsonrpc: "2.0", id: id ?? null, result: cache.get(key) };
      }

      const payload = { jsonrpc: "2.0", id: id ?? 1, method, params: params ?? [] };
      const answer = await enqueue(payload);

      // Never cache an error, and never cache empty bytecode: an address can be
      // deployed later, and pinning "0x" would make readiness fail forever.
      if (
        key &&
        answer &&
        answer.error === undefined &&
        answer.result !== undefined &&
        !(method === "eth_getCode" && (answer.result === "0x" || !answer.result))
      ) {
        cache.set(key, answer.result);
      }
      return { ...answer, id: id ?? answer?.id ?? null };
    },
    get cacheSize() {
      return cache.size;
    },
  };
}

export function createRpcRoute(options) {
  const relay = options.relay ?? createRpcRelay(options);
  return {
    relay,
    handler: async (request) => {
      let body;
      try {
        body = await request.json();
      } catch {
        return Response.json(
          {
            error: {
              title: "Malformed RPC request",
              body: "The request body must be valid JSON.",
            },
          },
          { status: 400 },
        );
      }
      try {
        return Response.json(await relay.call(body));
      } catch (error) {
        return Response.json(
          {
            error: {
              title: "RPC relay failed",
              body: formatPublicError(
                error,
                "The Arc RPC could not be reached.",
              ),
            },
          },
          {
            status: Number.isInteger(error?.statusCode)
              ? error.statusCode
              : 502,
          },
        );
      }
    },
  };
}
