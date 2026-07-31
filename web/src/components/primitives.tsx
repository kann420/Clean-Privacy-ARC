import type { ReactNode } from "react";
import { sx, sxWith } from "../lib/sx";

/**
 * The three shapes the mock repeated inside every screen. The mock had to inline them
 * because its template language has no components; the markup they produce is identical.
 */

/** Token badge: white disc, chunky outline, icon filling it. */
export function TokenIcon({ src, size, border = "2.5px" }: { src: string; size: number; border?: string }) {
  return (
    <span
      aria-hidden="true"
      style={sxWith(
        "display:grid;place-items:center;flex-shrink:0;border-radius:999px;background:#FFFFFF;overflow:hidden",
        { width: size + "px", height: size + "px", border: border + " solid var(--ink)" },
      )}
    >
      <img src={src} alt="" width={size} height={size} style={sx("display:block;width:100%;height:100%")} />
    </span>
  );
}

/** Arc icon disc, used in the header pill and the landing badges. */
export function ArcIcon({ size, inner, border = "2.5px" }: { size: number; inner: number; border?: string }) {
  return (
    <span
      aria-hidden="true"
      style={sxWith("display:grid;place-items:center;flex-shrink:0;border-radius:999px;background:#FFFFFF;overflow:hidden", {
        width: size + "px",
        height: size + "px",
        border: border + " solid var(--ink)",
      })}
    >
      <img
        src="/assets/brand/arc-icon-navy.svg"
        alt=""
        width={inner}
        height={inner}
        style={sxWith("display:block", { width: inner + "px", height: inner + "px" })}
      />
    </span>
  );
}

/** Busy ring. `color: current` follows the button label, matching the mock. */
export function Spinner({ size = 16, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <span
      aria-hidden="true"
      style={sxWith("display:inline-block;border-radius:999px;border-top-color:transparent;animation:cp-spin .7s linear infinite", {
        width: size + "px",
        height: size + "px",
        border: "3px solid " + color,
        "border-top-color": "transparent",
      })}
    />
  );
}

/** Field-level validation message. Nothing in the mock corresponded to this. */
export function FieldError({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      style={sx(
        "margin-top:8px;display:flex;align-items:flex-start;gap:8px;font-family:var(--fb);font-weight:700;font-size:13px;line-height:1.45;color:var(--berry)",
      )}
    >
      <span aria-hidden="true">⚠</span>
      <span>{children}</span>
    </div>
  );
}

/** Recoverable-operation error card: title, body, and one retry that polls by id. */
export function ErrorCard({
  title,
  body,
  actionLabel,
  onAction,
}: {
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div
      role="alert"
      style={sx(
        "margin-top:18px;display:flex;gap:12px;border-radius:18px;border:3px solid var(--berry);background:var(--cloud-2);padding:14px 16px",
      )}
    >
      <span aria-hidden="true" style={sx("font-size:18px")}>
        ⚠️
      </span>
      <div>
        <div style={sx("font-family:var(--fd);font-weight:700;font-size:16px;color:var(--berry)")}>{title}</div>
        <div style={sx("margin-top:3px;font-family:var(--fb);font-weight:600;font-size:14px;line-height:1.5;color:var(--ink-2)")}>
          {body}
        </div>
        {actionLabel && onAction ? (
          <button
            type="button"
            onClick={onAction}
            style={sx(
              "margin-top:10px;border-radius:999px;border:3px solid var(--ink);background:var(--cloud);color:var(--ink);padding:7px 16px;font-family:var(--fb);font-weight:800;font-size:13px;box-shadow:1px 1px 0 var(--pop)",
            )}
          >
            {actionLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Success card shown after a deposit, transfer or swap settles. */
export function DoneCard({ title, body, children }: { title: string; body: string; children?: ReactNode }) {
  return (
    <div
      style={sx(
        "margin-top:18px;border-radius:18px;border:3px solid var(--ink);background:var(--sand);padding:16px 18px;box-shadow:2px 2px 0 var(--pop);animation:cp-drop .36s var(--spring) both",
      )}
    >
      <div style={sx("font-family:var(--fd);font-weight:700;font-size:19px;color:var(--on-tint)")}>{title}</div>
      <div style={sx("margin-top:4px;font-family:var(--fb);font-weight:600;font-size:14px;color:var(--on-tint)")}>{body}</div>
      {children}
    </div>
  );
}

/** Quick 25/50/75/Max pills under an amount field. */
export function QuickPills({ picks }: { picks: { label: string; on: () => void; bg: string; fg: string }[] }) {
  return (
    <div style={sx("margin-top:10px;display:flex;gap:8px")}>
      {picks.map((q) => (
        <button
          key={q.label}
          type="button"
          onClick={q.on}
          className="cp-lift"
          style={sxWith(
            "flex:1;min-width:0;border-radius:999px;border:3px solid var(--ink);padding:8px 10px;font-family:var(--fb);font-weight:800;font-size:12px;text-transform:uppercase;letter-spacing:.03em;box-shadow:1px 1px 0 var(--pop)",
            { background: q.bg, color: q.fg },
          )}
        >
          {q.label}
        </button>
      ))}
    </div>
  );
}

/** Numbered step or phase row, shared by the deposit and swap side panels. */
export function StepRow({
  row,
}: {
  row: { label: string; detail: string; mark: string; dot: string; bg: string; border: string };
}) {
  return (
    <div
      style={sxWith("display:flex;gap:14px;align-items:flex-start;border-radius:18px;padding:14px 16px", {
        border: "3px solid " + row.border,
        background: row.bg,
      })}
    >
      <span
        aria-hidden="true"
        style={sxWith(
          "display:grid;place-items:center;width:30px;height:30px;flex-shrink:0;border-radius:999px;border:3px solid var(--ink);font-family:var(--fd);font-weight:700;font-size:13px;color:var(--on-tint)",
          { background: row.dot },
        )}
      >
        {row.mark}
      </span>
      <div style={sx("min-width:0")}>
        <div style={sx("font-family:var(--fb);font-weight:800;font-size:14px;color:var(--ink)")}>{row.label}</div>
        <div style={sx("margin-top:3px;font-family:var(--fm);font-size:12px;line-height:1.5;color:var(--ink-2);word-break:break-word")}>
          {row.detail}
        </div>
      </div>
    </div>
  );
}
