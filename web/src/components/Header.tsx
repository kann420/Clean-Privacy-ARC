import { sx, sxWith } from "../lib/sx";
import { ConnectButton } from "@rainbow-me/rainbowkit/components";
import type { ViewModel } from "../state/viewModel";
import { ArcIcon, inAppLink } from "./primitives";

/** Sticky app header: brand, in-app nav, private balance, account chip, network, wallet. */
export function Header({ vm }: { vm: ViewModel }) {
  return (
    <header
      style={sx(
        "position:sticky;top:0;z-index:40;border-bottom:3px solid var(--ink);background:color-mix(in srgb, var(--paper) 88%, transparent);backdrop-filter:blur(10px)",
      )}
    >
      <div style={sx("display:flex;width:100%;align-items:center;justify-content:space-between;gap:16px;padding:12px 20px")}>
        <div style={sx("display:flex;min-width:0;align-items:center;gap:16px")}>
          <a
            href={vm.landingHref}
            onClick={inAppLink(vm.goLanding)}
            aria-label="Clean Privacy home"
            style={sx("display:flex;align-items:center;gap:10px;background:none;border:0;padding:0;text-decoration:none;color:inherit")}
          >
            <img
              src="/assets/brand/cleanprivacy-mark-arc.png"
              alt=""
              aria-hidden="true"
              width={46}
              height={46}
              style={sx("display:block;width:46px;height:46px;flex-shrink:0")}
            />
            <span style={sx("font-family:var(--fd);font-weight:700;font-size:20px;line-height:1;color:var(--ink);white-space:nowrap")}>
              <span style={sx("color:var(--arc)")}>Clean</span> Privacy
            </span>
            <span
              style={sx(
                "display:inline-flex;align-items:center;gap:6px;border-radius:999px;border:2.5px solid var(--ink);background:var(--cloud);padding:3px 9px 3px 4px;font-family:var(--fb);font-weight:800;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-2)",
              )}
            >
              <ArcIcon size={18} inner={11} border="0px" />
              for Arc
            </span>
          </a>

          {vm.inApp ? (
            <nav data-cp-nav="wide" style={sx("display:var(--nav-inline);align-items:center;gap:8px;flex-shrink:0")}>
              {vm.nav.map((n) => (
                <a
                  key={n.id}
                  href={n.href}
                  onClick={inAppLink(n.on)}
                  aria-current={n.active ? "page" : undefined}
                  className="cp-nudge"
                  style={sxWith(
                    "display:inline-flex;align-items:center;flex-shrink:0;white-space:nowrap;border-radius:999px;padding:6px 14px;font-family:var(--fb);font-weight:800;font-size:14px;text-decoration:none",
                    { border: "3px solid " + n.border, background: n.bg, color: n.fg, "box-shadow": n.shadow },
                  )}
                >
                  {n.label}
                </a>
              ))}
            </nav>
          ) : null}
        </div>

        <div style={sx("display:flex;flex-shrink:0;align-items:center;gap:10px")}>
          {vm.inApp ? (
            <>
              <span
                style={sxWith(
                  "display:inline-flex;align-items:center;gap:7px;border-radius:999px;border:3px solid var(--ink);padding:5px 12px;font-family:var(--fb);font-weight:800;font-size:12px;text-transform:uppercase;letter-spacing:.02em;box-shadow:1px 1px 0 var(--pop)",
                  { background: vm.acct.chipBg, color: vm.acct.chipFg },
                )}
              >
                <span
                  aria-hidden="true"
                  style={sxWith("width:8px;height:8px;border-radius:999px", { background: vm.acct.chipDot })}
                />
                {vm.acct.chipLabel}
              </span>

              <span
                style={sx(
                  "display:inline-flex;align-items:center;gap:9px;border-radius:999px;border:3px solid var(--ink);background:var(--mist);color:var(--ink);padding:4px 13px 4px 4px;box-shadow:1px 1px 0 var(--pop)",
                )}
              >
                <ArcIcon size={26} inner={15} />
                <span style={sx("display:block")}>
                  <span style={sx("display:block;font-family:var(--fd);font-weight:700;font-size:13px;line-height:1;white-space:nowrap")}>
                    Arc Testnet
                  </span>
                  <span style={sx("display:block;margin-top:2px;font-family:var(--fm);font-size:10px;line-height:1;color:var(--ink-2)")}>
                    chain 5042002
                  </span>
                </span>
              </span>

              <RainbowWalletChip fallbackLabel={vm.shortWallet} />
            </>
          ) : null}

          <button
            type="button"
            onClick={vm.toggleTheme}
            aria-label="Toggle dark mode"
            className="cp-nudge"
            style={sx(
              "display:grid;place-items:center;width:38px;height:38px;border-radius:999px;border:3px solid var(--ink);background:var(--cloud);box-shadow:1px 1px 0 var(--pop)",
            )}
          >
            <span style={sx("font-family:var(--fb);font-weight:800;font-size:14px")}>{vm.themeIcon}</span>
          </button>
        </div>
      </div>

      {vm.inApp ? (
        <nav
          data-cp-nav="compact"
          style={sx("display:var(--nav-row);align-items:center;gap:8px;overflow-x:auto;border-top:3px solid var(--hair);padding:9px 20px")}
        >
          {vm.nav.map((n) => (
            <a
              key={n.id}
              href={n.href}
              onClick={inAppLink(n.on)}
              aria-current={n.active ? "page" : undefined}
              style={sxWith(
                "display:inline-flex;align-items:center;flex-shrink:0;white-space:nowrap;border-radius:999px;border:3px solid var(--ink);padding:6px 14px;font-family:var(--fb);font-weight:800;font-size:13px;box-shadow:1px 1px 0 var(--pop);text-decoration:none",
                { background: n.rowBg, color: n.rowFg },
              )}
            >
              {n.label}
            </a>
          ))}
        </nav>
      ) : null}
    </header>
  );
}

function RainbowWalletChip({ fallbackLabel }: { fallbackLabel: string }) {
  return (
    <ConnectButton.Custom>
      {({
        account,
        chain,
        mounted,
        openAccountModal,
        openChainModal,
        openConnectModal,
      }) => {
        const connected = mounted && account && chain;
        const label = !connected
          ? fallbackLabel
          : chain.unsupported
            ? "wrong network"
            : account.displayName;
        const action = !connected
          ? openConnectModal
          : chain.unsupported
            ? openChainModal
            : openAccountModal;

        return (
          <button
            type="button"
            onClick={action}
            disabled={!mounted}
            aria-label={connected ? "Open wallet details" : "Connect wallet"}
            style={sx(
              "display:inline-flex;align-items:center;gap:8px;border-radius:999px;border:3px solid var(--ink);background:var(--cloud);padding:6px 12px;box-shadow:1px 1px 0 var(--pop);font-family:var(--fm);font-size:12px;color:var(--ink)",
            )}
          >
            <span
              aria-hidden="true"
              style={sx(
                "width:10px;height:10px;border-radius:999px;background:var(--peach);border:1.5px solid var(--ink)",
              )}
            />
            {label}
          </button>
        );
      }}
    </ConnectButton.Custom>
  );
}
