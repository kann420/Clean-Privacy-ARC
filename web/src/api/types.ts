import type { RouteId, TokenSymbol } from "../config/arc";

export type AccountStatus = "none" | "derived" | "registered";
/** Custody is always a connected browser wallet; the app never holds a key. */
export type WalletKind = "injected";
export type SyncStatus = "current" | "syncing" | "unknown";
export type UnitBalances = Record<TokenSymbol, string>;

export type OperationKind =
  | "Deposit"
  | "Private transfer"
  | "Withdrawal"
  | "Unlink-funded swap";
export type OperationStatus =
  | "processed"
  | "re-shielded"
  | "pending"
  | "manual recovery"
  | "failed";

export type Operation = {
  kind: OperationKind;
  token: TokenSymbol;
  amountUnits: string;
  decimals: number;
  id: string;
  status: OperationStatus;
};

export type ActivityBadge = "public" | "private" | "public leg";
export type ActivityEntry = {
  id: string;
  title: string;
  meta: string;
  amount: string;
  tint: string;
  glyph: string;
  badge: ActivityBadge;
};

export type PendingOp = {
  id: string;
  kind: "deposit" | "transfer" | "withdraw" | "swap";
  state: string;
  token: string;
  amountUnits: string;
  error?: string;
};

export type Session = {
  status: AccountStatus;
  wallet: string | null;
  walletKind: WalletKind | null;
  chainOk: boolean;
  unlinkAddress: string | null;
  syncStatus: SyncStatus;
  publicBalances: UnitBalances;
  privateBalances: UnitBalances;
  pendingOperation: PendingOp | null;
  operations: Operation[];
  activity: ActivityEntry[];
};

export type DepositRequest = { token: TokenSymbol; amount: string };
export type TransferRequest = {
  recipient: string;
  token: TokenSymbol;
  amount: string;
};
export type WithdrawRequest = TransferRequest;
export type SwapRequest = { route: RouteId; grossAmount: string };

export type DepositStage = "reading" | "submitting" | "waiting";
export type TransferStage = "proving";
export type WithdrawStage = "withdrawing" | "fee";
export type SwapStage = "phase-a" | "phase-b";

export type Receipt = {
  id: string;
  txHash?: string;
  kind: "deposit" | "transfer" | "withdraw";
  token: TokenSymbol;
  amountUnits: string;
  feeUnits: string;
  decimals: number;
  feeTxId?: string;
  recipient?: string;
};

export type Quote = {
  netUnits: string;
  feeUnits: string;
  estimatedOutUnits: string;
  minOutUnits?: string;
  indicative: boolean;
};

export type SwapReceipt = {
  phaseAExecutionId: string;
  phaseBExecutionId: string;
  withdrawalTxIds: string[];
  handleOpsTxHash?: string;
  /** On-chain hash of the Phase B adapter swap, when the SDK reported one. */
  phaseBTxHash?: string;
  accountIndex: number;
  accountAddress: string;
  grossUnits: string;
  feeUnits: string;
  netUnits: string;
  outUnits: string;
  outToken: "EURC" | "USDC";
  decimals: number;
  /**
   * Input side of the route. Carried on the receipt rather than re-read from
   * the currently selected route, so flipping the direction after a swap
   * cannot relabel a settled result.
   */
  inToken: "EURC" | "USDC";
  inDecimals: number;
};

export type EvidenceExport = { file: string; records: number };
export type BackendErrorCode =
  | "manual_recovery_required"
  | "pending_exists"
  | "wrong_chain"
  | "locks_unavailable"
  | "backend_unreachable"
  | "wallet_required";

export class BackendError extends Error {
  readonly title: string;
  readonly body: string;
  readonly code?: BackendErrorCode;

  constructor(
    title: string,
    body: string,
    code?: BackendErrorCode,
  ) {
    super(`${title} — ${body}`);
    this.name = "BackendError";
    this.title = title;
    this.body = body;
    this.code = code;
  }
}

/**
 * Trim provider errors to their first meaningful lines: viem appends request
 * bodies, call arguments and doc links that are noise (and would leak call
 * context on other flows). Mirrors the CLI's formatPublicError shape.
 */
const publicErrorBody = (message: string): string => {
  const cut = message.split(
    /\n\s*(?:URL:|Request body:|Raw Call Arguments:|Contract Call:|Docs:|Version:)/u,
    1,
  )[0]!;
  const details = /Details:\s*([^\n]+)/u.exec(message)?.[1];
  const trimmed = cut.trim();
  return details && !trimmed.includes(details)
    ? `${trimmed} (${details.trim()})`
    : trimmed;
};

/**
 * Describe a thrown value that is NOT an `Error`.
 *
 * EIP-1193 wallet extensions reject with plain objects (`{ code, message }`),
 * not `Error` instances, so the whole injected-wallet path used to collapse to
 * a content-free "unexpected error" that named neither the wallet nor the
 * reason — including an ordinary "user rejected the request" (Phase 4 live
 * finding on a real extension deposit). Only short, already user-facing fields
 * are read; `publicErrorBody` still strips request bodies and call arguments.
 */
const describeThrown = (error: unknown): string => {
  if (typeof error === "string" && error.trim()) {
    return publicErrorBody(error);
  }
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const message = [
      record.shortMessage,
      record.message,
      record.reason,
      record.details,
    ].find((value) => typeof value === "string" && value.trim());
    const code =
      typeof record.code === "number" || typeof record.code === "string"
        ? ` (code ${record.code})`
        : "";
    if (typeof message === "string") {
      return `${publicErrorBody(message)}${code}`;
    }
    if (code) {
      return `The wallet rejected or could not complete the request${code}.`;
    }
  }
  return "The backend returned an unexpected error.";
};

export const asBackendError = (error: unknown): BackendError =>
  error instanceof BackendError
    ? error
    : new BackendError(
        "Operation failed",
        error instanceof Error
          ? publicErrorBody(error.message)
          : describeThrown(error),
      );

export interface Backend {
  readonly mode: "demo" | "live";
  getSession(): Promise<Session>;
  connectWallet(kind: WalletKind): Promise<Session>;
  disconnectWallet(): Promise<Session>;
  deriveAccount(): Promise<Session>;
  registerAccount(): Promise<Session>;
  getQuote(route: RouteId, grossAmount: string): Promise<Quote>;
  deposit(
    request: DepositRequest,
    onStage: (stage: DepositStage) => void,
  ): Promise<Receipt>;
  transfer(
    request: TransferRequest,
    onStage: (stage: TransferStage) => void,
  ): Promise<Receipt>;
  withdraw(
    request: WithdrawRequest,
    onStage: (stage: WithdrawStage) => void,
  ): Promise<Receipt>;
  swap(
    request: SwapRequest,
    onStage: (stage: SwapStage) => void,
  ): Promise<SwapReceipt>;
  resumePending(): Promise<void>;
  returnPendingSwapToPool?(): Promise<void>;
  /** Operator exit from `manual_recovery_required`; proves no residue first. */
  archiveStuckOperation?(): Promise<void>;
  requestFaucet(token: TokenSymbol): Promise<void>;
  exportEvidence(): Promise<EvidenceExport>;
  switchChain?(): Promise<Session>;

  setAccountStatus?(status: AccountStatus): Promise<Session>;
  setFailureInjection?(enabled: boolean): void;
  reset?(): Promise<Session>;
}
