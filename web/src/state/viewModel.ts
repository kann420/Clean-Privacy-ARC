import {
  ADDR,
  CHAIN,
  DEMO_VIDEO_URL,
  EXPLORER,
  FEES,
  REVERSE_ROUTE,
  ROUTES,
  TOK,
  TOKENS,
  type RouteId,
  type TokenSymbol,
} from "../config/arc";
import { bpsLabel, feeFromInput, fromBaseUnits, toBaseUnits } from "../lib/fees";
import { DEMO_EXECUTION_ACCOUNT, DEMO_SENDER } from "../api/demoFixtures";
import { addressLink, fmt, quickPicks, short, shortId, txLink } from "../lib/format";
import type { AccountStatus } from "../api/types";
import type { CleanPrivacyStore, Screen } from "./useCleanPrivacy";

/**
 * Port of the mock's `renderVals()`. Same keys, same order, same derived strings, so a
 * screen component can be compared against the mock's markup line by line. Everything
 * a screen renders is computed here and nowhere else.
 */
/**
 * Pick the action behind a call-to-action whose label changes once an operation
 * has completed.
 *
 * The done-state labels are "Send another" and "Swap again". Both used to be
 * wired straight to the run action, so one click re-broadcast the operation
 * that had just settled, with no second confirmation — during Phase 4 live QA
 * that sent an unintended duplicate 0.05 USDC transfer on Arc Testnet. A label
 * that promises a fresh start must reset the form and make the user press the
 * real send button again.
 */
/** Circle's own testnet faucet: it funds every token this app deposits. */
const CIRCLE_FAUCET = "https://faucet.circle.com/";

export function ctaAction<T>(done: boolean, reset: T, run: T): T {
  return done ? reset : run;
}

/**
 * Explorer target for a settled swap receipt.
 *
 * Phase B is the adapter swap itself, so its hash is what an operator wants to
 * open. Phase A is the fallback when the SDK reported no Phase B hash, and the
 * ExecutionAccount address is the last resort — the demo backend has no hashes
 * at all, and a receipt chip that links nowhere is worse than one that links to
 * the account the swap ran through.
 */
export function swapReceiptLink(
  receipt: { phaseBTxHash?: string; handleOpsTxHash?: string; accountAddress: string },
  explorer: string,
): { hash: string | null; href: string } {
  const hash = receipt.phaseBTxHash ?? receipt.handleOpsTxHash ?? null;
  return {
    hash,
    href: hash
      ? txLink(explorer, hash)
      : addressLink(explorer, receipt.accountAddress),
  };
}

export function buildViewModel(store: CleanPrivacyStore) {
  const { session, state, actions, route: r, routeId } = store;
  const ready = store.ready;
  const maskOn = state.mask;
  const unitsNumber = (value: string, symbol: string) =>
    Number(value) / 10 ** TOK(symbol).dec;
  const money = (value: string, symbol: string) =>
    maskOn ? "••••" : fmt(unitsNumber(value, symbol), symbol);
  const amtIn = Number(state.swapAmount) || 0;
  // The swap fee comes out of the input, so every quote is taken on the
  // remainder — and the input token is whichever side the route sells.
  const inSymbol = r.in;
  const inDecimals = TOK(inSymbol).dec;
  const swapSplit = feeFromInput(toBaseUnits(amtIn, inDecimals), FEES.swapBps);
  const swapFee = fromBaseUnits(swapSplit.fee, inDecimals);
  const netIn = fromBaseUnits(swapSplit.net, inDecimals);
  const outVal = r.quote(netIn);
  const swapLink = state.swapReceipt
    ? swapReceiptLink(state.swapReceipt, EXPLORER)
    : null;
  const isWithdrawal = state.sendMode === "evm";
  const link = (address: string) => addressLink(EXPLORER, address);
  // Deposit, transfer and withdrawal are token-generic in both modes. Only the
  // swap venue is restricted, and that restriction lives in ROUTES.
  const operationTokens = TOKENS;

  const acct = acctMeta(
    session.status,
    session.wallet ?? "not connected",
    session.unlinkAddress,
    actions.derive,
  );

  const navPill = (id: Screen, label: string) => {
    const active = state.screen === id;
    return {
      id,
      label,
      on: actions.go(id),
      bg: active ? "var(--navy)" : "transparent",
      fg: active ? "#fff" : "var(--ink-2)",
      border: active ? "var(--ink)" : "transparent",
      shadow: active ? "1px 1px 0 var(--pop)" : "none",
      rowBg: active ? "var(--navy)" : "var(--cloud)",
      rowFg: active ? "#fff" : "var(--ink-2)",
    };
  };

  const tokenBtn = (symbol: TokenSymbol, selected: TokenSymbol, on: (next: TokenSymbol) => void) => {
    const meta = TOK(symbol);
    const active = selected === symbol;
    return {
      symbol,
      icon: meta.icon,
      tint: meta.tint,
      on: () => on(symbol),
      bg: active ? "var(--navy)" : "var(--cloud-2)",
      fg: active ? "#fff" : "var(--ink)",
      shadow: active ? "2px 2px 0 var(--pop)" : "1px 1px 0 var(--pop)",
    };
  };

  const stepRow = (index: number, label: string, detail: string) => {
    const current = state.depositStep;
    const done = current > index || current === 4;
    const active = current === index;
    return {
      label,
      detail,
      mark: done ? "✓" : String(index),
      dot: done ? "var(--mist)" : active ? "var(--sand)" : "var(--cloud-2)",
      bg: active ? "var(--cloud-2)" : "var(--cloud)",
      border: active ? "var(--ink)" : "var(--hair)",
    };
  };

  const phaseRow = (index: number, label: string, detail: string) => {
    const current = state.swapStep;
    const done = current > index || current === 3;
    const active = current === index;
    return {
      label,
      detail,
      mark: done ? "✓" : String(index),
      dot: done ? "var(--mist)" : active ? "var(--sand)" : "var(--cloud-2)",
      bg: active ? "var(--cloud-2)" : "var(--cloud)",
      border: active ? "var(--ink)" : "var(--hair)",
    };
  };

  return {
    nav: [
      navPill("account", "Account"),
      navPill("deposit", "Deposit"),
      navPill("transfer", "Transfer"),
      navPill("swap", "Swap"),
      navPill("evidence", "Evidence"),
    ],
    inApp: state.screen !== "landing",
    isLanding: state.screen === "landing",
    isAccount: state.screen === "account",
    isDeposit: state.screen === "deposit",
    isTransfer: state.screen === "transfer",
    isSwap: state.screen === "swap",
    isEvidence: state.screen === "evidence",
    goLanding: actions.go("landing"),
    goAccount: actions.go("account"),
    goDisclosure: actions.goDisclosure,
    toggleTheme: actions.toggleTheme,
    themeIcon: state.dark ? "☀" : "☾",
    shortWallet: session.wallet ? short(session.wallet) : "connect wallet",
    privateUsdcLabel: money(session.privateBalances.USDC, "USDC"),
    acct,

    // landing
    videoSrc: DEMO_VIDEO_URL,
    landingStats: LANDING_STATS,
    howItWorks: HOW_IT_WORKS,
    assetList: [
      { symbol: "USDC" as TokenSymbol, icon: TOK("USDC").icon, note: "0x3600…0000 · gas + ERC-20 view" },
      { symbol: "EURC" as TokenSymbol, icon: TOK("EURC").icon, note: short(ADDR.eurc, 8, 6) + " · 6 dec" },
      { symbol: "cirBTC" as TokenSymbol, icon: TOK("cirBTC").icon, note: short(ADDR.cirbtc, 8, 6) + " · 8 dec" },
    ],
    contracts: [
      { label: "Unlink Pool", short: short(ADDR.pool), href: link(ADDR.pool) },
      { label: "Circle Adapter", short: short(ADDR.circleAdapter), href: link(ADDR.circleAdapter) },
      { label: "USDC", short: short(ADDR.usdc), href: link(ADDR.usdc) },
      { label: "EURC", short: short(ADDR.eurc), href: link(ADDR.eurc) },
      { label: "cirBTC", short: short(ADDR.cirbtc), href: link(ADDR.cirbtc) },
      { label: "EntryPoint v0.7", short: short(ADDR.entryPoint), href: link(ADDR.entryPoint) },
      { label: "ExecutionAccount factory", short: short(ADDR.eaFactory), href: link(ADDR.eaFactory) },
    ],

    // account
    signing: state.signing,
    signingNote: session.status === "none" ? "waiting for the wallet signature" : "registering with Unlink",
    accountError: state.accountError,
    unlocks: UNLOCKS,

    // deposit
    depositTokens: operationTokens.map((t) =>
      tokenBtn(t.symbol, state.token, actions.selectToken),
    ),
    depositSymbol: state.token,
    amount: state.amount,
    onAmount: actions.onAmount,
    amountError: state.amountError,
    depositPcts: quickPicks(state.depositAvailable, state.token, state.amount, actions.setAmount),
    publicBalanceLabel:
      fmt(
        unitsNumber(session.publicBalances[state.token], state.token),
        state.token,
      ) +
      " " +
      state.token,
    spendableLabel:
      state.token === "USDC"
        ? "spendable " + fmt(state.depositAvailable, state.token) + " after the gas buffer"
        : null,
    runDeposit: actions.runDeposit,
    // "Deposit again" is the same trap as the transfer and swap CTAs: it must
    // clear the receipt, not repeat a real public deposit.
    depositCtaAction: ctaAction(
      state.depositStep === 4,
      actions.resetDeposit,
      actions.runDeposit,
    ),
    faucetHref: CIRCLE_FAUCET,
    showFaucet: store.backend.mode === "live" && ready,
    depositBusy: state.depositStep > 0 && state.depositStep < 4,
    depositCta:
      state.depositStep === 0
        ? "Deposit " + (state.amount || "0") + " " + state.token
        : state.depositStep === 1
          ? "Reading balance…"
          : state.depositStep === 2
            ? "depositWithApproval…"
            : state.depositStep === 3
              ? "Waiting for processed…"
              : "Deposit again",
    depositError: state.depositError,
    showBlocked: !!state.blocked,
    blocked: state.blocked ?? { title: "", body: "" },
    // The blocked card used to hardcode "Derive account" because in the mock
    // that was the only way to be blocked. It is now reused for a saved
    // operation too, where telling an already-registered user to derive is
    // simply wrong — so the action follows the actual reason.
    blockedActionLabel: session.pendingOperation
      ? "Resume saved operation"
      : "Derive account",
    blockedAction: session.pendingOperation
      ? actions.resumePending
      : actions.go("account"),
    depositDone:
      state.depositStep === 4 && state.depositReceipt
        ? {
            title: "Deposit successful",
            body:
              fmt(
                Number(state.depositReceipt.amountUnits) /
                  10 ** state.depositReceipt.decimals,
                state.depositReceipt.token,
              ) +
              " " +
              state.depositReceipt.token +
              " is now in your private balance.",
            // The receipt carries the on-chain hash of the deposit itself, so the
            // link points at that transaction on ArcScan. Only the mock, which has
            // no hash, falls back to the pool address.
            tx: state.depositReceipt.txHash
              ? short(state.depositReceipt.txHash, 10, 8)
              : "deposit " + shortId(state.depositReceipt.id),
            href: state.depositReceipt.txHash
              ? txLink(EXPLORER, state.depositReceipt.txHash)
              : link(ADDR.pool),
          }
        : null,
    depositSteps: [
      stepRow(1, "Read the ERC-20 balance", "decimals " + TOK(state.token).dec + " · gas buffer reserved for USDC"),
      stepRow(2, "depositWithApproval(token, amount)", "txId persisted before the wait begins"),
      stepRow(3, "Wait for processed, verify delta", "private balance must move by exactly the amount"),
    ],
    privateBalances: operationTokens.map((t) => ({
      symbol: t.symbol,
      icon: t.icon,
      amount: money(session.privateBalances[t.symbol], t.symbol),
    })),

    // transfer and withdrawal share one screen; the recipient decides which one
    isWithdrawal,
    // Both destinations are private transfers; they differ in how much of the
    // operation Arc gets to see. Naming them that way is more accurate than
    // "private transfer" versus "withdraw", which read as opposites.
    sendTitle: isWithdrawal
      ? "Partly private transfer to an EVM address"
      : "Fully private transfer",
    sendLead: isWithdrawal
      ? "The pool hides which private account paid. Arc still records the destination, the token and the amount."
      : "Sender, recipient, token and amount are all hidden by the Unlink proof. Nothing hits Arc.",
    // No banner on the EVM side: the lead already states what Arc sees, and the
    // alarm-styled card read as "this transfer is public", which it is not.
    sendBanner: isWithdrawal
      ? null
      : {
          tint: "var(--mist)",
          glyph: "🛡️",
          title: "Fully private",
          body:
            "Both deltas are verified after the operation reaches processed: exactly " +
            `−${state.transferAmount || "0"} on your side, +${state.transferAmount || "0"} on theirs.`,
        },
    // The side column explains the choice the recipient field is making, and how
    // a recipient produces an unlink1 address at all — the two questions that
    // decide whether a send is fully private or only partly.
    sendGuides: SEND_GUIDES,
    hygieneWarnings: state.hygieneWarnings,
    transferFeeLabel: `${fmt(state.transferFee, state.xToken)} ${state.xToken} · ${bpsLabel(FEES.transferBps)}`,
    transferTotalLabel: `${fmt((Number(state.transferAmount) || 0) + state.transferFee, state.xToken)} ${state.xToken}`,
    feeDestination: isWithdrawal
      ? "paid privately to the fee account after the transfer settles"
      : "paid inside the same private transaction",
    transferTokens: operationTokens.map((t) =>
      tokenBtn(t.symbol, state.xToken, actions.selectTransferToken),
    ),
    transferSymbol: state.xToken,
    transferBalanceLabel: money(session.privateBalances[state.xToken], state.xToken) + " " + state.xToken,
    recipient: state.recipient,
    onRecipient: actions.onRecipient,
    recipientError: state.recipientError,
    transferAmount: state.transferAmount,
    onTransferAmount: actions.onTransferAmount,
    transferAmountError: state.transferAmountError,
    // Both branches of this screen — private transfer and withdrawal — charge the
    // fee on top, so the picks must leave room for it or "Max" cannot be sent.
    transferPcts: quickPicks(
      unitsNumber(session.privateBalances[state.xToken], state.xToken),
      state.xToken,
      state.transferAmount,
      actions.setTransferAmount,
      FEES.transferBps,
    ),
    runTransfer: actions.runTransfer,
    // In the done state the CTA reads "Send another", so it must RESET the form
    // rather than re-broadcast the operation it just completed (Phase 4 live QA:
    // one click sent an unintended duplicate transfer). `runTransfer` itself is
    // left untouched for the error card's explicit resume action.
    transferCtaAction: ctaAction(
      state.transferStep === 2,
      actions.resetTransfer,
      actions.runTransfer,
    ),
    transferBusy: state.transferStep === 1,
    transferCta: !ready
      ? "Derive your account first"
      : state.transferStep === 1
        ? isWithdrawal
          ? "Sending…"
          : "Building the proof…"
        : state.transferStep === 2
          ? "Send another"
          : // One label for both destinations: the screen's title and its side
            // column already say how private each one is.
            "Send privately",
    transferCtaBg: ready ? "var(--navy)" : "var(--cloud-2)",
    transferCtaFg: ready ? "#fff" : "var(--ink-2)",
    transferError: state.transferError,
    transferDone:
      state.transferStep === 2 && state.transferReceipt
        ? {
            title: state.transferReceipt.kind === "withdraw" ? "Withdrawn" : "Processed",
            body: state.transferReceipt.kind === "withdraw"
              ? `${fmt(Number(state.transferReceipt.amountUnits) / 10 ** state.transferReceipt.decimals, state.transferReceipt.token)} ${state.transferReceipt.token} ` +
                `arrived at ${short(state.transferReceipt.recipient ?? "")}. Fee ` +
                `${fmt(Number(state.transferReceipt.feeUnits) / 10 ** state.transferReceipt.decimals, state.transferReceipt.token)} ${state.transferReceipt.token}, ` +
                "collected privately. Arc sees the destination and the amount, not the source."
              : `${fmt(Number(state.transferReceipt.amountUnits) / 10 ** state.transferReceipt.decimals, state.transferReceipt.token)} ${state.transferReceipt.token} ` +
                `moved inside the pool. Fee ${fmt(Number(state.transferReceipt.feeUnits) / 10 ** state.transferReceipt.decimals, state.transferReceipt.token)} ` +
                `${state.transferReceipt.token}, paid in the same transaction. Arc recorded nothing about it.`,
            // A live operation carries the on-chain hash of the transaction that
            // settled it, so the chip links straight to ArcScan. The mock has no
            // hash, so it stays an unlinked operation id.
            tx: state.transferReceipt.txHash
              ? "tx " + short(state.transferReceipt.txHash, 10, 8)
              : "tx " + shortId(state.transferReceipt.id),
            href: state.transferReceipt.txHash
              ? txLink(EXPLORER, state.transferReceipt.txHash)
              : null,
          }
        : null,
    toggleMask: actions.toggleMask,
    maskCta: state.mask ? "Reveal amounts" : "Hide amounts",
    maskIcon: state.mask ? "🙈" : "👁",
    activity: session.activity.map((a) => ({
      id: a.id,
      title: a.title,
      meta: a.meta,
      tint: a.tint,
      glyph: a.glyph,
      amount: maskOn ? "••••" : a.amount,
      badge: a.badge,
      badgeBg: a.badge === "private" ? "var(--mist)" : "var(--sand)",
      badgeFg: "var(--on-tint)",
    })),

    // swap
    swapLead:
      "Out of the pool, through " +
      r.venue +
      ", back into the pool. Two phases, one execution account, output re-shielded.",
    swapFeeDisclosure:
      "The 0.05% fee is taken in Phase A and is not refundable if the swap cannot complete.",
    routes: (Object.keys(ROUTES) as RouteId[]).map((key) => {
      const active = key === routeId;
      return {
        id: key,
        label: ROUTES[key].label,
        venue: ROUTES[key].venue,
        on: () => actions.selectRoute(key),
        bg: active ? "var(--navy)" : "var(--cloud-2)",
        fg: active ? "#fff" : "var(--ink)",
        shadow: active ? "2px 2px 0 var(--pop)" : "1px 1px 0 var(--pop)",
      };
    }),
    swapAmount: state.swapAmount,
    onSwapAmount: actions.onSwapAmount,
    swapAmountError: state.swapAmountError,
    swapPcts: quickPicks(
      unitsNumber(session.privateBalances[inSymbol], inSymbol),
      inSymbol,
      state.swapAmount,
      actions.setSwapAmount,
    ),
    swapOut: fmt(
      state.swapQuote
        ? Number(state.swapQuote.estimatedOutUnits) / 10 ** TOK(r.out).dec
        : outVal,
      r.out,
    ),
    swapFeeLabel: `${fmt(
      state.swapQuote
        ? Number(state.swapQuote.feeUnits) / 10 ** inDecimals
        : swapFee,
      inSymbol,
    )} ${inSymbol} · ${bpsLabel(FEES.swapBps)}`,
    inSymbol,
    outSymbol: r.out,
    outIcon: TOK(r.out).icon,
    usdcIcon: TOK(inSymbol).icon,
    onFlipRoute: () => actions.selectRoute(REVERSE_ROUTE[routeId]),
    flipLabel: `Flip to ${ROUTES[REVERSE_ROUTE[routeId]].label}`,
    quoteLabel:
      "Indicative Circle quote · the captured plan is revalidated before Phase B",
    swapFacts: [
      {
        label: "Rate",
        // In live mode the only honest rate is the one the backend just quoted.
        // The static demo curve stays where it belongs: the demo adapter.
        value: state.swapQuote
          ? `1 ${inSymbol} ≈ ` +
            fmt(
              (Number(state.swapQuote.estimatedOutUnits) /
                10 ** TOK(r.out).dec /
                (Number(state.swapQuote.netUnits || "1") / 10 ** inDecimals)),
              r.out,
            ) +
            " " +
            r.out +
            " · live"
          : store.backend.mode === "live"
            ? "quoting…"
            : `1 ${inSymbol} ≈ ` + fmt(r.quote(1), r.out) + " " + r.out,
      },
      {
        label: "Minimum out",
        value: state.swapQuote?.minOutUnits
          ? fmt(
              Number(state.swapQuote.minOutUnits) / 10 ** TOK(r.out).dec,
              r.out,
            ) +
            " " +
            r.out
          : "set by the captured plan",
      },
      {
        label: "Protocol fee",
        value:
          fmt(
            state.swapQuote
              ? Number(state.swapQuote.feeUnits) / 10 ** inDecimals
              : swapFee,
            inSymbol,
          ) +
          ` ${inSymbol} · ` +
          bpsLabel(FEES.swapBps) +
          " of the input",
      },
      { label: "Target", value: r.targetLabel + " " + short(r.target, 6, 4) },
      { label: "Costs", value: r.provider },
    ],
    runSwap: actions.runSwap,
    // Same rule as the transfer CTA: "Swap again" resets, it never re-executes
    // a two-phase swap without a fresh confirmation.
    swapCtaAction: ctaAction(
      state.swapStep === 3,
      actions.resetSwap,
      actions.runSwap,
    ),
    swapBusy: state.swapStep === 1 || state.swapStep === 2,
    swapCta: !ready
      ? "Derive your account first"
      : state.swapStep === 1
        ? "Phase A · funding + approving…"
        : state.swapStep === 2
          ? "Phase B · swapping + returning…"
          : state.swapStep === 3
            ? "Swap again"
            : "Swap from private balance",
    swapCtaBg: ready ? "var(--navy)" : "var(--cloud-2)",
    swapCtaFg: ready ? "#fff" : "var(--ink-2)",
    swapError: state.swapError,
    swapDone:
      state.swapStep === 3 && state.swapReceipt
        ? {
            title: "Swapped and re-shielded",
            body:
              fmt(
                Number(state.swapReceipt.grossUnits) /
                  10 ** state.swapReceipt.inDecimals,
                state.swapReceipt.inToken,
              ) +
              ` ${state.swapReceipt.inToken} → ` +
              fmt(
                Number(state.swapReceipt.outUnits) /
                  10 ** state.swapReceipt.decimals,
                state.swapReceipt.outToken,
              ) +
              " " +
              state.swapReceipt.outToken +
              " returned to the pool, after a " +
              fmt(
                Number(state.swapReceipt.feeUnits) /
                  10 ** state.swapReceipt.inDecimals,
                state.swapReceipt.inToken,
              ) +
              ` ${state.swapReceipt.inToken} protocol fee. No input residue, no allowance left.`,
            exec: swapLink?.hash
              ? short(swapLink.hash, 10, 8)
              : "execution " + shortId(state.swapReceipt.phaseBExecutionId),
            href: swapLink!.href,
          }
        : null,
    swapRoute: [
      phaseRow(
        1,
        "Phase A · withdraw into a fresh account",
        "execution account " +
          short(state.swapReceipt?.accountAddress ?? DEMO_EXECUTION_ACCOUNT, 6, 4) +
          " · index persisted",
      ),
      phaseRow(
        2,
        "Phase B · " + r.call,
        "value 0 · ERC-4337 through " + short(ADDR.entryPoint, 6, 4),
      ),
      phaseRow(3, "returnToPool [" + r.out + ", sweep]", "min_total from the quote, bounded max_total"),
    ],

    // evidence
    ev:
      state.mode === "privacy"
        ? {
            title: "Privacy disclosure",
            subtitle:
              "What each operation reveals on Arc. No claim beyond this is made anywhere in the product.",
            tableTitle: "Exposure per operation",
            note: "An Unlink-funded swap is not a confidential swap: only the funding account is hidden. If the output returns to the pool, the resulting owner and balance become private again.",
          }
        : {
            title: "Your operations",
            subtitle:
              "Every accepted operation, with the id we persisted before signing. Ids are how a rerun recovers.",
            tableTitle: "Processed on Arc Testnet",
            note: "Amounts here are your own records. Transfers appear because you performed them, not because Arc published them — on-chain there is only the pool contract.",
          },
    evModes: [
      {
        label: "Your operations",
        on: () => actions.setMode("ops"),
        bg: state.mode === "ops" ? "var(--navy)" : "transparent",
        fg: state.mode === "ops" ? "#fff" : "var(--ink-2)",
      },
      {
        label: "Disclosure",
        on: () => actions.setMode("privacy"),
        bg: state.mode === "privacy" ? "var(--navy)" : "transparent",
        fg: state.mode === "privacy" ? "#fff" : "var(--ink-2)",
      },
    ],
    evStats: [
      {
        caption: "private transfers processed",
        value: String(session.operations.filter((o) => o.kind === "Private transfer").length),
        suffix: "",
      },
      {
        caption: "swaps re-shielded",
        value: String(session.operations.filter((o) => o.kind === "Unlink-funded swap").length),
        suffix: "",
      },
      { caption: "unrecoverable operations", value: "0", suffix: "" },
    ],
    evColumns:
      state.mode === "privacy"
        ? [{ label: "Operation" }, { label: "Sender" }, { label: "Recipient" }, { label: "Amount" }, { label: "Calls" }]
        : [{ label: "Operation" }, { label: "Token" }, { label: "Amount" }, { label: "Persisted id" }, { label: "Status" }],
    evRows:
      state.mode === "privacy"
        ? PRIVACY_ROWS
        : session.operations.map((o) => ({
            key: o.id,
            a: o.kind,
            b: o.token as string,
            c: fmt(
              Number(o.amountUnits) / 10 ** o.decimals,
              o.token,
            ),
            d: shortId(o.id),
            e: o.status as string,
            tint: o.status === "processed" ? "var(--mist)" : "var(--sand)",
          })),
    evEmpty:
      state.mode === "ops" && session.operations.length === 0
        ? "No operations yet. Register your account, then deposit to create the first private note."
        : null,
    poolHref: link(ADDR.pool),
    poolLabel: "Unlink Pool " + short(ADDR.pool, 6, 4) + " ↗",
    exportEvidence: actions.exportEvidence,
    exportBusy: state.exportStep === 1,
    exportCta:
      state.exportStep === 1 ? "Collecting checkpoints…" : state.exportStep === 2 ? "Export again" : "Export evidence JSONL",
    exportNote:
      state.exportStep === 2 && state.exportResult
        ? state.exportResult.file + " ready · " + state.exportResult.records + " records"
        : "allowlisted public fields only",
    eaLine1: "account " + DEMO_EXECUTION_ACCOUNT,
    eaLine2: "EntryPoint v0.7 · " + short(ADDR.entryPoint, 10, 6),
    eaLine3: "Circle adapter " + short(ADDR.circleAdapter, 10, 6) + " · value 0",

    // demo panel
    showDemo: state.demo,
    hideDemo: actions.hideDemo,
    demoStates: (["none", "derived", "registered"] as AccountStatus[]).map((key) => ({
      key,
      label: key === "none" ? "None" : key === "derived" ? "Derived" : "Ready",
      on: actions.setAccountStatus(key),
      bg: session.status === key ? "var(--navy)" : "var(--cloud-2)",
      fg: session.status === key ? "#fff" : "var(--ink-2)",
    })),
    toggleFail: actions.toggleFail,
    failLabel: state.forceFail ? "RPC limit: ON" : "RPC limit: off",
    failBg: state.forceFail ? "var(--peach)" : "var(--cloud-2)",
    failFg: state.forceFail ? "var(--on-tint)" : "var(--ink-2)",
    resetDemo: actions.resetDemo,
  };
}

export type ViewModel = ReturnType<typeof buildViewModel>;

// ── Static copy, unchanged from the mock ────────────────────────────────────

/** Verified Arc Testnet results: 3 assets shielded, 3 transfers, 1 swap, 0 gas paid by the user. */
export const STAT_TARGETS = ["3", "3", "1", "0"] as const;

const LANDING_STATS = [
  { suffix: "", caption: "assets shielded", tint: "var(--mist)", mark: "shielded" },
  { suffix: "", caption: "private transfers", tint: "var(--sand)", mark: "transfer" },
  { suffix: "", caption: "swap re-shielded", tint: "var(--peach)", mark: "swap" },
  { suffix: "USDC", caption: "gas paid", tint: "var(--lilac)", mark: "gas" },
] as const;

const HOW_IT_WORKS = [
  {
    step: "1",
    tint: "var(--peach)",
    title: "Derive, don't sign up",
    body: "One wallet signature derives a seed-backed Unlink account for app id clean-privacy-arc on chain 5042002. The key never leaves the browser.",
  },
  {
    step: "2",
    tint: "var(--sand)",
    title: "Move privately",
    body: "Inside Unlink your balance is a note. An Unlink-to-Unlink transfer hides sender, recipient, token and amount.",
  },
  {
    step: "3",
    tint: "var(--mist)",
    title: "Spend on Arc",
    body: "A throwaway execution account swaps through Circle App Kit or the USDC/cirBTC pair, then returns the output to the pool.",
  },
] as const;

/**
 * Side-column explainers for the send screen. Both destinations are private
 * transfers — the difference is how much of the operation Arc records — and a
 * recipient can only be paid privately once they have derived an address, so
 * both facts are stated where the recipient field is being filled in.
 */
const SEND_GUIDES = [
  {
    title: "2 ways to private transfer",
    items: [
      {
        tint: "var(--mist)",
        label: "To an unlink1 address · fully private",
        body: "The money never leaves the pool. Sender, recipient, token and amount are all hidden by the proof. Arc records nothing about the payment.",
      },
      {
        tint: "var(--sand)",
        label: "To a 0x address · partly private",
        body: "The money leaves the pool as a normal Arc transfer. Hidden: which private account paid, and its history. Visible: the destination, the token and the amount.",
      },
    ],
    note: "Both cost the same 0.1% protocol fee.",
  },
  {
    title: "Getting an unlink1 address",
    items: [
      {
        tint: "var(--peach)",
        label: "1 · The recipient connects their wallet",
        body: "Any EVM wallet on Arc Testnet. They do not need funds, an account, or to have used Unlink before.",
      },
      {
        tint: "var(--sand)",
        label: "2 · They sign once on the Account screen",
        body: "A plain message signature, no gas and no transaction. It derives their private account inside their own browser.",
      },
      {
        tint: "var(--mist)",
        label: "3 · They copy it from “Receive privately”",
        body: "The full address sits there with a copy button and a QR code. Registering as well lets the pool index the notes sent to them.",
      },
    ],
    note: "The address is derived from their signature, so the same wallet always produces the same one — and nobody can compute it from their 0x address alone.",
  },
] as const;

const UNLOCKS = [
  {
    tint: "var(--mist)",
    text: "App id and chain id are permanent: change either and you get a different private account",
  },
  { tint: "var(--sand)", text: "Deposit USDC, EURC or cirBTC and read the private balance back" },
  { tint: "var(--peach)", text: "Send Unlink-to-Unlink transfers with both deltas verified" },
  { tint: "var(--lilac)", text: "Fund an execution account for an Arc swap, then re-shield the output" },
] as const;

const PRIVACY_ROWS = [
  { key: "deposit", a: "Public deposit", b: "public", c: "linkable", d: "public", e: "none", tint: "var(--peach)" },
  { key: "transfer", a: "Unlink → Unlink transfer", b: "private", c: "private", d: "private", e: "none", tint: "var(--mist)" },
  { key: "withdrawal", a: "Public withdrawal", b: "private", c: "public EVM", d: "public", e: "none", tint: "var(--peach)" },
  { key: "swap", a: "Unlink-funded swap", b: "private", c: "execution account", d: "public", e: "public", tint: "var(--sand)" },
] as const;

// ── Account card ────────────────────────────────────────────────────────────

function acctMeta(
  status: AccountStatus,
  wallet: string,
  unlinkAddress: string | null,
  derive: () => void,
) {
  // The real derived address; the demo constant remains only for the in-memory
  // demo adapter, whose session reports it as its unlinkAddress anyway.
  const shownUnlink = unlinkAddress ?? DEMO_SENDER;
  if (status === "registered") {
    return {
      glyph: "🔓",
      tint: "var(--mist)",
      title: "Registered",
      body:
        "Your Unlink account is derived and registered on " +
        CHAIN.env +
        ". Deposits, transfers and swaps are open; the spending key stayed in this browser.",
      ctaLabel: "Go to deposit",
      ctaBg: "var(--navy)",
      ctaFg: "#fff",
      action: derive,
      chipLabel: "registered",
      chipBg: "var(--mist)",
      chipFg: "var(--ink)",
      chipDot: "var(--navy)",
      // The full address, for the copy button and the QR. A recipient can only
      // be paid privately once someone has this string verbatim, so it must be
      // shareable without retyping bech32m by hand.
      shareAddress: shownUnlink,
      fields: [
        { label: "unlink1 address", value: short(shownUnlink, 18, 8) },
        { label: "App id", value: CHAIN.appId },
        { label: "Environment", value: CHAIN.env },
        { label: "Pool", value: short(ADDR.pool, 10, 6) },
      ],
    };
  }
  if (status === "derived") {
    return {
      glyph: "✍️",
      tint: "var(--sand)",
      title: "Derived, not registered",
      body:
        "The signature produced a seed-backed account for app id " +
        CHAIN.appId +
        " on chain " +
        CHAIN.id +
        ". One registration call and the pool will accept it.",
      ctaLabel: "Register with Unlink",
      ctaBg: "var(--peach)",
      ctaFg: "var(--on-tint)",
      action: derive,
      chipLabel: "derived",
      chipBg: "var(--sand)",
      chipFg: "var(--on-tint)",
      chipDot: "var(--on-tint)",
      // Derived is enough to receive: the address exists before registration.
      shareAddress: shownUnlink,
      fields: [
        { label: "unlink1 address", value: short(shownUnlink, 18, 8) },
        { label: "App id", value: CHAIN.appId },
        { label: "Chain", value: String(CHAIN.id) },
        { label: "Wallet", value: short(wallet, 10, 6) },
      ],
    };
  }
  return {
    glyph: "🔑",
    tint: "var(--peach)",
    title: "Not derived yet",
    body: "Clean Privacy has no account for this wallet. Signing the derivation message creates one locally — no email, no KYC, no server-side custody.",
    ctaLabel: "Sign to derive account",
    ctaBg: "var(--navy)",
    ctaFg: "#fff",
    action: derive,
    chipLabel: "no account",
    chipBg: "var(--peach)",
    chipFg: "var(--on-tint)",
    chipDot: "var(--on-tint)",
    shareAddress: null as string | null,
    fields: [
      { label: "Derivation", value: "wallet signature · browser only" },
      { label: "App id", value: CHAIN.appId },
      { label: "Chain", value: String(CHAIN.id) },
      { label: "Wallet", value: short(wallet, 10, 6) },
    ],
  };
}
