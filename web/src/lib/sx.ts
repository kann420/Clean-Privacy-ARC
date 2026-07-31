import type { CSSProperties } from "react";

/**
 * The design mock carries every rule in a literal `style="..."` string. Keeping those
 * strings verbatim is what makes this port line-for-line comparable with the mock, so
 * instead of hand-translating a thousand declarations into object literals the port
 * parses them once and caches the result.
 *
 *   <div style={sx("display:flex;gap:16px")}>
 *
 * Splitting happens at top-level semicolons only, so values that contain parentheses
 * or commas (`color-mix(in srgb, var(--paper) 88%, transparent)`) survive intact.
 */
const cache = new Map<string, CSSProperties>();

const camel = (property: string): string =>
  property.startsWith("--") ? property : property.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

function split(css: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === ";" && depth === 0) {
      out.push(css.slice(start, i));
      start = i + 1;
    }
  }
  out.push(css.slice(start));
  return out;
}

export function sx(css: string): CSSProperties {
  const hit = cache.get(css);
  if (hit) return hit;
  const style: Record<string, string> = {};
  for (const declaration of split(css)) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim();
    const value = declaration.slice(colon + 1).trim();
    if (!property || !value) continue;
    style[camel(property)] = value;
  }
  const frozen = style as CSSProperties;
  cache.set(css, frozen);
  return frozen;
}

/** Same parser, plus per-render dynamic declarations that the mock interpolated. */
export function sxWith(css: string, extra: Record<string, string | undefined>): CSSProperties {
  const base = { ...(sx(css) as Record<string, string>) };
  for (const [property, value] of Object.entries(extra)) {
    if (value !== undefined) base[camel(property)] = value;
  }
  return base as CSSProperties;
}
