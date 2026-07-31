import {
  ExecuteRecoveryError,
  createExecutionAccountClient,
  finalizeExecute,
  fromWireExecutionIntent,
  getExecuteNextAction,
  getExecuteSession,
  hashExecutionIntent,
  pollExecuteStatus,
  prepareExecute,
  prepareExecuteAccountCall,
  reserveExecutionAccount,
  submitExecute,
  submitExecuteAccountCall,
} from "@unlink-xyz/sdk/advanced";
import {
  getAddress,
  keccak256,
  parseAbi,
  sliceHex,
  zeroAddress,
} from "viem";

import { EXECUTION_TERMINAL_STATUSES } from "./swap.mjs";
import { withRpcRetry } from "./wallet.mjs";

const UINT128_MASK = (1n << 128n) - 1n;
const ENTRY_POINT_BALANCE_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
]);

const DEFAULT_SDK = {
  createExecutionAccountClient,
  finalizeExecute,
  fromWireExecutionIntent,
  getExecuteNextAction,
  getExecuteSession,
  hashExecutionIntent,
  pollExecuteStatus,
  prepareExecute,
  prepareExecuteAccountCall,
  reserveExecutionAccount,
  submitExecute,
  submitExecuteAccountCall,
};

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function assertCanonicalEqual(actual, expected, label) {
  if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(expected))) {
    throw new Error(`prepared execution changed ${label}`);
  }
}

function normalizeCalls(values) {
  return values.map(({ target, value, data }) => ({
    target: getAddress(target),
    value: String(value),
    data: data.toLowerCase(),
  }));
}

function normalizeTokenEntries(values) {
  return values.map((value) => ({
    ...value,
    token: getAddress(value.token),
  }));
}

function unpack128(packed) {
  const value = BigInt(packed);
  return { high: value >> 128n, low: value & UINT128_MASK };
}

function requireExecutionEnvironment(environment) {
  const executionConfig = environment.execution_account;
  if (
    !executionConfig?.enabled ||
    !executionConfig.entry_point_address ||
    !executionConfig.factory_address ||
    !executionConfig.account_implementation_address
  ) {
    throw new Error("Unlink ExecutionAccounts are not enabled");
  }
  return executionConfig;
}

function indicesFromReservation(reservation) {
  return {
    tenantIdx: reservation.tenant_index,
    chainIdx: reservation.chain_index,
    accountIdx: reservation.account_index,
  };
}

function deriveExecutionAccount(options, indices, sdk = DEFAULT_SDK) {
  const executionConfig = requireExecutionEnvironment(options.environment);
  return sdk.createExecutionAccountClient({
    account: options.unlink.unlinkAccount,
    chainId: options.environment.chain_id,
    factoryAddress: executionConfig.factory_address,
    accountImplementationAddress:
      executionConfig.account_implementation_address,
    ...indices,
  });
}

function validateIntent(options) {
  const executionConfig = requireExecutionEnvironment(options.environment);
  const intent = options.intent;
  if (
    BigInt(intent.chainId) !== BigInt(options.environment.chain_id) ||
    getAddress(intent.entryPoint) !==
      getAddress(executionConfig.entry_point_address) ||
    getAddress(intent.account) !== getAddress(options.accountAddress)
  ) {
    throw new Error("execution intent does not match Arc account configuration");
  }
  if (
    options.intentHash &&
    options.sdk.hashExecutionIntent(intent) !== options.intentHash
  ) {
    throw new Error("execution intent hash failed local validation");
  }
  if (
    options.executionCallData &&
    keccak256(
      sliceHex(
        /** @type {`0x${string}`} */ (options.executionCallData),
        4,
      ),
    ) !== intent.planHash
  ) {
    throw new Error("execution plan hash failed local validation");
  }
}

function executionResult(session, executionId, withdrawalTxIds = []) {
  return {
    executionId,
    withdrawalTxIds,
    status: session.status,
    handleOpsTxHash: session.handle_ops_tx_hash ?? null,
    execution: session,
  };
}

function recoveryError(metadata, cause) {
  return new ExecuteRecoveryError(metadata, cause);
}

/**
 * EntryPoint v0.7 prefund from packed prepared-intent fields.
 *
 * @param {import("@unlink-xyz/sdk/advanced").ExecutionIntent} intent
 */
export function requiredPrefundFromIntent(intent) {
  const accountGas = unpack128(intent.accountGasLimits);
  const paymasterGas = unpack128(intent.paymasterGasLimits);
  const fees = unpack128(intent.gasFees);
  return (
    accountGas.high +
    accountGas.low +
    BigInt(intent.preVerificationGas) +
    paymasterGas.high +
    paymasterGas.low
  ) * fees.low;
}

export function assertPaymasterPrefund(paymasterBalance, requiredPrefund) {
  if (requiredPrefund <= 0n) {
    throw new Error("prepared execution required prefund is invalid");
  }
  if (paymasterBalance * 2n < requiredPrefund * 3n) {
    throw new Error(
      "paymaster EntryPoint balance is below 1.5x required prefund; no execution submitted",
    );
  }
}

/**
 * Create a submit hook that verifies the prepared intent's paymaster deposit.
 *
 * @param {{publicClient: any, environment: any}} options
 */
export function createPrefundGuard(options) {
  const executionConfig = requireExecutionEnvironment(options.environment);
  return async (prepared) => {
    let paymaster;
    try {
      paymaster = getAddress(prepared?.intent?.paymaster);
      if (paymaster === getAddress(zeroAddress)) throw new Error("zero");
    } catch {
      throw new Error("prepared execution has no paymaster; no submit");
    }
    const deposit = await withRpcRetry(() =>
      options.publicClient.readContract({
        address: getAddress(executionConfig.entry_point_address),
        abi: ENTRY_POINT_BALANCE_ABI,
        functionName: "balanceOf",
        args: [paymaster],
      }),
    );
    assertPaymasterPrefund(
      deposit,
      requiredPrefundFromIntent(prepared.intent),
    );
  };
}

/**
 * Prepare and sign a funded execution, persisting the accepted ID before any
 * withdrawal signature or submit attempt.
 *
 * @param {{
 *   unlink: any,
 *   environment: any,
 *   withdrawFromPool: any[],
 *   calls: any[],
 *   returnToPool?: any[],
 *   onAccepted?: (accepted: any) => void,
 *   onStatus?: (status: string, executionId: string) => void,
 *   onRecoveryPayload?: (payload: any) => void,
 *   sdk?: typeof DEFAULT_SDK,
 * }} options
 */
export async function prepareFundedExecution(options) {
  const sdk = options.sdk ?? DEFAULT_SDK;
  const executionConfig = requireExecutionEnvironment(options.environment);
  const page = await options.unlink.client.executionAccounts.list({
    environment: options.environment.name,
  });
  const hint = page.allocation_hint;
  if (!hint) throw new Error("executionAccounts.list returned no allocation hint");
  const reservation = {
    tenant_index: hint.tenant_index,
    chain_index: hint.chain_index,
    account_index: hint.next_slot_index,
  };
  const indices = indicesFromReservation(reservation);
  const executionAccount = deriveExecutionAccount(options, indices, sdk);
  const accountAddress = getAddress(executionAccount.executionAccountAddress);
  const ownerAddress = getAddress(executionAccount.ownerAddress);
  const rawClient = options.unlink.client.getApiClient();
  let prepared;
  let finalized;
  let withdrawalSignatures = [];
  let intent;
  let executionIntentSignature;
  let withdrawalTxIds = [];
  let recoveryPayload;
  try {
    prepared = await sdk.prepareExecute(rawClient, {
      accountPolicy: "fresh",
      executionAccount: {
        slotIndex: reservation.account_index,
        accountAddress,
        ownerAddress,
        initCode: executionAccount.getCreateAccountInitCode(),
      },
      unlinkAddress: options.unlink.unlinkAddress,
      environment: options.environment.name,
      withdrawFromPool: options.withdrawFromPool,
      calls: options.calls,
      returnToPool: options.returnToPool ?? [],
    });
    withdrawalTxIds = (prepared.withdrawals ?? []).map((item) => item.tx_id);
    options.onAccepted?.({
      kind: "funded",
      executionId: prepared.execution_id,
      withdrawalTxIds,
      status: prepared.status,
      accountIndices: indices,
      accountAddress,
    });
    options.onStatus?.(prepared.status, prepared.execution_id);
    recoveryPayload = {
      kind: "funded",
      executionId: prepared.execution_id,
      withdrawalTxIds,
      pendingWithdrawals: (prepared.withdrawals ?? []).map(
        (withdrawal, index) => ({
          signingRequest: withdrawal.signing_request,
          requested: options.withdrawFromPool[index],
        }),
      ),
      withdrawalSignatures: [],
    };
    options.onRecoveryPayload?.(recoveryPayload);
    if (prepared.execution_intent !== null) {
      throw new Error("funded prepare unexpectedly returned an execution intent");
    }
    if (
      prepared.account.account_index !== reservation.account_index ||
      getAddress(prepared.account.account_address ?? accountAddress) !==
        accountAddress
    ) {
      throw new Error("prepared ExecutionAccount does not match allocation");
    }
    assertCanonicalEqual(
      normalizeTokenEntries(prepared.withdraw_from_pool),
      normalizeTokenEntries(options.withdrawFromPool),
      "withdrawFromPool",
    );
    assertCanonicalEqual(
      normalizeCalls(prepared.user_calls),
      normalizeCalls(options.calls),
      "calls",
    );
    assertCanonicalEqual(
      normalizeTokenEntries(prepared.return_to_pool),
      normalizeTokenEntries(options.returnToPool ?? []),
      "returnToPool",
    );
    await executionAccount.verifyReturnToPool({
      unlinkAddress: options.unlink.unlinkAddress,
      requestedReturnToPool: options.returnToPool ?? [],
      returnToPoolDeposits: prepared.return_to_pool_deposits,
    });

    for (let index = 0; index < (prepared.withdrawals ?? []).length; index += 1) {
      const withdrawal = prepared.withdrawals[index];
      const requested = options.withdrawFromPool[index];
      const signed =
        await options.unlink.unlinkAccount.signVerifiedSigningRequest(
          withdrawal.signing_request,
          {
            operation: "withdraw",
            unlink_address: options.unlink.unlinkAddress,
            environment: options.environment.name,
            chain_id: options.environment.chain_id,
            pool_address: options.environment.pool_address,
            evm_address: accountAddress,
            token: requested.token,
            amount: requested.amount,
            executionAccount: accountAddress,
          },
        );
      withdrawalSignatures.push(signed.signature);
      recoveryPayload = {
        ...recoveryPayload,
        withdrawalSignatures: [...withdrawalSignatures],
      };
      options.onRecoveryPayload?.(recoveryPayload);
    }
    finalized = await sdk.finalizeExecute(rawClient, {
      executionId: prepared.execution_id,
      withdrawalSignatures,
    });
    options.onStatus?.(finalized.status, prepared.execution_id);
    intent = sdk.fromWireExecutionIntent(
      finalized.execution_intent,
      "finalized.execution_intent",
    );
    if (
      finalized.unlink_address !== options.unlink.unlinkAddress ||
      finalized.environment !== options.environment.name ||
      finalized.account_index !== reservation.account_index ||
      getAddress(finalized.account_address) !== accountAddress
    ) {
      throw new Error("finalized execution changed account identity");
    }
    validateIntent({
      environment: options.environment,
      accountAddress,
      intent,
      intentHash: finalized.execution_intent_hash,
      executionCallData: finalized.execution_call_data,
      sdk,
    });
    executionIntentSignature = (
      await executionAccount.signExecutionIntent(intent)
    ).signature;
    options.onRecoveryPayload?.({
      ...recoveryPayload,
      withdrawalSignatures,
      executionIntent: intent,
      executionIntentSignature,
      submitPayload: { executionIntentSignature },
    });
    return {
      kind: "funded",
      executionId: prepared.execution_id,
      withdrawalTxIds,
      accountIndices: indices,
      accountIndex: reservation.account_index,
      accountAddress,
      intent,
      executionIntentSignature,
      rawClient,
    };
  } catch (error) {
    throw recoveryError(
      {
        executionId: prepared?.execution_id ?? "prepare-not-accepted",
        withdrawalTxIds,
        stage: finalized ? "execution_intent_sign" : "execution_finalize",
        lastKnownExecution: finalized,
        accountIndices: indices,
        withdrawalSignatures,
        executionIntent: intent,
        executionIntentSignature,
        submitPayload: executionIntentSignature
          ? { executionIntentSignature }
          : undefined,
      },
      error,
    );
  }
}

/**
 * Prepare an account call on the exact Phase A slot and persist its execution
 * ID before signing or submitting.
 *
 * @param {{
 *   unlink: any,
 *   environment: any,
 *   accountIndex: number,
 *   expectedAccountAddress: `0x${string}`,
 *   calls: any[],
 *   returnToPool?: any[],
 *   onAccepted?: (accepted: any) => void,
 *   onStatus?: (status: string, executionId: string) => void,
 *   onRecoveryPayload?: (payload: any) => void,
 *   sdk?: typeof DEFAULT_SDK,
 * }} options
 */
export async function prepareAccountCallExecution(options) {
  const sdk = options.sdk ?? DEFAULT_SDK;
  const rawClient = options.unlink.client.getApiClient();
  const reservation = await sdk.reserveExecutionAccount(rawClient, {
    unlinkAddress: options.unlink.unlinkAddress,
    environment: options.environment.name,
    allocationPolicy: "by_index",
    accountIndex: options.accountIndex,
  });
  const indices = indicesFromReservation(reservation);
  const executionAccount = deriveExecutionAccount(options, indices, sdk);
  const accountAddress = getAddress(executionAccount.executionAccountAddress);
  const ownerAddress = getAddress(executionAccount.ownerAddress);
  if (
    reservation.account_index !== options.accountIndex ||
    getAddress(reservation.account_address) !== accountAddress ||
    getAddress(options.expectedAccountAddress) !== accountAddress
  ) {
    throw new Error("Phase B account does not match the persisted Phase A slot");
  }
  let prepared;
  let intent;
  let executionIntentSignature;
  try {
    prepared = await sdk.prepareExecuteAccountCall(rawClient, {
      accountId: reservation.account_id,
      unlinkAddress: options.unlink.unlinkAddress,
      environment: options.environment.name,
      accountAddress,
      ownerAddress,
      calls: options.calls,
      returnToPool: options.returnToPool ?? [],
      initCode: executionAccount.getCreateAccountInitCode(),
    });
    options.onAccepted?.({
      kind: "account_call",
      executionId: prepared.execution_id,
      withdrawalTxIds: [],
      status: prepared.status,
      accountIndices: indices,
      accountAddress,
    });
    options.onStatus?.(prepared.status, prepared.execution_id);
    assertCanonicalEqual(
      normalizeCalls(prepared.user_calls),
      normalizeCalls(options.calls),
      "calls",
    );
    assertCanonicalEqual(
      normalizeTokenEntries(prepared.return_to_pool),
      normalizeTokenEntries(options.returnToPool ?? []),
      "returnToPool",
    );
    await executionAccount.verifyReturnToPool({
      unlinkAddress: options.unlink.unlinkAddress,
      requestedReturnToPool: options.returnToPool ?? [],
      returnToPoolDeposits: prepared.return_to_pool_deposits,
    });
    intent = sdk.fromWireExecutionIntent(
      prepared.execution_intent,
      "prepared.execution_intent",
    );
    validateIntent({
      environment: options.environment,
      accountAddress,
      intent,
      intentHash: prepared.execution_intent_hash,
      executionCallData: prepared.execution_call_data,
      sdk,
    });
    executionIntentSignature = (
      await executionAccount.signExecutionIntent(intent)
    ).signature;
    const initCode = executionAccount.getCreateAccountInitCode();
    options.onRecoveryPayload?.({
      kind: "account_call",
      executionId: prepared.execution_id,
      executionIntent: intent,
      executionIntentSignature,
      submitPayload: { executionIntentSignature, initCode },
    });
    return {
      kind: "account_call",
      executionId: prepared.execution_id,
      withdrawalTxIds: [],
      accountIndices: indices,
      accountIndex: reservation.account_index,
      accountAddress,
      intent,
      executionIntentSignature,
      initCode,
      rawClient,
    };
  } catch (error) {
    throw recoveryError(
      {
        executionId: prepared?.execution_id ?? "prepare-not-accepted",
        withdrawalTxIds: [],
        stage: prepared ? "execution_intent_sign" : "execution_prepare",
        accountIndices: indices,
        executionIntent: intent,
        executionIntentSignature,
        submitPayload: executionIntentSignature
          ? {
              executionIntentSignature,
              initCode: executionAccount.getCreateAccountInitCode(),
            }
          : undefined,
      },
      error,
    );
  }
}

function requireBeforeSubmit(options, label) {
  if (typeof options.beforeSubmit !== "function") {
    throw new Error(`${label} requires a beforeSubmit prefund guard`);
  }
}

async function submitAndPoll(options) {
  const sdk = options.sdk ?? DEFAULT_SDK;
  requireBeforeSubmit(options, "execution submit");
  let session;
  try {
    await options.beforeSubmit(options.prepared);
    try {
      session =
        options.prepared.kind === "funded"
          ? await sdk.submitExecute(options.prepared.rawClient, {
              executionId: options.prepared.executionId,
              executionIntentSignature:
                options.prepared.executionIntentSignature,
            })
          : await sdk.submitExecuteAccountCall(options.prepared.rawClient, {
              executionId: options.prepared.executionId,
              executionIntentSignature:
                options.prepared.executionIntentSignature,
              initCode: options.prepared.initCode,
            });
    } catch (submitError) {
      const existing = await sdk
        .getExecuteSession(
          options.prepared.rawClient,
          options.prepared.executionId,
        )
        .catch(() => null);
      if (!existing?.execution_submit_accepted) throw submitError;
      session = existing;
    }
    options.onStatus?.(session.status, options.prepared.executionId, session);
    if (
      session.status !== "completed" ||
      (session.confirmation_status !== "processed" &&
        session.confirmation_status !== "confirmed")
    ) {
      session = await sdk.pollExecuteStatus(
        options.prepared.rawClient,
        options.prepared.executionId,
        {
          waitUntil: "processed",
          onStatus: (status, executionId) =>
            options.onStatus?.(status, executionId),
        },
      );
    }
    return executionResult(
      session,
      options.prepared.executionId,
      options.prepared.withdrawalTxIds,
    );
  } catch (error) {
    throw recoveryError(
      {
        executionId: options.prepared.executionId,
        withdrawalTxIds: options.prepared.withdrawalTxIds,
        stage: session ? "execution_poll" : "execution_submit",
        lastKnownExecution: session,
        accountIndices: options.prepared.accountIndices,
        executionIntent: options.prepared.intent,
        executionIntentSignature:
          options.prepared.executionIntentSignature,
        submitPayload:
          options.prepared.kind === "funded"
            ? {
                executionIntentSignature:
                  options.prepared.executionIntentSignature,
              }
            : {
                executionIntentSignature:
                  options.prepared.executionIntentSignature,
                initCode: options.prepared.initCode,
              },
      },
      error,
    );
  }
}

export async function submitPreparedExecution(options) {
  if (options.prepared.kind !== "funded") {
    throw new Error("submitPreparedExecution requires a funded prepare");
  }
  requireBeforeSubmit(options, "submitPreparedExecution");
  return submitAndPoll(options);
}

export async function submitPreparedAccountCall(options) {
  if (options.prepared.kind !== "account_call") {
    throw new Error("submitPreparedAccountCall requires an account-call prepare");
  }
  requireBeforeSubmit(options, "submitPreparedAccountCall");
  return submitAndPoll(options);
}

/**
 * A known execution ID is authoritative. This helper never prepares a new
 * execution and hard-stops on the SDK's manual-recovery status.
 *
 * @param {{
 *   rawClient: any,
 *   executionId: string,
 *   withdrawalTxIds?: string[],
 *   onStatus?: (status: string, executionId: string) => void,
 *   sdk?: typeof DEFAULT_SDK,
 * }} options
 */
export async function pollExistingExecution(options) {
  const sdk = options.sdk ?? DEFAULT_SDK;
  let session = await sdk.getExecuteSession(
    options.rawClient,
    options.executionId,
  );
  options.onStatus?.(session.status, options.executionId);
  if (session.status === "manual_recovery_required") {
    throw new Error(
      `execution ${options.executionId} requires manual recovery; no resubmit is allowed`,
    );
  }
  if (
    !EXECUTION_TERMINAL_STATUSES.has(session.status) ||
    (session.status === "completed" &&
      session.confirmation_status !== "processed" &&
      session.confirmation_status !== "confirmed")
  ) {
    session = await sdk.pollExecuteStatus(
      options.rawClient,
      options.executionId,
      {
        waitUntil: "processed",
        onStatus: options.onStatus,
      },
    );
  }
  return executionResult(
    session,
    options.executionId,
    options.withdrawalTxIds ?? [],
  );
}

export function assertProcessedExecution(result, label) {
  if (
    result.status !== "completed" ||
    (result.execution.confirmation_status !== "processed" &&
      result.execution.confirmation_status !== "confirmed")
  ) {
    throw new Error(
      `${label} is ${result.status}/${result.execution.confirmation_status ?? "unknown"}, expected completed/processed`,
    );
  }
}

/**
 * Return the next safe local action for a persisted SDK recovery payload.
 * It deliberately never creates a fresh execution.
 *
 * @param {{session: any, recovery?: any, sdk?: typeof DEFAULT_SDK}} options
 */
export function getPersistedExecutionNextAction(options) {
  const sdk = options.sdk ?? DEFAULT_SDK;
  if (options.session.status === "manual_recovery_required") {
    return "hard_stop";
  }
  const action = sdk.getExecuteNextAction(options.session);
  if (action === "finalize_execution") {
    const pendingCount = Array.isArray(
      options.recovery?.pendingWithdrawals,
    )
      ? options.recovery.pendingWithdrawals.length
      : 0;
    if (
      Array.isArray(options.recovery?.withdrawalSignatures) &&
      options.recovery.withdrawalSignatures.length > 0 &&
      (pendingCount === 0 ||
        options.recovery.withdrawalSignatures.length === pendingCount)
    ) {
      return "resume_finalize";
    }
    if (pendingCount > 0) {
      return "resume_sign_withdrawals";
    }
    return "hard_stop";
  }
  if (action === "sign_execution_intent") return "resume_sign_and_submit";
  return "poll_existing";
}

/**
 * Resume an accepted prepare/finalize/sign/submit boundary using only the
 * persisted execution ID and local recovery payload. No prepare endpoint is
 * called, so this function cannot create a duplicate withdrawal or swap.
 *
 * @param {{
 *   unlink: any,
 *   environment: any,
 *   execution: {
 *     executionId: string,
 *     withdrawalTxIds: string[],
 *     accountIndices: {tenantIdx: number, chainIdx: number, accountIdx: number},
 *     accountAddress: string,
 *     recovery?: any,
 *   },
 *   kind: "funded" | "account_call",
 *   beforeSubmit: (prepared: any) => Promise<void>,
 *   onStatus?: (status: string, executionId: string, session?: any) => void,
 *   onRecoveryPayload?: (payload: any) => void,
 *   sdk?: typeof DEFAULT_SDK,
 * }} options
 */
export async function resumePersistedExecution(options) {
  const sdk = options.sdk ?? DEFAULT_SDK;
  requireBeforeSubmit(options, "resumePersistedExecution");
  const rawClient = options.unlink.client.getApiClient();
  let session = await sdk.getExecuteSession(
    rawClient,
    options.execution.executionId,
  );
  options.onStatus?.(
    session.status,
    options.execution.executionId,
    session,
  );
  const next = getPersistedExecutionNextAction({
    session,
    recovery: options.execution.recovery,
    sdk,
  });
  if (next === "hard_stop") {
    throw new Error(
      `execution ${options.execution.executionId} cannot be resumed safely`,
    );
  }
  if (next === "poll_existing") {
    return pollExistingExecution({
      rawClient,
      executionId: options.execution.executionId,
      withdrawalTxIds: options.execution.withdrawalTxIds,
      onStatus: options.onStatus,
      sdk,
    });
  }

  const executionAccount = deriveExecutionAccount(
    options,
    options.execution.accountIndices,
    sdk,
  );
  const accountAddress = getAddress(
    executionAccount.executionAccountAddress,
  );
  if (getAddress(options.execution.accountAddress) !== accountAddress) {
    throw new Error("persisted execution account derivation does not match");
  }
  let withdrawalSignatures =
    options.execution.recovery?.withdrawalSignatures ?? [];
  if (next === "resume_sign_withdrawals") {
    withdrawalSignatures = [];
    for (const pending of options.execution.recovery.pendingWithdrawals) {
      const requested = pending.requested;
      const signed =
        await options.unlink.unlinkAccount.signVerifiedSigningRequest(
          pending.signingRequest,
          {
            operation: "withdraw",
            unlink_address: options.unlink.unlinkAddress,
            environment: options.environment.name,
            chain_id: options.environment.chain_id,
            pool_address: options.environment.pool_address,
            evm_address: accountAddress,
            token: requested.token,
            amount: requested.amount,
            executionAccount: accountAddress,
          },
        );
      withdrawalSignatures.push(signed.signature);
      options.onRecoveryPayload?.({
        ...options.execution.recovery,
        withdrawalSignatures: [...withdrawalSignatures],
      });
    }
  }
  if (next === "resume_finalize" || next === "resume_sign_withdrawals") {
    session = await sdk.finalizeExecute(rawClient, {
      executionId: options.execution.executionId,
      withdrawalSignatures,
    });
    options.onStatus?.(
      session.status,
      options.execution.executionId,
      session,
    );
  }
  const intent = sdk.fromWireExecutionIntent(
    session.execution_intent,
    "recovery.execution_intent",
  );
  validateIntent({
    environment: options.environment,
    accountAddress,
    intent,
    intentHash: session.execution_intent_hash,
    executionCallData: session.execution_call_data,
    sdk,
  });
  const executionIntentSignature = (
    await executionAccount.signExecutionIntent(intent)
  ).signature;
  const initCode =
    options.kind === "account_call"
      ? executionAccount.getCreateAccountInitCode()
      : undefined;
  const recovery = {
    ...(options.execution.recovery ?? {}),
    kind: options.kind,
    executionId: options.execution.executionId,
    executionIntent: intent,
    executionIntentSignature,
    withdrawalSignatures,
    submitPayload:
      options.kind === "funded"
        ? { executionIntentSignature }
        : { executionIntentSignature, initCode },
  };
  options.onRecoveryPayload?.(recovery);
  const prepared = {
    kind: options.kind,
    executionId: options.execution.executionId,
    withdrawalTxIds: options.execution.withdrawalTxIds,
    accountIndices: options.execution.accountIndices,
    accountIndex: options.execution.accountIndices.accountIdx,
    accountAddress,
    intent,
    executionIntentSignature,
    initCode,
    rawClient,
  };
  return submitAndPoll({
    prepared,
    beforeSubmit: options.beforeSubmit,
    onStatus: options.onStatus,
    sdk,
  });
}
