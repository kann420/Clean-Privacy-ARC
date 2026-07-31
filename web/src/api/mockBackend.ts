import {
  FEES,
  ROUTES,
  TOK,
  USDC_GAS_BUFFER,
  WALLET,
  type RouteId,
  type TokenSymbol,
} from "../config/arc";
import { DEMO_EXECUTION_ACCOUNT, DEMO_SENDER } from "./demoFixtures";
import {
  feeFromInput,
  feeOnTop,
  formatUnitsString,
  parseDecimalUnits,
} from "../lib/fees";
import {
  BackendError,
  type AccountStatus,
  type ActivityEntry,
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

const ZERO: UnitBalances = { USDC: "0", EURC: "0", cirBTC: "0" };
const SEED_PUBLIC: UnitBalances = {
  USDC: "18996877",
  EURC: "4000000",
  cirBTC: "30000",
};
const SEED_PRIVATE: UnitBalances = {
  USDC: "400000",
  EURC: "577592",
  cirBTC: "5000",
};

const SEED_OPERATIONS: Operation[] = [
  {
    kind: "Deposit",
    token: "USDC",
    amountUnits: "1000000",
    decimals: 6,
    id: "c650fbdc-2252-441a-b6ed-f1e22dc2bba4",
    status: "processed",
  },
  {
    kind: "Deposit",
    token: "EURC",
    amountUnits: "1000000",
    decimals: 6,
    id: "23531314-7e51-4f07-850e-ddad99bd4fba",
    status: "processed",
  },
  {
    kind: "Deposit",
    token: "cirBTC",
    amountUnits: "10000",
    decimals: 8,
    id: "1e564c27-d6d4-4b7d-a369-da9d16814e73",
    status: "processed",
  },
  {
    kind: "Private transfer",
    token: "USDC",
    amountUnits: "500000",
    decimals: 6,
    id: "cc70b7d8-058f-41d1-aaf7-da889affc730",
    status: "processed",
  },
  {
    kind: "Unlink-funded swap",
    token: "EURC",
    amountUnits: "77592",
    decimals: 6,
    id: "609db09e-0d5c-4a1e-9e2f-1c0f2b7a51d7",
    status: "re-shielded",
  },
];

const SEED_ACTIVITY: ActivityEntry[] = [
  {
    id: "a4",
    title: "Swap USDC → EURC",
    meta: "execution 609db09e · re-shielded",
    amount: "+0.077592",
    tint: "var(--lilac)",
    glyph: "⇄",
    badge: "public leg",
  },
  {
    id: "a1",
    title: "Deposit processed",
    meta: "USDC · tx c650fbdc",
    amount: "+1.000000",
    tint: "var(--sand)",
    glyph: "↘",
    badge: "public",
  },
];

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const newId = (): string =>
  crypto.randomUUID?.() ??
  `00000000-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`;

export type MockBackendOptions = {
  status?: AccountStatus;
  delayScale?: number;
};

export class MockBackend implements Backend {
  readonly mode = "demo" as const;
  private status: AccountStatus;
  private wallet: string | null = WALLET;
  private walletKind: WalletKind | null = "injected";
  private readonly delayScale: number;
  private publicBalances: UnitBalances = { ...SEED_PUBLIC };
  private privateBalances: UnitBalances = { ...SEED_PRIVATE };
  private operations: Operation[] = [...SEED_OPERATIONS];
  private activity: ActivityEntry[] = [...SEED_ACTIVITY];
  private failureInjection = false;

  constructor(options: MockBackendOptions = {}) {
    this.status = options.status ?? "none";
    this.delayScale = options.delayScale ?? 1;
  }

  private pause(milliseconds: number): Promise<void> {
    return wait(milliseconds * this.delayScale);
  }

  private snapshot(): Session {
    const registered = this.status === "registered";
    return {
      status: this.status,
      wallet: this.wallet,
      walletKind: this.walletKind,
      chainOk: true,
      unlinkAddress: this.status === "none" ? null : DEMO_SENDER,
      syncStatus: registered ? "current" : "unknown",
      publicBalances: { ...this.publicBalances },
      privateBalances: registered ? { ...this.privateBalances } : { ...ZERO },
      pendingOperation: null,
      operations: registered ? [...this.operations] : [],
      activity: registered ? [...this.activity] : [],
    };
  }

  getSession(): Promise<Session> {
    return Promise.resolve(this.snapshot());
  }

  async connectWallet(kind: WalletKind): Promise<Session> {
    this.walletKind = kind;
    this.wallet = WALLET;
    return this.snapshot();
  }

  async disconnectWallet(): Promise<Session> {
    this.wallet = null;
    this.walletKind = null;
    this.status = "none";
    return this.snapshot();
  }

  async deriveAccount(): Promise<Session> {
    await this.pause(1300);
    if (!this.wallet) this.wallet = WALLET;
    if (!this.walletKind) this.walletKind = "injected";
    if (this.status === "none") this.status = "derived";
    return this.snapshot();
  }

  async registerAccount(): Promise<Session> {
    if (this.status === "none") {
      throw new BackendError(
        "No derived account yet",
        "Sign the derivation message first; there is nothing to register.",
      );
    }
    await this.pause(1500);
    this.status = "registered";
    return this.snapshot();
  }

  private requireRegistered(): void {
    if (this.status !== "registered") {
      throw new BackendError(
        "Account is not registered",
        "Unlink accepts operations only for a registered account.",
      );
    }
  }

  private parsePositive(amount: string, token: TokenSymbol): bigint {
    let units: bigint;
    try {
      units = parseDecimalUnits(amount, TOK(token).dec);
    } catch (error) {
      throw new BackendError(
        "Invalid amount",
        error instanceof Error ? error.message : "The amount is invalid.",
      );
    }
    if (units <= 0n) {
      throw new BackendError(
        "Invalid amount",
        "The amount must be greater than zero.",
      );
    }
    return units;
  }

  private requireBalance(
    available: string,
    requested: bigint,
    kind: "public" | "private",
  ): void {
    if (requested > BigInt(available)) {
      throw new BackendError(
        `Insufficient ${kind} balance`,
        "The requested base-unit amount exceeds the spendable balance.",
      );
    }
  }

  async getQuote(
    routeId: RouteId,
    grossAmount: string,
  ): Promise<Quote> {
    const route = ROUTES[routeId];
    const gross = this.parsePositive(grossAmount, route.in);
    const split = feeFromInput(gross, FEES.swapBps);
    const inScale = 10 ** TOK(route.in).dec;
    const outScale = 10 ** TOK(route.out).dec;
    const netHuman = Number(split.net) / inScale;
    const out = BigInt(Math.round(route.quote(netHuman) * outScale));
    return {
      netUnits: split.net.toString(),
      feeUnits: split.fee.toString(),
      estimatedOutUnits: out.toString(),
      minOutUnits: ((out * 97n) / 100n).toString(),
      indicative: true,
    };
  }

  async deposit(
    request: DepositRequest,
    onStage: (stage: DepositStage) => void,
  ): Promise<Receipt> {
    this.requireRegistered();
    const units = this.parsePositive(request.amount, request.token);
    const reserve =
      request.token === "USDC"
        ? parseDecimalUnits(String(USDC_GAS_BUFFER), TOK("USDC").dec)
        : 0n;
    this.requireBalance(
      (BigInt(this.publicBalances[request.token]) - reserve).toString(),
      units,
      "public",
    );
    onStage("reading");
    await this.pause(350);
    onStage("submitting");
    await this.pause(350);
    const id = newId();
    onStage("waiting");
    await this.pause(500);
    this.publicBalances[request.token] = (
      BigInt(this.publicBalances[request.token]) - units
    ).toString();
    this.privateBalances[request.token] = (
      BigInt(this.privateBalances[request.token]) + units
    ).toString();
    this.operations.unshift({
      kind: "Deposit",
      token: request.token,
      amountUnits: units.toString(),
      decimals: TOK(request.token).dec,
      id,
      status: "processed",
    });
    return {
      id,
      kind: "deposit",
      token: request.token,
      amountUnits: units.toString(),
      feeUnits: "0",
      decimals: TOK(request.token).dec,
    };
  }

  private transferFee(units: bigint): bigint {
    return feeOnTop(units, FEES.transferBps).fee;
  }

  async transfer(
    request: TransferRequest,
    onStage: (stage: TransferStage) => void,
  ): Promise<Receipt> {
    this.requireRegistered();
    if (!/^unlink1[0-9a-z]{8,}$/u.test(request.recipient)) {
      throw new BackendError(
        "Invalid recipient",
        "A private transfer requires an unlink1 address.",
      );
    }
    const units = this.parsePositive(request.amount, request.token);
    const fee = this.transferFee(units);
    this.requireBalance(
      this.privateBalances[request.token],
      units + fee,
      "private",
    );
    onStage("proving");
    await this.pause(900);
    const id = newId();
    this.privateBalances[request.token] = (
      BigInt(this.privateBalances[request.token]) -
      units -
      fee
    ).toString();
    this.operations.unshift({
      kind: "Private transfer",
      token: request.token,
      amountUnits: units.toString(),
      decimals: TOK(request.token).dec,
      id,
      status: "processed",
    });
    this.activity.unshift({
      id,
      title: "Sent privately",
      meta: `${request.token} · tx ${id.slice(0, 8)}`,
      amount: `−${formatUnitsString(units, TOK(request.token).dec)}`,
      tint: "var(--peach)",
      glyph: "↗",
      badge: "private",
    });
    return {
      id,
      kind: "transfer",
      token: request.token,
      amountUnits: units.toString(),
      feeUnits: fee.toString(),
      decimals: TOK(request.token).dec,
      recipient: request.recipient,
    };
  }

  async withdraw(
    request: WithdrawRequest,
    onStage: (stage: WithdrawStage) => void,
  ): Promise<Receipt> {
    this.requireRegistered();
    if (
      !/^0x[0-9a-fA-F]{40}$/u.test(request.recipient) ||
      /^0x0{40}$/u.test(request.recipient)
    ) {
      throw new BackendError(
        "Invalid destination",
        "A withdrawal requires a non-zero 20-byte EVM address.",
      );
    }
    const units = this.parsePositive(request.amount, request.token);
    const fee = this.transferFee(units);
    this.requireBalance(
      this.privateBalances[request.token],
      units + fee,
      "private",
    );
    onStage("withdrawing");
    await this.pause(700);
    const id = newId();
    this.privateBalances[request.token] = (
      BigInt(this.privateBalances[request.token]) - units
    ).toString();
    let feeTxId: string | undefined;
    if (fee > 0n) {
      onStage("fee");
      await this.pause(500);
      feeTxId = newId();
      this.privateBalances[request.token] = (
        BigInt(this.privateBalances[request.token]) - fee
      ).toString();
    }
    this.operations.unshift({
      kind: "Withdrawal",
      token: request.token,
      amountUnits: units.toString(),
      decimals: TOK(request.token).dec,
      id,
      status: "processed",
    });
    return {
      id,
      kind: "withdraw",
      token: request.token,
      amountUnits: units.toString(),
      feeUnits: fee.toString(),
      decimals: TOK(request.token).dec,
      feeTxId,
      recipient: request.recipient,
    };
  }

  async swap(
    request: SwapRequest,
    onStage: (stage: SwapStage) => void,
  ): Promise<SwapReceipt> {
    this.requireRegistered();
    const route = ROUTES[request.route];
    const gross = this.parsePositive(request.grossAmount, route.in);
    this.requireBalance(this.privateBalances[route.in], gross, "private");
    const quote = await this.getQuote(request.route, request.grossAmount);
    onStage("phase-a");
    await this.pause(850);
    if (this.failureInjection) {
      throw new BackendError(
        "Phase A accepted, RPC wait timed out",
        "The persisted execution can be resumed without another signature.",
      );
    }
    const phaseAExecutionId = newId();
    onStage("phase-b");
    await this.pause(850);
    const phaseBExecutionId = newId();
    this.privateBalances[route.in] = (
      BigInt(this.privateBalances[route.in]) - gross
    ).toString();
    this.privateBalances[route.out] = (
      BigInt(this.privateBalances[route.out]) + BigInt(quote.estimatedOutUnits)
    ).toString();
    this.operations.unshift({
      kind: "Unlink-funded swap",
      token: route.out,
      amountUnits: quote.estimatedOutUnits,
      decimals: TOK(route.out).dec,
      id: phaseBExecutionId,
      status: "re-shielded",
    });
    return {
      phaseAExecutionId,
      phaseBExecutionId,
      withdrawalTxIds: [newId()],
      accountIndex: 0,
      accountAddress: DEMO_EXECUTION_ACCOUNT,
      grossUnits: gross.toString(),
      feeUnits: quote.feeUnits,
      netUnits: quote.netUnits,
      outUnits: quote.estimatedOutUnits,
      outToken: route.out,
      decimals: TOK(route.out).dec,
      inToken: route.in,
      inDecimals: TOK(route.in).dec,
    };
  }

  resumePending(): Promise<void> {
    return Promise.resolve();
  }

  async requestFaucet(token: TokenSymbol): Promise<void> {
    const units = 10n * 10n ** BigInt(TOK(token).dec);
    this.publicBalances[token] = (
      BigInt(this.publicBalances[token]) + units
    ).toString();
  }

  async exportEvidence(): Promise<EvidenceExport> {
    await this.pause(400);
    return {
      file: "clean-privacy-arc-demo-journal.json",
      records: this.operations.length,
    };
  }

  setFailureInjection(enabled: boolean): void {
    this.failureInjection = enabled;
  }

  async setAccountStatus(status: AccountStatus): Promise<Session> {
    this.status = status;
    return this.snapshot();
  }

  async reset(): Promise<Session> {
    this.status = "none";
    this.wallet = WALLET;
    this.walletKind = "injected";
    this.publicBalances = { ...SEED_PUBLIC };
    this.privateBalances = { ...SEED_PRIVATE };
    this.operations = [...SEED_OPERATIONS];
    this.activity = [...SEED_ACTIVITY];
    this.failureInjection = false;
    return this.snapshot();
  }
}
