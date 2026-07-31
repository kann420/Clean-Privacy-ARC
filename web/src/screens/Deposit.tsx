import { sx, sxWith } from "../lib/sx";
import type { ViewModel } from "../state/viewModel";
import { DoneCard, ErrorCard, FieldError, QuickPills, Spinner, StepRow, TokenIcon } from "../components/primitives";

/** Public deposit into Unlink. The amount is checked against the spendable balance. */
export function Deposit({ vm }: { vm: ViewModel }) {
  return (
    <div data-screen-label="Deposit" style={sx("animation:cp-pop .3s var(--spring) both")}>
      <header style={sx("margin-bottom:28px")}>
        <h1
          style={sx(
            "margin:0;font-family:var(--fd);font-weight:700;font-size:40px;line-height:1.05;color:var(--ink);transform:rotate(-1deg)",
          )}
        >
          Deposit into Unlink
        </h1>
        <p style={sx("margin:8px 0 0;font-family:var(--fb);font-weight:600;font-size:16px;color:var(--ink-2)")}>
          This step is public: the chain shows your address funding the pool. Privacy starts after it lands.
        </p>
      </header>

      {vm.showBlocked ? (
        <div
          style={sx(
            "margin-bottom:22px;display:flex;flex-wrap:wrap;align-items:center;gap:18px;background:var(--peach);border:3px solid var(--ink);border-radius:28px;box-shadow:4px 4px 0 var(--pop);padding:22px 26px;animation:cp-drop .36s var(--spring) both",
          )}
        >
          <span
            aria-hidden="true"
            style={sx(
              "display:grid;place-items:center;width:52px;height:52px;flex-shrink:0;border-radius:20px;border:3px solid var(--ink);background:#fff;font-size:24px",
            )}
          >
            🔑
          </span>
          <div style={sx("min-width:220px;flex:1")}>
            <div style={sx("font-family:var(--fd);font-weight:700;font-size:22px;color:var(--on-tint)")}>{vm.blocked.title}</div>
            <div style={sx("margin-top:4px;font-family:var(--fb);font-weight:600;font-size:15px;line-height:1.5;color:var(--on-tint)")}>
              {vm.blocked.body}
            </div>
          </div>
          <button
            type="button"
            onClick={vm.blockedAction}
            className="cp-lift"
            style={sx(
              "display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:12px 20px;border-radius:18px;border:3px solid var(--ink);background:var(--ink);color:var(--cloud);font-family:var(--fb);font-weight:800;font-size:15px;box-shadow:4px 4px 0 rgba(19,33,57,.35)",
            )}
          >
            {vm.blockedActionLabel}
          </button>
        </div>
      ) : null}

      <div style={sx("display:grid;grid-template-columns:var(--c2);gap:24px;align-items:start")}>
        <div
          style={sx(
            "background:var(--cloud);border:3px solid var(--ink);border-radius:28px;box-shadow:4px 4px 0 var(--pop);padding:28px",
          )}
        >
          <div
            style={sx("font-family:var(--fb);font-weight:800;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-2)")}
          >
            Token
          </div>
          <div style={sx("margin-top:10px;display:flex;gap:10px;flex-wrap:wrap")}>
            {vm.depositTokens.map((t) => (
              <button
                key={t.symbol}
                type="button"
                onClick={t.on}
                className="cp-lift"
                style={sxWith(
                  "flex:1;min-width:150px;display:flex;align-items:center;gap:12px;border-radius:18px;border:3px solid var(--ink);padding:14px 16px;text-align:left",
                  { background: t.bg, color: t.fg, "box-shadow": t.shadow },
                )}
              >
                <TokenIcon src={t.icon} size={34} border="3px" />
                <span style={sx("min-width:0;font-family:var(--fd);font-weight:700;font-size:17px;line-height:1.1")}>{t.symbol}</span>
              </button>
            ))}
          </div>

          <div style={sx("margin-top:22px;display:flex;align-items:baseline;justify-content:space-between;gap:12px")}>
            <div
              style={sx("font-family:var(--fb);font-weight:800;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-2)")}
            >
              Amount
            </div>
            <div style={sx("font-family:var(--fb);font-weight:700;font-size:13px;color:var(--ink-2);text-align:right")}>
              public balance {vm.publicBalanceLabel}
              {vm.spendableLabel ? (
                <span style={sx("display:block;font-weight:600;font-size:12px;color:var(--ink-3)")}>{vm.spendableLabel}</span>
              ) : null}
            </div>
          </div>
          <div
            style={sxWith(
              "margin-top:10px;display:flex;align-items:center;gap:10px;border-radius:18px;background:var(--cloud-2);padding:6px 18px;box-shadow:1px 1px 0 var(--pop)",
              { border: "3px solid " + (vm.amountError ? "var(--berry)" : "var(--ink)") },
            )}
          >
            <input
              type="text"
              inputMode="decimal"
              value={vm.amount}
              onChange={(event) => vm.onAmount(event.target.value)}
              aria-label="Deposit amount"
              aria-invalid={!!vm.amountError}
              style={sx(
                "flex:1;min-width:0;border:0;background:transparent;outline:none;font-family:var(--fd);font-weight:700;font-size:34px;color:var(--ink)",
              )}
            />
            <span style={sx("font-family:var(--fb);font-weight:800;font-size:14px;color:var(--ink-2)")}>{vm.depositSymbol}</span>
          </div>
          {vm.amountError ? <FieldError>{vm.amountError}</FieldError> : null}
          <QuickPills picks={vm.depositPcts} />

          <div style={sx("margin-top:24px;display:flex;flex-wrap:wrap;gap:12px;align-items:center")}>
            <button
              type="button"
              onClick={vm.depositCtaAction}
              disabled={vm.depositBusy}
              className="cp-raise"
              style={sx(
                "display:inline-flex;align-items:center;justify-content:center;gap:10px;min-height:50px;padding:14px 26px;border-radius:18px;border:3px solid var(--ink);background:var(--navy);color:#fff;font-family:var(--fb);font-weight:800;font-size:16px;box-shadow:4px 4px 0 var(--pop)",
              )}
            >
              {vm.depositBusy ? <Spinner /> : null}
              {vm.depositCta}
            </button>
            {/*
              The pool faucet only ever funded a subset of the tokens, so the
              in-app button failed for the rest. Circle's own testnet faucet
              covers them, and a link cannot fail inside this screen.
            */}
            {vm.showFaucet ? (
              <a
                href={vm.faucetHref}
                target="_blank"
                rel="noreferrer"
                style={sx(
                  "display:inline-flex;align-items:center;justify-content:center;min-height:50px;padding:12px 18px;border-radius:18px;border:3px solid var(--ink);background:var(--sand);color:var(--ink);font-family:var(--fb);font-weight:800;text-decoration:none",
                )}
              >
                Request Testnet Faucet ↗
              </a>
            ) : null}
          </div>

          {vm.depositError ? (
            <ErrorCard title={vm.depositError.title} body={vm.depositError.body} actionLabel="Resume by txId" onAction={vm.runDeposit} />
          ) : null}

          {vm.depositDone ? (
            <DoneCard title={vm.depositDone.title} body={vm.depositDone.body}>
              <a
                href={vm.depositDone.href}
                target="_blank"
                rel="noreferrer"
                style={sx(
                  "display:inline-block;margin-top:10px;border-radius:999px;border:3px solid var(--ink);background:#fff;color:var(--ink);padding:7px 14px;font-family:var(--fm);font-size:12px;text-decoration:none;box-shadow:1px 1px 0 var(--pop)",
                )}
              >
                {vm.depositDone.tx} ↗
              </a>
            </DoneCard>
          ) : null}
        </div>

        <div style={sx("display:grid;gap:20px")}>
          <div
            style={sx(
              "background:var(--cloud);border:3px solid var(--ink);border-radius:28px;box-shadow:4px 4px 0 var(--pop);padding:26px",
            )}
          >
            <h3 style={sx("margin:0 0 16px;font-family:var(--fd);font-weight:700;font-size:20px;color:var(--ink)")}>What happens</h3>
            <div style={sx("display:grid;gap:12px")}>
              {vm.depositSteps.map((s) => (
                <StepRow key={s.label} row={s} />
              ))}
            </div>
          </div>
          <div
            style={sx(
              "background:var(--cloud-2);border:3px solid var(--ink);border-radius:28px;box-shadow:4px 4px 0 var(--pop);padding:22px;transform:rotate(-.5deg)",
            )}
          >
            <div style={sx("display:flex;align-items:center;gap:10px")}>
              <span
                aria-hidden="true"
                style={sx(
                  "display:grid;place-items:center;width:28px;height:28px;border-radius:999px;border:3px solid var(--ink);background:var(--sand);font-size:13px",
                )}
              >
                🔒
              </span>
              <div
                style={sx(
                  "font-family:var(--fb);font-weight:800;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-2)",
                )}
              >
                Private balance
              </div>
            </div>
            <div style={sx("margin-top:12px;display:grid;gap:8px")}>
              {vm.privateBalances.map((p) => (
                <div
                  key={p.symbol}
                  style={sx(
                    "display:flex;align-items:center;justify-content:space-between;gap:12px;border-radius:14px;border:3px solid var(--ink);background:var(--cloud);padding:10px 14px",
                  )}
                >
                  <span
                    style={sx("display:inline-flex;align-items:center;gap:8px;font-family:var(--fb);font-weight:800;font-size:13px;color:var(--ink)")}
                  >
                    <TokenIcon src={p.icon} size={20} border="2px" />
                    {p.symbol}
                  </span>
                  <span
                    style={sx("font-family:var(--fd);font-weight:700;font-size:20px;color:var(--ink);font-variant-numeric:tabular-nums")}
                  >
                    {p.amount}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
