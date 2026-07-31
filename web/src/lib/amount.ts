import { isAddress } from "viem";

import { fmt } from "./format";

/**
 * Input and balance validation. The mock had none of this: the amount field accepted
 * "1.2.3", `Number("1.2.3")` became NaN, NaN was treated as 0, and the balance update
 * clamped the source with Math.max(0, balance - amount) while crediting the destination
 * in full — a 999 USDC deposit against a 19 USDC balance minted money in the demo.
 *
 * Everything here is a client-side guard for fast feedback. The backend validates the
 * same rules authoritatively; see api/mockBackend.ts for the mirrored checks.
 */

export type Parsed = { ok: true; value: number } | { ok: false; error: string };

/** Keeps the field to digits and one dot, at the token's own precision. */
export function sanitizeAmountInput(raw: string, decimals: number): string {
  const digitsAndDots = raw.replace(/[^0-9.]/g, "");
  const firstDot = digitsAndDots.indexOf(".");
  if (firstDot < 0) return digitsAndDots;
  const whole = digitsAndDots.slice(0, firstDot);
  const fraction = digitsAndDots.slice(firstDot + 1).replace(/\./g, "");
  return whole + "." + fraction.slice(0, decimals);
}

export type AmountRules = {
  symbol: string;
  decimals: number;
  /** Spendable balance, already net of any reserve such as the USDC gas buffer. */
  available: number;
  /** "public" or "private", used in the over-balance message. */
  kind: "public" | "private";
  /** Appended to the over-balance message, e.g. the gas-buffer explanation. */
  note?: string;
  /** Protocol fee charged on top; the balance must cover amount + fee. */
  fee?: number;
};

export function parseAmount(raw: string, rules: AmountRules): Parsed {
  const text = raw.trim();
  if (text === "") return { ok: false, error: "Enter an amount." };
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(text)) {
    return { ok: false, error: "Enter a plain decimal amount, for example 1.5." };
  }
  const value = Number(text);
  if (!Number.isFinite(value)) return { ok: false, error: "Enter a plain decimal amount, for example 1.5." };
  if (value <= 0) return { ok: false, error: "Amount must be greater than zero." };

  const fraction = text.split(".")[1] ?? "";
  if (fraction.length > rules.decimals) {
    return { ok: false, error: `${rules.symbol} has ${rules.decimals} decimals; remove the extra digits.` };
  }

  if (rules.available <= 0) {
    return {
      ok: false,
      error: `No spendable ${rules.kind} ${rules.symbol} balance.${rules.note ? " " + rules.note : ""}`,
    };
  }
  const fee = rules.fee ?? 0;
  if (value + fee > rules.available) {
    const feeNote =
      fee > 0
        ? ` The ${fmt(fee, rules.symbol)} ${rules.symbol} protocol fee is charged on top.`
        : "";
    return {
      ok: false,
      error:
        `Amount exceeds the spendable ${rules.kind} balance of ${fmt(rules.available, rules.symbol)} ` +
        `${rules.symbol}.${feeNote}${rules.note ? " " + rules.note : ""}`,
    };
  }
  return { ok: true, value };
}

/**
 * What the recipient field currently holds. This is what decides whether the send
 * button runs a private transfer or a public withdrawal, so the UI can disclose the
 * exposure before anything is signed.
 */
export type RecipientKind = "empty" | "unlink" | "evm" | "invalid";

export function detectRecipient(value: string): RecipientKind {
  const text = value.trim();
  if (text === "") return "empty";
  if (text.startsWith("unlink1")) return "unlink";
  if (/^0x/i.test(text)) return "evm";
  return "invalid";
}

/**
 * Unlink addresses are lowercase bech32 with an `unlink1` prefix; EVM addresses are
 * 20 bytes of hex. The backend is the authority; this only stops the obvious mistakes,
 * including an empty recipient.
 */
export function validateRecipient(value: string, self?: string): string | null {
  const text = value.trim();
  switch (detectRecipient(text)) {
    case "empty":
      return "Enter a recipient: an unlink1 address for a private transfer, or a 0x address to withdraw.";
    case "invalid":
      return "That is neither an unlink1 address nor a 0x EVM address.";
    case "evm":
      if (!/^0x[0-9a-fA-F]{40}$/.test(text)) return "An EVM address is 0x followed by 40 hex characters.";
      if (/^0x0{40}$/.test(text)) return "The zero address cannot receive a withdrawal.";
      if (
        /[a-f]/.test(text.slice(2)) &&
        /[A-F]/.test(text.slice(2)) &&
        !isAddress(text, { strict: true })
      ) {
        return "This address fails its EIP-55 checksum; re-copy it from the source.";
      }
      return null;
    case "unlink":
    default:
      if (!/^[0-9a-z]+$/.test(text)) return "unlink1 addresses are lowercase bech32; remove the invalid characters.";
      if (text.length < 60) return "That unlink1 address is too short to be a valid Unlink account.";
      if (self && text === self) return "That is your own account. Pick a different recipient.";
      return null;
  }
}

/**
 * Privacy hygiene, not validation: these are the ways a withdrawal can undo the
 * unlinkability the pool just provided. They warn, they never block.
 *
 * @param recentDeposits amounts deposited in this session, in the same token
 */
export function withdrawalWarnings(options: {
  recipient: string;
  wallet: string;
  amount: number;
  recentDeposits: number[];
}): string[] {
  const warnings: string[] = [];
  if (options.recipient.trim().toLowerCase() === options.wallet.toLowerCase()) {
    warnings.push(
      "This is the same wallet that funds your deposits. On-chain, that re-links your deposit to this withdrawal.",
    );
  }
  if (options.amount > 0 && options.recentDeposits.some((deposit) => deposit === options.amount)) {
    warnings.push(
      "This is exactly an amount you deposited in this session. Matching amounts are the easiest correlation to make.",
    );
  }
  return warnings;
}
