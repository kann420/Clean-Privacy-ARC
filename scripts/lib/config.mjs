import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";

export const ROOT_URL = new URL("../../", import.meta.url);
export const DEFAULT_CHAIN_KEY = "arc-testnet";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/u;
const UNLINK_ADDRESS_PATTERN = /^unlink1[02-9ac-hj-np-z]{8,}$/u;
const CHAIN_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const AMOUNT_PATTERN = /^(0|[1-9]\d*)(?:\.(\d+))?$/u;

const CHAIN_FIELDS = [
  "chainId",
  "rpc",
  "explorer",
  "unlinkEnvironment",
  "circleChain",
  "bridgeSources",
  "nativeCurrency",
  "tokens",
  "fees",
  "protocol",
];
/** Circle chain identifiers such as `Ethereum_Sepolia`. */
const CIRCLE_CHAIN_PATTERN = /^[A-Z][A-Za-z0-9]*(?:_[A-Z0-9][A-Za-z0-9]*)*$/u;
const NATIVE_CURRENCY_FIELDS = ["name", "symbol", "decimals"];
const FEE_FIELDS = ["owner", "transferBps", "swapBps", "collector"];
/** Protocol fees are capped at 1% so a registry typo cannot quietly overcharge. */
const MAX_FEE_BPS = 100;
const TOKEN_FIELDS = ["address", "decimals"];
const PROTOCOL_FIELDS = [
  "unlinkPool",
  "permit2",
  "entryPoint",
  "executionAccountFactory",
  "executionAccountImplementation",
  "circleAdapter",
  "circleBridge",
  "erc4337Version",
  "executionAccountsEnabled",
];

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function requireRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requireDecimals(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) {
    throw new Error(`${label} must be an integer between 0 and 255`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requireFeeBps(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_FEE_BPS) {
    throw new Error(
      `${label} must be an integer between 0 and ${MAX_FEE_BPS} basis points`,
    );
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requireAddress(value, label) {
  const candidate = requireString(value, label);
  if (!ADDRESS_PATTERN.test(candidate)) {
    throw new Error(`${label} must be a 20-byte 0x-prefixed address`);
  }
  return candidate;
}

/**
 * Validate the CCTP bridge source allowlist.
 *
 * This is an allowlist of Circle chain identifiers, deliberately NOT an address
 * registry: every source chain's USDC address, RPC endpoint and CCTP domain is
 * read from Circle's own chain definitions at run time, so nothing here can
 * drift out of sync with the protocol.
 *
 * @param {unknown} value
 * @param {string} label
 * @param {string} ownChain
 */
function requireBridgeSources(value, label, ownChain) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  const seen = new Set();
  for (const entry of value) {
    const candidate = requireString(entry, `${label} entry`);
    if (!CIRCLE_CHAIN_PATTERN.test(candidate)) {
      throw new Error(`${label} entry must be a Circle chain identifier`);
    }
    if (candidate === ownChain) {
      throw new Error(`${label} must not contain the destination chain`);
    }
    if (seen.has(candidate)) {
      throw new Error(`${label} contains a duplicate entry: ${candidate}`);
    }
    seen.add(candidate);
  }
  return Object.freeze([...value]);
}

function requireUnlinkAddress(value, label) {
  const candidate = requireString(value, label);
  if (!UNLINK_ADDRESS_PATTERN.test(candidate)) {
    throw new Error(`${label} must be a lowercase unlink1 bech32m address`);
  }
  return candidate;
}

/**
 * @param {unknown} value
 * @param {string} label
 */
export function requireHttpsUrl(value, label) {
  const candidate = requireString(value, label);
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${label} must use HTTPS`);
  }
  return candidate;
}

/**
 * @param {Record<string, unknown>} value
 * @param {string[]} expected
 * @param {string} label
 */
function requireExactFields(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((field, index) => field !== wanted[index])
  ) {
    throw new Error(`${label} must contain exactly: ${wanted.join(", ")}`);
  }
}

/**
 * @template T
 * @param {T} value
 * @returns {Readonly<T>}
 */
function deepFreeze(value) {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

/**
 * Validate and normalize an in-memory chain registry.
 *
 * @param {unknown} input
 */
export function validateChainRegistry(input) {
  const registry = requireRecord(input, "chain registry");
  if (Object.keys(registry).length === 0) {
    throw new Error("chain registry must not be empty");
  }

  /** @type {Record<string, unknown>} */
  const validated = {};
  for (const [chainKey, chainValue] of Object.entries(registry)) {
    if (!CHAIN_KEY_PATTERN.test(chainKey)) {
      throw new Error(`invalid chain key: ${chainKey}`);
    }
    const chain = requireRecord(chainValue, `chains.${chainKey}`);
    requireExactFields(chain, CHAIN_FIELDS, `chains.${chainKey}`);

    const nativeCurrency = requireRecord(
      chain.nativeCurrency,
      `${chainKey}.nativeCurrency`,
    );
    requireExactFields(
      nativeCurrency,
      NATIVE_CURRENCY_FIELDS,
      `${chainKey}.nativeCurrency`,
    );

    const rawTokens = requireRecord(chain.tokens, `${chainKey}.tokens`);
    if (Object.keys(rawTokens).length === 0) {
      throw new Error(`${chainKey}.tokens must not be empty`);
    }
    /** @type {Record<string, {symbol: string, address: string, decimals: number}>} */
    const tokens = {};
    const configuredAddresses = new Set();
    for (const [symbol, tokenValue] of Object.entries(rawTokens)) {
      if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(symbol)) {
        throw new Error(`invalid token symbol: ${symbol}`);
      }
      const token = requireRecord(tokenValue, `${chainKey}.tokens.${symbol}`);
      requireExactFields(token, TOKEN_FIELDS, `${chainKey}.tokens.${symbol}`);
      const tokenAddress = requireAddress(
        token.address,
        `${chainKey}.tokens.${symbol}.address`,
      );
      const normalizedAddress = tokenAddress.toLowerCase();
      if (configuredAddresses.has(normalizedAddress)) {
        throw new Error(`${chainKey} contains a duplicate configured address`);
      }
      configuredAddresses.add(normalizedAddress);
      tokens[symbol] = {
        symbol,
        address: tokenAddress,
        decimals: requireDecimals(
          token.decimals,
          `${chainKey}.tokens.${symbol}.decimals`,
        ),
      };
    }

    if (!tokens.USDC) {
      throw new Error(`${chainKey}.tokens.USDC is required for Arc gas`);
    }

    const rawFees = requireRecord(chain.fees, `${chainKey}.fees`);
    requireExactFields(rawFees, FEE_FIELDS, `${chainKey}.fees`);
    const feeOwner = requireAddress(rawFees.owner, `${chainKey}.fees.owner`);
    if (configuredAddresses.has(feeOwner.toLowerCase())) {
      throw new Error(`${chainKey} contains a duplicate configured address`);
    }
    configuredAddresses.add(feeOwner.toLowerCase());
    const fees = {
      owner: feeOwner,
      transferBps: requireFeeBps(
        rawFees.transferBps,
        `${chainKey}.fees.transferBps`,
      ),
      swapBps: requireFeeBps(rawFees.swapBps, `${chainKey}.fees.swapBps`),
      collector: requireUnlinkAddress(
        rawFees.collector,
        `${chainKey}.fees.collector`,
      ),
    };

    const rawProtocol = requireRecord(chain.protocol, `${chainKey}.protocol`);
    requireExactFields(
      rawProtocol,
      PROTOCOL_FIELDS,
      `${chainKey}.protocol`,
    );
    /** @type {Record<string, string | boolean>} */
    const protocol = {};
    for (const field of PROTOCOL_FIELDS.slice(0, 7)) {
      const protocolAddress = requireAddress(
        rawProtocol[field],
        `${chainKey}.protocol.${field}`,
      );
      const normalizedAddress = protocolAddress.toLowerCase();
      if (configuredAddresses.has(normalizedAddress)) {
        throw new Error(`${chainKey} contains a duplicate configured address`);
      }
      configuredAddresses.add(normalizedAddress);
      protocol[field] = protocolAddress;
    }
    protocol.erc4337Version = requireString(
      rawProtocol.erc4337Version,
      `${chainKey}.protocol.erc4337Version`,
    );
    if (typeof rawProtocol.executionAccountsEnabled !== "boolean") {
      throw new Error(
        `${chainKey}.protocol.executionAccountsEnabled must be a boolean`,
      );
    }
    protocol.executionAccountsEnabled =
      rawProtocol.executionAccountsEnabled;

    validated[chainKey] = {
      network: chainKey,
      chainKey,
      chainId: requirePositiveInteger(
        chain.chainId,
        `${chainKey}.chainId`,
      ),
      rpc: requireHttpsUrl(chain.rpc, `${chainKey}.rpc`),
      explorer: requireHttpsUrl(chain.explorer, `${chainKey}.explorer`),
      unlinkEnvironment: requireString(
        chain.unlinkEnvironment,
        `${chainKey}.unlinkEnvironment`,
      ),
      circleChain: requireString(
        chain.circleChain,
        `${chainKey}.circleChain`,
      ),
      bridgeSources: requireBridgeSources(
        chain.bridgeSources,
        `${chainKey}.bridgeSources`,
        requireString(chain.circleChain, `${chainKey}.circleChain`),
      ),
      nativeCurrency: {
        name: requireString(
          nativeCurrency.name,
          `${chainKey}.nativeCurrency.name`,
        ),
        symbol: requireString(
          nativeCurrency.symbol,
          `${chainKey}.nativeCurrency.symbol`,
        ),
        decimals: requireDecimals(
          nativeCurrency.decimals,
          `${chainKey}.nativeCurrency.decimals`,
        ),
      },
      tokens,
      fees,
      protocol,
    };
  }

  return deepFreeze(validated);
}

export function loadChainRegistry() {
  const raw = JSON.parse(
    readFileSync(new URL("config/chains.json", ROOT_URL), "utf8"),
  );
  return validateChainRegistry(raw);
}

/**
 * @param {string} [chainKey]
 */
export function loadChainConfig(chainKey = DEFAULT_CHAIN_KEY) {
  if (!CHAIN_KEY_PATTERN.test(chainKey)) {
    throw new Error(`invalid chain key: ${chainKey}`);
  }
  const registry = loadChainRegistry();
  if (!registry[chainKey]) {
    throw new Error(`unknown chain key: ${chainKey}`);
  }
  return registry[chainKey];
}

/**
 * Parse a human-readable amount exactly once using the configured token
 * decimals. The result is a base-unit bigint.
 *
 * @param {string} value
 * @param {number} decimals
 */
export function parseDecimalAmount(value, decimals) {
  requireDecimals(decimals, "decimals");
  const match = AMOUNT_PATTERN.exec(value);
  if (!match) {
    throw new Error(`invalid decimal amount: ${value}`);
  }
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    throw new Error(`amount has more than ${decimals} decimal places`);
  }
  const wholeUnits = BigInt(match[1]) * 10n ** BigInt(decimals);
  const fractionUnits =
    fraction.length === 0 ? 0n : BigInt(fraction.padEnd(decimals, "0"));
  return wholeUnits + fractionUnits;
}

/**
 * @param {string} symbol
 * @param {string} value
 * @param {string} [chainKey]
 */
export function parseTokenAmount(
  symbol,
  value,
  chainKey = DEFAULT_CHAIN_KEY,
) {
  const config = loadChainConfig(chainKey);
  const token = config.tokens[symbol];
  if (!token) {
    throw new Error(`unsupported token on ${chainKey}: ${symbol}`);
  }
  return parseDecimalAmount(value, token.decimals);
}

/**
 * @param {string} chainKey
 */
export function assertChainKey(chainKey) {
  if (typeof chainKey !== "string" || !CHAIN_KEY_PATTERN.test(chainKey)) {
    throw new Error(`invalid chain key: ${chainKey}`);
  }
  return chainKey;
}

/**
 * Convert a base-unit bigint into the decimal string the Unlink SDK and
 * checkpoint records expect. This is the only sanctioned bigint-to-string
 * amount conversion; callers must not stringify amounts ad hoc.
 *
 * @param {bigint} value
 */
export function toBaseUnitString(value) {
  if (typeof value !== "bigint" || value < 0n) {
    throw new Error("base-unit amount must be a non-negative bigint");
  }
  return value.toString();
}

/**
 * Parse `KEY=VALUE` lines from a local environment file. Blank lines and
 * `#` comments are ignored; values keep everything after the first `=`.
 *
 * @param {string} text
 */
export function parseEnvFile(text) {
  /** @type {Record<string, string>} */
  const parsed = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match) {
      continue;
    }
    parsed[match[1]] = match[2].trim();
  }
  return parsed;
}

/**
 * Load `.env.local` from the repository root, letting real environment
 * variables override file entries. Values are never logged.
 *
 * @param {{envFileUrl?: URL, processEnv?: Record<string, string | undefined>}} [options]
 */
/**
 * Choose which endpoint actually gets dialled.
 *
 * `ARC_RPC_URL` is an OPTIONAL transport override, nothing more. Provider URLs
 * usually embed a token in the path, so it is a secret: it belongs in the
 * gitignored `.env.local`, never in `config/chains.json`, and never behind a
 * `VITE_` prefix, which would bundle it into the browser.
 *
 * Deliberately NOT folded into the loaded chain config: `config.rpc` stays the
 * canonical public endpoint, so evidence and manifests keep recording that
 * value instead of leaking a tokenised URL. This only changes who is dialled —
 * never a chain id, token address or contract address.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{rpc: string}} config
 * @returns {string}
 */
export function selectRpcEndpoint(env, config) {
  const override = (env?.ARC_RPC_URL ?? "").trim();
  if (!override) return config.rpc;
  return requireHttpsUrl(override, "ARC_RPC_URL");
}

/**
 * `selectRpcEndpoint` against the local environment, for call sites that build
 * a viem transport and have no env of their own.
 *
 * @param {{rpc: string}} config
 * @param {Record<string, string | undefined>} [env]
 */
export function resolveRpcUrl(config, env) {
  return selectRpcEndpoint(env ?? loadLocalEnv(), config);
}

export function loadLocalEnv(options = {}) {
  const envFileUrl = options.envFileUrl ?? new URL(".env.local", ROOT_URL);
  const processEnv = options.processEnv ?? process.env;
  /** @type {Record<string, string>} */
  const merged = {};
  if (existsSync(envFileUrl)) {
    Object.assign(merged, parseEnvFile(readFileSync(envFileUrl, "utf8")));
  }
  for (const [key, value] of Object.entries(processEnv)) {
    if (typeof value === "string" && value.length > 0) {
      merged[key] = value;
    }
  }
  return Object.freeze(merged);
}

/**
 * @param {string[]} argv
 * @param {{defaultChain?: string, requireChain?: boolean}} [options]
 */
export function parseChainFlag(argv, options = {}) {
  let chainKey = options.defaultChain ?? DEFAULT_CHAIN_KEY;
  let supplied = false;
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--chain") {
      rest.push(argv[index]);
      continue;
    }
    if (supplied) {
      throw new Error("--chain may be supplied only once");
    }
    const value = argv[index + 1];
    if (!value) {
      throw new Error("--chain requires a value");
    }
    chainKey = value;
    supplied = true;
    index += 1;
  }
  if (options.requireChain && !supplied) {
    throw new Error("--chain is required");
  }
  assertChainKey(chainKey);
  return { chainKey, rest };
}

/**
 * Keep console failures useful without emitting call arguments, cryptographic
 * material, or credential-like fields.
 *
 * URL handling is deliberately blunt: scheme and host survive so an operator
 * can still see WHICH endpoint failed, and everything after the host is
 * dropped. `ARC_RPC_URL` and `BRIDGE_SOURCE_RPC_URL` are documented secrets
 * because provider URLs carry their token in the path or query, and viem embeds
 * the full endpoint in every network error it throws. Redacting only
 * token-shaped substrings would be a guess about the provider's key format —
 * a UUID-style key, for instance, survives any "long alphanumeric run" rule.
 * Any userinfo (`https://user:pass@host`) is dropped for the same reason.
 *
 * @param {unknown} error
 * @param {string} fallback
 */
export function formatPublicError(error, fallback) {
  const message = error instanceof Error ? error.message : fallback;
  return message
    .split(/\n\s*(?:Contract Call|Request Arguments|Raw Call Arguments):/u, 1)[0]
    .replace(
      /(https?:\/\/)(?:[^\s/?#@]*@)?([^\s/?#]+)([/?#]\S*)?/giu,
      (_match, scheme, host, rest) =>
        `${scheme}${host}${rest ? "/[redacted url]" : ""}`,
    )
    .replace(/0x[0-9a-fA-F]{64,}/gu, "[redacted hex]")
    .replace(
      /(["']?(?:authorization|api[_ -]?key|kit[_ -]?key|private[_ -]?key|viewing[_ -]?key|nullifying[_ -]?key|signature)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/giu,
      "$1[redacted]",
    );
}

const EVIDENCE_NAME_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/u;

const SAFE_EVIDENCE_FIELDS = new Set([
  "accountIndex",
  "accountImplementation",
  "address",
  "afterBalance",
  "allowance",
  "amount",
  "amountIn",
  "attempt",
  "appId",
  "blockNumber",
  "beforeBalance",
  "chainId",
  "circleExecutionId",
  "confirmationStatus",
  "delta",
  "destinationCctpDomain",
  "destinationChain",
  "deterministicOutput",
  "entryPoint",
  "environment",
  "estimatedOutput",
  "executionAccountAddress",
  "executionId",
  "explorer",
  "factory",
  "feeAmount",
  "feeBps",
  "feeRecipient",
  "feeTxId",
  "fundsUsable",
  "handleOpsTxHash",
  "liquidity",
  "lpBalance",
  "maxOut",
  "minOut",
  "pair",
  "pairFactory",
  "pool",
  "provider",
  "quote",
  "quoteFingerprint",
  "recipientAddress",
  "recipientAfterBalance",
  "recipientBeforeBalance",
  "recipientDelta",
  "recipientEvmAddress",
  "recipientPublicAfterBalance",
  "recipientPublicBeforeBalance",
  "recipientPublicDelta",
  "reserve0",
  "reserve1",
  "route",
  "rpc",
  "senderAfterBalance",
  "senderBeforeBalance",
  "senderDelta",
  "sourceCctpDomain",
  "sourceChain",
  "sourceChainId",
  "sourceToken",
  "stage",
  "state",
  "status",
  "stepNames",
  "stepStates",
  "stopLimit",
  "token",
  "tokenIn",
  "tokenOut",
  "tokenDecimals",
  "tokenSymbol",
  "transferSpeed",
  "txHash",
  "txHashes",
  "txId",
  "unlinkAddress",
  "verifiedAt",
  "withdrawalTxIds",
]);

/**
 * @param {unknown} value
 */
function validateEvidenceValue(value) {
  const isScalar = (item) =>
    item === null ||
    typeof item === "string" ||
    typeof item === "number" ||
    typeof item === "boolean" ||
    typeof item === "bigint";
  if (isScalar(value)) {
    return;
  }
  if (Array.isArray(value) && value.every(isScalar)) {
    return;
  }
  throw new Error("evidence values must be public scalars or scalar arrays");
}

/**
 * Append-only allowlisted JSONL evidence under `deployments/evidence/`, the
 * only committed evidence location.
 *
 * @param {{
 *   chainKey: string,
 *   flow: string,
 *   runId?: string,
 *   append?: (line: string) => void,
 * }} options
 */
export function createEvidenceWriter(options) {
  const chainKey = assertChainKey(options.chainKey);
  if (!EVIDENCE_NAME_PATTERN.test(options.flow)) {
    throw new Error(`invalid evidence flow name: ${options.flow}`);
  }
  const directory = new URL("deployments/evidence/", ROOT_URL);
  const path = new URL(`${chainKey}.${options.flow}.jsonl`, directory);
  const runId = options.runId ?? randomBytes(12).toString("hex");
  if (!/^[0-9a-f]{24}$/u.test(runId)) {
    throw new Error("evidence runId must be 12 public random bytes in hex");
  }

  /**
   * @param {string} event
   * @param {Record<string, unknown>} fields
   */
  function writeEvidence(event, fields = {}) {
    if (!EVIDENCE_NAME_PATTERN.test(event)) {
      throw new Error(`invalid evidence event: ${event}`);
    }
    for (const [key, value] of Object.entries(fields)) {
      if (!SAFE_EVIDENCE_FIELDS.has(key)) {
        throw new Error(`evidence field is not allowlisted: ${key}`);
      }
      validateEvidenceValue(value);
    }
    const record = {
      timestamp: new Date().toISOString(),
      event,
      chainKey,
      runId,
      ...fields,
    };
    const line = `${JSON.stringify(record, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value)}\n`;
    if (options.append) {
      options.append(line);
    } else {
      mkdirSync(directory, { recursive: true });
      appendFileSync(path, line, "utf8");
    }
  }
  writeEvidence.runId = runId;
  return writeEvidence;
}
