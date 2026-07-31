import { formatPublicError } from "../../scripts/lib/config.mjs";

export const MAX_BODY_BYTES = 32 * 1024;
const DEFAULT_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

export function parseAllowedOrigins(value) {
  const origins = (value ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return new Set(origins.length > 0 ? origins : DEFAULT_ORIGINS);
}

export function createTokenBucket(options = {}) {
  const now = options.now ?? Date.now;
  const buckets = new Map();

  return function consume(key, capacity) {
    const timestamp = now();
    const previous = buckets.get(key) ?? { tokens: capacity, timestamp };
    const elapsed = Math.max(0, timestamp - previous.timestamp);
    const tokens = Math.min(
      capacity,
      previous.tokens + (elapsed * capacity) / 60_000,
    );
    if (tokens < 1) {
      buckets.set(key, { tokens, timestamp });
      return {
        ok: false,
        retryAfter: Math.max(
          1,
          Math.ceil(((1 - tokens) * 60) / capacity),
        ),
      };
    }
    buckets.set(key, { tokens: tokens - 1, timestamp });
    return { ok: true, retryAfter: 0 };
  };
}

function writeJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function corsHeaders(origin) {
  return origin
    ? {
        "access-control-allow-origin": origin,
        vary: "Origin",
      }
    : {};
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body exceeds 32 KB");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function toFetchRequest(request, body) {
  const host = request.headers.host ?? "127.0.0.1";
  const url = new URL(request.url ?? "/", `http://${host}`);
  const init = {
    method: request.method,
    headers: new Headers(
      Object.entries(request.headers)
        .filter(([, value]) => typeof value === "string")
        .map(([key, value]) => [key, value]),
    ),
  };
  if (body.length > 0 && request.method !== "GET" && request.method !== "HEAD") {
    init.body = body;
  }
  return new Request(url, init);
}

async function sendFetchResponse(nodeResponse, fetchResponse, origin) {
  const headers = Object.fromEntries(fetchResponse.headers.entries());
  delete headers["access-control-allow-origin"];
  delete headers["access-control-allow-credentials"];
  Object.assign(headers, corsHeaders(origin));
  const raw = await fetchResponse.text();
  if (!fetchResponse.ok) {
    // Route handlers that already emit a redacted {error:{title,body}} payload
    // pass through untouched; re-wrapping them nested a JSON blob inside the
    // message the UI shows (Opus review, mandatory fix 5 side effect).
    let passthrough = null;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.error?.title === "string" && typeof parsed?.error?.body === "string") {
        passthrough = parsed;
      }
    } catch {
      passthrough = null;
    }
    writeJson(
      nodeResponse,
      fetchResponse.status,
      passthrough ?? {
        error: {
          title: "Request failed",
          body: formatPublicError(new Error(raw), "The upstream request failed"),
        },
      },
      headers,
    );
    return;
  }
  nodeResponse.writeHead(fetchResponse.status, headers);
  nodeResponse.end(raw);
}

function routeClass(pathname) {
  if (
    pathname === "/api/unlink/register" ||
    pathname === "/api/unlink/authorization-token"
  ) {
    return { key: "auth", capacity: 30 };
  }
  // Quote polling and post-Phase-A plan capture must never share a bucket: a
  // user re-quoting amounts could otherwise 429 the capture and strand the
  // net amount in the ExecutionAccount until the bucket refills.
  if (pathname === "/api/swap/quote") {
    return { key: "swap-quote", capacity: 10 };
  }
  if (pathname === "/api/swap/circle-plan") {
    return { key: "swap-plan", capacity: 10 };
  }
  // The relay is chatty by design — it exists so the app stops hitting the
  // public RPC directly — so its bucket is sized for a real session rather than
  // for the deliberately tight swap buckets. The relay does its own upstream
  // pacing, caching and 429 retry, so this is only a runaway guard.
  if (pathname === "/api/rpc") {
    return { key: "rpc", capacity: 600 };
  }
  return null;
}

/**
 * The rate-limit bucket key. Behind the deployment's reverse proxy every
 * request arrives from the proxy's own address, which would collapse all
 * visitors into one bucket, so the proxy-set client address is preferred when
 * the deployment opts in. Only enable `trustProxy` when the proxy overwrites
 * `X-Forwarded-For`, because a client can otherwise forge the header and evade
 * its own bucket.
 *
 * @param {import("node:http").IncomingMessage} request
 * @param {boolean} trustProxy
 */
export function clientAddress(request, trustProxy) {
  if (trustProxy) {
    const header = request.headers["x-forwarded-for"];
    const forwarded = (Array.isArray(header) ? header[0] : header) ?? "";
    const client = forwarded.split(",")[0].trim();
    if (client) return client;
  }
  return request.socket.remoteAddress ?? "unknown";
}

export function createRequestHandler(options) {
  const allowedOrigins =
    options.allowedOrigins instanceof Set
      ? options.allowedOrigins
      : parseAllowedOrigins(options.allowedOrigins);
  const consume = options.consume ?? createTokenBucket();
  const trustProxy = options.trustProxy === true;

  return async function handle(request, response) {
    const origin =
      typeof request.headers.origin === "string"
        ? request.headers.origin
        : undefined;
    if (origin && !allowedOrigins.has(origin)) {
      writeJson(response, 403, {
        error: {
          title: "Origin denied",
          body: "This origin is not allowed to use the testnet backend.",
        },
      });
      return;
    }
    const cors = corsHeaders(origin);
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        ...cors,
        "access-control-allow-methods": "POST, GET, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      response.end();
      return;
    }

    const pathname = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "127.0.0.1"}`,
    ).pathname;
    const classification = routeClass(pathname);
    if (classification) {
      const remote = clientAddress(request, trustProxy);
      const result = consume(`${classification.key}:${remote}`, classification.capacity);
      if (!result.ok) {
        writeJson(
          response,
          429,
          {
            error: {
              title: "Rate limit reached",
              body: "Wait before retrying this testnet endpoint.",
            },
          },
          { ...cors, "retry-after": String(result.retryAfter) },
        );
        return;
      }
    }

    try {
      const hasBody =
        request.method !== "GET" &&
        request.method !== "HEAD" &&
        Number(request.headers["content-length"] ?? 0) !== 0;
      if (
        hasBody &&
        !String(request.headers["content-type"] ?? "")
          .toLowerCase()
          .startsWith("application/json")
      ) {
        writeJson(
          response,
          415,
          {
            error: {
              title: "JSON required",
              body: "Request bodies must use application/json.",
            },
          },
          cors,
        );
        return;
      }
      const body = await readBody(request);
      const fetchRequest = await toFetchRequest(request, body);
      let result;
      if (pathname === "/api/health" && request.method === "GET") {
        result = Response.json(options.health);
      } else if (
        pathname === "/api/unlink/register" &&
        request.method === "POST"
      ) {
        result = await options.authRoutes.register(fetchRequest);
      } else if (
        pathname === "/api/unlink/authorization-token" &&
        request.method === "POST"
      ) {
        result = await options.authRoutes.authorizationToken(fetchRequest);
      } else if (
        pathname === "/api/swap/quote" &&
        request.method === "POST"
      ) {
        result = await options.swapRoutes.quote(fetchRequest);
      } else if (
        pathname === "/api/swap/circle-plan" &&
        request.method === "POST"
      ) {
        result = await options.swapRoutes.circlePlan(fetchRequest);
      } else if (
        pathname === "/api/rpc" &&
        request.method === "POST" &&
        options.rpcRoute
      ) {
        result = await options.rpcRoute(fetchRequest);
      } else {
        writeJson(
          response,
          404,
          {
            error: {
              title: "Not found",
              body: "No backend route matches this request.",
            },
          },
          cors,
        );
        return;
      }
      await sendFetchResponse(response, result, origin);
    } catch (error) {
      const status =
        Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      writeJson(
        response,
        status,
        {
          error: {
            title: status === 413 ? "Request too large" : "Request failed",
            body: formatPublicError(
              error,
              "The backend could not complete the request",
            ),
          },
        },
        cors,
      );
    }
  };
}
