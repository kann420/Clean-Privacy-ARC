# Clean Privacy for Arc — web application

React port of the Claude Design mock `Clean Privacy for Arc.html`, built with Vite +
React 18 + TypeScript. Every screen, section and derived string of the mock is
reproduced; the demo logic behind it now runs through a backend adapter and validates
its inputs.

Network: Arc Testnet, chain `5042002`. Nothing in this package broadcasts a transaction.

## Run it

```bash
npm --prefix web install
npm --prefix web run dev
```

The demo video is not in Git. For local development, write it once:

```bash
node web/tools/extract-mock-assets.mjs "Clean Privacy for Arc.html" --with-video
```

In production, host that file and set `VITE_DEMO_VIDEO_URL` instead.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server on 5173, `/api` proxied to `BACKEND_ORIGIN` |
| `npm run build` | `tsc --noEmit` then a production build into `dist/` |
| `npm test` | Vitest: validation, quote and ledger tests |
| `npm run typecheck` | Types only |
| `npm run extract-assets` | Re-extract fonts and images from the mock |

## Structure, one to one with the mock

| Mock | Port |
| --- | --- |
| first `<style>` block (`@font-face` rules) | `src/styles/fonts.css` (generated) |
| second `<style>` block (palette, layout vars, keyframes) | `src/styles/theme.css` |
| root `<div>`, `<header>`, `<main>`, demo panel | `src/App.tsx`, `src/components/Header.tsx`, `src/components/DemoPanel.tsx` |
| `sc-if isLanding` … `sc-if isEvidence` | `src/screens/{Landing,Account,Deposit,Transfer,Swap,Evidence}.tsx` |
| `class Component extends DCLogic` state and handlers | `src/state/useCleanPrivacy.ts` |
| `renderVals()` | `src/state/viewModel.ts` |
| `petRef`, `scramble()` | `src/hooks/useVeilSprite.ts`, `src/hooks/useStatScramble.ts` |
| `EXPLORER`, `CHAIN`, `ADDR`, `TOKENS`, `ROUTES` | `src/config/arc.ts` |
| `short()`, `fmt()`, `quickPicks()` | `src/lib/format.ts` |

Two mechanical differences are worth knowing:

- The mock writes every rule as a literal `style="..."` string. Those strings are kept
  verbatim and parsed by `src/lib/sx.ts` (cached), which is what makes the port
  comparable with the mock line by line.
- `style-hover` / `style-active` attributes have no React equivalent, so the two shapes
  the mock used became the `.cp-raise`, `.cp-lift` and `.cp-nudge` classes in
  `theme.css`, applied on the same elements.

## Backend contract

`src/api/types.ts` defines the v2 `Backend` interface. `createBackend()` picks
one adapter for the whole browser session:

- `VITE_BACKEND_MODE=demo` → `MockBackend`, an in-memory base-unit ledger.
- `VITE_BACKEND_MODE=live`, or an API base URL with no explicit mode →
  `UnlinkBrowserBackend`. It holds the spending account in the browser and uses
  the loopback backend only for Unlink auth and Circle public plan preparation.

```text
POST /api/unlink/register
POST /api/unlink/authorization-token
POST /api/swap/quote?taker=<user EVM address> { amountNetUnits }
POST /api/swap/circle-plan { executionAccount, accountIndex, amountNetUnits }
GET  /api/health
```

Live mutations are browser-side SDK calls. The browser persists intent before
the SDK call, records transaction and execution ids at first acceptance, holds
one cross-tab Web Lock through verification, and polls existing ids after a
timeout. An unsettled journal entry blocks every new mutation. The Unlink admin
API key and Circle kit key remain server-side.

## What was changed on purpose

The mock was a visual prototype. Six defects were fixed in the port.

1. **Balances are validated.** The mock applied `Math.max(0, balance - amount)` to the
   source and credited the destination in full, so a 999 USDC deposit against a 19 USDC
   balance minted money; deposit, transfer and swap all behaved that way. Amounts are now
   checked before anything runs (`src/lib/amount.ts`) and again inside the backend
   (`requireBalance`), and the ledger moves by the exact amount on both sides. For USDC
   deposits a 1 USDC gas buffer is reserved, because gas and ERC-20 USDC are the same Arc
   balance.
2. **Inputs are validated.** An empty or malformed recipient is rejected, `"1.2.3"` can no
   longer be typed (and would be rejected anyway instead of becoming `NaN` and then `0`),
   zero is rejected, and an amount with more decimals than the token has is rejected.
   Errors appear under the field that caused them.
3. **No phantom private balance.** The mock showed `0.4` private USDC in the header while
   the account state was `none`. Private balances and operation history now come from the
   backend and are empty until the account is registered, which is also how the real
   backend behaves: there is nothing private to read before registration.
4. **One decimal convention.** `fmt()` formats at the token's configured precision (6 for
   USDC and EURC, 8 for cirBTC), so seeded and new records read the same. The deposit
   receipt shows the id of the operation that just ran; the mock printed the hardcoded
   `c650fbdc…f2ba` for every deposit.
5. **`min` is below the quote.** Both routes now derive `min_total` as the quote minus a 3%
   slippage bound. On the Circle route this reproduces the live capture exactly
   (`0.077592` out, `0.075264` minimum); on the direct pair route the mock returned the
   same number for both, so "minimum out" equalled the amount received.
6. **Assets are files, not a 9.2 MB inline blob.** `tools/extract-mock-assets.mjs` writes
   the fonts and images into `public/assets/`; the 546 KB cirBTC PNG was replaced with the
   official 2 KB cirBTC icon SVG already in the repository, and the 5 MB video is served
   from `public/media/` (gitignored) or a hosted URL. The live SDK is included
   only by the live adapter and emits its own operation chunks.

Two smaller additions follow from the above: operations that fail now surface a
title-and-body error card with a resume action, and empty states exist for the activity
list and the operations table.

## Sending: one field, two protocols

The send screen has a single recipient field and decides from its contents:

| Recipient | Operation | Sender | Recipient | Token | Amount |
| --- | --- | --- | --- | --- | --- |
| `unlink1…` | private transfer | private | private | private | private |
| `0x…` | withdrawal | private | **public** | **public** | **public** |

The banner, the title, and the button label all change with the mode, so the
exposure is stated before anything is signed. Two hygiene warnings fire on the
withdrawal path: withdrawing to the wallet that funds your deposits, and
withdrawing exactly an amount you deposited in this session. Both warn; neither
blocks.

## Protocol fees

| Flow | Rate | Taken | Paid to |
| --- | ---: | --- | --- |
| Private transfer | 0.1% | on top | Unlink fee account |
| Withdrawal | 0.1% | on top | Unlink fee account |
| Swap | 0.05% | out of the input | owner EOA, publicly |

`src/lib/fees.ts` mirrors `scripts/lib/fees.mjs`: base-unit BigInt arithmetic,
rounded down, so a dust amount pays nothing instead of being blocked. On a
transfer or withdrawal the recipient receives the full amount and the sender pays
amount + fee, which the balance check accounts for. On a swap the fee comes out of
the input, so the displayed quote and minimum are computed on the remainder.

Transfer and withdrawal fees are collected into an Unlink account, never a public
address: a percentage fee sent publicly would publish a transaction worth exactly
1/1000 of a private transfer at the same moment. The swap fee is public because a
swap's execution already is.

## Privacy claims

Unchanged from the mock and from `ARCHITECTURE.md`. An Unlink-to-Unlink transfer hides
sender, recipient, token and amount. An Unlink-funded swap hides only the private funding
account: the execution account, target, pair, amount and calldata stay public on Arc. The
product makes no KYC, A-Pass or CleanGate claim.
