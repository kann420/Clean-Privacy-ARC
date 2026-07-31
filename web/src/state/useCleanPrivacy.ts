import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createBackend } from "../api/backend";
import {
  asBackendError,
  type AccountStatus,
  type Backend,
  type EvidenceExport,
  type Receipt,
  type Session,
  type SwapReceipt,
  type Quote,
  type WalletKind,
} from "../api/types";
import {
  FEES,
  ROUTES,
  TOK,
  USDC_GAS_BUFFER,
  type RouteId,
  type TokenSymbol,
} from "../config/arc";
import { DEMO_RECIPIENT } from "../api/demoFixtures";
import {
  detectRecipient,
  parseAmount,
  sanitizeAmountInput,
  validateRecipient,
  withdrawalWarnings,
} from "../lib/amount";
import {
  feeOnTop,
  fromBaseUnits,
  parseDecimalUnits,
} from "../lib/fees";

export type Screen = "landing" | "account" | "deposit" | "transfer" | "swap" | "evidence";
export type EvidenceMode = "ops" | "privacy";
export type Notice = { title: string; body: string };

export type AppProps = {
  startScreen?: Screen;
  startRoute?: RouteId;
  accountState?: AccountStatus;
  darkMode?: boolean;
  showDemoPanel?: boolean;
  maskPrivateAmounts?: boolean;
};

const EMPTY_SESSION: Session = {
  status: "none",
  wallet: null,
  walletKind: null,
  chainOk: true,
  unlinkAddress: null,
  syncStatus: "unknown",
  publicBalances: { USDC: "0", EURC: "0", cirBTC: "0" },
  privateBalances: { USDC: "0", EURC: "0", cirBTC: "0" },
  pendingOperation: null,
  operations: [],
  activity: [],
};

const GAS_BUFFER_NOTE =
  `A ${USDC_GAS_BUFFER} USDC gas buffer stays behind: on Arc, gas and ERC-20 USDC are the same balance.`;

/**
 * Port of the mock's `class Component extends DCLogic`. State names and transitions are
 * unchanged; the difference is that every operation goes through the backend adapter,
 * balances come back from it, and each amount is validated before anything runs.
 */
export function useCleanPrivacy(props: AppProps) {
  const backendRef = useRef<Backend | null>(null);
  if (!backendRef.current) backendRef.current = createBackend(props.accountState ?? "none");
  const backend = backendRef.current;

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const [session, setSession] = useState<Session>(EMPTY_SESSION);
  const [screen, setScreen] = useState<Screen>(props.startScreen ?? "landing");
  const [dark, setDark] = useState<boolean>(props.darkMode ?? false);
  const [demo, setDemo] = useState<boolean>((props.showDemoPanel ?? true) && backend.mode === "demo");
  const [mask, setMask] = useState<boolean>(props.maskPrivateAmounts ?? false);
  const [signing, setSigning] = useState(false);
  const [accountError, setAccountError] = useState<Notice | null>(null);
  const [readinessVerified, setReadinessVerified] = useState(false);

  const [token, setToken] = useState<TokenSymbol>("USDC");
  const [amount, setAmount] = useState("1.00");
  const [amountError, setAmountError] = useState<string | null>(null);
  const [depositStep, setDepositStep] = useState(0);
  const [depositError, setDepositError] = useState<Notice | null>(null);
  const [depositReceipt, setDepositReceipt] = useState<Receipt | null>(null);
  const [blocked, setBlocked] = useState<Notice | null>(null);

  const [xToken, setXToken] = useState<TokenSymbol>("USDC");
  const [recipient, setRecipient] = useState(DEMO_RECIPIENT);
  const [recipientError, setRecipientError] = useState<string | null>(null);
  const [transferAmount, setTransferAmount] = useState("0.25");
  const [transferAmountError, setTransferAmountError] = useState<string | null>(null);
  const [transferStep, setTransferStep] = useState(0);
  const [transferError, setTransferError] = useState<Notice | null>(null);
  const [transferReceipt, setTransferReceipt] = useState<Receipt | null>(null);

  const [route, setRoute] = useState<RouteId>(props.startRoute ?? "eurc");
  const [swapAmount, setSwapAmount] = useState("0.10");
  const [swapAmountError, setSwapAmountError] = useState<string | null>(null);
  const [swapStep, setSwapStep] = useState(0);
  const [swapError, setSwapError] = useState<Notice | null>(null);
  const [swapReceipt, setSwapReceipt] = useState<SwapReceipt | null>(null);
  const [swapQuote, setSwapQuote] = useState<Quote | null>(null);
  const [swapQuoteFor, setSwapQuoteFor] = useState<string | null>(null);

  /** Amounts deposited in this session, used only for the correlation warning. */
  const [sessionDeposits, setSessionDeposits] = useState<Record<TokenSymbol, number[]>>({
    USDC: [],
    EURC: [],
    cirBTC: [],
  });

  const [mode, setMode] = useState<EvidenceMode>("ops");
  const [exportStep, setExportStep] = useState(0);
  const [exportResult, setExportResult] = useState<EvidenceExport | null>(null);
  const [forceFail, setForceFail] = useState(false);

  const commit = useCallback((next: Session) => {
    if (alive.current) setSession(next);
  }, []);

  useEffect(() => {
    const reload = () => {
      void backend.getSession().then(commit).catch(() => {});
    };
    window.addEventListener("cleanprivacy-session-invalidated", reload);
    // Balances move outside this tab: an incoming transfer, another device, or
    // a faucet. Without a periodic re-read the client-side balance guard blocks
    // a perfectly valid amount using a stale snapshot.
    const timer =
      backend.mode === "live" ? window.setInterval(reload, 20_000) : null;
    const onFocus = () => {
      if (document.visibilityState === "visible") reload();
    };
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("cleanprivacy-session-invalidated", reload);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
      if (timer !== null) window.clearInterval(timer);
    };
  }, [backend, commit]);

  const applyTheme = useCallback((value: boolean) => {
    try {
      document.documentElement.classList.toggle("dark", value);
    } catch {
      /* server-side rendering or a locked-down document */
    }
  }, []);

  // componentDidMount: restore the theme, then read the session.
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("cleanprivacy-arc:theme");
    } catch {
      /* storage disabled */
    }
    const restored = saved ? saved === "dark" : (props.darkMode ?? false);
    setDark(restored);
    applyTheme(restored);
    void backend
      .getSession()
      .then(commit)
      .catch((error: unknown) => {
        const failure = asBackendError(error);
        if (alive.current) {
          setAccountError({ title: failure.title, body: failure.body });
        }
      });
    // Mount-only, exactly like componentDidMount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ready = session.status === "registered";

  // ── Navigation ─────────────────────────────────────────────────────────────

  const go = useCallback(
    (next: Screen) => () => {
      setScreen(next);
      setBlocked(null);
    },
    [],
  );

  const goDisclosure = useCallback(() => {
    setScreen("evidence");
    setMode("privacy");
  }, []);

  const toggleTheme = useCallback(() => {
    const next = !dark;
    setDark(next);
    applyTheme(next);
    try {
      localStorage.setItem("cleanprivacy-arc:theme", next ? "dark" : "light");
    } catch {
      /* storage disabled */
    }
  }, [applyTheme, dark]);

  // ── Account ────────────────────────────────────────────────────────────────

  const derive = useCallback(() => {
    if (!session.wallet) return;
    if (session.status === "registered") {
      setScreen("deposit");
      return;
    }
    setAccountError(null);
    setSigning(true);
    const step = session.status === "none" ? backend.deriveAccount() : backend.registerAccount();
    void step
      .then(commit)
      .catch((error: unknown) => {
        const failure = asBackendError(error);
        if (alive.current) setAccountError({ title: failure.title, body: failure.body });
      })
      .finally(() => {
        if (alive.current) setSigning(false);
      });
  }, [backend, commit, session.status, session.wallet]);

  const connectWallet = useCallback(
    async (kind: WalletKind): Promise<void> => {
      setSigning(true);
      setAccountError(null);
      try {
        const next = await backend.connectWallet(kind);
        commit(next);
        setScreen("account");
      } catch (error: unknown) {
        const failure = asBackendError(error);
        if (alive.current) {
          setAccountError({ title: failure.title, body: failure.body });
        }
      } finally {
        if (alive.current) setSigning(false);
      }
    },
    [backend, commit],
  );

  // ── Deposit ────────────────────────────────────────────────────────────────

  const depositAvailable = useMemo(
    () =>
      Math.max(
        0,
        Number(session.publicBalances[token]) / 10 ** TOK(token).dec -
          (token === "USDC" ? USDC_GAS_BUFFER : 0),
      ),
    [session.publicBalances, token],
  );

  const onAmount = useCallback(
    (value: string) => {
      setAmount(sanitizeAmountInput(value, TOK(token).dec));
      setAmountError(null);
    },
    [token],
  );

  const selectToken = useCallback((next: TokenSymbol) => {
    setToken(next);
    setAmountError(null);
  }, []);

  const runDeposit = useCallback(() => {
    if (depositStep > 0 && depositStep < 4) return;
    if (session.status !== "registered") {
      setBlocked(
        session.status === "derived"
          ? {
              title: "Account derived but not registered",
              body: "Unlink needs one registration call before it will accept a deposit for this address.",
            }
          : {
              title: "No private account yet",
              body: "Sign once to derive your Unlink account from this wallet. Nothing can move into the pool before that.",
            },
      );
      setDepositError(null);
      return;
    }
    if (session.pendingOperation) {
      setBlocked({
        title: "Pending operation",
        body: "Resume the saved operation before starting another mutation.",
      });
      return;
    }

    const parsed = parseAmount(amount, {
      symbol: token,
      decimals: TOK(token).dec,
      available: depositAvailable,
      kind: "public",
      note: token === "USDC" ? GAS_BUFFER_NOTE : undefined,
    });
    if (!parsed.ok) {
      setAmountError(parsed.error);
      setDepositError(null);
      return;
    }

    setAmountError(null);
    setDepositStep(1);
    setDepositError(null);
    setBlocked(null);
    setDepositReceipt(null);

    void backend
      .deposit({ token, amount }, (stage) => {
        if (!alive.current) return;
        setDepositStep(stage === "reading" ? 1 : stage === "submitting" ? 2 : 3);
      })
      .then(async (receipt) => {
        setReadinessVerified(true);
        const next = await backend.getSession();
        if (!alive.current) return;
        commit(next);
        setDepositReceipt(receipt);
        setDepositStep(4);
        setSessionDeposits((current) => ({
          ...current,
          [receipt.token]: [
            ...current[receipt.token],
            Number(receipt.amountUnits) / 10 ** receipt.decimals,
          ],
        }));
      })
      .catch((error: unknown) => {
        const failure = asBackendError(error);
        if (!alive.current) return;
        setDepositStep(0);
        setDepositError({ title: failure.title, body: failure.body });
      });
  }, [amount, backend, commit, depositAvailable, depositStep, session.pendingOperation, session.status, token]);

  // ── Private transfer ───────────────────────────────────────────────────────

  const onRecipient = useCallback((value: string) => {
    setRecipient(value);
    setRecipientError(null);
  }, []);

  const onTransferAmount = useCallback(
    (value: string) => {
      setTransferAmount(sanitizeAmountInput(value, TOK(xToken).dec));
      setTransferAmountError(null);
    },
    [xToken],
  );

  const selectTransferToken = useCallback((next: TokenSymbol) => {
    setXToken(next);
    setTransferAmountError(null);
  }, []);

  /** Which operation the recipient field currently means. */
  const sendMode = useMemo(() => detectRecipient(recipient), [recipient]);

  /** Fee charged on top of a transfer or withdrawal, in the selected token. */
  const transferFee = useMemo(() => {
    const decimals = TOK(xToken).dec;
    try {
      const units = parseDecimalUnits(transferAmount || "0", decimals);
      return fromBaseUnits(feeOnTop(units, FEES.transferBps).fee, decimals);
    } catch {
      return 0;
    }
  }, [transferAmount, xToken]);

  const hygieneWarnings = useMemo(
    () =>
      sendMode === "evm"
        ? withdrawalWarnings({
            recipient,
            wallet: session.wallet ?? "",
            amount: Number(transferAmount) || 0,
            recentDeposits: sessionDeposits[xToken],
          })
        : [],
    [recipient, sendMode, sessionDeposits, session.wallet, transferAmount, xToken],
  );

  /**
   * One button, two protocols. An `unlink1` recipient runs a private transfer; a
   * `0x` recipient runs a withdrawal, whose destination and amount are public. The
   * screen says which one is about to happen before this ever runs.
   */
  /**
   * Clear a finished receipt and return the form to its editable state.
   *
   * The done-state button reads "Send another"/"Swap again". It used to be
   * wired to the run action, so a single click re-broadcast the SAME operation
   * with no second confirmation — which is exactly what happened during Phase 4
   * live QA, sending an unintended duplicate transfer. A label that promises a
   * fresh start must never resubmit; it resets, and the user re-confirms by
   * pressing the real send button.
   */
  const resetDeposit = useCallback(() => {
    setDepositStep(0);
    setDepositError(null);
    setDepositReceipt(null);
    setBlocked(null);
  }, []);

  const resetTransfer = useCallback(() => {
    setTransferStep(0);
    setTransferError(null);
    setTransferReceipt(null);
  }, []);

  const resetSwap = useCallback(() => {
    setSwapStep(0);
    setSwapError(null);
    setSwapReceipt(null);
  }, []);

  const runTransfer = useCallback(() => {
    if (transferStep === 1) return;
    if (session.status !== "registered") {
      setScreen("account");
      return;
    }
    if (session.pendingOperation) {
      setTransferError({
        title: "Pending operation",
        body: "Resume the saved operation before starting another mutation.",
      });
      return;
    }

    const recipientProblem = validateRecipient(recipient, session.unlinkAddress ?? undefined);
    const parsed = parseAmount(transferAmount, {
      symbol: xToken,
      decimals: TOK(xToken).dec,
      available: Number(session.privateBalances[xToken]) / 10 ** TOK(xToken).dec,
      kind: "private",
      fee: transferFee,
    });
    setRecipientError(recipientProblem);
    setTransferAmountError(parsed.ok ? null : parsed.error);
    if (recipientProblem || !parsed.ok) return;

    setTransferStep(1);
    setTransferError(null);
    setTransferReceipt(null);

    const request = { recipient: recipient.trim(), token: xToken, amount: transferAmount };
    const operation =
      sendMode === "evm"
        ? backend.withdraw(request, () => {
            /* stages are reported for the busy label only */
          })
        : backend.transfer(request, () => {
            /* single stage: building the proof */
          });

    void operation
      .then(async (receipt) => {
        setReadinessVerified(true);
        const next = await backend.getSession();
        if (!alive.current) return;
        commit(next);
        setTransferReceipt(receipt);
        setTransferStep(2);
      })
      .catch((error: unknown) => {
        const failure = asBackendError(error);
        if (!alive.current) return;
        setTransferStep(0);
        setTransferError({ title: failure.title, body: failure.body });
      });
  }, [
    backend,
    commit,
    recipient,
    sendMode,
    session.privateBalances,
    session.pendingOperation,
    session.status,
    session.unlinkAddress,
    transferAmount,
    transferFee,
    transferStep,
    xToken,
  ]);

  // ── Unlink-funded swap ─────────────────────────────────────────────────────

  const onSwapAmount = useCallback(
    (value: string) => {
      setSwapAmount(sanitizeAmountInput(value, TOK(ROUTES[route].in).dec));
      setSwapAmountError(null);
      setSwapQuote(null);
      setSwapQuoteFor(null);
    },
    [route],
  );

  const selectRoute = useCallback((next: RouteId) => {
    setRoute(next);
    setSwapStep(0);
    setSwapError(null);
    setSwapAmountError(null);
    // The old quote priced the other direction; keeping it would let the user
    // start Phase A against a stale rate for the wrong token.
    setSwapQuote(null);
    setSwapQuoteFor(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (session.status !== "registered" || !swapAmount) {
      setSwapQuote(null);
      setSwapQuoteFor(null);
      return;
    }
    const timer = window.setTimeout(() => {
      void backend
        .getQuote(route, swapAmount)
        .then((quote) => {
          if (!cancelled && alive.current) {
            setSwapQuote(quote);
            setSwapQuoteFor(swapAmount);
          }
        })
        .catch(() => {
          if (!cancelled && alive.current) {
            setSwapQuote(null);
            setSwapQuoteFor(null);
          }
        });
    }, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [backend, route, session.status, swapAmount]);

  const runSwap = useCallback(() => {
    if (swapStep === 1 || swapStep === 2) return;
    if (session.status !== "registered") {
      setScreen("account");
      return;
    }
    if (session.pendingOperation) {
      setSwapError({
        title: "Pending operation",
        body: "Resume or recover the saved operation before starting another swap.",
      });
      return;
    }
    if (!swapQuote || swapQuoteFor !== swapAmount) {
      setSwapError({
        title: "Quote not ready",
        body: "Wait for the indicative Circle quote before starting Phase A.",
      });
      return;
    }

    // Balance and precision must be checked against the token the route sells,
    // not against USDC.
    const inSymbol = ROUTES[route].in;
    const parsed = parseAmount(swapAmount, {
      symbol: inSymbol,
      decimals: TOK(inSymbol).dec,
      available:
        Number(session.privateBalances[inSymbol]) / 10 ** TOK(inSymbol).dec,
      kind: "private",
      note: "Deposit into Unlink first, or lower the amount.",
    });
    if (!parsed.ok) {
      setSwapAmountError(parsed.error);
      setSwapError(null);
      return;
    }

    setSwapAmountError(null);
    setSwapStep(1);
    setSwapError(null);
    setSwapReceipt(null);

    void backend
      .swap({ route, grossAmount: swapAmount }, (stage) => {
        if (!alive.current) return;
        setSwapStep(stage === "phase-a" ? 1 : 2);
      })
      .then(async (receipt) => {
        setReadinessVerified(true);
        const next = await backend.getSession();
        if (!alive.current) return;
        commit(next);
        setSwapReceipt(receipt);
        setSwapStep(3);
      })
      .catch((error: unknown) => {
        const failure = asBackendError(error);
        if (!alive.current) return;
        setSwapStep(0);
        setSwapError({ title: failure.title, body: failure.body });
      });
  }, [backend, commit, route, session.pendingOperation, session.privateBalances, session.status, swapAmount, swapQuote, swapQuoteFor, swapStep]);

  const resumePending = useCallback(() => {
    setBlocked(null);
    void backend
      .resumePending()
      .then(() => backend.getSession())
      .then((next) => {
        setReadinessVerified(true);
        commit(next);
      })
      .catch((error: unknown) => {
        const failure = asBackendError(error);
        if (alive.current) setBlocked({ title: failure.title, body: failure.body });
      });
  }, [backend, commit]);

  const returnPendingSwapToPool = useCallback(() => {
    void backend
      .returnPendingSwapToPool?.()
      .then(() => backend.getSession())
      .then((next) => {
        if (next) {
          setReadinessVerified(true);
          commit(next);
        }
      })
      .catch((error: unknown) => {
        const failure = asBackendError(error);
        if (alive.current) setBlocked({ title: failure.title, body: failure.body });
      });
  }, [backend, commit]);

  const archiveStuckOperation = useCallback(() => {
    setBlocked(null);
    void backend
      .archiveStuckOperation?.()
      .then(() => backend.getSession())
      .then((next) => {
        if (next) commit(next);
      })
      .catch((error: unknown) => {
        const failure = asBackendError(error);
        if (alive.current) setBlocked({ title: failure.title, body: failure.body });
      });
  }, [backend, commit]);

  const switchChain = useCallback(() => {
    void backend
      .switchChain?.()
      .then((next) => {
        if (next) commit(next);
      })
      .catch((error: unknown) => {
        const failure = asBackendError(error);
        if (alive.current) setAccountError({ title: failure.title, body: failure.body });
      });
  }, [backend, commit]);

  const disconnectWallet = useCallback(() => {
    return backend.disconnectWallet().then(commit);
  }, [backend, commit]);

  const retrySession = useCallback(() => {
    setAccountError(null);
    void backend
      .getSession()
      .then(commit)
      .catch((error: unknown) => {
        const failure = asBackendError(error);
        if (alive.current) setAccountError({ title: failure.title, body: failure.body });
      });
  }, [backend, commit]);

  const exportBurnerKey = useCallback(() => {
    const key = backend.exportBurnerKey?.();
    if (key) {
      window.prompt(
        "Copy this burner private key now. Never share it. It is not included in journal or evidence exports.",
        key,
      );
    }
  }, [backend]);

  const destroyBurner = useCallback(() => {
    const confirmation = window.prompt(
      "Destroying a burner can irreversibly lose private funds. Type DESTROY to force destruction after exporting the key.",
    );
    if (confirmation === null) return;
    void backend
      .destroyBurner?.(confirmation)
      .then((next) => {
        if (next) commit(next);
      })
      .catch((error: unknown) => {
        const failure = asBackendError(error);
        if (alive.current) setAccountError({ title: failure.title, body: failure.body });
      });
  }, [backend, commit]);

  // ── Evidence ───────────────────────────────────────────────────────────────

  const exportEvidence = useCallback(() => {
    if (exportStep === 1) return;
    setExportStep(1);
    void backend
      .exportEvidence()
      .then((result) => {
        if (!alive.current) return;
        setExportResult(result);
        setExportStep(2);
      })
      .catch(() => {
        if (alive.current) setExportStep(0);
      });
  }, [backend, exportStep]);

  // ── Demo controls (in-memory backend only) ─────────────────────────────────

  const setAccountStatus = useCallback(
    (status: AccountStatus) => () => {
      setBlocked(null);
      setDepositStep(0);
      setDepositError(null);
      setAmountError(null);
      void backend.setAccountStatus?.(status).then(commit);
    },
    [backend, commit],
  );

  const toggleFail = useCallback(() => {
    const next = !forceFail;
    setForceFail(next);
    backend.setFailureInjection?.(next);
  }, [backend, forceFail]);

  const resetDemo = useCallback(() => {
    setDepositStep(0);
    setDepositError(null);
    setDepositReceipt(null);
    setAmountError(null);
    setBlocked(null);
    setTransferStep(0);
    setTransferError(null);
    setTransferReceipt(null);
    setTransferAmountError(null);
    setRecipientError(null);
    setRecipient(DEMO_RECIPIENT);
    setSwapStep(0);
    setSwapError(null);
    setSwapReceipt(null);
    setSwapAmountError(null);
    setExportStep(0);
    setExportResult(null);
    setForceFail(false);
    setAccountError(null);
    backend.setFailureInjection?.(false);
    setScreen("landing");
    void backend.reset?.().then(commit);
  }, [backend, commit]);

  /**
   * True while a mutation started in this tab is still in flight.
   *
   * A live operation writes its journal entry before it broadcasts, so the very
   * next session refresh reports a pending operation and the "Saved operation"
   * banner used to pop up mid-deposit — describing the deposit the user was
   * watching as if it were stranded work from an earlier session. The banner is
   * for operations nobody is currently driving, so it stays hidden until this
   * one settles or fails.
   */
  const operationBusy =
    (depositStep > 0 && !depositReceipt) ||
    (transferStep > 0 && !transferReceipt) ||
    (swapStep > 0 && !swapReceipt);

  return {
    backend,
    session,
    ready,
    route: ROUTES[route],
    routeId: route,
    state: {
      operationBusy,
      screen,
      dark,
      demo,
      mask,
      signing,
      readinessVerified,
      accountError,
      token,
      amount,
      amountError,
      depositStep,
      depositError,
      depositReceipt,
      depositAvailable,
      blocked,
      xToken,
      recipient,
      recipientError,
      transferAmount,
      transferAmountError,
      transferStep,
      transferError,
      transferReceipt,
      transferFee,
      sendMode,
      hygieneWarnings,
      swapAmount,
      swapAmountError,
      swapStep,
      swapError,
      swapReceipt,
      swapQuote,
      mode,
      exportStep,
      exportResult,
      forceFail,
    },
    actions: {
      go,
      goDisclosure,
      toggleTheme,
      derive,
      connectWallet,
      selectToken,
      onAmount,
      setAmount,
      runDeposit,
      resetDeposit,
      selectTransferToken,
      onRecipient,
      onTransferAmount,
      setTransferAmount,
      runTransfer,
      resetTransfer,
      selectRoute,
      onSwapAmount,
      setSwapAmount,
      runSwap,
      resetSwap,
      resumePending,
      returnPendingSwapToPool,
      archiveStuckOperation,
      switchChain,
      disconnectWallet,
      exportBurnerKey,
      destroyBurner,
      retrySession,
      setMode,
      exportEvidence,
      toggleMask: () => setMask((value) => !value),
      hideDemo: () => setDemo(false),
      setAccountStatus,
      toggleFail,
      resetDemo,
    },
  };
}

export type CleanPrivacyStore = ReturnType<typeof useCleanPrivacy>;
