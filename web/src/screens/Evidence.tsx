import { sx, sxWith } from "../lib/sx";
import type { ViewModel } from "../state/viewModel";
import { Spinner } from "../components/primitives";

const GRID = "display:grid;grid-template-columns:1.5fr .9fr 1.1fr 1.2fr .9fr;gap:12px";

/** Two views: the account's own operation records, and the privacy disclosure table. */
export function Evidence({ vm }: { vm: ViewModel }) {
  return (
    <div data-screen-label="Evidence" style={sx("animation:cp-pop .3s var(--spring) both")}>
      <header
        style={sx("display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:26px")}
      >
        <div>
          <h1
            className="cp-screen-title"
            style={sx(
              "margin:0;font-family:var(--fd);font-weight:700;font-size:40px;line-height:1.05;color:var(--ink);transform:rotate(-1deg)",
            )}
          >
            {vm.ev.title}
          </h1>
          <p style={sx("margin:8px 0 0;max-width:60ch;font-family:var(--fb);font-weight:600;font-size:16px;color:var(--ink-2)")}>
            {vm.ev.subtitle}
          </p>
        </div>
        <div
          style={sx(
            "display:flex;gap:8px;padding:5px;border-radius:999px;border:3px solid var(--ink);background:var(--cloud);box-shadow:2px 2px 0 var(--pop)",
          )}
        >
          {vm.evModes.map((m) => (
            <button
              key={m.label}
              type="button"
              onClick={m.on}
              style={sxWith(
                "border-radius:999px;border:0;padding:9px 18px;font-family:var(--fb);font-weight:800;font-size:13px;text-transform:uppercase;letter-spacing:.03em",
                { background: m.bg, color: m.fg },
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
      </header>

      <div style={sx("display:grid;grid-template-columns:var(--c3);gap:16px;margin-bottom:22px")}>
        {vm.evStats.map((s) => (
          <div
            className="cp-card"
            key={s.caption}
            style={sx(
              "background:var(--cloud);border:3px solid var(--ink);border-radius:28px;box-shadow:4px 4px 0 var(--pop);padding:20px",
            )}
          >
            <div
              style={sx(
                "font-family:var(--fb);font-weight:800;font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:var(--ink-2)",
              )}
            >
              {s.caption}
            </div>
            <div
              style={sx(
                "margin-top:6px;font-family:var(--fd);font-weight:700;font-size:30px;line-height:1;color:var(--ink);font-variant-numeric:tabular-nums",
              )}
            >
              {s.value}
              <span style={sx("margin-left:5px;font-family:var(--fb);font-weight:800;font-size:13px;color:var(--ink-2)")}>{s.suffix}</span>
            </div>
          </div>
        ))}
      </div>

      <div
        className="cp-card"
        style={sx("background:var(--cloud);border:3px solid var(--ink);border-radius:28px;box-shadow:4px 4px 0 var(--pop);padding:26px")}
      >
        <div style={sx("display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px")}>
          <h3 style={sx("margin:0;font-family:var(--fd);font-weight:700;font-size:22px;color:var(--ink)")}>{vm.ev.tableTitle}</h3>
          <a
            href={vm.poolHref}
            target="_blank"
            rel="noreferrer"
            style={sx(
              "border-radius:999px;border:3px solid var(--ink);background:var(--cloud-2);color:var(--ink);padding:7px 14px;font-family:var(--fm);font-size:12px;text-decoration:none;box-shadow:1px 1px 0 var(--pop)",
            )}
          >
            {vm.poolLabel}
          </a>
        </div>

        <div className="cp-evidence-scroll" style={sx("margin-top:18px;overflow-x:auto")}>
          <div style={sx(GRID + ";padding:0 4px 10px;border-bottom:3px solid var(--hair);min-width:680px")}>
            {vm.evColumns.map((c) => (
              <div
                key={c.label}
                style={sx(
                  "font-family:var(--fb);font-weight:800;font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:var(--ink-2)",
                )}
              >
                {c.label}
              </div>
            ))}
          </div>
          <div style={sx("display:grid;min-width:680px")}>
            {vm.evRows.map((r) => (
              <div key={r.key} style={sx(GRID + ";align-items:center;padding:14px 4px;border-bottom:3px solid var(--hair)")}>
                <div style={sx("font-family:var(--fb);font-weight:800;font-size:13px;color:var(--ink)")}>{r.a}</div>
                <div style={sx("font-family:var(--fb);font-weight:700;font-size:13px;color:var(--ink-2)")}>{r.b}</div>
                <div
                  style={sx(
                    "font-family:var(--fd);font-weight:700;font-size:15px;color:var(--ink);font-variant-numeric:tabular-nums;word-break:break-all",
                  )}
                >
                  {r.c}
                </div>
                <div style={sx("font-family:var(--fm);font-size:12px;color:var(--ink-2);word-break:break-all")}>{r.d}</div>
                <div>
                  <span
                    style={sxWith(
                      "display:inline-flex;align-items:center;gap:5px;border-radius:999px;border:2.5px solid var(--ink);color:var(--on-tint);padding:3px 10px;font-family:var(--fb);font-weight:800;font-size:10px;text-transform:uppercase;letter-spacing:.03em",
                      { background: r.tint },
                    )}
                  >
                    {r.e}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
        {vm.evEmpty ? (
          <p style={sx("margin:16px 0 0;font-family:var(--fb);font-weight:600;font-size:14px;color:var(--ink-3)")}>{vm.evEmpty}</p>
        ) : null}
        <p
          style={sx(
            "margin:16px 0 0;max-width:78ch;font-family:var(--fb);font-weight:600;font-size:14px;line-height:1.6;color:var(--ink-2)",
          )}
        >
          {vm.ev.note}
        </p>
      </div>

      <div style={sx("margin-top:22px;display:grid;grid-template-columns:var(--c2r);gap:20px;align-items:start")}>
        <div
          className="cp-card"
          style={sx("background:var(--cloud);border:3px solid var(--ink);border-radius:28px;box-shadow:4px 4px 0 var(--pop);padding:26px")}
        >
          <h3 style={sx("margin:0;font-family:var(--fd);font-weight:700;font-size:20px;color:var(--ink)")}>Recovery, not retries</h3>
          <p
            style={sx(
              "margin:8px 0 0;max-width:56ch;font-family:var(--fb);font-weight:600;font-size:15px;line-height:1.6;color:var(--ink-2)",
            )}
          >
            Every accepted transaction and execution id is written to a checkpoint before anything is signed. A timeout polls
            the same id; it never resubmits. Ambiguous balances hard-stop instead of guessing.
          </p>
          <div style={sx("margin-top:16px;display:flex;flex-wrap:wrap;gap:10px")}>
            <button
              type="button"
              onClick={vm.exportEvidence}
              disabled={vm.exportBusy}
              className="cp-raise"
              style={sx(
                "display:inline-flex;align-items:center;gap:10px;min-height:46px;padding:12px 22px;border-radius:18px;border:3px solid var(--ink);background:var(--peach);color:var(--on-tint);font-family:var(--fb);font-weight:800;font-size:15px;box-shadow:4px 4px 0 var(--pop)",
              )}
            >
              {vm.exportBusy ? <Spinner size={15} /> : null}
              {vm.exportCta}
            </button>
            <span style={sx("align-self:center;font-family:var(--fb);font-weight:700;font-size:13px;color:var(--ink-3)")}>
              {vm.exportNote}
            </span>
          </div>
        </div>
        <div
          className="cp-card"
          style={sx("background:var(--cloud-2);border:3px solid var(--ink);border-radius:28px;box-shadow:4px 4px 0 var(--pop);padding:24px")}
        >
          <div
            style={sx("font-family:var(--fb);font-weight:800;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-2)")}
          >
            Execution account
          </div>
          <div
            style={sx(
              "margin-top:10px;border-radius:14px;border:3px solid var(--ink);background:var(--cloud);padding:12px;font-family:var(--fm);font-size:12px;line-height:1.7;color:var(--ink);word-break:break-all",
            )}
          >
            {vm.eaLine1}
            <br />
            {vm.eaLine2}
            <br />
            {vm.eaLine3}
          </div>
        </div>
      </div>
    </div>
  );
}
