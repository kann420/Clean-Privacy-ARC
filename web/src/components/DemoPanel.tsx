import { sx, sxWith } from "../lib/sx";
import type { ViewModel } from "../state/viewModel";

/**
 * Demo controls, ported unchanged from the mock. They exist only in explicit
 * demo mode; live account state and failures are SDK-owned.
 */
export function DemoPanel({ vm }: { vm: ViewModel }) {
  return (
    <div
      style={sx(
        "position:fixed;bottom:16px;right:16px;z-index:50;width:236px;background:var(--cloud);border:3px solid var(--ink);border-radius:24px;box-shadow:4px 4px 0 var(--pop);padding:16px",
      )}
    >
      <div style={sx("display:flex;align-items:center;justify-content:space-between;gap:8px")}>
        <span
          style={sx(
            "font-family:var(--fb);font-weight:800;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-2)",
          )}
        >
          Demo controls
        </span>
        <button
          type="button"
          onClick={vm.hideDemo}
          aria-label="Hide demo controls"
          style={sx("border:0;background:none;font-family:var(--fb);font-weight:800;font-size:14px;color:var(--ink-3);padding:0")}
        >
          ×
        </button>
      </div>
      <div
        style={sx(
          "margin-top:10px;font-family:var(--fb);font-weight:800;font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-3)",
        )}
      >
        Account state
      </div>
      <div style={sx("margin-top:6px;display:flex;gap:6px")}>
        {vm.demoStates.map((d) => (
          <button
            key={d.key}
            type="button"
            onClick={d.on}
            style={sxWith(
              "flex:1;border-radius:999px;border:2.5px solid var(--ink);padding:6px 4px;font-family:var(--fb);font-weight:800;font-size:10px;text-transform:uppercase",
              { background: d.bg, color: d.fg },
            )}
          >
            {d.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={vm.toggleFail}
        style={sxWith(
          "margin-top:10px;width:100%;border-radius:14px;border:2.5px solid var(--ink);padding:8px;font-family:var(--fb);font-weight:800;font-size:11px",
          { background: vm.failBg, color: vm.failFg },
        )}
      >
        {vm.failLabel}
      </button>
      <button
        type="button"
        onClick={vm.resetDemo}
        style={sx(
          "margin-top:6px;width:100%;border-radius:14px;border:2.5px solid var(--ink);background:var(--cloud-2);color:var(--ink);padding:8px;font-family:var(--fb);font-weight:800;font-size:11px",
        )}
      >
        Reset demo
      </button>
    </div>
  );
}
