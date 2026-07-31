import {
  account as unlinkAccounts,
  createUnlinkClient,
  evm,
} from "@unlink-xyz/sdk/browser";
import { buildDeriveSeedMessage } from "@unlink-xyz/sdk/crypto";
import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  stringToHex,
  type Address,
} from "viem";

import {
  ARC_REGISTRY,
  CHAIN,
  FEES,
  ROUTES,
  TOK,
  TOKENS,
  type Route,
  type RouteId,
  type TokenSymbol,
} from "../config/arc";
import {
  feeFromInput,
  feeOnTop,
  parseDecimalUnits,
} from "../lib/fees";
import {
  validateCirclePublicPlan,
  type CirclePublicPlan,
  type ValidatedPlan,
} from "../lib/fingerprint";
import {
  exportBurnerKey,
  injectedAccounts,
  injectedProvider,
  loadOrCreateBurner,
  providerChainOk,
  removeBurner,
  setInjectedProvider,
  switchToArc,
  arcChain,
  arcTransport,
  type BurnerWallet,
  type Eip1193Provider,
} from "../wallet/provider";
import {
  createJournalStore,
  isSettled,
  reconcileIntent,
  withMutationLock,
  type JournalEntry,
} from "./journal";
import {
  ReadinessGate,
  registryFingerprint,
  runReadiness,
} from "./readiness";
import {
  BackendError,
  type Backend,
  type DepositRequest,
  type DepositStage,
  type EvidenceExport,
  type Operation,
  type Quote,
  type Receipt,
  type Session,
  type SwapReceipt,
  type SwapRequest,
  type SwapStage,
  type TransferRequest,
  type TransferStage,
  type UnitBalances,
  type WalletKind,
  type WithdrawRequest,
  type WithdrawStage,
} from "./types";

type UnlinkClientLike = any;
type JournalStore = ReturnType<typeof createJournalStore>;
type EnvironmentInfo = { name: string; chain_id: number };

const ZERO: UnitBalances = { USDC: "0", EURC: "0", cirBTC: "0" };
// Cap in whole input-token units. Kept as a decimal-aware helper so a route
// whose input has different decimals cannot silently inherit a USDC-shaped cap.
const MAX_SWAP_WHOLE = 5n;
const maxSwapNet = (symbol: TokenSymbol): bigint =>
  MAX_SWAP_WHOLE * 10n ** BigInt(TOK(symbol).dec);

function requireRoute(route: RouteId): Route {
  const config = ROUTES[route];
  if (!config) {
    throw new BackendError(
      "Route not available",
      "That swap route is not configured in this build.",
    );
  }
  requireSwappableToken(config.in);
  requireSwappableToken(config.out);
  return config;
}
const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/u, "");

export function buildPrivateTransferLegs(
  recipient: string,
  amount: bigint,
  fee: bigint,
) {
  const transfers = [
    { recipientAddress: recipient, amount: amount.toString() },
  ];
  if (fee > 0n) {
    transfers.push({
      recipientAddress: FEES.collector,
      amount: fee.toString(),
    });
  }
  return transfers;
}

/**
 * Both the approval and the fee transfer must target the INPUT token of the
 * route. Leaving these pinned to USDC would, on the EURC -> USDC direction,
 * approve an asset the ExecutionAccount does not hold and pay the fee from the
 * wrong balance.
 */
export function buildSwapPhaseACalls(
  net: bigint,
  fee: bigint,
  tokenIn: TokenSymbol = "USDC",
) {
  const inputAddress = TOK(tokenIn).address;
  const calls = [
    {
      target: inputAddress,
      value: "0" as const,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [ARC_REGISTRY.protocol.circleAdapter, net],
      }),
      label: "Approve exact Circle venue amount",
    },
  ];
  if (fee > 0n) {
    calls.push({
      target: inputAddress,
      value: "0",
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [FEES.owner, fee],
      }),
      label: "Pay public swap fee",
    });
  }
  return calls;
}

function tokenSymbol(address: string): TokenSymbol | null {
  const token = TOKENS.find(
    (item) => item.address.toLowerCase() === address.toLowerCase(),
  );
  return token?.symbol ?? null;
}

/**
 * Only the SWAP route is token-restricted. The web venue is Circle App Kit,
 * which quotes USDC and EURC in both directions; the USDC/cirBTC route needs the
 * deterministic exact-out math, live reserve reads and snapshots, a stale-reserve
 * policy, pair invariant checks, and its own recovery path, so it stays CLI-only.
 *
 * Deposit, private transfer and withdrawal are token-generic: they already
 * compute in base-unit bigints from each token's configured decimals, so cirBTC
 * needs no extra code and carries no extra risk there.
 */
function requireSwappableToken(symbol: TokenSymbol): void {
  if (symbol === "cirBTC") {
    throw new BackendError(
      "Route not available in the web app",
      "The web swap venue is Circle App Kit (USDC and EURC). The USDC/cirBTC pair route runs from the CLI.",
    );
  }
}

function requirePositiveUnits(value: string, decimals: number): bigint {
  const units = parseDecimalUnits(value, decimals);
  if (units <= 0n) {
    throw new BackendError(
      "Invalid amount",
      "The amount must be greater than zero.",
    );
  }
  return units;
}

function assertProcessed(result: any, label: string): void {
  if (
    result?.status !== "processed" ||
    result?.confirmationStatus !== "processed" ||
    result?.fundsUsable !== true
  ) {
    throw new Error(`${label} did not reach processed and funds-usable state`);
  }
}

/**
 * SDK transaction statuses are exactly
 * ["pending", "relayed", "confirmed", "processed", "failed"], so "failed" is
 * the only terminal failure and everything below "processed" is still in
 * flight. Executions already had this (`isTerminalExecutionFailure`);
 * transactions did not, so a terminally failed leg left
 * `pollTransactionStatus({ until: "processed" })` waiting forever: no error
 * surfaced, and the pending banner blocked every mutation permanently while
 * the Unlink dashboard already showed FAILED (Phase 4 G4 live finding).
 */
export function isTerminalTransactionFailure(status: unknown): boolean {
  return status === "failed";
}

export class TransactionFailedError extends Error {
  readonly txId: string;

  constructor(label: string, txId: string) {
    super(`${label} failed on Unlink`);
    this.name = "TransactionFailedError";
    this.txId = txId;
  }
}

/**
 * Poll to "processed" but abort as soon as the status turns terminal, so a
 * failed leg raises a typed error instead of hanging.
 */
async function pollUntilProcessed(
  client: UnlinkClientLike,
  txId: string,
  label: string,
): Promise<any> {
  const controller = new AbortController();
  let sawFailure = false;
  try {
    const result = await client.pollTransactionStatus(txId, {
      until: "processed",
      signal: controller.signal,
      onStatus: (status: string) => {
        if (isTerminalTransactionFailure(status)) {
          sawFailure = true;
          controller.abort();
        }
      },
    });
    if (isTerminalTransactionFailure(result?.status)) {
      throw new TransactionFailedError(label, txId);
    }
    return result;
  } catch (error) {
    if (sawFailure) throw new TransactionFailedError(label, txId);
    throw error;
  }
}

function assertExecutionCompleted(result: any, label: string): void {
  const status = result?.status ?? result?.execution?.status;
  if (status !== "completed" && status !== "processed") {
    throw new Error(`${label} did not complete`);
  }
}

/** Execution id from either the SDK result shape or its nested session. */
function executionIdOf(result: any): string | undefined {
  return (
    result?.executionId ??
    result?.execution_id ??
    result?.execution?.execution_id ??
    undefined
  );
}

/**
 * Wait out a still-pending execution by re-polling the SAME accepted id.
 *
 * Arc Testnet regularly needs longer than the SDK's own wait to reach a
 * terminal state. Treating that as a failure left completed executions looking
 * stuck: a return-to-pool that had actually swept on-chain still read as
 * `recovery_pending`, because nothing re-read it after the first wait returned.
 *
 * Two invariants are preserved exactly:
 *  - nothing is ever resubmitted; only the accepted id is polled;
 *  - a terminal failure is returned untouched for the caller's own handling,
 *    and pending is never reported as success.
 */
export async function settleExecution(
  client: UnlinkClientLike,
  result: any,
  attempts = 10,
  delayMs = 3_000,
): Promise<any> {
  let current = result;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (isExecutionSuccess(current)) return current;
    if (isTerminalExecutionFailure(executionStatusOf(current))) return current;
    const id = executionIdOf(current);
    if (!id) return current;
    await sleepMs(delayMs);
    try {
      current = await client.pollExecuteStatus(id, { waitUntil: "processed" });
    } catch {
      // A transient poll error must not be read as a verdict on the execution.
      // Keep the last known result and try again within the bounded window.
    }
  }
  return current;
}

/**
 * SDK terminal execution statuses are exactly
 * ["completed", "failed", "user_op_reverted", "manual_recovery_required"].
 * A still-pending status must NEVER be treated as a revert: routing it into a
 * retry would submit a second execution while the first is live (Opus review,
 * mandatory fix 4).
 */
export function executionStatusOf(result: any): string | undefined {
  return result?.status ?? result?.execution?.status;
}

export function isExecutionSuccess(result: any): boolean {
  const status = executionStatusOf(result);
  return status === "completed" || status === "processed";
}

export function isTerminalExecutionFailure(
  status: string | undefined,
): boolean {
  return status === "failed" || status === "user_op_reverted";
}

/**
 * How a resume must classify a polled execution. Exposed so the decision itself
 * is unit-testable without a live SDK: "pending" must never be treated as a
 * revert, because retrying then submits a second execution while the first is
 * still live.
 */
export function classifyExecution(
  result: unknown,
): "success" | "manual" | "retryable-failure" | "pending" {
  if (isExecutionSuccess(result)) return "success";
  const status = executionStatusOf(result);
  if (status === "manual_recovery_required") return "manual";
  if (isTerminalExecutionFailure(status)) return "retryable-failure";
  return "pending";
}

function stillPendingError(label: string): BackendError {
  return new BackendError(
    `${label} is still pending`,
    "The execution has not reached a terminal state. Nothing was resubmitted; resume again shortly.",
    "pending_exists",
  );
}

/**
 * The public Arc RPC rate-limits bursts and reports "request limit reached"
 * as a JSON-RPC error that viem's transport retry does not cover (Phase 1
 * operational finding). Every app-level read goes through one serialized,
 * paced, retrying gate so readiness checks and balance reads cannot burst.
 *
 * Once the limit is tripped the endpoint answers 429 WITHOUT CORS headers, so
 * the browser cannot read the status and reports the opaque
 * `TypeError: Failed to fetch`, which viem rethrows as "HTTP request failed."
 * (Phase 4 G4 live finding). Matching only the readable rate-limit wording
 * therefore missed the browser's own symptom and aborted the whole mutation on
 * the first blocked read, so bare network failures are retried here too.
 * Only reads go through this gate, so a retry can never double-submit.
 */
export const RETRYABLE_RPC_ERROR =
  /request limit|rate limit|too many request|status: 429|failed to fetch|http request failed|fetch failed|network ?error|load failed/iu;
const RPC_PACING_MS = 350;
const RPC_MAX_ATTEMPTS = 5;
const sleepMs = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
let rpcQueue: Promise<unknown> = Promise.resolve();
function pacedRpc<T>(run: () => Promise<T>): Promise<T> {
  const next = rpcQueue.then(async () => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await run();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          attempt >= RPC_MAX_ATTEMPTS - 1 ||
          !RETRYABLE_RPC_ERROR.test(message)
        ) {
          throw error;
        }
        // A tripped limit blocks for seconds, not milliseconds: back off
        // exponentially instead of linearly.
        await sleepMs(1_500 * 2 ** attempt);
      }
    }
  });
  rpcQueue = next.catch(() => undefined).then(() => sleepMs(RPC_PACING_MS));
  return next;
}

async function readJson<T>(path: string, body?: unknown): Promise<T> {
  // Serialize OUTSIDE the network try so an unserializable payload surfaces as
  // its own error instead of masquerading as an unreachable backend.
  const requestBody =
    body === undefined
      ? undefined
      : JSON.stringify(body, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value,
        );
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: requestBody === undefined ? "GET" : "POST",
      headers:
        requestBody === undefined
          ? undefined
          : { "content-type": "application/json" },
      body: requestBody,
    });
  } catch {
    throw new BackendError(
      "Backend unreachable",
      "The live backend did not answer. Start it and retry; the app will not switch to demo.",
      "backend_unreachable",
    );
  }
  const payload = (await response.json().catch(() => ({}))) as {
    error?: { title?: string; body?: string };
  };
  if (!response.ok) {
    throw new BackendError(
      payload.error?.title ?? `Request failed (${response.status})`,
      payload.error?.body ?? "The backend rejected the request.",
    );
  }
  return payload as T;
}

export class UnlinkBrowserBackend implements Backend {
  readonly mode = "live" as const;
  private status: Session["status"] = "none";
  private walletKind: WalletKind | null = null;
  private wallet: Address | null = null;
  private provider: Eip1193Provider | null = null;
  private burner: BurnerWallet | null = null;
  private chainOk = false;
  private client: UnlinkClientLike | null = null;
  private unlinkAddress: string | null = null;
  private environment: EnvironmentInfo | null = null;
  private journal: JournalStore | null = null;
  private healthCheck: Promise<void> | null = null;
  private generation = 0;
  private readonly publicClient = createPublicClient({
    chain: arcChain,
    transport: arcTransport(),
  });
  private readonly readiness = new ReadinessGate(async () => {
    const client = this.requireClient();
    const environment =
      this.environment ??
      ((await client.getEnvironmentInfo()) as EnvironmentInfo);
    this.environment = environment;
    return runReadiness({
      // Route the bytecode sweep through the paced, retrying RPC gate.
      publicClient: {
        getChainId: () => pacedRpc(() => this.publicClient.getChainId()),
        getCode: (input: { address: `0x${string}` }) =>
          pacedRpc(() => this.publicClient.getCode(input)),
      },
      environment,
    });
  });

  constructor() {
    if (!navigator.locks) {
      // The explanatory error is surfaced when the first mutation is attempted.
    }
  }

  private invalidate = (): void => {
    this.generation += 1;
    this.client = null;
    this.unlinkAddress = null;
    this.environment = null;
    this.journal = null;
    this.status = "none";
    this.readiness.invalidate();
  };

  private bindProvider(provider: Eip1193Provider): void {
    const changed = () => {
      this.invalidate();
      void this.refreshInjectedIdentity().finally(() => {
        window.dispatchEvent(new Event("cleanprivacy-session-invalidated"));
      });
    };
    const disconnected = () => {
      this.invalidate();
      this.wallet = null;
      this.chainOk = false;
      window.dispatchEvent(new Event("cleanprivacy-session-invalidated"));
    };
    provider.on?.("accountsChanged", changed);
    provider.on?.("chainChanged", changed);
    provider.on?.("disconnect", disconnected);
  }

  private async refreshInjectedIdentity(): Promise<void> {
    if (!this.provider) return;
    const accounts = await injectedAccounts(this.provider);
    this.wallet = accounts[0] ?? null;
    this.chainOk = Boolean(this.wallet) && (await providerChainOk(this.provider));
  }

  private requireClient(): UnlinkClientLike {
    if (!this.client || !this.unlinkAddress || !this.journal) {
      throw new BackendError(
        "Private account unavailable",
        "Connect a wallet and sign the derivation message first.",
        "wallet_required",
      );
    }
    return this.client;
  }

  private requireRegistered(): UnlinkClientLike {
    const client = this.requireClient();
    if (this.status !== "registered") {
      throw new BackendError(
        "Account is not registered",
        "Register the derived Unlink account before moving funds.",
      );
    }
    if (!this.chainOk) {
      throw new BackendError(
        "Wrong network",
        "Switch the connected wallet to Arc Testnet before signing.",
        "wrong_chain",
      );
    }
    return client;
  }

  private async checkHealth(): Promise<void> {
    const health = await readJson<{
      ok: boolean;
      chainId: number;
      environment: string;
    }>("/api/health");
    if (
      !health.ok ||
      health.chainId !== CHAIN.id ||
      (health.environment !== CHAIN.env &&
        !health.environment.startsWith(`${CHAIN.env}-`))
    ) {
      throw new BackendError(
        "Backend configuration mismatch",
        "The backend is not connected to the configured Arc Testnet environment.",
        "backend_unreachable",
      );
    }
  }

  private health(): Promise<void> {
    this.healthCheck ??= this.checkHealth().catch((error) => {
      this.healthCheck = null;
      throw error;
    });
    return this.healthCheck;
  }

  async connectWallet(kind: WalletKind): Promise<Session> {
    await this.health();
    this.invalidate();
    this.walletKind = kind;
    if (kind === "injected") {
      const provider = injectedProvider();
      this.provider = provider;
      this.burner = null;
      this.bindProvider(provider);
      const accounts = await injectedAccounts(provider, true);
      this.wallet = accounts[0] ?? null;
      this.chainOk = await providerChainOk(provider);
    } else {
      setInjectedProvider(null);
      this.burner = loadOrCreateBurner();
      this.provider = null;
      this.wallet = this.burner.address;
      this.chainOk = true;
    }
    return this.getSession();
  }

  async disconnectWallet(): Promise<Session> {
    this.invalidate();
    setInjectedProvider(null);
    this.walletKind = null;
    this.wallet = null;
    this.provider = null;
    this.burner = null;
    this.chainOk = false;
    return this.getSession();
  }

  async switchChain(): Promise<Session> {
    if (!this.provider) return this.getSession();
    await switchToArc(this.provider);
    await this.refreshInjectedIdentity();
    return this.getSession();
  }

  async deriveAccount(): Promise<Session> {
    if (!this.wallet || !this.walletKind) {
      return this.connectWallet("injected");
    }
    if (!this.chainOk) {
      throw new BackendError(
        "Wrong network",
        "Switch the connected wallet to Arc Testnet before deriving the account.",
        "wrong_chain",
      );
    }
    const generation = this.generation;
    const message = buildDeriveSeedMessage({
      appId: CHAIN.appId,
      chainId: CHAIN.id,
    });
    let signature: string;
    let evmProvider:
      | ReturnType<typeof evm.fromEip1193>
      | ReturnType<typeof evm.fromViem>;
    if (this.walletKind === "injected") {
      const provider = this.provider ?? injectedProvider();
      signature = String(
        await provider.request({
          method: "personal_sign",
          params: [stringToHex(message), this.wallet],
        }),
      );
      evmProvider = evm.fromEip1193({ provider });
    } else {
      const burner = this.burner ?? loadOrCreateBurner();
      signature = await burner.account.signMessage({ message });
      evmProvider = evm.fromViem({
        walletClient: burner.walletClient,
        publicClient: burner.publicClient,
      });
    }
    if (generation !== this.generation) {
      throw new Error("Wallet changed while the derivation signature was pending.");
    }
    const unlinkAccount = await unlinkAccounts.fromEthereumSignature({
      signature,
      appId: CHAIN.appId,
      chainId: CHAIN.id,
    });
    // No register/authorizationToken overrides: the SDK's defaults already
    // POST /api/unlink/register and /api/unlink/authorization-token on this
    // origin (the dev proxy path) using its own wire serialization. A custom
    // JSON.stringify here choked on the payload's BigInt fields and the fetch
    // wrapper misreported that as "backend unreachable".
    this.client = createUnlinkClient({
      environment: CHAIN.env,
      account: unlinkAccount,
      evm: evmProvider,
    });
    const unlinkAddress = String(await this.client.getAddress());
    this.unlinkAddress = unlinkAddress;
    this.journal = createJournalStore({
      chainId: CHAIN.id,
      unlinkAddress,
    });
    this.status = "derived";
    return this.getSession();
  }

  async registerAccount(): Promise<Session> {
    const client = this.requireClient();
    await client.ensureRegistered();
    this.status = "registered";
    return this.getSession();
  }

  private async publicBalances(owner: Address | null): Promise<UnitBalances> {
    if (!owner) return { ...ZERO };
    // pacedRpc serializes these; the map still reads naturally.
    const values = await Promise.all(
      TOKENS.map((token) =>
        pacedRpc(() =>
          this.publicClient.readContract({
            address: token.address,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [owner],
          }),
        ),
      ),
    );
    return Object.fromEntries(
      TOKENS.map((token, index) => [
        token.symbol,
        (values[index] ?? 0n).toString(),
      ]),
    ) as UnitBalances;
  }

  private async privateSnapshot(): Promise<{
    balances: UnitBalances;
    syncStatus: Session["syncStatus"];
  }> {
    if (!this.client || this.status !== "registered") {
      return { balances: { ...ZERO }, syncStatus: "unknown" };
    }
    const result = await this.client.getBalances();
    const balances = { ...ZERO };
    for (const item of result.balances ?? []) {
      const symbol = tokenSymbol(item.token);
      if (symbol) balances[symbol] = String(item.amount);
    }
    return { balances, syncStatus: result.sync_status ?? "unknown" };
  }

  /**
   * `getBalances` may answer `sync_status: "syncing"` with pre-operation
   * amounts for a moment after a pool withdrawal. A single immediate read
   * therefore fails an exact-delta assertion on a perfectly healthy operation —
   * and in the swap path that drove the entry into `manual_recovery_required`
   * while the ExecutionAccount held exactly the right net and allowance
   * (Phase 4 G5 live finding). The CLI already retried its delta checks; the
   * browser did not.
   *
   * Waits for a settled snapshot that satisfies `matches`, then returns the
   * last snapshot read. It never invents a value: if the balance genuinely
   * never converges the caller still sees the real figure and hard-stops.
   */
  /**
   * Capture a STARTING balance, refusing to proceed while the account is still
   * syncing.
   *
   * Every operation records a `before` figure and later asserts an exact delta
   * against it. A freshly registered account answers `getBalances` with
   * `sync_status: "syncing"` and a stale — often zero — amount, so a mutation
   * started in that window bakes a wrong baseline into the journal. The
   * operation then succeeds on-chain but can NEVER verify, and lands in
   * `manual_recovery_required` with the funds perfectly safe but the journal
   * permanently blocking every later mutation (seen live on an extension
   * deposit made straight after registration).
   *
   * Failing closed here is the whole point: refusing to start costs nothing,
   * whereas recording a bad baseline strands the operation.
   */
  private async syncedBalances(): Promise<UnitBalances> {
    let snapshot = await this.privateSnapshot();
    for (
      let attempt = 1;
      attempt < 6 && snapshot.syncStatus !== "current";
      attempt += 1
    ) {
      await sleepMs(1_500);
      snapshot = await this.privateSnapshot();
    }
    if (snapshot.syncStatus !== "current") {
      throw new BackendError(
        "Private balance is still syncing",
        "Your private balance has not finished syncing, so the exact before/after check this operation relies on would be meaningless. Wait a few seconds and try again.",
      );
    }
    return snapshot.balances;
  }

  /**
   * Poll the private snapshot until it both reports `current` and satisfies the
   * predicate. The window was 6 attempts (~7.5s), which is shorter than Arc
   * Testnet's observed settle time: a correct operation could fall out of the
   * window and be judged a mismatch. 20 attempts (~30s) keeps the verification
   * itself unchanged — it only stops giving up early.
   */
  private async settledBalances(
    matches: (balances: UnitBalances) => boolean,
    attempts = 20,
  ): Promise<UnitBalances> {
    let snapshot = await this.privateSnapshot();
    for (let attempt = 1; attempt < attempts; attempt += 1) {
      if (snapshot.syncStatus === "current" && matches(snapshot.balances)) {
        break;
      }
      await sleepMs(1_500);
      snapshot = await this.privateSnapshot();
    }
    return snapshot.balances;
  }

  /**
   * The documented operator exit from `manual_recovery_required`.
   *
   * That state is a deliberate hard stop, but leaving it with no exit meant the
   * only way out was clearing localStorage by hand — which discards the ids a
   * real recovery would need. This archives the entry instead, and only after
   * PROVING on-chain that nothing is stranded: no ExecutionAccount residue and
   * no live allowance. It never submits anything, so it cannot move funds.
   */
  async archiveStuckOperation(): Promise<void> {
    const journal = this.journal;
    if (!journal) throw new Error("No journal is open for this account.");
    const entry = journal.pending(await registryFingerprint());
    if (!entry || entry.state !== "manual_recovery_required") {
      throw new BackendError(
        "Nothing to archive",
        "Only an operation stopped for manual recovery can be archived.",
      );
    }
    if (entry.accountAddress) {
      const account = getAddress(entry.accountAddress);
      // Check the legs of the entry's own route, not a fixed pair: a reverse
      // swap leaves its residue in the opposite tokens.
      const archiveRoute = requireRoute(entry.route ?? "eurc");
      const inSymbol = archiveRoute.in;
      const outSymbol = archiveRoute.out;
      const [inputResidue, outputResidue, allowance] = await Promise.all([
        this.readTokenBalance(TOK(inSymbol).address, account),
        this.readTokenBalance(TOK(outSymbol).address, account),
        this.readAllowance(
          TOK(inSymbol).address,
          account,
          ARC_REGISTRY.protocol.circleAdapter,
        ),
      ]);
      if (inputResidue !== 0n || outputResidue !== 0n || allowance !== 0n) {
        throw new BackendError(
          "Funds are still recoverable",
          `ExecutionAccount ${account} still holds ${inputResidue} ${inSymbol} / ${outputResidue} ${outSymbol} with allowance ${allowance}. Return the funds to the pool before archiving.`,
          "manual_recovery_required",
        );
      }
    }
    journal.transition(entry.id, "failed", {
      error:
        (entry.error ? entry.error + " " : "") +
        "Archived by the operator after proving no ExecutionAccount residue or allowance remained.",
    });
  }

  private operations(entries: JournalEntry[]): Operation[] {
    return entries.map((entry) => {
      const symbol = tokenSymbol(entry.token) ?? "USDC";
      // A swap row shows what came back, which depends on its direction.
      const outSymbol = ROUTES[entry.route ?? "eurc"]?.out ?? "EURC";
      const id =
        entry.phaseBExecutionId ??
        entry.phaseAExecutionId ??
        entry.feeTxId ??
        entry.txId ??
        entry.id;
      return {
        kind:
          entry.kind === "deposit"
            ? "Deposit"
            : entry.kind === "transfer"
              ? "Private transfer"
              : entry.kind === "withdraw"
                ? "Withdrawal"
                : "Unlink-funded swap",
        token: entry.kind === "swap" ? outSymbol : symbol,
        amountUnits:
          entry.kind === "swap"
            ? entry.beforeBalances.outAfter
              ? (
                  BigInt(entry.beforeBalances.outAfter) -
                  BigInt(entry.beforeBalances.out ?? "0")
                ).toString()
              : "0"
            : entry.amountUnits,
        decimals: TOK(entry.kind === "swap" ? outSymbol : symbol).dec,
        id,
        status:
          entry.state === "verified"
            ? entry.kind === "swap"
              ? "re-shielded"
              : "processed"
            : entry.state === "manual_recovery_required"
              ? "manual recovery"
              : entry.state === "failed"
                ? "failed"
              : "pending",
      };
    });
  }

  async getSession(): Promise<Session> {
    await this.health();
    const [publicBalances, privateState, fingerprint] = await Promise.all([
      this.publicBalances(this.wallet),
      this.privateSnapshot(),
      registryFingerprint(),
    ]);
    const entries = this.journal?.read() ?? [];
    const pending = this.journal?.pending(fingerprint) ?? null;
    return {
      status: this.status,
      wallet: this.wallet,
      walletKind: this.walletKind,
      chainOk: this.chainOk,
      unlinkAddress: this.unlinkAddress,
      syncStatus: privateState.syncStatus,
      publicBalances,
      privateBalances: privateState.balances,
      pendingOperation: pending
        ? {
            id: pending.id,
            kind: pending.kind,
            state: pending.state,
            token: pending.token,
            amountUnits: pending.amountUnits,
            error: pending.error,
          }
        : null,
      operations: this.operations(entries),
      activity: [],
    };
  }

  private async prepareMutation(): Promise<{
    client: UnlinkClientLike;
    journal: JournalStore;
    fingerprint: string;
  }> {
    const client = this.requireRegistered();
    if (!navigator.locks) {
      throw new BackendError(
        "Web Locks unavailable",
        "This browser cannot serialize live mutations across tabs. Live transaction buttons are disabled.",
        "locks_unavailable",
      );
    }
    const readiness = await this.readiness.verify();
    const journal = this.journal!;
    const pending = journal.pending(readiness.registryFingerprint);
    if (pending) {
      throw new BackendError(
        "Pending operation exists",
        "Resume or resolve the saved operation before starting another mutation.",
        pending.state === "manual_recovery_required"
          ? "manual_recovery_required"
          : "pending_exists",
      );
    }
    return {
      client,
      journal,
      fingerprint: readiness.registryFingerprint,
    };
  }

  /**
   * The pre-lock pending check in prepareMutation is advisory; two tabs can
   * both pass it. This is the authoritative re-check, run as the first
   * statement inside every mutation lock (Opus review, mandatory fix 3).
   */
  private assertNoPendingLocked(journal: JournalStore, fingerprint: string): void {
    const pending = journal.pending(fingerprint);
    if (pending) {
      throw new BackendError(
        "Pending operation exists",
        "Another tab started or left an operation; resume or resolve it first.",
        pending.state === "manual_recovery_required"
          ? "manual_recovery_required"
          : "pending_exists",
      );
    }
  }

  private async waitTransaction(client: UnlinkClientLike, handle: any) {
    // Poll by id instead of awaiting the handle: the handle's own wait has no
    // terminal-failure exit, so a failed leg would hang forever rather than
    // raising (Phase 4 G4 live finding).
    return pollUntilProcessed(client, handle.txId, "Transaction");
  }

  async deposit(
    request: DepositRequest,
    onStage: (stage: DepositStage) => void,
  ): Promise<Receipt> {
    const prepared = await this.prepareMutation();
    const token = TOK(request.token);
    const amount = requirePositiveUnits(request.amount, token.dec);
    return withMutationLock(
      navigator.locks,
      CHAIN.id,
      this.unlinkAddress!,
      async () => {
        this.assertNoPendingLocked(prepared.journal, prepared.fingerprint);
        const beforePrivate = (await this.syncedBalances())[request.token];
        const beforePublic = (await this.publicBalances(this.wallet))[request.token];
        const reserve =
          request.token === "USDC"
            ? 10n ** BigInt(TOK("USDC").dec)
            : 0n;
        if (BigInt(beforePublic) < amount + reserve) {
          throw new BackendError(
            "Insufficient public balance",
            "The deposit amount plus the required Arc USDC gas buffer is not available.",
          );
        }
        let entry = prepared.journal.create({
          kind: "deposit",
          token: token.address,
          amountUnits: amount.toString(),
          feeUnits: "0",
          registryFingerprint: prepared.fingerprint,
          beforeBalances: {
            private: beforePrivate,
            public: beforePublic,
          },
        });
        onStage("reading");
        const handle = await prepared.client.depositWithApproval({
          token: token.address,
          amount: amount.toString(),
        });
        entry = prepared.journal.transition(entry.id, "accepted", {
          txId: handle.txId,
        });
        onStage("submitting");
        onStage("waiting");
        const result = await this.waitTransaction(prepared.client, handle);
        assertProcessed(result, "Deposit");
        entry = prepared.journal.transition(entry.id, "processed", {
          txHash: result.txHash,
        });
        const afterPrivate = (
          await this.settledBalances(
            (balances) =>
              BigInt(balances[request.token]) - BigInt(beforePrivate) === amount,
          )
        )[request.token];
        const afterPublic = (await this.publicBalances(this.wallet))[request.token];
        if (BigInt(afterPrivate) - BigInt(beforePrivate) !== amount) {
          throw this.hardStop(entry, "Deposit private balance delta mismatched.");
        }
        const publicDelta = BigInt(beforePublic) - BigInt(afterPublic);
        if (
          (request.token === "USDC" && publicDelta < amount) ||
          (request.token !== "USDC" && publicDelta !== amount)
        ) {
          throw this.hardStop(entry, "Deposit public balance delta mismatched.");
        }
        prepared.journal.transition(entry.id, "verified", {
          verifiedAt: new Date().toISOString(),
        });
        return {
          id: handle.txId,
          txHash: result.txHash,
          kind: "deposit",
          token: request.token,
          amountUnits: amount.toString(),
          feeUnits: "0",
          decimals: token.dec,
        };
      },
    );
  }

  /**
   * Stop the entry for a human, and say why.
   *
   * Hard stopping is not always the first thing that happens to an entry: a
   * recovery attempt on an already-stopped entry can hit another failed
   * postcondition and stop it again. The transition table has no
   * `manual_recovery_required -> manual_recovery_required` edge, and adding one
   * would weaken the table everywhere, so the repeat is absorbed here instead.
   *
   * This matters beyond tidiness. Re-entering the state used to throw
   * "Invalid swap journal transition: manual_recovery_required ->
   * manual_recovery_required", which replaced the real diagnosis with a message
   * about the journal, and left the operator with no way to see what actually
   * failed (live QA, 2026-07-31).
   */
  private hardStop(entry: JournalEntry, message: string): BackendError {
    const journal = this.journal;
    if (journal) {
      const current =
        journal.read().find((item) => item.id === entry.id) ?? entry;
      if (current.state === "manual_recovery_required") {
        journal.save({
          ...current,
          error: message,
          updatedAt: new Date().toISOString(),
        });
      } else {
        journal.transition(entry.id, "manual_recovery_required", {
          error: message,
        });
      }
    }
    return new BackendError(
      "Manual recovery required",
      message,
      "manual_recovery_required",
    );
  }

  /**
   * Submit the withdrawal fee once more after the previous attempt failed
   * terminally. Reachable only when reconciliation found no live broadcast and
   * the private balance still equals the post-withdrawal figure, so nothing
   * moved. Capped at a single replacement so a repeatedly failing fee can never
   * spend in a loop; write-ahead so the new id survives a crash.
   */
  private async submitReplacementFee(
    entry: JournalEntry,
    client: UnlinkClientLike,
    journal: JournalStore,
  ): Promise<JournalEntry> {
    const used = entry.attempts.filter(
      (attempt) => attempt.action === "fee_replacement",
    ).length;
    if (used >= 1) {
      throw this.hardStop(
        entry,
        "The withdrawal fee already used its single replacement; resolve it manually.",
      );
    }
    journal.requireState(entry.id, ["fee_intent"]);
    journal.recordAttempt(entry.id, {
      at: new Date().toISOString(),
      action: "fee_replacement",
      outcome: "previous fee failed terminally and moved no funds",
    });
    const handle = await client.transfer({
      recipientAddress: FEES.collector,
      token: entry.token,
      amount: entry.feeUnits,
    });
    return journal.transition(entry.id, "fee_accepted", {
      feeTxId: handle.txId,
    });
  }

  async transfer(
    request: TransferRequest,
    onStage: (stage: TransferStage) => void,
  ): Promise<Receipt> {
    const prepared = await this.prepareMutation();
    const token = TOK(request.token);
    if (!/^unlink1[02-9ac-hj-np-z]{8,}$/u.test(request.recipient)) {
      throw new BackendError(
        "Invalid recipient",
        "A private transfer requires a lowercase unlink1 bech32m address.",
      );
    }
    const amount = requirePositiveUnits(request.amount, token.dec);
    const split = feeOnTop(amount, FEES.transferBps);
    return withMutationLock(
      navigator.locks,
      CHAIN.id,
      this.unlinkAddress!,
      async () => {
        this.assertNoPendingLocked(prepared.journal, prepared.fingerprint);
        const before = (await this.syncedBalances())[request.token];
        if (BigInt(before) < split.total) {
          throw new BackendError(
            "Insufficient private balance",
            "The private balance cannot cover the amount plus its on-top fee.",
          );
        }
        let entry = prepared.journal.create({
          kind: "transfer",
          token: token.address,
          amountUnits: amount.toString(),
          feeUnits: split.fee.toString(),
          recipient: request.recipient,
          registryFingerprint: prepared.fingerprint,
          beforeBalances: { private: before },
        });
        onStage("proving");
        const transfers = buildPrivateTransferLegs(
          request.recipient,
          amount,
          split.fee,
        );
        const handle = await prepared.client.transfer({
          token: token.address,
          transfers,
        });
        entry = prepared.journal.transition(entry.id, "accepted", {
          txId: handle.txId,
        });
        const result = await this.waitTransaction(prepared.client, handle);
        assertProcessed(result, "Private transfer");
        entry = prepared.journal.transition(entry.id, "processed", {
          txHash: result.txHash,
        });
        const after = (
          await this.settledBalances(
            (balances) =>
              BigInt(before) - BigInt(balances[request.token]) === split.total,
          )
        )[request.token];
        if (BigInt(before) - BigInt(after) !== split.total) {
          throw this.hardStop(entry, "Private transfer sender delta mismatched.");
        }
        prepared.journal.transition(entry.id, "verified", {
          verifiedAt: new Date().toISOString(),
        });
        return {
          id: handle.txId,
          txHash: result.txHash,
          kind: "transfer",
          token: request.token,
          amountUnits: amount.toString(),
          feeUnits: split.fee.toString(),
          decimals: token.dec,
          recipient: request.recipient,
        };
      },
    );
  }

  async withdraw(
    request: WithdrawRequest,
    onStage: (stage: WithdrawStage) => void,
  ): Promise<Receipt> {
    const prepared = await this.prepareMutation();
    const token = TOK(request.token);
    const recipient = getAddress(request.recipient);
    if (/^0x0{40}$/u.test(recipient)) {
      throw new BackendError(
        "Invalid destination",
        "The zero address cannot receive a withdrawal.",
      );
    }
    const amount = requirePositiveUnits(request.amount, token.dec);
    const split = feeOnTop(amount, FEES.transferBps);
    return withMutationLock(
      navigator.locks,
      CHAIN.id,
      this.unlinkAddress!,
      async () => {
        this.assertNoPendingLocked(prepared.journal, prepared.fingerprint);
        const beforePrivate = (await this.syncedBalances())[request.token];
        const beforePublic = await this.readTokenBalance(token.address, recipient);
        if (BigInt(beforePrivate) < split.total) {
          throw new BackendError(
            "Insufficient private balance",
            "The private balance cannot cover the withdrawal plus its fee.",
          );
        }
        let entry = prepared.journal.create({
          kind: "withdraw",
          token: token.address,
          amountUnits: amount.toString(),
          feeUnits: split.fee.toString(),
          recipient,
          registryFingerprint: prepared.fingerprint,
          beforeBalances: {
            private: beforePrivate,
            recipientPublic: beforePublic.toString(),
          },
        });
        onStage("withdrawing");
        const handle = await prepared.client.withdraw({
          recipientEvmAddress: recipient,
          token: token.address,
          amount: amount.toString(),
        });
        entry = prepared.journal.transition(entry.id, "accepted", {
          txId: handle.txId,
        });
        const result = await this.waitTransaction(prepared.client, handle);
        assertProcessed(result, "Withdrawal");
        entry = prepared.journal.transition(entry.id, "processed", {
          txHash: result.txHash,
        });
        const afterWithdrawal = (
          await this.settledBalances(
            (balances) =>
              BigInt(beforePrivate) - BigInt(balances[request.token]) === amount,
          )
        )[request.token];
        const afterPublic = await this.readTokenBalance(token.address, recipient);
        if (
          BigInt(beforePrivate) - BigInt(afterWithdrawal) !== amount ||
          afterPublic - beforePublic !== amount
        ) {
          throw this.hardStop(entry, "Withdrawal balance deltas mismatched.");
        }
        let feeTxId: string | undefined;
        if (split.fee > 0n) {
          entry = prepared.journal.transition(entry.id, "fee_intent");
          onStage("fee");
          const feeHandle = await prepared.client.transfer({
            recipientAddress: FEES.collector,
            token: token.address,
            amount: split.fee.toString(),
          });
          feeTxId = feeHandle.txId;
          entry = prepared.journal.transition(entry.id, "fee_accepted", {
            feeTxId,
          });
          const feeResult = await this.waitTransaction(
            prepared.client,
            feeHandle,
          );
          assertProcessed(feeResult, "Withdrawal fee");
          entry = prepared.journal.transition(entry.id, "fee_processed");
        }
        const afterFee = (
          await this.settledBalances(
            (balances) =>
              BigInt(beforePrivate) - BigInt(balances[request.token]) ===
              split.total,
          )
        )[request.token];
        if (BigInt(beforePrivate) - BigInt(afterFee) !== split.total) {
          throw this.hardStop(entry, "Withdrawal fee delta mismatched.");
        }
        prepared.journal.transition(entry.id, "verified", {
          verifiedAt: new Date().toISOString(),
        });
        return {
          id: handle.txId,
          txHash: result.txHash,
          kind: "withdraw",
          token: request.token,
          amountUnits: amount.toString(),
          feeUnits: split.fee.toString(),
          decimals: token.dec,
          feeTxId,
          recipient,
        };
      },
    );
  }

  async getQuote(
    route: RouteId,
    grossAmount: string,
  ): Promise<Quote> {
    const config = requireRoute(route);
    const gross = requirePositiveUnits(grossAmount, TOK(config.in).dec);
    const split = feeFromInput(gross, FEES.swapBps);
    if (split.net > maxSwapNet(config.in)) {
      throw new BackendError(
        "Swap amount exceeds the cap",
        `The net Circle venue amount may not exceed ${MAX_SWAP_WHOLE} ${config.in}.`,
      );
    }
    const quotePath = this.wallet
      ? `/api/swap/quote?taker=${encodeURIComponent(this.wallet)}`
      : "/api/swap/quote";
    const quote = await readJson<{
      estimatedOutUnits: string;
      indicative: true;
    }>(quotePath, {
      route,
      amountNetUnits: split.net.toString(),
    });
    return {
      netUnits: split.net.toString(),
      feeUnits: split.fee.toString(),
      estimatedOutUnits: quote.estimatedOutUnits,
      indicative: quote.indicative,
    };
  }

  private async readTokenBalance(
    token: Address,
    owner: Address,
  ): Promise<bigint> {
    return pacedRpc(() =>
      this.publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
      }),
    );
  }

  private async readAllowance(
    token: Address,
    owner: Address,
    spender: Address,
  ): Promise<bigint> {
    return pacedRpc(() =>
      this.publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [owner, spender],
      }),
    );
  }

  private phaseACalls(net: bigint, fee: bigint, tokenIn: TokenSymbol) {
    return buildSwapPhaseACalls(net, fee, tokenIn);
  }

  private async capturePlan(
    entry: JournalEntry,
    route: RouteId,
  ): Promise<ValidatedPlan> {
    const config = requireRoute(route);
    const raw = await readJson<CirclePublicPlan>("/api/swap/circle-plan", {
      route,
      executionAccount: entry.accountAddress,
      accountIndex: entry.accountIndex,
      amountNetUnits: entry.netUnits,
    });
    return validateCirclePublicPlan(raw, {
      executionAccount: entry.accountAddress!,
      amountIn: entry.netUnits!,
      tokenIn: TOK(config.in).address,
      tokenOut: TOK(config.out).address,
    });
  }

  async swap(
    request: SwapRequest,
    onStage: (stage: SwapStage) => void,
  ): Promise<SwapReceipt> {
    const config = requireRoute(request.route);
    const tokenIn = config.in;
    const tokenOut = config.out;
    const prepared = await this.prepareMutation();
    const gross = requirePositiveUnits(
      request.grossAmount,
      TOK(tokenIn).dec,
    );
    const split = feeFromInput(gross, FEES.swapBps);
    if (split.net > maxSwapNet(tokenIn)) {
      throw new BackendError(
        "Swap amount exceeds the cap",
        `The net Circle venue amount may not exceed ${MAX_SWAP_WHOLE} ${tokenIn}.`,
      );
    }
    return withMutationLock(
      navigator.locks,
      CHAIN.id,
      this.unlinkAddress!,
      async () => {
        this.assertNoPendingLocked(prepared.journal, prepared.fingerprint);
        const before = await this.syncedBalances();
        if (BigInt(before[tokenIn]) < gross) {
          throw new BackendError(
            "Insufficient private balance",
            `The private ${tokenIn} balance cannot cover the gross swap input.`,
          );
        }
        let entry = prepared.journal.create({
          kind: "swap",
          token: TOK(tokenIn).address,
          amountUnits: gross.toString(),
          grossUnits: gross.toString(),
          netUnits: split.net.toString(),
          feeUnits: split.fee.toString(),
          registryFingerprint: prepared.fingerprint,
          route: request.route,
          beforeBalances: {
            input: before[tokenIn],
            out: before[tokenOut],
          },
        });
        onStage("phase-a");
        let phaseAExecutionId: string | undefined;
        const phaseA = await prepared.client.execute({
          withdrawFromPool: [
            { token: TOK(tokenIn).address, amount: gross.toString() },
          ],
          calls: this.phaseACalls(split.net, split.fee, tokenIn),
          waitUntil: "processed",
          onStatus: (
            _status: string,
            executionId: string,
          ) => {
            if (!phaseAExecutionId) {
              phaseAExecutionId = executionId;
              entry = prepared.journal.transition(
                entry.id,
                "phaseA_accepted",
                { phaseAExecutionId: executionId },
              );
            }
          },
        });
        // Poll the accepted id out to a terminal state before judging it. The
        // settled view is authoritative for status and for any field the first
        // wait may not have carried yet; the original result stays the fallback.
        const settledA = await settleExecution(prepared.client, phaseA);
        assertExecutionCompleted(settledA, "Swap Phase A");
        phaseAExecutionId ??= phaseA.executionId ?? executionIdOf(settledA);
        if (entry.state === "intent") {
          entry = prepared.journal.transition(entry.id, "phaseA_accepted", {
            phaseAExecutionId,
          });
        }
        const accountIndex =
          settledA.execution?.account_index ??
          settledA.account_index ??
          phaseA.execution.account_index;
        const accountAddress = getAddress(
          settledA.execution?.account_address ??
            settledA.account_address ??
            phaseA.execution.account_address,
        );
        entry = prepared.journal.transition(entry.id, "phaseA_processed", {
          phaseAExecutionId,
          accountIndex,
          accountAddress,
          withdrawalTxIds:
            phaseA.withdrawalTxIds ?? settledA.withdrawalTxIds ?? [],
          handleOpsTxHash:
            phaseA.handleOpsTxHash ?? settledA.handleOpsTxHash ?? undefined,
        });
        const phaseAPrivate = (
          await this.settledBalances(
            (balances) =>
              BigInt(before[tokenIn]) - BigInt(balances[tokenIn]) === gross,
          )
        )[tokenIn];
        const eaInput = await this.readTokenBalance(
          TOK(tokenIn).address,
          accountAddress,
        );
        const allowance = await this.readAllowance(
          TOK(tokenIn).address,
          accountAddress,
          ARC_REGISTRY.protocol.circleAdapter,
        );
        if (
          BigInt(before[tokenIn]) - BigInt(phaseAPrivate) !== gross ||
          eaInput !== split.net ||
          allowance !== split.net
        ) {
          throw this.hardStop(entry, "Swap Phase A balance or allowance mismatched.");
        }
        let plan: ValidatedPlan;
        try {
          plan = await this.capturePlan(entry, request.route);
          entry = prepared.journal.transition(entry.id, "plan_captured", {
            plan,
          });
        } catch (error) {
          prepared.journal.transition(entry.id, "recovery_pending", {
            error:
              error instanceof Error
                ? error.message
                : "Circle plan capture failed.",
          });
          throw new BackendError(
            "Swap needs recovery",
            "Phase A is complete and its fee is not refundable. Retry plan capture with the same ExecutionAccount or return the net funds to the pool.",
            "pending_exists",
          );
        }
        onStage("phase-b");
        let phaseBExecutionId: string | undefined;
        const phaseB = await prepared.client.executeAccountCall({
          accountIndex,
          calls: [{ ...plan.swapCall, label: "Circle adapter swap" }],
          returnToPool: [
            {
              token: TOK(tokenOut).address,
              sweep: true,
              baseline: "0",
              min_total: plan.minOut,
              max_total: plan.maxOut,
            },
          ],
          waitUntil: "processed",
          onStatus: (_status: string, executionId: string) => {
            if (!phaseBExecutionId) {
              phaseBExecutionId = executionId;
              entry = prepared.journal.transition(
                entry.id,
                "phaseB_accepted",
                { phaseBExecutionId: executionId },
              );
            }
          },
        });
        const settledB = await settleExecution(prepared.client, phaseB);
        assertExecutionCompleted(settledB, "Swap Phase B");
        phaseBExecutionId ??= phaseB.executionId ?? executionIdOf(settledB);
        if (entry.state === "plan_captured") {
          entry = prepared.journal.transition(entry.id, "phaseB_accepted", {
            phaseBExecutionId,
          });
        }
        entry = prepared.journal.transition(entry.id, "phaseB_processed");
        const after = await this.settledBalances((balances) => {
          const delta = BigInt(balances[tokenOut]) - BigInt(before[tokenOut]);
          return delta >= BigInt(plan.minOut) && delta <= BigInt(plan.maxOut);
        });
        const outDelta = BigInt(after[tokenOut]) - BigInt(before[tokenOut]);
        // The ExecutionAccount must retain neither leg of the pair and no live
        // allowance, whichever direction the route ran.
        const [eaIn, eaOut, finalAllowance] = await Promise.all([
          this.readTokenBalance(TOK(tokenIn).address, accountAddress),
          this.readTokenBalance(TOK(tokenOut).address, accountAddress),
          this.readAllowance(
            TOK(tokenIn).address,
            accountAddress,
            ARC_REGISTRY.protocol.circleAdapter,
          ),
        ]);
        if (
          outDelta < BigInt(plan.minOut) ||
          outDelta > BigInt(plan.maxOut) ||
          eaIn !== 0n ||
          eaOut !== 0n ||
          finalAllowance !== 0n
        ) {
          throw this.hardStop(entry, "Swap Phase B postconditions mismatched.");
        }
        prepared.journal.transition(entry.id, "verified", {
          verifiedAt: new Date().toISOString(),
          beforeBalances: {
            ...entry.beforeBalances,
            outAfter: after[tokenOut],
          },
        });
        return {
          phaseAExecutionId: phaseAExecutionId!,
          phaseBExecutionId: phaseBExecutionId!,
          withdrawalTxIds: phaseA.withdrawalTxIds ?? [],
          handleOpsTxHash: phaseA.handleOpsTxHash,
          // Phase B carries the adapter swap itself, so that is the hash worth
          // linking to. Phase A is kept as the fallback for a receipt whose
          // Phase B hash the SDK did not report.
          phaseBTxHash:
            phaseB.handleOpsTxHash ?? settledB.handleOpsTxHash ?? undefined,
          accountIndex,
          accountAddress,
          grossUnits: gross.toString(),
          feeUnits: split.fee.toString(),
          netUnits: split.net.toString(),
          outUnits: outDelta.toString(),
          outToken: tokenOut,
          decimals: TOK(tokenOut).dec,
          inToken: tokenIn,
          inDecimals: TOK(tokenIn).dec,
        };
      },
    );
  }

  async resumePending(): Promise<void> {
    const client = this.requireRegistered();
    const journal = this.journal!;
    const fingerprint = await registryFingerprint();
    // Fast read-only peek so a settled journal never touches the lock.
    const peek = journal.pending(fingerprint);
    if (!peek) return;
    if (peek.state === "manual_recovery_required") {
      throw new BackendError(
        "Manual recovery required",
        peek.error ?? "The journal is ambiguous and automatic resubmission is blocked.",
        "manual_recovery_required",
      );
    }
    await withMutationLock(
      navigator.locks,
      CHAIN.id,
      this.unlinkAddress!,
      async () => {
        // Re-read INSIDE the lock: another tab may have finished (or advanced)
        // this entry while we waited (Opus review, mandatory fix 3).
        const entry = journal.pending(fingerprint);
        if (!entry) return;
        if (entry.state === "manual_recovery_required") {
          throw new BackendError(
            "Manual recovery required",
            entry.error ?? "The journal is ambiguous and automatic resubmission is blocked.",
            "manual_recovery_required",
          );
        }
        if (entry.kind === "swap") {
          await this.resumeSwap(entry, client, journal);
          return;
        }
        await this.resumeTransaction(entry, client, journal);
      },
    );
  }

  private async resumeTransaction(
    original: JournalEntry,
    client: UnlinkClientLike,
    journal: JournalStore,
  ): Promise<void> {
    let entry = original;
    const symbol = tokenSymbol(entry.token);
    if (!symbol) throw this.hardStop(entry, "Journal token is not configured.");
    if (entry.state === "intent" && !entry.txId) {
      if (entry.kind === "swap") {
        throw this.hardStop(entry, "Swap intent reconciliation is ambiguous.");
      }
      const result = await client.getTransactions({
        type: entry.kind,
        limit: 100,
      });
      const current = (await this.privateSnapshot()).balances[symbol];
      // A transfer intent without its recipient is unreconcilable: an empty
      // placeholder in the expected set would guarantee zero matches and turn
      // an unchanged balance into a discard while the broadcast may be live
      // (Opus review, mandatory fix 3). Legacy entries may also predate
      // feeUnits; reconcileIntent defends with ?? "0", so mirror that here.
      if (entry.kind === "transfer" && !entry.recipient) {
        throw this.hardStop(
          entry,
          "Transfer intent has no recipient; reconciliation is impossible.",
        );
      }
      const entryFeeUnits = entry.feeUnits ?? "0";
      const recipientAddresses =
        entry.kind === "transfer"
          ? [
              entry.recipient!,
              ...(BigInt(entryFeeUnits) > 0n ? [FEES.collector] : []),
            ]
          : [];
      const reconciliation = reconcileIntent({
        entry,
        transactions: result.transactions ?? [],
        currentBalance: current,
        beforeBalance: entry.beforeBalances.private ?? "0",
        type: entry.kind,
        amountUnits: entry.amountUnits,
        feeUnits: entryFeeUnits,
        recipientAddresses,
      });
      if (reconciliation.decision === "discard") {
        journal.remove(entry.id);
        return;
      }
      if (reconciliation.decision === "manual") {
        throw this.hardStop(entry, "Intent reconciliation is ambiguous.");
      }
      entry = journal.transition(entry.id, "accepted", {
        txId: reconciliation.transaction.id,
        txHash: reconciliation.transaction.tx_hash ?? undefined,
      });
    }
    if (entry.state === "fee_intent" && !entry.feeTxId) {
      const result = await client.getTransactions({
        type: "transfer",
        limit: 100,
      });
      const current = (await this.privateSnapshot()).balances[symbol];
      const reconciliation = reconcileIntent({
        entry,
        transactions: result.transactions ?? [],
        currentBalance: current,
        beforeBalance: (
          BigInt(entry.beforeBalances.private ?? "0") - BigInt(entry.amountUnits)
        ).toString(),
        type: "transfer",
        amountUnits: entry.feeUnits,
        feeUnits: "0",
        recipientAddresses: [FEES.collector],
      });
      if (reconciliation.decision === "manual") {
        throw this.hardStop(
          entry,
          "Withdrawal fee reconciliation is ambiguous; it will not be submitted twice.",
        );
      }
      if (reconciliation.decision === "adopt") {
        entry = journal.transition(entry.id, "fee_accepted", {
          feeTxId: reconciliation.transaction.id,
        });
      } else {
        // "discard": no live fee broadcast exists AND the private balance is
        // exactly the post-withdrawal figure, so the earlier attempt moved
        // nothing. Submitting one replacement is therefore not a double-spend.
        entry = await this.submitReplacementFee(entry, client, journal);
      }
    }
    if (entry.state === "accepted" || entry.state === "fee_accepted") {
      const isFeeLeg = entry.state === "fee_accepted";
      const pollId = isFeeLeg ? entry.feeTxId : entry.txId;
      if (!pollId) throw this.hardStop(entry, "Accepted journal state has no id.");
      let result: any;
      try {
        result = await pollUntilProcessed(
          client,
          pollId,
          isFeeLeg ? "Resumed withdrawal fee" : "Resumed transaction",
        );
      } catch (error) {
        if (!(error instanceof TransactionFailedError)) throw error;
        // Terminal failure moved no funds. Record the dead id, then re-arm the
        // leg so the next pass reconciles and may submit ONE replacement.
        journal.recordAttempt(entry.id, {
          at: new Date().toISOString(),
          action: isFeeLeg ? "fee_failed" : "transaction_failed",
          id: pollId,
          outcome: "terminal failure on Unlink; moved no funds",
        });
        if (!isFeeLeg) {
          throw this.hardStop(
            entry,
            "The withdrawal transaction itself failed on Unlink; restart it from the form.",
          );
        }
        entry = journal.transition(entry.id, "fee_intent", {
          feeTxId: undefined,
          error: `Fee transaction ${pollId} failed on Unlink.`,
        });
        entry = await this.submitReplacementFee(entry, client, journal);
        result = await pollUntilProcessed(
          client,
          entry.feeTxId!,
          "Replacement withdrawal fee",
        );
      }
      assertProcessed(result, "Resumed transaction");
      if (entry.state === "accepted") {
        entry = journal.transition(entry.id, "processed", {
          txHash: result.txHash,
        });
      } else {
        entry = journal.transition(entry.id, "fee_processed");
      }
    }

    if (
      entry.kind === "withdraw" &&
      entry.state === "processed" &&
      BigInt(entry.feeUnits) > 0n
    ) {
      entry = journal.transition(entry.id, "fee_intent");
      entry = journal.requireState(entry.id, ["fee_intent"]);
      const feeHandle = await client.transfer({
        recipientAddress: FEES.collector,
        token: entry.token,
        amount: entry.feeUnits,
      });
      entry = journal.transition(entry.id, "fee_accepted", {
        feeTxId: feeHandle.txId,
      });
      const feeResult = await this.waitTransaction(client, feeHandle);
      assertProcessed(feeResult, "Resumed withdrawal fee");
      entry = journal.transition(entry.id, "fee_processed");
    }

    if (
      entry.state === "processed" ||
      entry.state === "fee_processed"
    ) {
      const before = BigInt(entry.beforeBalances.private ?? "0");
      const expectedDebit =
        entry.kind === "deposit"
          ? -BigInt(entry.amountUnits)
          : BigInt(entry.amountUnits) +
            (entry.kind === "transfer" || entry.state === "fee_processed"
              ? BigInt(entry.feeUnits)
              : 0n);
      // Wait for a settled read here too: a single syncing answer would leave a
      // finished operation stuck at `processed`, blocking every later mutation
      // until the user pressed resume again (seen live on an extension deposit).
      const current = (
        await this.settledBalances(
          (balances) => before - BigInt(balances[symbol]) === expectedDebit,
        )
      )[symbol];
      if (before - BigInt(current) !== expectedDebit) {
        // Name the figures. "delta mismatched" alone told an operator nothing,
        // and the usual cause is a baseline recorded while the account was
        // still syncing — which is only diagnosable if the numbers are shown.
        throw this.hardStop(
          entry,
          `Resumed transaction private balance delta mismatched: recorded before ${before}, now ${current}, expected a change of ${-expectedDebit} base units.`,
        );
      }
      if (entry.kind === "withdraw" && entry.recipient) {
        const currentPublic = await this.readTokenBalance(
          TOK(symbol).address,
          getAddress(entry.recipient),
        );
        if (
          currentPublic -
            BigInt(entry.beforeBalances.recipientPublic ?? "0") !==
          BigInt(entry.amountUnits)
        ) {
          throw this.hardStop(
            entry,
            "Resumed withdrawal public balance delta mismatched.",
          );
        }
      }
      journal.transition(entry.id, "verified", {
        verifiedAt: new Date().toISOString(),
      });
    }
  }

  private async resumeSwap(
    original: JournalEntry,
    client: UnlinkClientLike,
    journal: JournalStore,
  ): Promise<void> {
    let entry = original;
    // Entries written before the reverse route existed carry no `route`; they
    // can only have been USDC -> EURC, so that is the safe default here.
    const route: RouteId = entry.route ?? "eurc";
    const config = requireRoute(route);
    const tokenIn = config.in;
    const tokenOut = config.out;
    if (entry.state === "intent") {
      throw this.hardStop(
        entry,
        "Swap Phase A intent has no accepted execution id; automatic resubmission is blocked.",
      );
    }
    if (entry.state === "phaseA_accepted") {
      const result = await client.pollExecuteStatus(entry.phaseAExecutionId, {
        waitUntil: "processed",
      });
      const accountIndex =
        result.account_index ?? result.execution?.account_index;
      const accountAddress =
        result.account_address ?? result.execution?.account_address;
      if (!isExecutionSuccess(result)) {
        const status = executionStatusOf(result);
        if (status === "manual_recovery_required") {
          throw this.hardStop(entry, "Phase A reported manual recovery.");
        }
        if (!isTerminalExecutionFailure(status)) {
          // Still pending: poll again later, never reclassify as a failure.
          throw stillPendingError("Swap Phase A");
        }
        const privateInput = (await this.privateSnapshot()).balances[tokenIn];
        const accountEmpty = accountAddress
          ? (await this.readTokenBalance(
              TOK(tokenIn).address,
              getAddress(accountAddress),
            )) === 0n
          : true;
        if (
          privateInput === entry.beforeBalances.input &&
          accountEmpty
        ) {
          journal.transition(entry.id, "failed", {
            error: "Phase A failed before any withdrawal effect; funds remain intact.",
          });
          return;
        }
        throw this.hardStop(
          entry,
          "Failed Phase A effects are ambiguous.",
        );
      }
      entry = journal.transition(entry.id, "phaseA_processed", {
        accountIndex,
        accountAddress,
      });
      const privateInput = (await this.privateSnapshot()).balances[tokenIn];
      const eaInput = await this.readTokenBalance(
        TOK(tokenIn).address,
        getAddress(accountAddress),
      );
      const allowance = await this.readAllowance(
        TOK(tokenIn).address,
        getAddress(accountAddress),
        ARC_REGISTRY.protocol.circleAdapter,
      );
      if (
        BigInt(entry.beforeBalances.input ?? "0") -
            BigInt(privateInput) !==
          BigInt(entry.grossUnits ?? "0") ||
        eaInput !== BigInt(entry.netUnits ?? "0") ||
        allowance !== BigInt(entry.netUnits ?? "0")
      ) {
        throw this.hardStop(
          entry,
          "Resumed Phase A postconditions mismatched.",
        );
      }
    }
    if (
      entry.state === "phaseA_processed" ||
      entry.state === "recovery_pending"
    ) {
      try {
        const plan = await this.capturePlan(entry, route);
        entry = journal.transition(entry.id, "plan_captured", { plan });
      } catch (error) {
        if (entry.state !== "recovery_pending") {
          journal.transition(entry.id, "recovery_pending", {
            error: error instanceof Error ? error.message : "Plan capture failed.",
          });
        }
        throw new BackendError(
          "Swap recovery pending",
          "Retry plan capture with the same account, or return funds to the pool.",
          "pending_exists",
        );
      }
    }
    if (entry.state === "plan_captured") {
      if (
        BigInt(entry.plan?.deadline ?? "0") -
          BigInt(Math.floor(Date.now() / 1_000)) <
        480n
      ) {
        entry = journal.transition(entry.id, "recovery_pending", {
          error: "Captured Circle plan expired before Phase B acceptance.",
        });
        const plan = await this.capturePlan(entry, route);
        entry = journal.transition(entry.id, "plan_captured", { plan });
      }
      // Storage is the authority immediately before submission: a second tab
      // may have advanced or settled this entry (Opus review, mandatory fix 3).
      entry = journal.requireState(entry.id, ["plan_captured"]);
      const plan = entry.plan!;
      let executionId: string | undefined;
      const result = await client.executeAccountCall({
        accountIndex: entry.accountIndex,
        calls: [{ ...plan.swapCall, label: "Circle adapter swap" }],
        returnToPool: [
          {
            token: TOK(tokenOut).address,
            sweep: true,
            baseline: "0",
            min_total: plan.minOut,
            max_total: plan.maxOut,
          },
        ],
        waitUntil: "processed",
        onStatus: (_status: string, id: string) => {
          if (!executionId) {
            executionId = id;
            entry = journal.transition(entry.id, "phaseB_accepted", {
              phaseBExecutionId: id,
            });
          }
        },
      });
      assertExecutionCompleted(
        await settleExecution(client, result),
        "Resumed Swap Phase B",
      );
      if (entry.state === "plan_captured") {
        entry = journal.transition(entry.id, "phaseB_accepted", {
          phaseBExecutionId: result.executionId,
        });
      }
      entry = journal.transition(entry.id, "phaseB_processed");
    } else if (entry.state === "phaseB_accepted") {
      const result = await client.pollExecuteStatus(entry.phaseBExecutionId, {
        waitUntil: "processed",
      });
      const status = executionStatusOf(result);
      if (isExecutionSuccess(result)) {
        entry = journal.transition(entry.id, "phaseB_processed");
      } else if (status === "manual_recovery_required") {
        throw this.hardStop(entry, "Phase B reported manual recovery.");
      } else if (isTerminalExecutionFailure(status)) {
        await this.retryRevertedPhaseB(entry, client, journal);
        return;
      } else {
        // Pending is not a revert; retrying now would double-submit a live
        // execution (Opus review, mandatory fix 4).
        throw stillPendingError("Swap Phase B");
      }
    }
    if (entry.state === "phaseB_processed") {
      await this.verifyResumedSwap(entry, journal);
    }
  }

  private async retryRevertedPhaseB(
    original: JournalEntry,
    client: UnlinkClientLike,
    journal: JournalStore,
  ): Promise<void> {
    const route: RouteId = original.route ?? "eurc";
    const config = requireRoute(route);
    const tokenIn = config.in;
    const tokenOut = config.out;
    const retryCount = original.attempts.filter(
      (attempt) => attempt.action === "phaseB_retry",
    ).length;
    const account = getAddress(original.accountAddress!);
    const balances = (await this.privateSnapshot()).balances;
    const [eaInput, eaOutput] = await Promise.all([
      this.readTokenBalance(TOK(tokenIn).address, account),
      this.readTokenBalance(TOK(tokenOut).address, account),
    ]);
    if (
      retryCount >= 1 ||
      eaInput !== BigInt(original.netUnits ?? "0") ||
      eaOutput !== 0n ||
      balances[tokenIn] !==
        (
          BigInt(original.beforeBalances.input ?? "0") -
          BigInt(original.grossUnits ?? "0")
        ).toString() ||
      balances[tokenOut] !== original.beforeBalances.out
    ) {
      throw this.hardStop(
        original,
        "Reverted Phase B balances are ambiguous or the single retry was already used.",
      );
    }
    let entry = journal.transition(original.id, "recovery_pending", {
      attempts: [
        ...original.attempts,
        {
          at: new Date().toISOString(),
          action: "phaseB_retry",
          id: original.phaseBExecutionId,
          outcome: "reverted and disambiguated",
        },
      ],
    });
    const plan = await this.capturePlan(entry, route);
    entry = journal.transition(entry.id, "plan_captured", { plan });
    entry = journal.requireState(entry.id, ["plan_captured"]);
    let retryId: string | undefined;
    const result = await client.executeAccountCall({
      accountIndex: entry.accountIndex,
      calls: [{ ...plan.swapCall, label: "Circle adapter retry" }],
      returnToPool: [
        {
          token: TOK(tokenOut).address,
          sweep: true,
          baseline: "0",
          min_total: plan.minOut,
          max_total: plan.maxOut,
        },
      ],
      waitUntil: "processed",
      onStatus: (_status: string, id: string) => {
        if (!retryId) {
          retryId = id;
          entry = journal.transition(entry.id, "phaseB_accepted", {
            phaseBExecutionId: id,
          });
        }
      },
    });
    try {
      assertExecutionCompleted(
        await settleExecution(client, result),
        "Retried Swap Phase B",
      );
    } catch {
      throw this.hardStop(
        entry,
        "The single disambiguated Phase B retry also failed.",
      );
    }
    if (entry.state === "plan_captured") {
      entry = journal.transition(entry.id, "phaseB_accepted", {
        phaseBExecutionId: result.executionId,
      });
    }
    entry = journal.transition(entry.id, "phaseB_processed");
    await this.verifyResumedSwap(entry, journal);
  }

  private async verifyResumedSwap(
    entry: JournalEntry,
    journal: JournalStore,
  ): Promise<void> {
    const config = requireRoute(entry.route ?? "eurc");
    const tokenIn = config.in;
    const tokenOut = config.out;
    const account = getAddress(entry.accountAddress!);
    const after = await this.settledBalances((balances) => {
      const delta =
        BigInt(balances[tokenOut]) - BigInt(entry.beforeBalances.out ?? "0");
      return (
        !!entry.plan &&
        delta >= BigInt(entry.plan.minOut) &&
        delta <= BigInt(entry.plan.maxOut)
      );
    });
    const outDelta =
      BigInt(after[tokenOut]) - BigInt(entry.beforeBalances.out ?? "0");
    const [eaIn, eaOut, allowance] = await Promise.all([
      this.readTokenBalance(TOK(tokenIn).address, account),
      this.readTokenBalance(TOK(tokenOut).address, account),
      this.readAllowance(
        TOK(tokenIn).address,
        account,
        ARC_REGISTRY.protocol.circleAdapter,
      ),
    ]);
    if (
      !entry.plan ||
      outDelta < BigInt(entry.plan.minOut) ||
      outDelta > BigInt(entry.plan.maxOut) ||
      eaIn !== 0n ||
      eaOut !== 0n ||
      allowance !== 0n
    ) {
      throw this.hardStop(
        entry,
        "Resumed Swap Phase B postconditions mismatched.",
      );
    }
    journal.transition(entry.id, "verified", {
      verifiedAt: new Date().toISOString(),
      beforeBalances: { ...entry.beforeBalances, outAfter: after[tokenOut] },
    });
  }

  async returnPendingSwapToPool(): Promise<void> {
    const client = this.requireRegistered();
    const journal = this.journal!;
    const fingerprint = await registryFingerprint();
    const eligible = (candidate: JournalEntry | null): candidate is JournalEntry =>
      !!candidate &&
      candidate.kind === "swap" &&
      !!candidate.accountAddress &&
      candidate.accountIndex !== undefined &&
      !!candidate.netUnits &&
      [
        "phaseA_processed",
        "plan_captured",
        "recovery_pending",
        // A hard-stopped swap still holds its net in the ExecutionAccount, and
        // sweeping it home is exactly the manual action the state is asking
        // for. Every postcondition below is re-checked on-chain regardless.
        "manual_recovery_required",
      ].includes(candidate.state);
    if (!eligible(journal.pending(fingerprint))) {
      throw new Error("No recoverable post-Phase-A swap is available.");
    }
    await withMutationLock(
      navigator.locks,
      CHAIN.id,
      this.unlinkAddress!,
      async () => {
        // Storage is re-read inside the lock; another tab may have advanced
        // this entry (Opus review, mandatory fixes 2 and 3).
        let entry = journal.pending(fingerprint);
        if (!eligible(entry)) {
          throw new Error("No recoverable post-Phase-A swap is available.");
        }
        const account = getAddress(entry.accountAddress!);
        // Abandoning a swap sweeps the INPUT token back, so the route decides
        // which balance is restored and which allowance is reset.
        const abandonConfig = requireRoute(entry.route ?? "eurc");
        const abandonToken = abandonConfig.in;
        // The return execution ends with the private input balance at exactly
        // before-swap-input minus the non-refundable fee. An absolute target
        // verifies both the fresh path and a crash-resumed path.
        const expectedPrivate = (
          BigInt(entry.beforeBalances.input ?? "0") - BigInt(entry.feeUnits)
        ).toString();

        const prior = [...entry.attempts]
          .reverse()
          .find((attempt) => attempt.action === "return_to_pool" && attempt.id);
        let result: any;
        if (prior?.id) {
          // An accepted return execution already exists: poll it, never
          // submit a second one.
          result = await client.pollExecuteStatus(prior.id, {
            waitUntil: "processed",
          });
          const status = executionStatusOf(result);
          if (!isExecutionSuccess(result)) {
            if (!isTerminalExecutionFailure(status)) {
              throw stillPendingError("Return funds to pool");
            }
            throw this.hardStop(
              entry,
              "A previous return-to-pool execution failed terminally; state is ambiguous.",
            );
          }
        } else {
          // Write-ahead: persist the intent BEFORE the SDK call and the
          // execution id at first acceptance (Opus review, mandatory fix 2).
          if (entry.state !== "recovery_pending") {
            entry = journal.transition(entry.id, "recovery_pending", {
              error: "Return to pool requested by the user.",
            });
          }
          entry = journal.recordAttempt(entry.id, {
            at: new Date().toISOString(),
            action: "return_to_pool_intent",
          });
          const entryId = entry.id;
          let returnId: string | undefined;
          result = await client.executeAccountCall({
            accountIndex: entry.accountIndex,
            calls: [
              {
                target: TOK(abandonToken).address,
                value: "0",
                data: encodeFunctionData({
                  abi: erc20Abi,
                  functionName: "approve",
                  args: [ARC_REGISTRY.protocol.circleAdapter, 0n],
                }),
                label: "Reset Circle allowance",
              },
            ],
            returnToPool: [
              {
                token: TOK(abandonToken).address,
                sweep: true,
                baseline: "0",
                min_total: entry.netUnits,
                max_total: entry.netUnits,
              },
            ],
            waitUntil: "processed",
            onStatus: (_status: string, id: string) => {
              if (!returnId) {
                returnId = id;
                entry = journal.recordAttempt(entryId, {
                  at: new Date().toISOString(),
                  action: "return_to_pool",
                  id,
                });
              }
            },
          });
          if (!returnId && result?.executionId) {
            entry = journal.recordAttempt(entryId, {
              at: new Date().toISOString(),
              action: "return_to_pool",
              id: result.executionId,
            });
          }
          // This is the wait that stranded a completed sweep: the first result
          // was still pending, the throw left the journal in recovery_pending,
          // and the execution finished on-chain moments later with nothing
          // left to read it.
          assertExecutionCompleted(
            await settleExecution(client, result),
            "Return funds to pool",
          );
        }

        const after = (
          await this.settledBalances(
            (balances) => balances[abandonToken] === expectedPrivate,
          )
        )[abandonToken];
        const [residue, outputResidue, allowance] = await Promise.all([
          this.readTokenBalance(TOK(abandonToken).address, account),
          this.readTokenBalance(TOK(abandonConfig.out).address, account),
          this.readAllowance(
            TOK(abandonToken).address,
            account,
            ARC_REGISTRY.protocol.circleAdapter,
          ),
        ]);
        if (
          after !== expectedPrivate ||
          residue !== 0n ||
          outputResidue !== 0n ||
          allowance !== 0n
        ) {
          throw this.hardStop(entry, "Return-to-pool verification mismatched.");
        }
        journal.transition(entry.id, "verified", {
          verifiedAt: new Date().toISOString(),
          error: "Swap abandoned after Phase A; the net input returned to the pool and the fee was not refunded.",
        });
      },
    );
  }

  async requestFaucet(token: TokenSymbol): Promise<void> {
    const prepared = await this.prepareMutation();
    await withMutationLock(
      navigator.locks,
      CHAIN.id,
      this.unlinkAddress!,
      async () => {
        await prepared.client.faucet.requestTestTokens({
          token: TOK(token).address,
          evmAddress: this.wallet,
        });
      },
    );
  }

  async exportEvidence(): Promise<EvidenceExport> {
    const entries = (this.journal?.read() ?? []).map(
      ({ plan, ...entry }) => ({
        ...entry,
        plan: plan
          ? {
              chainId: plan.chainId,
              executionAccount: plan.executionAccount,
              amountIn: plan.amountIn,
              tokenIn: plan.tokenIn,
              tokenOut: plan.tokenOut,
              adapter: plan.adapter,
              minOut: plan.minOut,
              maxOut: plan.maxOut,
              deadline: plan.deadline,
              fingerprint: plan.fingerprint,
            }
          : undefined,
      }),
    );
    const file = `clean-privacy-arc-journal-${Date.now()}.json`;
    const blob = new Blob([JSON.stringify(entries, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file;
    anchor.click();
    URL.revokeObjectURL(url);
    return { file, records: entries.length };
  }

  exportBurnerKey(): string | null {
    return this.walletKind === "burner" ? exportBurnerKey() : null;
  }

  async destroyBurner(confirmation?: string): Promise<Session> {
    if (this.walletKind !== "burner") return this.getSession();
    const privateBalances = (await this.privateSnapshot()).balances;
    const hasFunds = Object.values(privateBalances).some(
      (amount) => BigInt(amount) > 0n,
    );
    const hasUnsettled = (this.journal?.read() ?? []).some(
      (entry) => !isSettled(entry),
    );
    if ((hasFunds || hasUnsettled) && confirmation !== "DESTROY") {
      throw new BackendError(
        "Burner destruction refused",
        "Private funds or an unsettled journal entry remain. Type DESTROY only after exporting the key and accepting irreversible loss.",
      );
    }
    removeBurner();
    return this.disconnectWallet();
  }
}
