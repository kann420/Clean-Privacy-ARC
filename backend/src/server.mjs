import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

import {
  createUnlinkAdmin,
  createUnlinkAuthRoutes,
} from "@unlink-xyz/sdk/admin";

import {
  formatPublicError,
  loadChainConfig,
  loadLocalEnv,
  selectRpcEndpoint,
} from "../../scripts/lib/config.mjs";
import { requireCircleKitKey } from "../../scripts/lib/circle.mjs";
import {
  createRequestHandler,
  parseAllowedOrigins,
} from "./router.mjs";
import { createRpcRoute } from "./rpc-route.mjs";
import { createSwapRoutes } from "./swap-routes.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;

function selectApiKey(env) {
  const key = env.UNLINK_API_KEY_ARC_TESTNET ?? env.UNLINK_API_KEY;
  if (!key) {
    throw new Error(
      "UNLINK_API_KEY_ARC_TESTNET or UNLINK_API_KEY is required",
    );
  }
  return key;
}

// One definition of the endpoint override for the backend relay and the CLI
// alike; re-exported so callers and tests can reach it from either module.
export { selectRpcEndpoint };

function assertEnvironment(environment, config) {
  if (
    environment.chain_id !== config.chainId ||
    (environment.name !== config.unlinkEnvironment &&
      !environment.name.startsWith(`${config.unlinkEnvironment}-`))
  ) {
    throw new Error("Unlink environment does not match Arc Testnet");
  }
  return environment;
}

function parsePort(value) {
  const port = value === undefined ? DEFAULT_PORT : Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("BACKEND_PORT must be an integer from 0 to 65535");
  }
  return port;
}

export async function createBackendServer(options = {}) {
  const config = options.config ?? loadChainConfig("arc-testnet");
  const env = options.env ?? loadLocalEnv();
  const host = options.host ?? env.BACKEND_BIND_HOST ?? DEFAULT_HOST;
  if (
    host !== DEFAULT_HOST &&
    (!env.BACKEND_BIND_HOST || env.ALLOW_INSECURE_TESTNET_AUTH !== "1")
  ) {
    throw new Error(
      "A non-loopback bind requires BACKEND_BIND_HOST and ALLOW_INSECURE_TESTNET_AUTH=1",
    );
  }
  const port = options.port ?? parsePort(env.BACKEND_PORT);
  const admin =
    options.admin ??
    createUnlinkAdmin({
      environment: config.unlinkEnvironment,
      apiKey: selectApiKey(env),
    });
  const environment = assertEnvironment(
    await admin.environment(),
    config,
  );
  const kitKey =
    options.kitKey ?? requireCircleKitKey(env);

  // Anonymous authorization is a deliberate Arc Testnet limitation. This
  // server must remain loopback-bound unless the explicit insecure flag is set.
  const authRoutes =
    options.authRoutes ??
    createUnlinkAuthRoutes({
      admin,
      authenticate: async () => ({ anonymous: true }),
      onRegister: async () => {},
      authorizeUnlinkAddress: async () => true,
    });
  const swapRoutes =
    options.swapRoutes ??
    createSwapRoutes({
      config,
      kitKey,
      circle: options.circle,
      quoteTaker: options.quoteTaker,
    });
  const rpcRoute =
    options.rpcRoute ??
    createRpcRoute({
      rpcUrl: selectRpcEndpoint(env, config),
      fetchImpl: options.rpcFetch,
    }).handler;
  const handler = createRequestHandler({
    authRoutes,
    swapRoutes,
    rpcRoute,
    allowedOrigins:
      options.allowedOrigins ??
      parseAllowedOrigins(env.BACKEND_ALLOWED_ORIGINS),
    // Set only where a reverse proxy overwrites X-Forwarded-For, which the
    // deployment's Caddy origin does. A directly exposed backend must leave it
    // unset so a client cannot forge its own rate-limit identity.
    trustProxy: options.trustProxy ?? env.BACKEND_TRUST_PROXY === "1",
    consume: options.consume,
    health: {
      ok: true,
      chainId: config.chainId,
      environment: environment.name,
    },
  });
  return {
    server: createServer((request, response) => {
      void handler(request, response);
    }),
    host,
    port,
    environment,
  };
}

export async function startBackend(options = {}) {
  const instance = await createBackendServer(options);
  await new Promise((resolve, reject) => {
    instance.server.once("error", reject);
    instance.server.listen(instance.port, instance.host, resolve);
  });
  return instance;
}

async function main() {
  const instance = await startBackend();
  const address = instance.server.address();
  const port = typeof address === "object" && address ? address.port : instance.port;
  console.log(
    `Clean Privacy backend listening on http://${instance.host}:${port}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(formatPublicError(error, "Backend startup failed"));
    process.exitCode = 1;
  });
}
