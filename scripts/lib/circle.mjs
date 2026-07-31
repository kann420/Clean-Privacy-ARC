import { createHash } from "node:crypto";

import { ViemAdapter } from "@circle-fin/adapter-viem-v2";
import { ArcTestnet } from "@circle-fin/app-kit/chains";
import {
  createSwapKitContext,
  estimate,
  getSwapStatus,
  swap,
} from "@circle-fin/swap-kit";
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  defineChain,
  getAddress,
  http,
  parseAbi,
} from "viem";

import { parseDecimalAmount, resolveRpcUrl } from "./config.mjs";

export const CIRCLE_SLIPPAGE_BPS = 300;
export const CIRCLE_CAPTURE_STOP = "CIRCLE_CAPTURE_COMPLETE";
export const MIN_CIRCLE_DEADLINE_SECONDS = 480n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const USDC_ALLOWANCE_ABI = parseAbi([
  "function increaseAllowance(address spender,uint256 addedValue) returns (bool)",
]);
// Circle emits `usdc.increaseAllowance` when the input is USDC and the generic
// `token.approve` for any other input token. Both are exact-amount approvals to
// the adapter; the selectors differ, so the captured calldata must be decoded
// with the ABI that matches the action Circle actually planned.
const ERC20_APPROVE_ABI = parseAbi([
  "function approve(address spender,uint256 value) returns (bool)",
]);
const APPROVAL_ACTIONS = {
  "usdc.increaseAllowance": {
    abi: USDC_ALLOWANCE_ABI,
    functionName: "increaseAllowance",
  },
  "token.approve": { abi: ERC20_APPROVE_ABI, functionName: "approve" },
};
export const CIRCLE_ADAPTER_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          {
            name: "instructions",
            type: "tuple[]",
            components: [
              { name: "target", type: "address" },
              { name: "data", type: "bytes" },
              { name: "value", type: "uint256" },
              { name: "tokenIn", type: "address" },
              { name: "amountToApprove", type: "uint256" },
              { name: "tokenOut", type: "address" },
              { name: "minTokenOut", type: "uint256" },
            ],
          },
          {
            name: "tokens",
            type: "tuple[]",
            components: [
              { name: "token", type: "address" },
              { name: "beneficiary", type: "address" },
            ],
          },
          { name: "execId", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "metadata", type: "bytes" },
        ],
      },
      {
        name: "tokenInputs",
        type: "tuple[]",
        components: [
          { name: "permitType", type: "uint8" },
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "permitCalldata", type: "bytes" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
];

function canonical(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

function fingerprint(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function requirePositiveDecimal(value, label, decimals) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a decimal string`);
  }
  const parsed = parseDecimalAmount(value, decimals);
  if (parsed <= 0n) throw new Error(`${label} must be greater than zero`);
  return parsed;
}

function requireAddress(value, label) {
  try {
    return getAddress(value);
  } catch {
    throw new Error(`${label} must be an EVM address`);
  }
}

function requireNonNegativeBigInt(value, label) {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error();
    return parsed;
  } catch {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

function requireHex(value, label) {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/u.test(value)) {
    throw new Error(`${label} must be even-length hex`);
  }
  return value;
}

function sameAddress(left, right) {
  return getAddress(left) === getAddress(right);
}

/**
 * The kit key is mandatory even if the upstream service currently tolerates
 * anonymous requests. This prevents accidental permissionless execution.
 *
 * @param {Record<string, string | undefined>} env
 */
export function requireCircleKitKey(env) {
  const key = env.CIRCLE_APP_KIT_KEY?.trim();
  if (!key) {
    throw new Error("CIRCLE_APP_KIT_KEY is required for Circle swap operations");
  }
  return key;
}

/**
 * @param {ReturnType<import("./config.mjs").loadChainConfig>} config
 */
export function createArcViemChain(config) {
  return defineChain({
    id: config.chainId,
    name: "Arc Testnet",
    nativeCurrency: config.nativeCurrency,
    rpcUrls: { default: { http: [config.rpc] } },
    blockExplorers: {
      default: { name: "ArcScan", url: config.explorer },
    },
    testnet: true,
  });
}

/**
 * @param {{
 *   config: ReturnType<import("./config.mjs").loadChainConfig>,
 *   address: `0x${string}`,
 *   publicClient?: any,
 *   walletClient?: any,
 * }} options
 */
export function createCircleViemAdapter(options) {
  const chain = createArcViemChain(options.config);
  const address = getAddress(options.address);
  const rpcUrl = resolveRpcUrl(options.config);
  const publicClient =
    options.publicClient ??
    createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient =
    options.walletClient ??
    createWalletClient({
      account: address,
      chain,
      transport: http(rpcUrl),
    });
  return new ViemAdapter(
    {
      getPublicClient: () => publicClient,
      getWalletClient: () => walletClient,
    },
    {
      addressContext: "developer-controlled",
      supportedChains: [ArcTestnet],
    },
  );
}

/**
 * Resolve the swap direction for a request. Defaults to the original
 * USDC -> EURC route so existing callers keep their exact behaviour.
 *
 * @param {ReturnType<import("./config.mjs").loadChainConfig>} config
 * @param {{tokenIn?: string, tokenOut?: string}} options
 */
export function resolveCirclePair(config, options = {}) {
  const inSymbol = options.tokenIn ?? "USDC";
  const outSymbol = options.tokenOut ?? "EURC";
  if (inSymbol === outSymbol) {
    throw new Error("Circle swap input and output tokens must differ");
  }
  const inToken = config.tokens[inSymbol];
  const outToken = config.tokens[outSymbol];
  if (!inToken || !outToken) {
    throw new Error(`Circle swap route ${inSymbol}->${outSymbol} is not configured`);
  }
  return { inSymbol, outSymbol, inToken, outToken };
}

function buildSwapParams(options, adapter) {
  const pair = resolveCirclePair(options.config, options);
  return {
    from: {
      adapter,
      chain: ArcTestnet,
      address: getAddress(options.executionAccount),
    },
    to: {
      chain: ArcTestnet,
      recipientAddress: getAddress(options.executionAccount),
    },
    tokenIn: pair.inSymbol,
    tokenOut: pair.outSymbol,
    amountIn: options.amountHuman,
    config: {
      kitKey: options.kitKey,
      slippageBps: CIRCLE_SLIPPAGE_BPS,
      allowanceStrategy: "approve",
    },
  };
}

/**
 * @param {{
 *   config: ReturnType<import("./config.mjs").loadChainConfig>,
 *   executionAccount: `0x${string}`,
 *   amountHuman: string,
 *   kitKey: string,
 *   adapter?: any,
 *   estimateFn?: typeof estimate,
 *   context?: any,
 * }} options
 */
export async function estimateCircleSwap(options) {
  if (!options.kitKey?.trim()) {
    throw new Error("Circle estimate requires a non-empty kit key");
  }
  const pair = resolveCirclePair(options.config, options);
  const amount = requirePositiveDecimal(
    options.amountHuman,
    "Circle input amount",
    pair.inToken.decimals,
  );
  const adapter =
    options.adapter ??
    createCircleViemAdapter({
      config: options.config,
      address: options.executionAccount,
    });
  const result = await (options.estimateFn ?? estimate)(
    options.context ?? createSwapKitContext(),
    buildSwapParams(options, adapter),
  );
  if (
    result.chainIn !== options.config.circleChain ||
    result.chainOut !== options.config.circleChain ||
    !sameAddress(result.fromAddress, options.executionAccount) ||
    !sameAddress(result.toAddress, options.executionAccount) ||
    result.tokenIn !== pair.inSymbol ||
    result.tokenOut !== pair.outSymbol ||
    requirePositiveDecimal(
      result.amountIn,
      "Circle quoted input",
      pair.inToken.decimals,
    ) !== amount
  ) {
    throw new Error("Circle estimate changed the requested route");
  }
  requirePositiveDecimal(
    result.stopLimit?.amount,
    "Circle stop limit",
    pair.outToken.decimals,
  );
  requirePositiveDecimal(
    result.estimatedOutput?.amount,
    "Circle estimated output",
    pair.outToken.decimals,
  );
  if (
    result.stopLimit.token !== pair.outSymbol ||
    result.estimatedOutput.token !== pair.outSymbol
  ) {
    throw new Error("Circle estimate returned an unexpected output token");
  }
  return {
    chainIn: result.chainIn,
    chainOut: result.chainOut,
    fromAddress: getAddress(result.fromAddress),
    toAddress: getAddress(result.toAddress),
    tokenIn: result.tokenIn,
    tokenOut: result.tokenOut,
    amountIn: result.amountIn,
    amountInBaseUnits: amount.toString(),
    stopLimit: { ...result.stopLimit },
    estimatedOutput: { ...result.estimatedOutput },
    fees: (result.fees ?? []).map((fee) => ({
      token: fee.token,
      amount: fee.amount,
      type: fee.type,
    })),
    quotedAt: new Date().toISOString(),
  };
}

function normalizeCall(call, label) {
  return {
    target: requireAddress(call?.to ?? call?.target, `${label}.target`),
    data: requireHex(call?.data, `${label}.data`),
    value: requireNonNegativeBigInt(call?.value ?? 0n, `${label}.value`).toString(),
  };
}

function extractStructuredSwap(action) {
  const params = action?.params;
  const executeParams = params?.executeParams;
  if (!executeParams || !Array.isArray(executeParams.instructions)) {
    throw new Error("Circle swap action has no structured instructions");
  }
  return {
    executionId: requireNonNegativeBigInt(
      executeParams.execId,
      "Circle execution ID",
    ).toString(),
    deadline: requireNonNegativeBigInt(
      executeParams.deadline,
      "Circle deadline",
    ).toString(),
    instructions: executeParams.instructions.map((instruction, index) => ({
      target: requireAddress(
        instruction.target,
        `Circle instruction ${index} target`,
      ),
      data: requireHex(
        instruction.data,
        `Circle instruction ${index} data`,
      ),
      value: requireNonNegativeBigInt(
        instruction.value,
        `Circle instruction ${index} value`,
      ).toString(),
      tokenIn: requireAddress(
        instruction.tokenIn,
        `Circle instruction ${index} tokenIn`,
      ),
      amountToApprove: requireNonNegativeBigInt(
        instruction.amountToApprove,
        `Circle instruction ${index} amountToApprove`,
      ).toString(),
      tokenOut: requireAddress(
        instruction.tokenOut,
        `Circle instruction ${index} tokenOut`,
      ),
      minTokenOut: requireNonNegativeBigInt(
        instruction.minTokenOut,
        `Circle instruction ${index} minTokenOut`,
      ).toString(),
    })),
    beneficiaries: (executeParams.tokens ?? []).map((token, index) => ({
      token: requireAddress(token.token, `Circle output ${index} token`),
      beneficiary: requireAddress(
        token.beneficiary,
        `Circle output ${index} beneficiary`,
      ),
    })),
    tokenInputs: (params.tokenInputs ?? []).map((token, index) => ({
      permitType: Number(token.permitType),
      token: requireAddress(token.token, `Circle input ${index} token`),
      amount: requireNonNegativeBigInt(
        token.amount,
        `Circle input ${index} amount`,
      ).toString(),
      permitCalldata: requireHex(
        token.permitCalldata,
        `Circle input ${index} permitCalldata`,
      ),
    })),
    inputAmount: requireNonNegativeBigInt(
      params.inputAmount,
      "Circle structured input amount",
    ).toString(),
    tokenInAddress: requireAddress(
      params.tokenInAddress,
      "Circle structured input token",
    ),
  };
}

/**
 * Validate and normalize a capture-only Circle batch. No service response or
 * separate signature is retained; the executable swap calldata is sufficient.
 *
 * @param {{
 *   config: ReturnType<import("./config.mjs").loadChainConfig>,
 *   executionAccount: `0x${string}`,
 *   amountIn: bigint,
 *   estimate: Awaited<ReturnType<typeof estimateCircleSwap>>,
 *   actions: any[],
 *   calls: any[],
 *   nowSeconds?: bigint,
 * }} options
 */
export function validateCircleSwapPlan(options) {
  const sender = getAddress(options.executionAccount);
  const amountIn = requireNonNegativeBigInt(
    options.amountIn,
    "Circle plan input amount",
  );
  if (amountIn <= 0n) throw new Error("Circle plan input amount must be positive");
  if (!Array.isArray(options.actions) || options.actions.length !== 2) {
    throw new Error("Circle capture must contain exactly two actions");
  }
  if (!Array.isArray(options.calls) || options.calls.length !== 2) {
    throw new Error("Circle capture must contain exactly two calls");
  }

  const pair = resolveCirclePair(options.config, options);
  const approvalAction = options.actions[0];
  const approvalShape = APPROVAL_ACTIONS[approvalAction.action];
  if (!approvalShape) {
    throw new Error("Circle first action must be an exact input-token approval");
  }
  if (
    approvalAction.action === "usdc.increaseAllowance"
      ? pair.inSymbol !== "USDC"
      : !sameAddress(
          approvalAction.params?.tokenAddress ?? ZERO_ADDRESS,
          pair.inToken.address,
        )
  ) {
    throw new Error("Circle approval token does not match the swap input token");
  }
  if (!sameAddress(approvalAction.address, sender)) {
    throw new Error("Circle approval sender does not match ExecutionAccount");
  }
  if (approvalAction.chainId !== options.config.chainId) {
    throw new Error("Circle approval chain does not match Arc Testnet");
  }
  if (
    requireNonNegativeBigInt(
      approvalAction.params?.amount,
      "Circle approval amount",
    ) !== amountIn ||
    !sameAddress(
      approvalAction.params?.delegate,
      options.config.protocol.circleAdapter,
    )
  ) {
    throw new Error("Circle approval is not exact for the configured adapter");
  }

  const swapAction = options.actions[1];
  if (swapAction.action !== "swap.execute") {
    throw new Error("Circle second action must execute the swap");
  }
  if (!sameAddress(swapAction.address, sender)) {
    throw new Error("Circle swap sender does not match ExecutionAccount");
  }
  if (swapAction.chainId !== options.config.chainId) {
    throw new Error("Circle swap chain does not match Arc Testnet");
  }
  const structured = extractStructuredSwap(swapAction);
  const tokenInAddress = pair.inToken.address;
  const tokenOutAddress = pair.outToken.address;
  if (
    structured.inputAmount !== amountIn.toString() ||
    !sameAddress(structured.tokenInAddress, tokenInAddress)
  ) {
    throw new Error(
      `Circle structured input does not match exact ${pair.inSymbol} amount`,
    );
  }
  if (
    structured.tokenInputs.length !== 1 ||
    structured.tokenInputs[0].permitType !== 0 ||
    structured.tokenInputs[0].permitCalldata !== "0x" ||
    !sameAddress(structured.tokenInputs[0].token, tokenInAddress) ||
    BigInt(structured.tokenInputs[0].amount) !== amountIn
  ) {
    throw new Error(
      `Circle token input must use PermitType.NONE for exact ${pair.inSymbol}`,
    );
  }
  if (
    structured.instructions.length === 0 ||
    structured.instructions.some(
      (instruction) =>
        instruction.value !== "0" ||
        !sameAddress(instruction.tokenIn, tokenInAddress) ||
        (!sameAddress(instruction.tokenOut, tokenInAddress) &&
          !sameAddress(instruction.tokenOut, tokenOutAddress) &&
          !(
            sameAddress(instruction.tokenOut, ZERO_ADDRESS) &&
            instruction.minTokenOut === "0"
          )),
    ) ||
    structured.instructions.reduce(
      (sum, instruction) => sum + BigInt(instruction.amountToApprove),
      0n,
    ) !== amountIn
  ) {
    throw new Error("Circle instructions do not consume the exact approved input");
  }
  const routeOutputs = structured.instructions.filter(
    (instruction) =>
      sameAddress(instruction.tokenOut, tokenOutAddress) &&
      BigInt(instruction.minTokenOut) > 0n,
  );
  if (routeOutputs.length !== 1) {
    throw new Error(
      `Circle plan must have exactly one positive ${pair.outSymbol} output`,
    );
  }
  if (
    structured.beneficiaries.length === 0 ||
    structured.beneficiaries.some(
      (output) =>
        !sameAddress(output.beneficiary, sender) ||
        (!sameAddress(output.token, tokenInAddress) &&
          !sameAddress(output.token, tokenOutAddress)),
    ) ||
    structured.beneficiaries.filter((output) =>
      sameAddress(output.token, tokenOutAddress),
    ).length !== 1
  ) {
    throw new Error(
      `Circle beneficiaries must return exactly one ${pair.outSymbol} output to the ExecutionAccount`,
    );
  }
  const nowSeconds =
    options.nowSeconds ?? BigInt(Math.floor(Date.now() / 1_000));
  if (BigInt(structured.deadline) - nowSeconds < MIN_CIRCLE_DEADLINE_SECONDS) {
    throw new Error("Circle plan deadline is stale");
  }

  const approval = normalizeCall(options.calls[0], "Circle approval call");
  const swapCall = normalizeCall(options.calls[1], "Circle swap call");
  if (!sameAddress(approval.target, tokenInAddress) || approval.value !== "0") {
    throw new Error("Circle approval call target or value is invalid");
  }
  const decodedApproval = decodeFunctionData({
    abi: approvalShape.abi,
    data: approval.data,
  });
  if (
    decodedApproval.functionName !== approvalShape.functionName ||
    !sameAddress(
      decodedApproval.args[0],
      options.config.protocol.circleAdapter,
    ) ||
    decodedApproval.args[1] !== amountIn
  ) {
    throw new Error("Circle approval calldata is not exact");
  }
  if (
    !sameAddress(swapCall.target, options.config.protocol.circleAdapter) ||
    swapCall.value !== "0"
  ) {
    throw new Error("Circle swap target or native value is invalid");
  }
  const decodedSwap = decodeFunctionData({
    abi: CIRCLE_ADAPTER_ABI,
    data: swapCall.data,
  });
  if (decodedSwap.functionName !== "execute") {
    throw new Error("Circle swap calldata is not Adapter.execute");
  }
  const [decodedParams, decodedInputs, decodedSignature] = decodedSwap.args;
  const decodedStructured = extractStructuredSwap({
    params: {
      inputAmount: structured.inputAmount,
      tokenInAddress: structured.tokenInAddress,
      executeParams: decodedParams,
      tokenInputs: decodedInputs,
    },
  });
  if (
    JSON.stringify(canonical(decodedStructured)) !==
      JSON.stringify(canonical(structured)) ||
    requireHex(decodedSignature, "Circle adapter signature").toLowerCase() !==
      requireHex(
        swapAction.params?.signature,
        "Circle structured signature",
      ).toLowerCase() ||
    requireHex(
      decodedParams.metadata,
      "Circle adapter metadata",
    ).toLowerCase() !==
      requireHex(
        swapAction.params?.executeParams?.metadata,
        "Circle structured metadata",
      ).toLowerCase() ||
    decodedSignature === "0x"
  ) {
    throw new Error("Circle swap calldata does not match structured plan");
  }

  const estimatedOutput = requirePositiveDecimal(
    options.estimate.estimatedOutput?.amount,
    "Circle estimated output",
    pair.outToken.decimals,
  );
  const stopLimit = requirePositiveDecimal(
    options.estimate.stopLimit?.amount,
    "Circle stop limit",
    pair.outToken.decimals,
  );
  if (
    options.estimate.tokenIn !== pair.inSymbol ||
    options.estimate.tokenOut !== pair.outSymbol ||
    options.estimate.chainIn !== options.config.circleChain ||
    options.estimate.chainOut !== options.config.circleChain ||
    !sameAddress(options.estimate.fromAddress, sender) ||
    !sameAddress(options.estimate.toAddress, sender) ||
    options.estimate.amountInBaseUnits !== amountIn.toString() ||
    options.estimate.estimatedOutput.token !== pair.outSymbol ||
    options.estimate.stopLimit.token !== pair.outSymbol
  ) {
    throw new Error("Circle estimate does not match the captured route");
  }

  const plan = {
    version: 1,
    chainId: options.config.chainId,
    circleChain: options.config.circleChain,
    executionAccount: sender,
    tokenIn: getAddress(tokenInAddress),
    tokenOut: getAddress(tokenOutAddress),
    amountIn: amountIn.toString(),
    approval,
    swapCall,
    circleExecutionId: structured.executionId,
    deadline: structured.deadline,
    instructions: structured.instructions,
    beneficiaries: structured.beneficiaries,
    tokenInputs: structured.tokenInputs,
    minOut: routeOutputs[0].minTokenOut,
    estimatedOutput: estimatedOutput.toString(),
    stopLimit: stopLimit.toString(),
    fees: options.estimate.fees,
    capturedAt: new Date(Number(nowSeconds) * 1_000).toISOString(),
  };
  return Object.freeze({
    ...plan,
    fingerprint: fingerprint(plan),
  });
}

/**
 * @param {{
 *   config: ReturnType<import("./config.mjs").loadChainConfig>,
 *   executionAccount: `0x${string}`,
 *   amountHuman: string,
 *   amountIn: bigint,
 *   kitKey: string,
 *   estimate: Awaited<ReturnType<typeof estimateCircleSwap>>,
 *   baseAdapter?: any,
 *   swapFn?: typeof swap,
 *   context?: any,
 *   nowSeconds?: bigint,
 * }} options
 */
export async function captureCircleSwapPlan(options) {
  if (!options.kitKey?.trim()) {
    throw new Error("Circle capture requires a non-empty kit key");
  }
  const baseAdapter =
    options.baseAdapter ??
    createCircleViemAdapter({
      config: options.config,
      address: options.executionAccount,
    });
  const actions = [];
  let calls;
  const sentinel = new Error(CIRCLE_CAPTURE_STOP);
  const adapter = new Proxy(baseAdapter, {
    get(target, property, receiver) {
      if (property === "supportsAtomicBatch") return async () => true;
      if (property === "batchExecute") {
        return async (capturedCalls) => {
          calls = capturedCalls;
          throw sentinel;
        };
      }
      if (property === "prepareAction") {
        return async (action, params, context) => {
          actions.push({
            action,
            params,
            address: context.address,
            chainId: context.chain?.chainId,
          });
          return target.prepareAction(action, params, context);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  try {
    await (options.swapFn ?? swap)(
      options.context ?? createSwapKitContext(),
      buildSwapParams(options, adapter),
    );
    throw new Error("Circle capture unexpectedly completed a broadcast");
  } catch (error) {
    if (calls === undefined || actions.length !== 2) {
      throw error;
    }
  }
  return validateCircleSwapPlan({
    config: options.config,
    executionAccount: options.executionAccount,
    amountIn: options.amountIn,
    tokenIn: options.tokenIn,
    tokenOut: options.tokenOut,
    estimate: options.estimate,
    actions,
    calls,
    nowSeconds: options.nowSeconds,
  });
}

/**
 * Poll only the known Circle transaction hash. The caller must never invoke
 * this helper without a persisted hash from a previous broadcast.
 *
 * @param {{
 *   txHash: string,
 *   kitKey: string,
 *   chain?: string,
 *   attempts?: number,
 *   delayMs?: number,
 *   getStatusFn?: typeof getSwapStatus,
 *   sleepFn?: (milliseconds: number) => Promise<void>,
 * }} options
 */
export async function waitForCircleDone(options) {
  if (!/^0x[0-9a-fA-F]{64}$/u.test(options.txHash)) {
    throw new Error("Circle status polling requires a transaction hash");
  }
  if (!options.kitKey?.trim()) {
    throw new Error("Circle status polling requires a kit key");
  }
  const attempts = options.attempts ?? 40;
  const delayMs = options.delayMs ?? 3_000;
  const sleepFn =
    options.sleepFn ??
    ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let status;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    status = await (options.getStatusFn ?? getSwapStatus)({
      txHash: options.txHash,
      chainIn: options.chain ?? "Arc_Testnet",
      chainOut: options.chain ?? "Arc_Testnet",
      kitKey: options.kitKey,
    });
    if (status.progress?.status === "DONE") return status;
    if (
      status.progress?.status === "FAILED" ||
      status.progress?.status === "NOT_FOUND"
    ) {
      throw new Error(
        `Circle swap status is terminal: ${status.progress.status}`,
      );
    }
    if (attempt + 1 < attempts) await sleepFn(delayMs);
  }
  throw new Error(
    `Circle swap status remained ${status?.progress?.status ?? "unknown"} for the bounded polling window`,
  );
}
