import type { Screen } from "../state/useCleanPrivacy";

/**
 * One path per screen, so the deployed domain addresses every tab directly:
 * `arc.cleanprivacy.org/deposit` is the deposit screen, `/` is the landing page.
 *
 * The app is a single bundle with no router library, so this table is the whole
 * contract: `screenFromPath` reads the address bar on load and on back/forward,
 * `pathForScreen` writes it on every navigation, and the static host must serve
 * `index.html` for all of these paths (see `web/README.md`).
 */
export const SCREEN_PATHS = {
  landing: "/",
  account: "/account",
  deposit: "/deposit",
  transfer: "/transfer",
  swap: "/swap",
  evidence: "/evidence",
} as const satisfies Record<Screen, string>;

/** Browser tab title per screen, so a bookmark says which tab it points at. */
const BRAND = "Clean Privacy for Arc";
const SCREEN_TITLES = {
  landing: BRAND,
  account: "Account · " + BRAND,
  deposit: "Deposit · " + BRAND,
  transfer: "Transfer · " + BRAND,
  swap: "Swap · " + BRAND,
  evidence: "Evidence · " + BRAND,
} as const satisfies Record<Screen, string>;

const SCREENS = Object.keys(SCREEN_PATHS) as Screen[];

/**
 * Trailing slashes and letter case are host-dependent: a CDN redirect can hand
 * us `/deposit/` and a hand-typed address can be `/Deposit`. Both mean the
 * deposit screen; the canonical form written back into history is lowercase and
 * has no trailing slash.
 */
function normalizePath(pathname: string): string {
  const trimmed = pathname.trim().replace(/\/+$/, "").toLowerCase();
  return trimmed === "" ? "/" : trimmed;
}

export function pathForScreen(screen: Screen): string {
  return SCREEN_PATHS[screen];
}

export function titleForScreen(screen: Screen): string {
  return SCREEN_TITLES[screen];
}

/** The screen a pathname addresses, or null when the path is not one of ours. */
export function screenFromPath(pathname: string): Screen | null {
  const normalized = normalizePath(pathname);
  return SCREENS.find((screen) => SCREEN_PATHS[screen] === normalized) ?? null;
}

/** The screen the address bar currently addresses, outside the browser null. */
export function screenFromLocation(): Screen | null {
  if (typeof window === "undefined") return null;
  return screenFromPath(window.location.pathname);
}

/**
 * True when a click on a link should be handled in-app rather than by the
 * browser. Modifier clicks and middle clicks must keep their native meaning —
 * open in a new tab, in a new window, download — which is the whole reason the
 * nav pills are anchors instead of buttons.
 */
export function isPlainLeftClick(event: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.defaultPrevented
  );
}

/**
 * Write a screen into the address bar. The query string and hash are preserved:
 * they carry deployment-level flags, never screen state, so switching tabs must
 * not drop them.
 *
 * History access throws in a sandboxed iframe, and a failure to update the URL
 * must never take the screen down with it — the render is driven by React state
 * either way.
 */
export function writeScreenToHistory(
  screen: Screen,
  mode: "push" | "replace",
): void {
  if (typeof window === "undefined") return;
  const path =
    pathForScreen(screen) + window.location.search + window.location.hash;
  try {
    if (mode === "push" && window.location.pathname === pathForScreen(screen)) {
      // Re-clicking the active tab must not stack duplicate history entries.
      return;
    }
    window.history[mode === "push" ? "pushState" : "replaceState"](
      { screen },
      "",
      path,
    );
  } catch {
    /* history is unavailable; the screen still renders */
  }
}
