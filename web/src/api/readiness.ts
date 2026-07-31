import { ARC_REGISTRY, CHAIN, TOK } from "../config/arc";
import { sha256Hex } from "../lib/fingerprint";

export type ReadinessEnvironment = { name: string; chain_id: number };
export type ReadinessResult = {
  verified: true;
  registryFingerprint: string;
};

const CONTRACTS = [
  ["USDC", TOK("USDC").address],
  ["EURC", TOK("EURC").address],
  ["Unlink pool", ARC_REGISTRY.protocol.unlinkPool],
  ["Permit2", ARC_REGISTRY.protocol.permit2],
  ["EntryPoint", ARC_REGISTRY.protocol.entryPoint],
  [
    "ExecutionAccount factory",
    ARC_REGISTRY.protocol.executionAccountFactory,
  ],
  [
    "ExecutionAccount implementation",
    ARC_REGISTRY.protocol.executionAccountImplementation,
  ],
  ["Circle adapter", ARC_REGISTRY.protocol.circleAdapter],
] as const;

export async function registryFingerprint(): Promise<string> {
  return sha256Hex(ARC_REGISTRY);
}

export async function runReadiness(options: {
  publicClient: {
    getChainId(): Promise<number>;
    getCode(input: { address: `0x${string}` }): Promise<string | undefined>;
  };
  environment: ReadinessEnvironment;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<ReadinessResult> {
  if ((await options.publicClient.getChainId()) !== CHAIN.id) {
    throw new Error("Readiness check failed: Arc Testnet chain ID");
  }
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (let index = 0; index < CONTRACTS.length; index += 1) {
    const [label, address] = CONTRACTS[index]!;
    if (index > 0) await sleep(300);
    let code = await options.publicClient.getCode({ address });
    if (!code || code === "0x") {
      await sleep(300);
      code = await options.publicClient.getCode({ address });
    }
    if (!code || code === "0x") {
      throw new Error(`Readiness check failed: ${label} has no bytecode`);
    }
  }
  if (
    options.environment.chain_id !== CHAIN.id ||
    (options.environment.name !== CHAIN.env &&
      !options.environment.name.startsWith(`${CHAIN.env}-`))
  ) {
    throw new Error("Readiness check failed: Unlink environment");
  }
  return {
    verified: true,
    registryFingerprint: await registryFingerprint(),
  };
}

export class ReadinessGate {
  private cached: Promise<ReadinessResult> | null = null;

  constructor(
    private readonly run: () => Promise<ReadinessResult>,
  ) {}

  verify(): Promise<ReadinessResult> {
    this.cached ??= this.run().catch((error) => {
      this.cached = null;
      throw error;
    });
    return this.cached;
  }

  invalidate(): void {
    this.cached = null;
  }
}
