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
    bridgeSources: chain.bridgeSources,
    nativeCurrency: chain.nativeCurrency,
    tokens: chain.tokens,
    fees: chain.fees,
    protocol: chain.protocol,
  };
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
