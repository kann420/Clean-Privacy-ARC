import {
  encodeFunctionData,
  erc20Abi,
  getAddress,
  parseAbi,
} from "viem";

import { parseDecimalAmount } from "./config.mjs";
import { sleep, withRpcRetry } from "./wallet.mjs";

export const PUBLIC_CIRCLE_AMOUNT = "0.1";
export const PRIVATE_SWAP_AMOUNT = "0.1";
export const MINI_DEX_SEED_USDC = "5";
export const MINI_DEX_SEED_CIRBTC = "0.00005";
export const PUBLIC_MINIMUM_REMAINING_USDC = "10";
export const PROJECTED_PHASE3_GAS_USDC = "1";

const APPROVE_ABI = parseAbi([
  "function approve(address spender,uint256 amount) returns (bool)",
]);

/**
 * Assert immutable Arc/Unlink/Circle contract facts before a live mutation.
 *
 * @param {{
 *   config: ReturnType<import("./config.mjs").loadChainConfig>,
 *   publicClient: any,
 *   requireCircle?: boolean,
 *   extraContracts?: string[],
 *   paceMs?: number,
 * }} options
 */
export async function assertPhase3Contracts(options) {
  const chainId = await withRpcRetry(() => options.publicClient.getChainId());
  if (chainId !== options.config.chainId) {
    throw new Error(`RPC chain ID ${chainId} does not match Arc Testnet`);
  }
  if (
    options.config.unlinkEnvironment !== "arc-testnet" ||
    options.config.protocol.erc4337Version !== "v0.7" ||
    options.config.protocol.executionAccountsEnabled !== true
  ) {
    throw new Error("configured Unlink execution environment is invalid");
  }
  const required = [
    options.config.tokens.USDC.address,
    options.config.tokens.EURC.address,
    options.config.tokens.cirBTC.address,
    options.config.protocol.unlinkPool,
    options.config.protocol.entryPoint,
    options.config.protocol.executionAccountFactory,
    options.config.protocol.executionAccountImplementation,
    ...(options.requireCircle
      ? [options.config.protocol.circleAdapter]
      : []),
    ...(options.extraContracts ?? []),
  ];
  for (const address of required) {
    await sleep(options.paceMs ?? 200);
    const code = await withRpcRetry(() =>
      options.publicClient.getCode({
        address: getAddress(address),
      }),
    );
    if (!code || code === "0x") {
      throw new Error(`required Arc contract has no bytecode: ${address}`);
    }
  }
  for (const token of Object.values(options.config.tokens)) {
    await sleep(options.paceMs ?? 200);
    const decimals = await withRpcRetry(() =>
      options.publicClient.readContract({
        address: token.address,
        abi: erc20Abi,
        functionName: "decimals",
      }),
    );
    if (decimals !== token.decimals) {
      throw new Error(
        `${token.symbol} decimals ${decimals} do not match configured ${token.decimals}`,
      );
    }
  }
  return true;
}

/**
 * Gate A budget includes the public proof, the controlled fallback liquidity,
 * a conservative gas reserve, and at least 10 USDC remaining.
 *
 * @param {{
 *   config: ReturnType<import("./config.mjs").loadChainConfig>,
 *   publicClient: any,
 *   owner: string,
 * }} options
 */
export async function assertPhase3PublicBudget(options) {
  const usdc = options.config.tokens.USDC;
  const balance = await withRpcRetry(() =>
    options.publicClient.readContract({
      address: usdc.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [getAddress(options.owner)],
    }),
  );
  const required =
    parseDecimalAmount(PUBLIC_CIRCLE_AMOUNT, usdc.decimals) +
    parseDecimalAmount(MINI_DEX_SEED_USDC, usdc.decimals) +
    parseDecimalAmount(PROJECTED_PHASE3_GAS_USDC, usdc.decimals) +
    parseDecimalAmount(PUBLIC_MINIMUM_REMAINING_USDC, usdc.decimals);
  if (balance < required) {
    throw new Error(
      "public USDC must cover the Circle proof, fallback liquidity, gas reserve, and 10 USDC remainder",
    );
  }
  const cirbtc = options.config.tokens.cirBTC;
  await sleep(200);
  const cirbtcBalance = await withRpcRetry(() =>
    options.publicClient.readContract({
      address: cirbtc.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [getAddress(options.owner)],
    }),
  );
  const cirbtcSeed = parseDecimalAmount(
    MINI_DEX_SEED_CIRBTC,
    cirbtc.decimals,
  );
  if (cirbtcBalance < cirbtcSeed) {
    throw new Error("public cirBTC is insufficient for fallback liquidity");
  }
  return { usdcBalance: balance, cirbtcBalance, requiredUsdc: required };
}

/**
 * @param {{
 *   client: any,
 *   token: string,
 *   minimum: bigint,
 * }} options
 */
export async function assertPrivateSwapBudget(options) {
  const snapshot = await options.client.getBalances();
  if (snapshot.sync_status !== "current") {
    throw new Error("private balance sync status is not current");
  }
  const token = getAddress(options.token);
  const entry = snapshot.balances.find(
    (item) => getAddress(item.token) === token,
  );
  const balance = BigInt(entry?.amount ?? "0");
  if (balance < options.minimum) {
    throw new Error("private USDC balance is below the Phase 3 gate");
  }
  return balance;
}

export async function readTokenBalance(publicClient, token, owner) {
  return withRpcRetry(() =>
    publicClient.readContract({
      address: getAddress(token),
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [getAddress(owner)],
    }),
  );
}

export async function readTokenAllowance(
  publicClient,
  token,
  owner,
  spender,
) {
  return withRpcRetry(() =>
    publicClient.readContract({
      address: getAddress(token),
      abi: erc20Abi,
      functionName: "allowance",
      args: [getAddress(owner), getAddress(spender)],
    }),
  );
}

/**
 * Build a recovery account-call plan without allowing a zero-call sweep.
 *
 * @param {{
 *   classification: "ambiguous" | "empty" | "input_only" | "output_only",
 *   allowance: bigint,
 *   inputBalance: bigint,
 *   outputBalance: bigint,
 *   usdcAddress: string,
 *   outputTokenAddress: string,
 *   circleAdapter: string,
 * }} options
 */
export function buildRecoveryPlan(options) {
  if (options.classification === "ambiguous") {
    throw new Error("both input and output exist; recovery state is ambiguous");
  }
  if (options.classification === "empty" && options.allowance === 0n) {
    throw new Error("no recoverable token or allowance exists; hard stop");
  }
  const recoveryToken =
    options.classification === "output_only"
      ? options.outputTokenAddress
      : options.usdcAddress;
  const recoveryAmount =
    options.classification === "output_only"
      ? options.outputBalance
      : options.inputBalance;
  const calls =
    options.allowance > 0n || recoveryAmount > 0n
      ? [
          {
            target: options.usdcAddress,
            value: "0",
            data: encodeFunctionData({
              abi: APPROVE_ABI,
              functionName: "approve",
              args: [options.circleAdapter, 0n],
            }),
            label:
              options.allowance > 0n
                ? "revoke Circle allowance"
                : "assert zero allowance (gas-tier anchor)",
          },
        ]
      : [];
  const returnToPool =
    recoveryAmount > 0n
      ? [
          {
            token: recoveryToken,
            sweep: true,
            baseline: "0",
            min_total: recoveryAmount.toString(),
            max_total: recoveryAmount.toString(),
          },
        ]
      : [];
  if (calls.length === 0 && returnToPool.length > 0) {
    throw new Error("recovery plan cannot sweep with zero calls");
  }
  return { calls, returnToPool, recoveryToken, recoveryAmount };
}

/**
 * Run Phase B with the same disambiguation and fresh-plan rules for both
 * in-run reverts and persisted reverts from a previous run.
 *
 * @param {{
 *   lastAttemptStatus: string | null,
 *   disambiguate: () => Promise<void>,
 *   buildPlan: (forceFresh: boolean) => Promise<any>,
 *   execute: (plan: any) => Promise<{result: {status: string}}>,
 * }} options
 */
export async function runPhaseBWithRetry(options) {
  let forceFresh = false;
  if (options.lastAttemptStatus === "user_op_reverted") {
    await options.disambiguate();
    forceFresh = true;
  }
  let plan = await options.buildPlan(forceFresh);
  let outcome = await options.execute(plan);
  if (outcome.result.status === "user_op_reverted") {
    await options.disambiguate();
    plan = await options.buildPlan(true);
    outcome = await options.execute(plan);
  }
  return { plan, outcome };
}

/**
 * A terminal public swap may be retried only when neither side of the swap
 * changed and the exact input allowance is still available.
 *
 * @param {{
 *   receiptStatus: string,
 *   beforeOutput: bigint,
 *   currentOutput: bigint,
 *   expectedAllowance: bigint,
 *   currentAllowance: bigint,
 * }} options
 */
export function assertPublicCircleRetryState(options) {
  if (options.receiptStatus !== "reverted") {
    throw new Error("public Circle retry requires a terminal reverted receipt");
  }
  if (options.currentOutput !== options.beforeOutput) {
    throw new Error(
      "public Circle output balance changed after a revert; hard stop",
    );
  }
  if (options.currentAllowance !== options.expectedAllowance) {
    throw new Error(
      "public Circle input allowance changed after a revert; hard stop",
    );
  }
  return true;
}

/**
 * A failed funded execution can be replaced only when the terminal session
 * and every private/public balance prove that its withdrawal rolled back.
 *
 * @param {{
 *   status: string,
 *   confirmationStatus: string | null,
 *   beforePrivateInput: bigint,
 *   currentPrivateInput: bigint,
 *   beforePrivateOutput: bigint,
 *   currentPrivateOutput: bigint,
 *   executionInput: bigint,
 *   executionOutput: bigint,
 *   allowances: bigint[],
 * }} options
 */
export function assertPhaseARetryState(options) {
  if (
    options.status !== "user_op_reverted" ||
    options.confirmationStatus !== "failed"
  ) {
    throw new Error("Phase A retry requires a terminal reverted execution");
  }
  if (
    options.currentPrivateInput !== options.beforePrivateInput ||
    options.currentPrivateOutput !== options.beforePrivateOutput ||
    options.executionInput !== 0n ||
    options.executionOutput !== 0n ||
    options.allowances.some((allowance) => allowance !== 0n)
  ) {
    throw new Error(
      "Phase A retry balances are ambiguous; hard stop without replacement",
    );
  }
  return true;
}

/**
 * Archive a terminal Phase A only after exact private/public rollback proof.
 *
 * @param {{
 *   saved: {
 *     phaseA: any,
 *     phaseBAttempts: any[],
 *     beforeBalances: {input: string, output: string},
 *   },
 *   hasPairRoute: boolean,
 *   resume: () => Promise<{
 *     status: string,
 *     executionId: string,
 *     execution: any,
 *   }>,
 *   readPrivateInput: () => Promise<bigint>,
 *   readPrivateOutput: () => Promise<bigint>,
 *   readExecutionInput: () => Promise<bigint>,
 *   readExecutionOutput: () => Promise<bigint>,
 *   readCircleAllowance: () => Promise<bigint>,
 *   readPairAllowance: () => Promise<bigint>,
 *   archive: (executionId: string) => void,
 * }} options
 */
export async function archiveRolledBackPhaseAWith(options) {
  if (options.saved.phaseA?.status !== "user_op_reverted") {
    return;
  }
  if (options.saved.phaseBAttempts.length !== 0) {
    throw new Error("reverted Phase A has unexpected Phase B attempts");
  }
  const result = await options.resume();
  const [
    privateInput,
    privateOutput,
    executionInput,
    executionOutput,
    circleAllowance,
    pairAllowance,
  ] = await Promise.all([
    options.readPrivateInput(),
    options.readPrivateOutput(),
    options.readExecutionInput(),
    options.readExecutionOutput(),
    options.readCircleAllowance(),
    options.hasPairRoute ? options.readPairAllowance() : Promise.resolve(null),
  ]);
  assertPhaseARetryState({
    status: result.status,
    confirmationStatus: result.execution.confirmation_status ?? null,
    beforePrivateInput: BigInt(options.saved.beforeBalances.input),
    currentPrivateInput: privateInput,
    beforePrivateOutput: BigInt(options.saved.beforeBalances.output),
    currentPrivateOutput: privateOutput,
    executionInput,
    executionOutput,
    allowances: [
      circleAllowance,
      ...(options.hasPairRoute ? [pairAllowance] : []),
    ],
  });
  options.archive(result.executionId);
}
