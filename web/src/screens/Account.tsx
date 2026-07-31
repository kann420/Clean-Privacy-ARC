import { useEffect, useMemo, useRef, useState } from "react";
import { encodeQR } from "qr";
import { sx, sxWith } from "../lib/sx";
import { ConnectButton } from "@rainbow-me/rainbowkit/components";
import type { ViewModel } from "../state/viewModel";
import { ErrorCard, Spinner } from "../components/primitives";

/** Derivation and registration. The spending key is derived in the browser only. */
export function Account({
  vm,
  showBurnerChoice = false,
  onBurner,
}: {
  vm: ViewModel;
  showBurnerChoice?: boolean;
  onBurner?: () => void;
}) {
  return (
    <div data-screen-label="Account" style={sx("animation:cp-pop .3s var(--spring) both")}>
      <header style={sx("display:flex;flex-wrap:wrap;align-items:center;gap:16px;margin-bottom:28px")}>
        <div>
          <h1
            style={sx(
              "margin:0;font-family:var(--fd);font-weight:700;font-size:40px;line-height:1.05;color:var(--ink);transform:rotate(-1deg)",
            )}
          >
            Derive your private account
          </h1>
          <p style={sx("margin:8px 0 0;font-family:var(--fb);font-weight:600;font-size:16px;color:var(--ink-2)")}>
            One wallet signature, no sign-up. The signature never leaves your browser.
          </p>
        </div>
      </header>

      <div style={sx("display:grid;grid-template-columns:var(--c2v);gap:24px;align-items:start")}>
        <div
          style={sx(
            "background:var(--cloud);border:3px solid var(--ink);border-radius:28px;box-shadow:4px 4px 0 var(--pop);padding:32px",
          )}
        >
          <div style={sx("display:flex;align-items:center;gap:16px")}>
            <span
              aria-hidden="true"
              style={sxWith(
                "display:grid;place-items:center;width:64px;height:64px;flex-shrink:0;border-radius:24px;border:3px solid var(--ink);box-shadow:2px 2px 0 var(--pop);font-size:26px",
                { background: vm.acct.tint },
              )}
            >
              {vm.acct.glyph}
            </span>
            <div>
              <div
                style={sx(
                  "font-family:var(--fb);font-weight:800;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-2)",
                )}
              >
                Unlink account
              </div>
              <div style={sx("font-family:var(--fd);font-weight:700;font-size:30px;line-height:1.1;color:var(--ink)")}>
                {vm.acct.title}
              </div>
            </div>
          </div>
          <p style={sx("margin:20px 0 0;font-family:var(--fb);font-weight:600;font-size:16px;line-height:1.6;color:var(--ink-2)")}>
            {vm.acct.body}
          </p>

          <div style={sx("margin-top:22px;display:grid;grid-template-columns:var(--c2e);gap:10px")}>
            {vm.acct.fields.map((f) => (
              <div
                key={f.label}
                style={sx("border-radius:18px;border:3px solid var(--ink);background:var(--cloud-2);padding:12px 14px")}
              >
                <div
                  style={sx(
                    "font-family:var(--fb);font-weight:800;font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:var(--ink-2)",
                  )}
                >
                  {f.label}
                </div>
                <div style={sx("margin-top:4px;font-family:var(--fm);font-size:13px;color:var(--ink);word-break:break-all")}>
                  {f.value}
                </div>
              </div>
            ))}
          </div>

          <div style={sx("margin-top:24px;display:flex;flex-wrap:wrap;gap:12px;align-items:center")}>
            {showBurnerChoice ? (
              <InjectedConnectButton
                label="Connect wallet"
                background={vm.acct.ctaBg}
                color={vm.acct.ctaFg}
              />
            ) : (
              <button
                type="button"
                onClick={vm.acct.action}
                disabled={vm.signing}
                className="cp-raise"
                style={sxWith(
                  "display:inline-flex;align-items:center;justify-content:center;gap:10px;min-height:48px;padding:14px 24px;border-radius:18px;border:3px solid var(--ink);font-family:var(--fb);font-weight:800;font-size:16px;box-shadow:4px 4px 0 var(--pop)",
                  { background: vm.acct.ctaBg, color: vm.acct.ctaFg },
                )}
              >
                {vm.acct.ctaLabel}
              </button>
            )}
            {showBurnerChoice && onBurner ? (
              <button
                type="button"
                onClick={onBurner}
                disabled={vm.signing}
                className="cp-raise"
                title="Creates a local testnet-only key in this browser"
                style={sx(
                  "display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:14px 20px;border-radius:18px;border:3px solid var(--ink);background:var(--sand);color:var(--ink);font-family:var(--fb);font-weight:800;font-size:15px;box-shadow:3px 3px 0 var(--pop)",
                )}
              >
                Use local burner · testnet
              </button>
            ) : null}
            {vm.signing ? (
              <span style={sx("display:inline-flex;align-items:center;gap:10px;font-family:var(--fb);font-weight:700;font-size:14px;color:var(--ink-2)")}>
                <Spinner color="var(--navy)" />
                {vm.signingNote}
              </span>
            ) : null}
          </div>
          {showBurnerChoice ? (
            <p
              style={sx(
                "margin:12px 0 0;font-family:var(--fb);font-weight:600;font-size:12px;line-height:1.5;color:var(--ink-2)",
              )}
            >
              Browser wallets open in RainbowKit. The burner is a local Arc
              Testnet fallback whose private key must be exported before
              clearing browser storage.
            </p>
          ) : null}

          {vm.accountError ? <ErrorCard title={vm.accountError.title} body={vm.accountError.body} /> : null}
        </div>

        <div style={sx("display:grid;gap:20px")}>
          {vm.acct.shareAddress ? <ReceiveCard address={vm.acct.shareAddress} /> : null}
          <div
            style={sx(
              "background:var(--cloud);border:3px solid var(--ink);border-radius:28px;box-shadow:4px 4px 0 var(--pop);padding:26px;transform:rotate(.6deg)",
            )}
          >
            <h3 style={sx("margin:0;font-family:var(--fd);font-weight:700;font-size:20px;color:var(--ink)")}>
              Derivation is permanent
            </h3>
            <ul style={sx("margin:14px 0 0;padding:0;list-style:none;display:grid;gap:10px")}>
              {vm.unlocks.map((u) => (
                <li
                  key={u.text}
                  style={sx(
                    "display:flex;align-items:flex-start;gap:10px;font-family:var(--fb);font-weight:600;font-size:15px;line-height:1.5;color:var(--ink-2)",
                  )}
                >
                  <span
                    aria-hidden="true"
                    style={sxWith(
                      "display:grid;place-items:center;width:22px;height:22px;flex-shrink:0;margin-top:1px;border-radius:999px;border:2.5px solid var(--ink);font-size:11px;color:var(--on-tint);font-weight:800",
                      { background: u.tint },
                    )}
                  >
                    ✓
                  </span>
                  {u.text}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Hand the derived `unlink1` address to whoever wants to pay this account.
 *
 * A private transfer needs the recipient's address verbatim — bech32m is not
 * something anyone should retype from a truncated label, so the full string
 * lives here behind a copy button and a QR for phone-to-phone hand-off.
 */
function ReceiveCard({ address }: { address: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "manual">("idle");
  const [showQr, setShowQr] = useState(false);
  const addressRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (copyState === "idle") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 2400);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  // Reset both affordances when the account changes, so the card can never show
  // "Copied" or a QR belonging to a previous derivation.
  useEffect(() => {
    setCopyState("idle");
    setShowQr(false);
  }, [address]);

  /**
   * The Clipboard API needs a secure context and a permission the browser can
   * still refuse. When it does, select the address instead of failing silently:
   * the user finishes the copy with the keyboard, which is far better than a
   * dead button on the one string a private transfer cannot work without.
   */
  const copy = () => {
    const selectAddress = () => {
      const node = addressRef.current;
      const selection = window.getSelection();
      if (node && selection) {
        const range = document.createRange();
        range.selectNodeContents(node);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      setCopyState("manual");
    };
    try {
      void navigator.clipboard
        .writeText(address)
        .then(() => setCopyState("copied"))
        .catch(selectAddress);
    } catch {
      selectAddress();
    }
  };

  const copied = copyState === "copied";

  return (
    <div
      style={sx(
        "background:var(--cloud);border:3px solid var(--ink);border-radius:28px;box-shadow:4px 4px 0 var(--pop);padding:26px",
      )}
    >
      <h3 style={sx("margin:0;font-family:var(--fd);font-weight:700;font-size:20px;color:var(--ink)")}>
        Receive privately
      </h3>
      <p style={sx("margin:8px 0 0;font-family:var(--fb);font-weight:600;font-size:14px;line-height:1.6;color:var(--ink-2)")}>
        Share this address to be paid inside the pool. Nothing about the payment
        reaches Arc.
      </p>
      <div
        ref={addressRef}
        style={sx(
          "margin-top:14px;border-radius:18px;border:3px solid var(--ink);background:var(--cloud-2);padding:12px 14px;font-family:var(--fm);font-size:12px;line-height:1.6;color:var(--ink);word-break:break-all",
        )}
      >
        {address}
      </div>
      <div style={sx("margin-top:14px;display:flex;flex-wrap:wrap;gap:10px")}>
        <button
          type="button"
          onClick={copy}
          className="cp-raise"
          style={sxWith(
            "display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:11px 18px;border-radius:16px;border:3px solid var(--ink);font-family:var(--fb);font-weight:800;font-size:14px;box-shadow:3px 3px 0 var(--pop)",
            copied
              ? { background: "var(--mist)", color: "var(--ink)" }
              : { background: "var(--navy)", color: "#fff" },
          )}
        >
          {copied ? "Copied ✓" : "Copy address"}
        </button>
        <button
          type="button"
          onClick={() => setShowQr((on) => !on)}
          aria-expanded={showQr}
          className="cp-raise"
          style={sx(
            "display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:11px 18px;border-radius:16px;border:3px solid var(--ink);background:var(--sand);color:var(--ink);font-family:var(--fb);font-weight:800;font-size:14px;box-shadow:3px 3px 0 var(--pop)",
          )}
        >
          {showQr ? "Hide QR" : "Show QR"}
        </button>
      </div>
      {copyState === "manual" ? (
        <p style={sx("margin:10px 0 0;font-family:var(--fb);font-weight:700;font-size:13px;color:var(--ink-2)")}>
          The browser blocked the clipboard. The address is selected — press
          Ctrl/⌘+C.
        </p>
      ) : null}
      {showQr ? (
        <div
          style={sx(
            "margin-top:16px;display:grid;place-items:center;border-radius:18px;border:3px solid var(--ink);background:#fff;padding:16px",
          )}
        >
          <QrCode text={address} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The `qr` matrix rendered as one SVG path — one element instead of a rect per
 * cell, and no `dangerouslySetInnerHTML` for a string we can build ourselves.
 */
function QrCode({ text }: { text: string }) {
  const qr = useMemo(() => {
    const matrix = encodeQR(text, "raw", { ecc: "medium" });
    const quiet = 2;
    const size = matrix.length + quiet * 2;
    let path = "";
    matrix.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
      });
    });
    return { size, path };
  }, [text]);

  return (
    <svg
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      width="196"
      height="196"
      shapeRendering="crispEdges"
      role="img"
      aria-label="QR code of the unlink1 address"
    >
      <rect width={qr.size} height={qr.size} fill="#fff" />
      <path d={qr.path} fill="var(--ink)" />
    </svg>
  );
}

function InjectedConnectButton({
  label,
  background,
  color,
}: {
  label: string;
  background: string;
  color: string;
}) {
  return (
    <ConnectButton.Custom>
      {({ mounted, openConnectModal }) => (
        <button
          type="button"
          onClick={openConnectModal}
          disabled={!mounted}
          className="cp-raise"
          style={sxWith(
            "display:inline-flex;align-items:center;justify-content:center;gap:10px;min-height:48px;padding:14px 24px;border-radius:18px;border:3px solid var(--ink);font-family:var(--fb);font-weight:800;font-size:16px;box-shadow:4px 4px 0 var(--pop)",
            { background, color },
          )}
        >
          {label}
        </button>
      )}
    </ConnectButton.Custom>
  );
}
