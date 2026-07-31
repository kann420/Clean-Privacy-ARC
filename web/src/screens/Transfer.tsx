import { sx, sxWith } from "../lib/sx";
import type { ViewModel } from "../state/viewModel";
import { DoneCard, ErrorCard, FieldError, QuickPills, Spinner, TokenIcon } from "../components/primitives";

/**
 * One send screen for two protocols. An `unlink1` recipient is a fully private
 * Unlink-to-Unlink transfer; a `0x` recipient is a withdrawal whose destination and
 * amount are public. The screen switches its own disclosure before anything is signed.
 */
export function Transfer({ vm }: { vm: ViewModel }) {
  return (
    <div data-screen-label="Transfer" style={sx("animation:cp-pop .3s var(--spring) both")}>
      <header style={sx("margin-bottom:28px")}>
        <h1
          style={sx(
            "margin:0;font-family:var(--fd);font-weight:700;font-size:40px;line-height:1.05;color:var(--ink);transform:rotate(-1deg)",
          )}
        >
          {vm.sendTitle}
        </h1>
        <p style={sx("margin:8px 0 0;font-family:var(--fb);font-weight:600;font-size:16px;color:var(--ink-2)")}>
          {vm.sendLead}
        </p>
      </header>

      <div style={sx("display:grid;grid-template-columns:var(--c2);gap:24px;align-items:start")}>
        <div
          style={sx(
            "background:var(--cloud);border:3px solid var(--ink);border-radius:28px;box-shadow:4px 4px 0 var(--pop);padding:28px",
          )}
        >
          <div
            style={sx("font-family:var(--fb);font-weight:800;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-2)")}
          >
            Recipient · unlink1 address or 0x wallet
          </div>
          <div
            style={sxWith("margin-top:10px;border-radius:18px;background:var(--cloud-2);padding:14px 18px;box-shadow:1px 1px 0 var(--pop)", {
              border: "3px solid " + (vm.recipientError ? "var(--berry)" : "var(--ink)"),
            })}
          >
            <input
              type="text"
              value={vm.recipient}
              onChange={(event) => vm.onRecipient(event.target.value)}
              aria-label="Recipient"
              aria-invalid={!!vm.recipientError}
              spellCheck={false}
              style={sx("width:100%;border:0;background:transparent;outline:none;font-family:var(--fm);font-size:13px;color:var(--ink)")}
            />
          </div>
          {vm.recipientError ? <FieldError>{vm.recipientError}</FieldError> : null}

          <div
            style={sx(
              "margin-top:20px;font-family:var(--fb);font-weight:800;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-2)",
            )}
          >
            Token
          </div>
          <div style={sx("margin-top:10px;display:flex;gap:8px;flex-wrap:wrap")}>
            {vm.transferTokens.map((t) => (
              <button
                key={t.symbol}
                type="button"
                onClick={t.on}
                className="cp-nudge"
                style={sxWith(
                  "display:inline-flex;align-items:center;gap:8px;border-radius:999px;border:3px solid var(--ink);padding:7px 14px;font-family:var(--fb);font-weight:800;font-size:13px",
                  { background: t.bg, color: t.fg, "box-shadow": t.shadow },
                )}
              >
                <TokenIcon src={t.icon} size={22} />
                {t.symbol}
              </button>
            ))}
          </div>

          <div style={sx("margin-top:20px;display:flex;align-items:baseline;justify-content:space-between;gap:12px")}>
            <div
              style={sx("font-family:var(--fb);font-weight:800;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-2)")}
            >
              Amount
            </div>
            <div style={sx("display:flex;align-items:center;gap:8px")}>
              <span style={sx("font-family:var(--fb);font-weight:700;font-size:13px;color:var(--ink-2)")}>
                private balance {vm.transferBalanceLabel}
              </span>
              {/* The masking control sits on the balance it masks; the header pill it used to live on is gone. */}
              <button
                type="button"
                onClick={vm.toggleMask}
                aria-label={vm.maskCta}
                title={vm.maskCta}
                className="cp-nudge"
                style={sx(
                  "display:grid;place-items:center;width:26px;height:26px;flex-shrink:0;border-radius:999px;border:2.5px solid var(--ink);background:var(--cloud-2);box-shadow:1px 1px 0 var(--pop);font-size:12px;line-height:1",
                )}
              >
                <span aria-hidden="true">{vm.maskIcon}</span>
              </button>
            </div>
          </div>
          <div
            style={sxWith(
              "margin-top:10px;display:flex;align-items:center;gap:10px;border-radius:18px;background:var(--cloud-2);padding:6px 18px;box-shadow:1px 1px 0 var(--pop)",
              { border: "3px solid " + (vm.transferAmountError ? "var(--berry)" : "var(--ink)") },
            )}
          >
            <input
              type="text"
              inputMode="decimal"
              value={vm.transferAmount}
              onChange={(event) => vm.onTransferAmount(event.target.value)}
              aria-label="Transfer amount"
              aria-invalid={!!vm.transferAmountError}
              style={sx(
                "flex:1;min-width:0;border:0;background:transparent;outline:none;font-family:var(--fd);font-weight:700;font-size:34px;color:var(--ink)",
              )}
            />
            <span style={sx("font-family:var(--fb);font-weight:800;font-size:14px;color:var(--ink-2)")}>{vm.transferSymbol}</span>
          </div>
          {vm.transferAmountError ? <FieldError>{vm.transferAmountError}</FieldError> : null}
          <QuickPills picks={vm.transferPcts} />

          <div style={sx("margin-top:16px;display:grid;gap:6px")}>
            <div
              style={sx(
                "display:flex;align-items:center;justify-content:space-between;gap:12px;font-family:var(--fb);font-weight:700;font-size:13px;color:var(--ink-2)",
              )}
            >
              <span>Protocol fee</span>
              <span style={sx("font-family:var(--fm);font-size:12px;color:var(--ink);text-align:right")}>
                {vm.transferFeeLabel}
              </span>
            </div>
            <div
              style={sx(
                "display:flex;align-items:center;justify-content:space-between;gap:12px;font-family:var(--fb);font-weight:800;font-size:13px;color:var(--ink)",
              )}
            >
              <span>You pay in total</span>
              <span style={sx("font-family:var(--fm);font-size:12px;text-align:right")}>{vm.transferTotalLabel}</span>
            </div>
            <div style={sx("font-family:var(--fb);font-weight:600;font-size:12px;color:var(--ink-3)")}>
              The recipient receives the full amount; the fee is {vm.feeDestination}.
            </div>
          </div>

          {vm.sendBanner ? (
            <div
              style={sxWith(
                "margin-top:20px;display:flex;align-items:flex-start;gap:12px;border-radius:18px;border:3px solid var(--ink);padding:14px 16px",
                { background: vm.sendBanner.tint },
              )}
            >
              <span
                aria-hidden="true"
                style={sx(
                  "display:grid;place-items:center;width:30px;height:30px;flex-shrink:0;border-radius:999px;border:3px solid var(--ink);background:var(--cloud);font-size:14px",
                )}
              >
                {vm.sendBanner.glyph}
              </span>
              <div>
                <div style={sx("font-family:var(--fd);font-weight:700;font-size:15px;color:var(--on-tint)")}>
                  {vm.sendBanner.title}
                </div>
                <div style={sx("margin-top:2px;font-family:var(--fb);font-weight:700;font-size:14px;line-height:1.5;color:var(--on-tint)")}>
                  {vm.sendBanner.body}
                </div>
              </div>
            </div>
          ) : null}

          {vm.hygieneWarnings.map((warning) => (
            <div
              key={warning}
              role="alert"
              style={sx(
                "margin-top:10px;display:flex;align-items:flex-start;gap:10px;border-radius:18px;border:3px solid var(--berry);background:var(--cloud-2);padding:12px 14px;font-family:var(--fb);font-weight:700;font-size:13px;line-height:1.5;color:var(--ink)",
              )}
            >
              <span aria-hidden="true">⚠</span>
              <span>{warning}</span>
            </div>
          ))}

          <div style={sx("margin-top:22px;display:flex;flex-wrap:wrap;gap:12px")}>
            <button
              type="button"
              onClick={vm.transferCtaAction}
              disabled={vm.transferBusy}
              className="cp-raise"
              style={sxWith(
                "display:inline-flex;align-items:center;justify-content:center;gap:10px;min-height:50px;padding:14px 26px;border-radius:18px;border:3px solid var(--ink);font-family:var(--fb);font-weight:800;font-size:16px;box-shadow:4px 4px 0 var(--pop)",
                { background: vm.transferCtaBg, color: vm.transferCtaFg },
              )}
            >
              {vm.transferBusy ? <Spinner /> : null}
              {vm.transferCta}
            </button>
          </div>

          {vm.transferError ? (
            <ErrorCard title={vm.transferError.title} body={vm.transferError.body} actionLabel="Resume by txId" onAction={vm.runTransfer} />
          ) : null}

          {vm.transferDone ? (
            <DoneCard title={vm.transferDone.title} body={vm.transferDone.body}>
              {vm.transferDone.href ? (
                <a
                  href={vm.transferDone.href}
                  target="_blank"
                  rel="noreferrer"
                  style={sx(
                    "display:inline-block;margin-top:10px;border-radius:999px;border:3px solid var(--ink);background:#fff;color:var(--ink);padding:7px 14px;font-family:var(--fm);font-size:12px;text-decoration:none;box-shadow:1px 1px 0 var(--pop)",
                  )}
                >
                  {vm.transferDone.tx} ↗
                </a>
              ) : (
                <div
                  style={sx(
                    "margin-top:10px;display:inline-block;border-radius:999px;border:3px solid var(--ink);background:#fff;color:var(--ink);padding:6px 14px;font-family:var(--fm);font-size:12px",
                  )}
                >
                  {vm.transferDone.tx}
                </div>
              )}
            </DoneCard>
          ) : null}
        </div>

        <div style={sx("display:grid;gap:20px")}>
          {vm.sendGuides.map((guide) => (
            <div
              key={guide.title}
              style={sx(
                "background:var(--cloud);border:3px solid var(--ink);border-radius:28px;box-shadow:4px 4px 0 var(--pop);padding:26px",
              )}
            >
              <h3 style={sx("margin:0;font-family:var(--fd);font-weight:700;font-size:20px;color:var(--ink)")}>
                {guide.title}
              </h3>
              <div style={sx("margin-top:14px;display:grid;gap:12px")}>
                {guide.items.map((item) => (
                  <div
                    key={item.label}
                    style={sxWith("border-radius:18px;border:3px solid var(--ink);padding:12px 14px", {
                      background: item.tint,
                    })}
                  >
                    <div style={sx("font-family:var(--fb);font-weight:800;font-size:13px;color:var(--on-tint)")}>
                      {item.label}
                    </div>
                    <div
                      style={sx(
                        "margin-top:4px;font-family:var(--fb);font-weight:600;font-size:13px;line-height:1.55;color:var(--on-tint)",
                      )}
                    >
                      {item.body}
                    </div>
                  </div>
                ))}
              </div>
              <p
                style={sx(
                  "margin:12px 0 0;font-family:var(--fb);font-weight:600;font-size:12px;line-height:1.55;color:var(--ink-3)",
                )}
              >
                {guide.note}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
