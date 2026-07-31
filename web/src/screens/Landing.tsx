import { sx, sxWith } from "../lib/sx";
import { useStatScramble } from "../hooks/useStatScramble";
import { useVeilSprite } from "../hooks/useVeilSprite";
import { STAT_TARGETS, type ViewModel } from "../state/viewModel";
import { ArcIcon, TokenIcon, inAppLink } from "../components/primitives";

function StatMark({ mark }: { mark: string }) {
  const common = {
    width: 24,
    height: 24,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2.2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  if (mark === "shielded") {
    return (
      <svg {...common}>
        <path d="M12 3.4 18 6v5.1c0 4-2.5 7-6 9.1-3.5-2.1-6-5.1-6-9.1V6l6-2.6Z" />
        <circle cx="12" cy="11" r="2.2" />
        <path d="M9.3 11c.7-2 3-3.1 4.9-2.2" strokeWidth="1.4" />
      </svg>
    );
  }

  if (mark === "transfer") {
    return (
      <svg {...common}>
        <path d="M4 12h15m-5-5 5 5-5 5" />
        <path d="M4 7.5h5M4 16.5h5" strokeWidth="1.7" />
      </svg>
    );
  }

  if (mark === "swap") {
    return (
      <svg {...common}>
        <path d="M4 8h15m-4-4 4 4-4 4M20 16H5m4 4-4-4 4-4" />
      </svg>
    );
  }

  return (
    <svg {...common}>
      <path d="m13 3.5-7 10h5.2l-.7 7 7.5-10h-5.4l.4-7Z" fill="var(--peach)" />
    </svg>
  );
}

/** Marketing screen: hero, counters, demo video, how it works, disclosure, contracts. */
export function Landing({ vm }: { vm: ViewModel }) {
  const petRef = useVeilSprite();
  const scramble = useStatScramble(true, STAT_TARGETS);
  const stats = vm.landingStats.map((stat, i) => ({
    ...stat,
    value: scramble?.[i] ?? STAT_TARGETS[i] ?? "",
  }));

  return (
    <div data-screen-label="Landing" style={sx("animation:cp-pop .3s var(--spring) both")}>
      <section style={sx("display:grid;grid-template-columns:var(--hero);gap:32px;align-items:center")}>
        <div>
          <span style={sx("display:flex;flex-wrap:wrap;align-items:center;gap:10px")}>
            <span
              style={sx(
                "display:inline-flex;align-items:center;gap:11px;border-radius:999px;border:3px solid var(--ink);background:var(--mist);color:var(--ink);padding:5px 18px 5px 5px;box-shadow:2px 2px 0 var(--pop)",
              )}
            >
              <ArcIcon size={34} inner={19} />
              <span style={sx("font-family:var(--fd);font-weight:700;font-size:16px;line-height:1;white-space:nowrap")}>
                Arc Testnet
              </span>
            </span>
            <span
              style={sx(
                "display:inline-flex;align-items:center;gap:8px;border-radius:999px;border:3px solid var(--ink);background:var(--cloud);color:var(--ink);padding:8px 16px;box-shadow:2px 2px 0 var(--pop);font-family:var(--fb);font-weight:800;font-size:12px;text-transform:uppercase;letter-spacing:.08em",
              )}
            >
              <span
                aria-hidden="true"
                style={sx("width:9px;height:9px;border-radius:999px;background:var(--peach);border:1.5px solid var(--ink)")}
              />
              powered by Unlink
            </span>
          </span>

          <h1
            style={sx(
              "margin:18px 0 0;font-family:var(--fd);font-weight:700;font-size:58px;line-height:1.12;letter-spacing:-.02em;color:var(--ink)",
            )}
          >
            Private{" "}
            <span style={sx("position:relative;display:inline-block;vertical-align:baseline")}>
              <span aria-hidden="true" style={sx("visibility:hidden")}>
                Transfer
              </span>
              <span style={sx("position:absolute;inset:0;overflow:hidden")}>
                <span
                  style={sx(
                    "display:grid;grid-template-rows:repeat(3,1fr);height:300%;animation:cp-swap 4.6s cubic-bezier(.72,0,.28,1) infinite",
                  )}
                >
                  <span style={sx("color:var(--arc)")}>Transfer</span>
                  <span style={sx("color:var(--arc)")}>Swap</span>
                  <span aria-hidden="true" style={sx("color:var(--arc)")}>
                    Transfer
                  </span>
                </span>
              </span>
            </span>
            <br />
            for <span style={sx("color:var(--arc)")}>Arc</span> Assets.
          </h1>
          <p
            style={sx(
              "margin:18px 0 0;max-width:56ch;font-family:var(--fb);font-weight:600;font-size:17px;line-height:1.6;color:var(--ink-2)",
            )}
          >
            Shield USDC, EURC or cirBTC in Unlink, move them privately, then spend them on Arc. No gate, no KYC claim.
          </p>
          <p style={sx("margin:14px 0 0;font-family:var(--fd);font-weight:600;font-size:18px;color:var(--ink);transform:rotate(-.6deg)")}>
            Private balances for you. Public settlement for Arc.
          </p>
          <div style={sx("margin-top:28px;display:flex;flex-wrap:wrap;gap:12px")}>
            <a
              href={vm.accountHref}
              onClick={inAppLink(vm.goAccount)}
              className="cp-raise"
              style={sx(
                "display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;padding:14px 24px;border-radius:18px;border:3px solid var(--ink);background:var(--navy);color:#fff;font-family:var(--fb);font-weight:800;font-size:16px;box-shadow:4px 4px 0 var(--pop);text-decoration:none",
              )}
            >
              Enter the pool
            </a>
            <a
              href={vm.evidenceHref}
              onClick={inAppLink(vm.goDisclosure)}
              className="cp-raise"
              style={sx(
                "display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;padding:14px 24px;border-radius:18px;border:3px solid var(--ink);background:var(--cloud);color:var(--ink);font-family:var(--fb);font-weight:800;font-size:16px;box-shadow:4px 4px 0 var(--pop);text-decoration:none",
              )}
            >
              What stays private
            </a>
          </div>
        </div>

        <div style={sx("display:grid;place-items:center")}>
          <div style={sx("position:relative;display:grid;place-items:center;animation:cp-bob 3.4s ease-in-out infinite")}>
            <div
              role="img"
              aria-label="Veil, the Clean Privacy mascot"
              ref={petRef}
              style={sx(
                'width:250px;height:271px;background-image:url("/assets/mascot/veil-sprite.webp");background-repeat:no-repeat;background-size:800% 1100%;background-position:0% 0%;filter:drop-shadow(0 14px 10px rgba(19,33,57,.18))',
              )}
            />
            <div
              aria-hidden="true"
              style={sx("width:186px;height:24px;margin-top:-10px;border-radius:999px;background:rgba(19,33,57,.14);filter:blur(3px)")}
            />
          </div>
        </div>
      </section>

      <section style={sx("margin-top:40px;display:grid;grid-template-columns:var(--c4);gap:16px")}>
        {stats.map((s) => (
          <div
            key={s.caption}
            style={sx(
              "background:var(--cloud);border:3px solid var(--ink);border-radius:28px;box-shadow:4px 4px 0 var(--pop);padding:20px",
            )}
          >
            <div style={sx("display:flex;align-items:center;gap:12px")}>
              <span
                aria-hidden="true"
                style={sxWith(
                  "display:grid;place-items:center;width:40px;height:40px;flex-shrink:0;border-radius:999px;border:3px solid var(--ink);box-shadow:1px 1px 0 var(--pop);font-family:var(--fd);font-weight:700;font-size:16px;color:var(--on-tint)",
                  { background: s.tint },
                )}
              >
                <StatMark mark={s.mark} />
              </span>
              <div style={sx("min-width:0")}>
                <div
                  style={sx(
                    "font-family:var(--fd);font-weight:700;font-size:30px;line-height:1;color:var(--ink);font-variant-numeric:tabular-nums",
                  )}
                >
                  {s.value}
                  <span style={sx("margin-left:5px;font-family:var(--fb);font-weight:800;font-size:13px;color:var(--ink-2)")}>
                    {s.suffix}
                  </span>
                </div>
                <div
                  style={sx(
                    "margin-top:5px;font-family:var(--fb);font-weight:800;font-size:11px;text-transform:uppercase;letter-spacing:.02em;line-height:1.25;color:var(--ink-2);white-space:nowrap",
                  )}
                >
                  {s.caption}
                </div>
              </div>
            </div>
          </div>
        ))}
      </section>

      <section style={sx("margin-top:40px")}>
        <div style={sx("display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:20px")}>
          <h2 style={sx("margin:0;font-family:var(--fd);font-weight:700;font-size:32px;color:var(--ink);transform:rotate(-1deg)")}>
            See it in one minute
          </h2>
          <span
            style={sx("font-family:var(--fb);font-weight:800;font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:var(--ink-2)")}
          >
            derive → deposit → transfer → swap
          </span>
        </div>
        <div
          style={sx(
            "border:3px solid var(--ink);border-radius:28px;background:var(--ink);box-shadow:6px 6px 0 var(--pop);overflow:hidden",
          )}
        >
          {/* Served from /public or a CDN via VITE_DEMO_VIDEO_URL; never inlined. */}
          <video
            src={vm.videoSrc}
            controls
            playsInline
            preload="metadata"
            style={sx("display:block;width:100%;aspect-ratio:16/9;background:var(--ink)")}
          />
        </div>
      </section>

      <section style={sx("margin-top:40px")}>
        <h2 style={sx("margin:0 0 20px;font-family:var(--fd);font-weight:700;font-size:32px;color:var(--ink);transform:rotate(-1deg)")}>
          How it works
        </h2>
        <div style={sx("display:grid;grid-template-columns:var(--c3);gap:20px")}>
          {vm.howItWorks.map((h) => (
            <div
              key={h.step}
              style={sx(
                "background:var(--cloud);border:3px solid var(--ink);border-radius:28px;box-shadow:4px 4px 0 var(--pop);padding:24px",
              )}
            >
              <span
                aria-hidden="true"
                style={sxWith(
                  "display:grid;place-items:center;width:44px;height:44px;border-radius:18px;border:3px solid var(--ink);box-shadow:1px 1px 0 var(--pop);font-family:var(--fd);font-weight:700;font-size:18px;color:var(--on-tint)",
                  { background: h.tint },
                )}
              >
                {h.step}
              </span>
              <h3 style={sx("margin:16px 0 0;font-family:var(--fd);font-weight:700;font-size:21px;color:var(--ink)")}>{h.title}</h3>
              <p style={sx("margin:8px 0 0;font-family:var(--fb);font-weight:600;font-size:15px;line-height:1.6;color:var(--ink-2)")}>
                {h.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section style={sx("margin-top:40px;display:grid;grid-template-columns:var(--c2r);gap:20px;align-items:start")}>
        <div
          style={sx(
            "background:var(--lilac);border:3px solid var(--ink);border-radius:28px;box-shadow:4px 4px 0 var(--pop);padding:26px",
          )}
        >
          <h2 style={sx("margin:0;font-family:var(--fd);font-weight:700;font-size:24px;color:var(--ink)")}>We say what leaks</h2>
          <p
            style={sx(
              "margin:10px 0 0;max-width:52ch;font-family:var(--fb);font-weight:600;font-size:15px;line-height:1.6;color:var(--ink)",
            )}
          >
            An Unlink-funded swap is not a confidential swap. It hides which private account paid; the execution account, the
            pair, the amount and the calldata stay visible on Arc. Deposits and withdrawals are public by design.
            Unlink-to-Unlink transfers are the flow that hides everything.
          </p>
          <a
            href={vm.evidenceHref}
            onClick={inAppLink(vm.goDisclosure)}
            className="cp-lift"
            style={sx(
              "margin-top:18px;display:inline-flex;align-items:center;min-height:44px;padding:12px 20px;border-radius:16px;border:3px solid var(--ink);background:var(--cloud);color:var(--ink);font-family:var(--fb);font-weight:800;font-size:14px;box-shadow:3px 3px 0 var(--pop);text-decoration:none",
            )}
          >
            Read the disclosure table
          </a>
        </div>
        <div
          style={sx(
            "background:var(--cloud);border:3px solid var(--ink);border-radius:28px;box-shadow:4px 4px 0 var(--pop);padding:26px;transform:rotate(.6deg)",
          )}
        >
          <div
            style={sx("font-family:var(--fb);font-weight:800;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-2)")}
          >
            Assets live on Arc
          </div>
          <div style={sx("margin-top:14px;display:grid;gap:10px")}>
            {vm.assetList.map((a) => (
              <div
                key={a.symbol}
                style={sx(
                  "display:flex;align-items:center;gap:12px;border-radius:16px;border:3px solid var(--ink);background:var(--cloud-2);padding:10px 14px",
                )}
              >
                <TokenIcon src={a.icon} size={30} />
                <span style={sx("min-width:0;flex:1")}>
                  <span style={sx("display:block;font-family:var(--fd);font-weight:700;font-size:15px;line-height:1.1;color:var(--ink)")}>
                    {a.symbol}
                  </span>
                  <span style={sx("display:block;margin-top:2px;font-family:var(--fm);font-size:11px;color:var(--ink-2)")}>
                    {a.note}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section
        style={sx(
          "margin-top:40px;background:var(--cloud);border:3px solid var(--ink);border-radius:28px;box-shadow:4px 4px 0 var(--pop);padding:28px",
        )}
      >
        <div style={sx("display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px")}>
          <h2 style={sx("margin:0;font-family:var(--fd);font-weight:700;font-size:24px;color:var(--ink)")}>Deployed on Arc Testnet</h2>
          <span
            style={sx(
              "display:inline-flex;align-items:center;gap:8px;border-radius:999px;border:3px solid var(--ink);background:var(--mist);padding:5px 14px;font-family:var(--fm);font-size:12px;color:var(--ink);box-shadow:1px 1px 0 var(--pop)",
            )}
          >
            testnet.arcscan.app
          </span>
        </div>
        <p
          style={sx(
            "margin:12px 0 0;font-family:var(--fb);font-weight:800;font-size:12px;text-transform:uppercase;letter-spacing:.02em;color:var(--ink-2)",
          )}
        >
          every address verifiable on the Arc explorer
        </p>
        <div style={sx("margin-top:18px;display:grid;grid-template-columns:var(--c2e);gap:10px")}>
          {vm.contracts.map((c) => (
            <a
              key={c.label}
              href={c.href}
              target="_blank"
              rel="noreferrer"
              className="cp-lift"
              style={sx(
                "display:flex;align-items:center;justify-content:space-between;gap:12px;text-decoration:none;border-radius:18px;border:3px solid var(--ink);background:var(--cloud-2);padding:12px 16px;box-shadow:1px 1px 0 var(--pop)",
              )}
            >
              <span style={sx("font-family:var(--fb);font-weight:800;font-size:13px;color:var(--ink)")}>{c.label}</span>
              <span style={sx("font-family:var(--fm);font-size:12px;color:var(--berry)")}>{c.short} ↗</span>
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}
