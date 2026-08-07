import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const ROOT = new URL("../../", import.meta.url);
const SOURCE = new URL("config/chains.json", ROOT);
const OUTPUT = new URL("web/src/config/chains.generated.ts", ROOT);
const REQUIRED_CHAIN = "arc-testnet";

function assertRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

/**
 * Fields the browser must NOT receive.
 *
 * This projection is not just configuration: `registryFingerprint()` in
 * `web/src/api/readiness.ts` hashes the whole of `ARC_REGISTRY`, and every
 * journal entry stores that hash. Change the projection and every in-flight
 * operation in every user's browser is invalidated on their next page load.
 *
 * So the projection carries only what binds an operation's safety — chain,
 * tokens, fees, protocol addresses — and never configuration the browser does
 * not act on. `bridgeSources` is a CLI-only CCTP allowlist: it cannot affect a
 * pending deposit, transfer or swap, but publishing it here moved the
 * fingerprint and bricked live journals (2026-08-07).
 */
const CLI_ONLY_FIELDS = Object.freeze(["bridgeSources"]);

export function projectArcRegistry(registry) {
  const chain = assertRecord(
    assertRecord(registry, "chain registry")[REQUIRED_CHAIN],
    REQUIRED_CHAIN,
  );
  return {
    chainId: chain.chainId,
    rpc: chain.rpc,
    explorer: chain.explorer,
    unlinkEnvironment: chain.unlinkEnvironment,
    circleChain: chain.circleChain,
    nativeCurrency: chain.nativeCurrency,
    tokens: chain.tokens,
    fees: chain.fees,
    protocol: chain.protocol,
  };
}

/**
 * Every registry field is either projected into the browser or explicitly
 * declared CLI-only. A new field added to `config/chains.json` fails this check
 * until someone decides which it is, so nobody can silently move the
 * fingerprint again.
 *
 * @param {Record<string, unknown>} chain
 * @param {Record<string, unknown>} projected
 */
export function assertProjectionIsComplete(chain, projected) {
  const unaccounted = Object.keys(chain).filter(
    (field) =>
      !(field in projected) && !CLI_ONLY_FIELDS.includes(field),
  );
  if (unaccounted.length > 0) {
    throw new Error(
      `chain registry field is neither projected nor declared CLI-only: ${unaccounted.join(", ")}. ` +
        "Projecting it changes registryFingerprint and invalidates every stored journal entry.",
    );
  }
  return projected;
}

export function renderGeneratedConfig(projected) {
  return `// GENERATED — do not edit. Source: config/chains.json
type DeepReadonly<T> =
  T extends (...args: never[]) => unknown ? T :
  T extends readonly (infer U)[] ? readonly DeepReadonly<U>[] :
  T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } :
  T;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

export const ARC_REGISTRY = deepFreeze(${JSON.stringify(projected, null, 2)} as const);
`;
}

export async function generateChainConfig(options = {}) {
  const source = options.source ?? SOURCE;
  const output = options.output ?? OUTPUT;
  const registry = JSON.parse(await readFile(source, "utf8"));
  const rendered = renderGeneratedConfig(projectArcRegistry(registry));
  await writeFile(output, rendered, "utf8");
  return rendered;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await generateChainConfig();
}
