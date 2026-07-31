import { sx } from "./lib/sx";
import { DemoPanel } from "./components/DemoPanel";
import { Header } from "./components/Header";
import { Account } from "./screens/Account";
import { Deposit } from "./screens/Deposit";
import { Evidence } from "./screens/Evidence";
import { Landing } from "./screens/Landing";
import { Swap } from "./screens/Swap";
import { Transfer } from "./screens/Transfer";
import { useCleanPrivacy, type AppProps } from "./state/useCleanPrivacy";
import { buildViewModel } from "./state/viewModel";
import { WalletBridge } from "./wallet/WalletBridge";

/**
 * Application shell, one to one with the mock's root element: header, single <main> that
 * renders exactly one screen, and the fixed demo panel.
 */
export default function App(props: AppProps) {
  const store = useCleanPrivacy(props);
  const vm = buildViewModel(store);

  return (
    <div className="cp-app" style={sx("min-height:100vh;font-family:var(--fb);font-weight:600;color:var(--ink)")}>
      <WalletBridge store={store} />
      <Header vm={vm} />

      <div
        className="cp-testnet-notice"
        style={sx(
          "position:sticky;top:73px;z-index:35;border-bottom:3px solid var(--ink);padding:8px 20px;text-align:center;font-family:var(--fm);font-size:12px;font-weight:800;background:var(--sand)",
        )}
      >
        <span className="cp-notice-long">
          Clean Privacy for ARC is currently only available on testnet. We are
          working hard every day to ship the best product and will deploy to
          mainnet in the future. We welcome feedback to improve the product.
        </span>
        <span className="cp-notice-mobile">
          Arc Testnet only · Mainnet is not live yet · Feedback welcome
        </span>
      </div>

      {store.backend.mode === "live" &&
      typeof navigator !== "undefined" &&
      !navigator.locks ? (
        <div style={sx("padding:12px 20px;background:var(--peach);text-align:center")}>
          Web Locks are unavailable in this browser. Live mutations are
          disabled; demo mode is unaffected.
        </div>
      ) : null}

      {store.session.wallet && !store.session.chainOk ? (
        <div style={sx("padding:12px 20px;background:var(--peach);text-align:center")}>
          The wallet is on the wrong network.{" "}
          <button type="button" onClick={store.actions.switchChain}>
            Switch to Arc Testnet
          </button>
        </div>
      ) : null}

      {store.backend.mode === "live" && store.state.accountError ? (
        <section
          className="cp-app-alert"
          style={sx(
            "margin:20px auto 0;width:min(1072px,calc(100% - 48px));border:3px solid var(--ink);border-radius:18px;background:var(--peach);padding:16px;box-shadow:4px 4px 0 var(--pop)",
          )}
        >
          <strong>{store.state.accountError.title}</strong>
          <p style={sx("margin:6px 0 12px")}>
            {store.state.accountError.body}
          </p>
          <button type="button" onClick={store.actions.retrySession}>
            Retry live backend
          </button>
        </section>
      ) : null}

      {store.session.pendingOperation && !store.state.operationBusy ? (
        <section
          className="cp-app-alert cp-recovery-alert"
          style={sx(
            "margin:20px auto 0;width:min(1072px,calc(100% - 48px));border:3px solid var(--ink);border-radius:18px;background:var(--peach);padding:16px;box-shadow:4px 4px 0 var(--pop)",
          )}
        >
          <strong>Saved operation: {store.session.pendingOperation.state}</strong>
          <p style={sx("margin:6px 0 12px")}>
            New mutations are blocked. Resume polls accepted ids and never
            blindly resubmits.
          </p>
          <button type="button" onClick={store.actions.resumePending}>
            Resume saved operation
          </button>
          {store.session.pendingOperation.kind === "swap" &&
          [
            "phaseA_processed",
            "plan_captured",
            "recovery_pending",
            "manual_recovery_required",
          ].includes(store.session.pendingOperation.state) ? (
            <button
              type="button"
              onClick={store.actions.returnPendingSwapToPool}
              style={sx("margin-left:8px")}
            >
              Return funds to pool
            </button>
          ) : null}
          {/*
            Documented exit from the hard stop. It archives the entry only after
            proving on-chain that the ExecutionAccount holds nothing and has no
            allowance, so it can never hide stranded funds — and it beats the
            previous alternative of clearing localStorage by hand, which throws
            away the ids a real recovery needs.
          */}
          {store.session.pendingOperation.state === "manual_recovery_required" ? (
            <button
              type="button"
              onClick={store.actions.archiveStuckOperation}
              style={sx("margin-left:8px")}
              title="Only succeeds when no ExecutionAccount residue or allowance remains"
            >
              Archive stuck operation
            </button>
          ) : null}
          {/*
            Recovery failures used to render ONLY on the deposit screen, so a
            refused resume or return-to-pool looked like a dead button
            everywhere else (Phase 4 G5 live finding). Surface it right where
            the action is taken.
          */}
          {store.state.blocked ? (
            <p
              style={sx(
                "margin:12px 0 0;padding:10px;border:2px solid var(--ink);border-radius:12px;background:var(--paper)",
              )}
            >
              <strong>{store.state.blocked.title}</strong>
              <br />
              {store.state.blocked.body}
            </p>
          ) : null}
        </section>
      ) : null}

      <main
        className={vm.showDemo ? "cp-main cp-main-with-demo" : "cp-main"}
        style={sx("position:relative;margin:0 auto;width:100%;max-width:1120px;padding:40px 24px 96px")}
      >
        {vm.isLanding ? <Landing vm={vm} /> : null}
        {vm.isAccount ? (
          <Account vm={vm} showConnect={!store.session.wallet} />
        ) : null}
        {vm.isDeposit ? <Deposit vm={vm} /> : null}
        {vm.isTransfer ? <Transfer vm={vm} /> : null}
        {vm.isSwap ? <Swap vm={vm} /> : null}
        {vm.isEvidence ? <Evidence vm={vm} /> : null}
      </main>

      {vm.showDemo ? <DemoPanel vm={vm} /> : null}
    </div>
  );
}
