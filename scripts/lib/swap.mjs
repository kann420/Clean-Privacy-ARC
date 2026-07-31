import { getAddress } from "viem";

export const PRIVATE_SWAP_ROUTES = Object.freeze({
  EURC: "private_swap_eurc",
  cirBTC: "private_swap_cirbtc",
});
export const EXECUTION_TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "user_op_reverted",
  "manual_recovery_required",
]);

function requireRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function requireIntegerString(value, label) {
  const text = requireString(value, label);
  if (!/^(?:0|[1-9]\d*)$/u.test(text)) {
    throw new Error(`${label} must be a non-negative integer string`);
  }
  return text;
}

function requireOptionalIntegerString(value, label) {
  return value == null ? null : requireIntegerString(value, label);
}

function requireOptionalTimestamp(value, label) {
  if (value == null) return null;
  const text = requireString(value, label);
  if (!Number.isFinite(Date.parse(text))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return text;
}

function requireAddress(value, label) {
  try {
    return getAddress(value);
  } catch {
    throw new Error(`${label} must be an EVM address`);
  }
}

/**
 * @param {string} left
 * @param {string} right
 */
export function sortPairTokens(left, right) {
  const tokenA = getAddress(left);
  const tokenB = getAddress(right);
  if (tokenA === tokenB) throw new Error("pair tokens must be different");
  return BigInt(tokenA) < BigInt(tokenB)
    ? [tokenA, tokenB]
    : [tokenB, tokenA];
}

/**
 * Canonical Uniswap V2 amount-out formula with the 0.30% fee.
 *
 * @param {bigint} amountIn
 * @param {bigint} reserveIn
 * @param {bigint} reserveOut
 */
export function getUniswapV2AmountOut(amountIn, reserveIn, reserveOut) {
  if (
    typeof amountIn !== "bigint" ||
    typeof reserveIn !== "bigint" ||
    typeof reserveOut !== "bigint" ||
    amountIn <= 0n ||
    reserveIn <= 0n ||
    reserveOut <= 0n
  ) {
    throw new Error("amount and reserves must be positive bigints");
  }
  const amountInWithFee = amountIn * 997n;
  const amountOut =
    (amountInWithFee * reserveOut) /
    (reserveIn * 1_000n + amountInWithFee);
  if (amountOut <= 0n || amountOut >= reserveOut) {
    throw new Error("Uniswap V2 quote is not executable");
  }
  return amountOut;
}

/**
 * Keep a deterministic 3% margin below the current Pair quote.
 *
 * @param {bigint} quote
 */
export function applyMiniDexMargin(quote) {
  if (typeof quote !== "bigint" || quote <= 0n) {
    throw new Error("mini DEX quote must be a positive bigint");
  }
  const exactOut = (quote * 97n) / 100n;
  if (exactOut <= 0n) throw new Error("mini DEX output rounds to zero");
  return exactOut;
}

/**
 * @param {{
 *   reserve0Before: bigint,
 *   reserve1Before: bigint,
 *   reserve0After: bigint,
 *   reserve1After: bigint,
 * }} values
 */
export function assertPairInvariant(values) {
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== "bigint" || value < 0n) {
      throw new Error(`${key} must be a non-negative bigint`);
    }
  }
  if (
    values.reserve0After * values.reserve1After <
    values.reserve0Before * values.reserve1Before
  ) {
    throw new Error("Pair invariant decreased");
  }
}

/**
 * Validate local private-swap state before callers convert any persisted
 * numeric value to BigInt.
 *
 * @param {unknown} input
 * @param {"EURC" | "cirBTC"} expectedTokenOut
 */
export function validatePrivateSwapCheckpoint(input, expectedTokenOut) {
  const value = requireRecord(input, "private swap checkpoint");
  if (value.version !== 1) {
    throw new Error("private swap checkpoint version must be 1");
  }
  if (value.tokenOut !== expectedTokenOut) {
    throw new Error("private swap checkpoint route does not match token-out");
  }
  const operation = requireRecord(value.operation, "swap operation");
  const beforeBalances = requireRecord(
    value.beforeBalances,
    "swap beforeBalances",
  );
  const phaseA = value.phaseA == null
    ? null
    : validateExecutionCheckpoint(value.phaseA, "phaseA");
  const phaseAFailures = value.phaseAFailures ?? [];
  if (!Array.isArray(phaseAFailures)) {
    throw new Error("phaseAFailures must be an array");
  }
  const normalizedPhaseAFailures = phaseAFailures.map((attempt, index) =>
    validateExecutionCheckpoint(attempt, `phaseAFailures[${index}]`),
  );
  const attempts = value.phaseBAttempts;
  if (!Array.isArray(attempts)) {
    throw new Error("phaseBAttempts must be an array");
  }
  const normalizedAttempts = attempts.map((attempt, index) =>
    validateExecutionCheckpoint(attempt, `phaseBAttempts[${index}]`),
  );
  return {
    version: 1,
    route: requireString(value.route, "route"),
    tokenOut: expectedTokenOut,
    operation: {
      chainId:
        Number.isSafeInteger(operation.chainId) && operation.chainId > 0
          ? operation.chainId
          : (() => {
              throw new Error("operation.chainId must be a positive integer");
            })(),
      unlinkAddress: requireString(
        operation.unlinkAddress,
        "operation.unlinkAddress",
      ),
      // `amountIn` is what reaches the venue. `grossIn` is what leaves the
      // private balance, which is larger whenever a protocol fee is charged.
      // Checkpoints written before fees existed carry neither field, so they
      // normalize to a zero fee and an identical gross amount.
      amountIn: requireIntegerString(
        operation.amountIn,
        "operation.amountIn",
      ),
      grossIn: requireIntegerString(
        operation.grossIn ?? operation.amountIn,
        "operation.grossIn",
      ),
      feeAmount: requireIntegerString(
        operation.feeAmount ?? "0",
        "operation.feeAmount",
      ),
      tokenIn: requireAddress(operation.tokenIn, "operation.tokenIn"),
      outputToken: requireAddress(
        operation.outputToken,
        "operation.outputToken",
      ),
      createdAt: requireOptionalTimestamp(
        operation.createdAt,
        "operation.createdAt",
      ),
    },
    beforeBalances: {
      input: requireIntegerString(beforeBalances.input, "beforeBalances.input"),
      output: requireIntegerString(
        beforeBalances.output,
        "beforeBalances.output",
      ),
    },
    phaseA,
    phaseAFailures: normalizedPhaseAFailures,
    phaseBAttempts: normalizedAttempts,
    plan:
      value.plan == null
        ? null
        : requireRecord(value.plan, "plan"),
    quoteFingerprint:
      value.quoteFingerprint == null
        ? null
        : requireString(value.quoteFingerprint, "quoteFingerprint"),
    reserveSnapshot:
      value.reserveSnapshot == null
        ? null
        : {
            reserve0: requireIntegerString(
              requireRecord(value.reserveSnapshot, "reserveSnapshot").reserve0,
              "reserveSnapshot.reserve0",
            ),
            reserve1: requireIntegerString(
              value.reserveSnapshot.reserve1,
              "reserveSnapshot.reserve1",
            ),
            blockNumber: requireIntegerString(
              value.reserveSnapshot.blockNumber,
              "reserveSnapshot.blockNumber",
            ),
          },
    deterministicOutput: requireOptionalIntegerString(
      value.deterministicOutput,
      "deterministicOutput",
    ),
    recoveredAt: requireOptionalTimestamp(value.recoveredAt, "recoveredAt"),
    verifiedAt: requireOptionalTimestamp(value.verifiedAt, "verifiedAt"),
  };
}

/**
 * @param {unknown} input
 * @param {string} label
 */
export function validateExecutionCheckpoint(input, label = "execution") {
  const value = requireRecord(input, label);
  const executionId = requireString(value.executionId, `${label}.executionId`);
  const status = requireString(value.status, `${label}.status`);
  const withdrawalTxIds = value.withdrawalTxIds ?? [];
  if (
    !Array.isArray(withdrawalTxIds) ||
    !withdrawalTxIds.every(
      (item) => typeof item === "string" && item.length > 0,
    )
  ) {
    throw new Error(`${label}.withdrawalTxIds must contain strings`);
  }
  const accountIndices = requireRecord(
    value.accountIndices,
    `${label}.accountIndices`,
  );
  for (const field of ["tenantIdx", "chainIdx", "accountIdx"]) {
    if (
      !Number.isSafeInteger(accountIndices[field]) ||
      accountIndices[field] < 0
    ) {
      throw new Error(`${label}.accountIndices.${field} must be non-negative`);
    }
  }
  return {
    executionId,
    withdrawalTxIds: [...withdrawalTxIds],
    status,
    confirmationStatus:
      value.confirmationStatus == null
        ? null
        : requireString(
            value.confirmationStatus,
            `${label}.confirmationStatus`,
          ),
    stage: requireString(value.stage, `${label}.stage`),
    accountIndices: {
      tenantIdx: accountIndices.tenantIdx,
      chainIdx: accountIndices.chainIdx,
      accountIdx: accountIndices.accountIdx,
    },
    accountAddress: requireAddress(
      value.accountAddress,
      `${label}.accountAddress`,
    ),
    handleOpsTxHash:
      value.handleOpsTxHash == null
        ? null
        : requireString(value.handleOpsTxHash, `${label}.handleOpsTxHash`),
    acceptedAt: requireOptionalTimestamp(
      value.acceptedAt,
      `${label}.acceptedAt`,
    ),
    updatedAt: requireOptionalTimestamp(
      value.updatedAt,
      `${label}.updatedAt`,
    ),
    terminalAt: requireOptionalTimestamp(
      value.terminalAt,
      `${label}.terminalAt`,
    ),
    origin:
      value.origin == null
        ? null
        : requireString(value.origin, `${label}.origin`),
    recovery:
      value.recovery == null
        ? null
        : requireRecord(value.recovery, `${label}.recovery`),
  };
}

/**
 * Resolve a completed checkpoint before any live client is constructed.
 *
 * @param {{verifiedAt?: string | null, recoveredAt?: string | null} | null} saved
 */
export function resolveSwapEntryGate(saved) {
  if (saved?.verifiedAt) return "verified";
  if (saved?.recoveredAt) return "recovered";
  return "proceed";
}

/**
 * Decide the only safe automatic action for an existing execution record.
 *
 * @param {ReturnType<typeof validateExecutionCheckpoint>} execution
 */
export function decideExecutionRecovery(execution) {
  if (execution.status === "manual_recovery_required") {
    return { action: "hard_stop", reason: "manual recovery is required" };
  }
  if (!EXECUTION_TERMINAL_STATUSES.has(execution.status)) {
    return { action: "poll_existing", executionId: execution.executionId };
  }
  if (execution.status === "completed") {
    if (
      execution.confirmationStatus === "processed" ||
      execution.confirmationStatus === "confirmed"
    ) {
      return { action: "verify_postconditions" };
    }
    return { action: "disambiguate_balances_before_retry" };
  }
  if (
    execution.status === "user_op_reverted" ||
    execution.status === "failed"
  ) {
    return { action: "disambiguate_balances_before_retry" };
  }
  return { action: "hard_stop", reason: `terminal status ${execution.status}` };
}
