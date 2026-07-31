import { sx, sxWith } from "../lib/sx";
import type { ViewModel } from "../state/viewModel";
import { DoneCard, ErrorCard, FieldError, QuickPills, Spinner, StepRow, TokenIcon } from "../components/primitives";

/**
 * Unlink-funded swap. The funding account stays private; the execution account, target,
 * pair, amount and calldata are public, and the screen says so.
 */
export function Swap({ vm }: { vm: ViewModel }) {
  return (
    <div data-screen-label="Swap" style={sx("animation:cp-pop .3s var(--spring) both")}>
      <header style={sx("margin-bottom:28px")}>
        <h1
          className="cp-screen-title"
          style={sx(
            "margin:0;font-family:var(--fd);font-weight:700;font-size:40px;line-height:1.05;color:var(--ink);transform:rotate(-1deg)",
          )}
        >
          Swap
        </h1>
        <p style={sx("margin:8px 0 0;font-family:var(--fb);font-weight:600;font-size:16px;color:var(--ink-2)")}>{vm.swapLead}</p>
        <p
          style={sx(
            "margin:10px 0 0;border:3px solid var(--ink);border-radius:16px;background:var(--peach);padding:10px 14px;font-size:14px;color:var(--on-tint)",
          )}
        >
          {vm.swapFeeDisclosure}
        </p>
      </header>

      <div style={sx("display:grid;grid-template-columns:var(--c2);gap:24px;align-items:start")}>
        <div
          className="cp-card cp-form-card"
          style={sx(
            "background:var(--cloud);border:3px solid var(--ink);border-radius:28px;box-shadow:4px 4px 0 var(--pop);padding:28px",
          )}
        >
          <div
            style={sx("font-family:var(--fb);font-weight:800;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-2)")}
          >
            Route
          </div>
          <div style={sx("margin-top:10px;display:flex;gap:10px;flex-wrap:wrap")}>
            {vm.routes.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={r.on}
                className="cp-lift"
                style={sxWith(
                  "flex:1;min-width:180px;display:flex;flex-direction:column;gap:3px;border-radius:18px;border:3px solid var(--ink);padding:12px 16px;text-align:left",
                  { background: r.bg, color: r.fg, "box-shadow": r.shadow },
                )}
              >
                <span style={sx("font-family:var(--fd);font-weight:700;font-size:16px;line-height:1.1")}>{r.label}</span>
                <span style={sx("font-family:var(--fb);font-weight:700;font-size:12px;opacity:.78")}>{r.venue}</span>
              </button>
            ))}
          </div>

          <div
            style={sxWith("margin-top:18px;border-radius:22px;background:var(--cloud-2);padding:18px;box-shadow:1px 1px 0 var(--pop)", {
              border: "3px solid " + (vm.swapAmountError ? "var(--berry)" : "var(--ink)"),
            })}
          >
            <div style={sx("display:flex;align-items:center;justify-content:space-between;gap:8px")}>
              <span
                style={sx(
                  "font-family:var(--fb);font-weight:800;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-2)",
                )}
              >
                You pay
              </span>
              <span style={sx("font-family:var(--fb);font-weight:700;font-size:12px;color:var(--ink-3)")}>
                fee {vm.swapFeeLabel}
              </span>
            </div>
            <div style={sx("margin-top:8px;display:flex;align-items:center;gap:12px")}>
              <input
                type="text"
                inputMode="decimal"
                value={vm.swapAmount}
                onChange={(event) => vm.onSwapAmount(event.target.value)}
                aria-label="Swap amount"
                aria-invalid={!!vm.swapAmountError}
                style={sx(
                  "flex:1;min-width:0;border:0;background:transparent;outline:none;font-family:var(--fd);font-weight:700;font-size:36px;color:var(--ink)",
                )}
              />
              <span
                style={sx(
                  "display:inline-flex;align-items:center;gap:8px;border-radius:999px;border:3px solid var(--ink);background:var(--cloud);padding:7px 14px;box-shadow:1px 1px 0 var(--pop)",
                )}
              >
                <TokenIcon src={vm.usdcIcon} size={24} />
                <span style={sx("font-family:var(--fd);font-weight:700;font-size:16px")}>{vm.inSymbol}</span>
              </span>
            </div>
            {vm.swapAmountError ? <FieldError>{vm.swapAmountError}</FieldError> : null}
            <QuickPills picks={vm.swapPcts} />
          </div>

          <div style={sx("display:flex;justify-content:center;margin:-13px 0;position:relative;z-index:2")}>
            <button
              type="button"
              onClick={vm.onFlipRoute}
              title={vm.flipLabel}
              aria-label={vm.flipLabel}
              style={sx(
                "display:grid;place-items:center;width:40px;height:40px;border-radius:999px;border:3px solid var(--ink);background:var(--peach);box-shadow:2px 2px 0 var(--pop);font-size:16px;color:var(--on-tint);cursor:pointer;padding:0",
              )}
            >
              ⇅
            </button>
          </div>

          <div
            style={sx("border-radius:22px;border:3px solid var(--ink);background:var(--cloud-2);padding:18px;box-shadow:1px 1px 0 var(--pop)")}
          >
            <div style={sx("display:flex;align-items:center;justify-content:space-between;gap:8px")}>
              <span
                style={sx(
                  "font-family:var(--fb);font-weight:800;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-2)",
                )}
              >
                You receive
              </span>
              <span style={sx("font-family:var(--fb);font-weight:700;font-size:12px;color:var(--ink-3)")}>
                {vm.quoteLabel}
              </span>
            </div>
            <div style={sx("margin-top:8px;display:flex;align-items:center;gap:12px")}>
              <span
                style={sx(
                  "flex:1;min-width:0;font-family:var(--fd);font-weight:700;font-size:34px;color:var(--ink);font-variant-numeric:tabular-nums;word-break:break-all",
                )}
              >
                {vm.swapOut}
              </span>
              <span
                style={sx(
                  "display:inline-flex;align-items:center;gap:8px;border-radius:999px;border:3px solid var(--ink);background:var(--cloud);padding:7px 14px;box-shadow:1px 1px 0 var(--pop)",
                )}
              >
                <TokenIcon src={vm.outIcon} size={24} />
                <span style={sx("font-family:var(--fd);font-weight:700;font-size:16px")}>{vm.outSymbol}</span>
              </span>
            </div>
          </div>

          <div style={sx("margin-top:18px;display:grid;gap:8px")}>
            {vm.swapFacts.map((f) => (
              <div
                key={f.label}
                style={sx(
                  "display:flex;align-items:center;justify-content:space-between;gap:12px;font-family:var(--fb);font-weight:700;font-size:13px;color:var(--ink-2)",
                )}
              >
                <span>{f.label}</span>
                <span style={sx("font-family:var(--fm);font-size:12px;color:var(--ink);text-align:right")}>{f.value}</span>
              </div>
            ))}
          </div>

          <div style={sx("margin-top:22px")}>
            <button
              type="button"
              onClick={vm.swapCtaAction}
              disabled={vm.swapBusy}
              className="cp-raise"
              style={sxWith(
                "display:inline-flex;align-items:center;justify-content:center;gap:10px;width:100%;min-height:52px;padding:14px 26px;border-radius:18px;border:3px solid var(--ink);font-family:var(--fb);font-weight:800;font-size:16px;box-shadow:4px 4px 0 var(--pop)",
                { background: vm.swapCtaBg, color: vm.swapCtaFg },
              )}
            >
              {vm.swapBusy ? <Spinner /> : null}
              {vm.swapCta}
            </button>
          </div>

          {vm.swapError ? (
            <ErrorCard title={vm.swapError.title} body={vm.swapError.body} actionLabel="Resume execution" onAction={vm.runSwap} />
          ) : null}

          {vm.swapDone ? (
            <DoneCard title={vm.swapDone.title} body={vm.swapDone.body}>
              <a
                href={vm.swapDone.href}
                target="_blank"
                rel="noreferrer"
                style={sx(
                  "display:inline-block;margin-top:10px;border-radius:999px;border:3px solid var(--ink);background:#fff;color:var(--ink);padding:7px 14px;font-family:var(--fm);font-size:12px;text-decoration:none;box-shadow:1px 1px 0 var(--pop)",
                )}
              >
                {vm.swapDone.exec} ↗
              </a>
            </DoneCard>
          ) : null}
        </div>

        <div style={sx("display:grid;gap:20px")}>
          <div
            className="cp-card"
            style={sx(
              "background:var(--cloud);border:3px solid var(--ink);border-radius:28px;box-shadow:4px 4px 0 var(--pop);padding:26px",
            )}
          >
            <h3 style={sx("margin:0;font-family:var(--fd);font-weight:700;font-size:20px;color:var(--ink)")}>
              Two phases, one execution account
            </h3>
            <div style={sx("margin-top:16px;display:grid;gap:10px")}>
              {vm.swapRoute.map((r) => (
                <StepRow key={r.label} row={r} />
              ))}
            </div>
          </div>
          <div
            className="cp-card"
            style={sx(
              "background:var(--lilac);border:3px solid var(--ink);border-radius:28px;box-shadow:4px 4px 0 var(--pop);padding:22px;transform:rotate(.6deg)",
            )}
          >
            <div style={sx("font-family:var(--fd);font-weight:700;font-size:18px;color:var(--ink)")}>
              Partially private by design
            </div>
            <p style={sx("margin:8px 0 0;font-family:var(--fb);font-weight:600;font-size:14px;line-height:1.6;color:var(--ink)")}>
              What stays private: which account funded the swap, and — once the output returns to the pool — its new owner and
              balance. What Arc still observes: the fresh execution account, the target, the pair, the amount and the calldata.
              The link between your private balance and this trade is what the design breaks.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
