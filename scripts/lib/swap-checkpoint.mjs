import { createCheckpointStore } from "./checkpoint.mjs";
import {
  PRIVATE_SWAP_ROUTES,
  validatePrivateSwapCheckpoint,
} from "./swap.mjs";

function nowIso() {
  return new Date().toISOString();
}

function checkpointSafe(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(checkpointSafe);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        checkpointSafe(child),
      ]),
    );
  }
  return value;
}

/**
 * Durable route-specific private-swap state. Sensitive recovery material is
 * stored only in the gitignored checkpoint, never in evidence or logs.
 *
 * @param {{
 *   chainKey: string,
 *   tokenOut: "EURC" | "cirBTC",
 *   target?: URL | string,
 * }} options
 */
export function createPrivateSwapState(options) {
  const route = PRIVATE_SWAP_ROUTES[options.tokenOut];
  if (!route) throw new Error(`unsupported private swap route: ${options.tokenOut}`);
  const store = createCheckpointStore({
    chainKey: options.chainKey,
    flow: route,
    target: options.target,
  });

  function read() {
    const raw = store.read().operations.privateSwap;
    return raw == null
      ? null
      : validatePrivateSwapCheckpoint(raw, options.tokenOut);
  }

  function update(mutate) {
    let validated;
    store.update((checkpoint) => {
      const current = checkpoint.operations.privateSwap;
      if (current == null) {
        throw new Error("private swap checkpoint is not initialized");
      }
      const value = structuredClone(current);
      mutate(value);
      validated = validatePrivateSwapCheckpoint(value, options.tokenOut);
      checkpoint.operations.privateSwap = value;
    });
    return validated;
  }

  function initialize(operation) {
    store.update((checkpoint) => {
      if (checkpoint.operations.privateSwap != null) {
        throw new Error("private swap checkpoint is already initialized");
      }
      const value = {
        version: 1,
        route,
        tokenOut: options.tokenOut,
        operation: {
          ...operation.operation,
          createdAt: operation.operation.createdAt ?? nowIso(),
        },
        beforeBalances: operation.beforeBalances,
        phaseA: null,
        phaseAFailures: [],
        phaseBAttempts: [],
        plan: null,
        quoteFingerprint: null,
        reserveSnapshot: null,
        deterministicOutput: null,
        recoveredAt: null,
        verifiedAt: null,
      };
      validatePrivateSwapCheckpoint(value, options.tokenOut);
      checkpoint.operations.privateSwap = value;
    });
    return read();
  }

  function persistAccepted(phase, accepted, attemptIndex, origin) {
    return update((value) => {
      const record = {
        executionId: accepted.executionId,
        withdrawalTxIds: accepted.withdrawalTxIds ?? [],
        status: accepted.status,
        confirmationStatus: null,
        stage: "accepted",
        accountIndices: accepted.accountIndices,
        accountAddress: accepted.accountAddress,
        handleOpsTxHash: null,
        acceptedAt: nowIso(),
        updatedAt: nowIso(),
        terminalAt: null,
        origin: origin ?? null,
        recovery: null,
      };
      if (phase === "phase_a") {
        if (value.phaseA != null) {
          throw new Error("Phase A execution ID is already persisted");
        }
        value.phaseA = record;
        return;
      }
      if (phase !== "phase_b") throw new Error(`unknown swap phase: ${phase}`);
      const expectedIndex = value.phaseBAttempts.length;
      if (attemptIndex !== expectedIndex) {
        throw new Error("Phase B attempt index must append exactly once");
      }
      value.phaseBAttempts.push(record);
    });
  }

  function persistStatus(phase, status, executionId, session, attemptIndex) {
    return update((value) => {
      const record =
        phase === "phase_a"
          ? value.phaseA
          : value.phaseBAttempts[attemptIndex];
      if (!record || record.executionId !== executionId) {
        throw new Error("execution status does not match persisted ID");
      }
      record.status = status;
      record.confirmationStatus = session?.confirmation_status ?? null;
      record.handleOpsTxHash = session?.handle_ops_tx_hash ?? null;
      record.updatedAt = nowIso();
      if (
        ["completed", "failed", "user_op_reverted", "manual_recovery_required"]
          .includes(status)
      ) {
        record.terminalAt = nowIso();
      }
    });
  }

  function persistRecovery(phase, payload, attemptIndex) {
    return update((value) => {
      const record =
        phase === "phase_a"
          ? value.phaseA
          : value.phaseBAttempts[attemptIndex];
      if (!record || record.executionId !== payload.executionId) {
        throw new Error("recovery payload does not match persisted execution");
      }
      record.recovery = checkpointSafe(payload);
      record.stage = "signed_locally";
      record.updatedAt = nowIso();
    });
  }

  function persistQuote(fields) {
    return update((value) => {
      value.plan = fields.plan ?? null;
      value.quoteFingerprint = fields.quoteFingerprint;
      value.reserveSnapshot = fields.reserveSnapshot ?? null;
      value.deterministicOutput = fields.deterministicOutput ?? null;
    });
  }

  function archiveTerminalPhaseA(executionId) {
    return update((value) => {
      const current = value.phaseA;
      if (!current || current.executionId !== executionId) {
        throw new Error("Phase A archive does not match persisted execution");
      }
      if (
        current.status !== "user_op_reverted" ||
        current.confirmationStatus !== "failed" ||
        current.terminalAt == null
      ) {
        throw new Error("only a terminal reverted Phase A can be archived");
      }
      if (value.phaseBAttempts.length !== 0) {
        throw new Error("Phase A cannot be archived after Phase B started");
      }
      value.phaseAFailures ??= [];
      value.phaseAFailures.push(current);
      value.phaseA = null;
      value.plan = null;
      value.quoteFingerprint = null;
      value.reserveSnapshot = null;
      value.deterministicOutput = null;
    });
  }

  function markVerified() {
    return update((value) => {
      if (value.verifiedAt != null) {
        throw new Error("private swap is already verified");
      }
      value.verifiedAt = nowIso();
    });
  }

  function markRecovered() {
    return update((value) => {
      if (value.recoveredAt != null) {
        throw new Error("private swap recovery is already verified");
      }
      value.recoveredAt = nowIso();
    });
  }

  function callbacks(phase, attemptIndex, origin) {
    return {
      onAccepted: (accepted) =>
        persistAccepted(phase, accepted, attemptIndex, origin),
      onStatus: (status, executionId, session) =>
        persistStatus(phase, status, executionId, session, attemptIndex),
      onRecoveryPayload: (payload) =>
        persistRecovery(phase, payload, attemptIndex),
    };
  }

  return {
    route,
    target: store.target,
    read,
    initialize,
    update,
    persistAccepted,
    persistStatus,
    persistRecovery,
    persistQuote,
    archiveTerminalPhaseA,
    markVerified,
    markRecovered,
    callbacks,
  };
}
