# Clean Privacy for Arc

**Confidential cross-border payouts on USDC rails.** Private balances, fully
private transfers, and privately-funded FX for **Arc Testnet** (chain
`5042002`), built on [Unlink](https://unlink.xyz) and Circle App Kit.

| | |
| --- | --- |
| Website | https://arc.cleanprivacy.org/ |
| GitHub | https://github.com/kann420/Clean-Privacy-ARC |
| Demo Video | https://youtu.be/qYEfjdg4rmQ |
| Presentation Deck | https://docs.google.com/presentation/d/15rUy83rC0mmOM_vXBaOi0DrvZn7ETUFBQvPHz8t54DQ/edit?usp=sharing |

## The problem: stablecoins fixed cost and speed, not confidentiality

The UAE is one of the world's largest remittance-sending corridors, and USDC on
Arc already solves the parts everyone talks about — settlement in seconds,
dollar-denominated fees, no correspondent-bank chain.

It does not solve the reason finance teams stall before moving a payout run
onchain. A public ledger turns a routine payment into a permanent disclosure:

- A company paying 40 global contractors in USDC publishes **every individual
  rate**, the **headcount**, and the **pay calendar** — to competitors, to
  recruiters, and to the contractors themselves, who can all read each other's
  pay from one address.
- Each recipient's address accumulates a **lifetime earnings history** visible
  to every future counterparty, including landlords and merchants they later
  pay from the same wallet.
- A marketplace settling with sellers publishes its **supplier list and unit
  economics**; an importer paying a supplier publishes its **negotiated price**.

Bank rails are slow and expensive, but they are confidential by default. That
asymmetry — not throughput — is what keeps payroll, marketplace settlement, and
B2B trade payments off public stablecoin rails.

Clean Privacy adds the missing leg. The salary run settles in USDC on Arc, with
the amounts and the recipient set hidden from everyone except the two parties
to each payment.

## Why the off-ramp stays public — on purpose

The confidential leg is Unlink → Unlink. Moving money **into** the pool
(deposit) and **out** to a public Arc address (withdrawal) is visible and
linkable, and this project does not try to hide it.

That boundary is a design choice, not a shortfall. The off-ramp is exactly
where a regulated VASP already performs KYC and reporting. Hiding a payroll run
from a contractor's competitors is a business-confidentiality requirement;
hiding a fiat conversion from the institution legally obliged to observe it is
not something this project attempts. The private leg covers the payout;
the public leg keeps the regulated boundary intact and auditable.

## What this actually hides

| Flow | Sender | Recipient | Token | Amount |
| --- | --- | --- | --- | --- |
| Unlink → Unlink transfer | private | private | private | private |
| Unlink-funded swap | private (funding account only) | public (ExecutionAccount) | public | public |
| Deposit / withdrawal | n/a — this leg is public and linkable by design | | | |

An Unlink-funded swap is **not** a fully confidential swap: only the account
that funded it is hidden. The ExecutionAccount address, token pair, amount,
target contract, and calldata are all public on Arc. This project never
claims otherwise, and does not implement or claim KYC gating, A-Pass, or
CleanGate (those belong to a different, unrelated product and are not part of
Arc). Arc's own Privacy Sector is not live and nothing here depends on it.

## A payout run, end to end

The four flows in the app are the four steps of a confidential global payout.

| Step | Flow | Screen | What Arc records |
| --- | --- | --- | --- |
| 0. Bring the treasury's USDC to Arc | CCTP burn-and-mint from Ethereum Sepolia, Base Sepolia, Avalanche Fuji or Arbitrum Sepolia | CLI — `scripts/bridge-to-arc.mjs` | Public on both chains. A treasury's USDC rarely starts on Arc; this is the funding leg that gets it there without an exchange. |
| 1. Fund the payout account | Deposit USDC into the private pool | `/deposit` | Public: the treasury funded the pool. The payroll total is visible; nothing about who gets paid is. |
| 2. Pay each recipient | Unlink → Unlink transfer | `/transfer` | Nothing. Sender, recipient, token and amount are all private — one opaque pool event, verified on chain at `0x6b717cb3…ccf2`. |
| 3. Pay a recipient in their currency | Unlink-funded USDC → EURC swap | `/swap` | The conversion is public from a fresh single-use ExecutionAccount; **which private account paid for it is not**. Output is swept straight back into the pool. |
| 4. Recipient cashes out | Withdraw to a public Arc address | `/transfer` | Public and linkable, by design — see above. The paying treasury still does not appear as the sender. |

The commercial point is step 2. A treasury runs one deposit, then N private
transfers. Competitors see a single lump sum enter a pool and nothing after
that: not the headcount, not the individual rates, not the schedule. Each
contractor sees only their own payment.

Step 3 is what makes the corridor work end to end. A contractor in the eurozone
should be paid in EURC, not USDC, and Circle Swap Kit executes that conversion
natively on Arc. Because the swap is funded from a private balance and the
output re-enters it, the FX leg does not de-anonymise the payroll run behind it
— the ExecutionAccount is single-use and holds no history.

## Architecture — pipeline

```mermaid
flowchart LR
    OP(["Wallet operator\n(browser, non-custodial)"])

    subgraph WEBAPP["web/ — React SPA"]
        ACC["/account\nderive + register"]
        DEP["/deposit"]
        XFR["/transfer\nprivate or withdraw"]
        SWP["/swap"]
    end

    AUTH["backend/ loopback API\nUnlink auth · Circle quote\n(admin/kit keys stay server-side)"]
    SDK["@unlink-xyz/sdk/browser\nspending key stays in-tab"]
    POOL[("Unlink Pool\nArc Testnet\n0x075b8d19...b9a5dcda")]

    EA["ExecutionAccount\n(ERC-4337, per swap)"]
    CIRCLE["Circle Adapter\nUSDC to EURC"]
    UNIV2["Uniswap V2 mini Pair\nself-deployed, USDC to cirBTC"]

    OUT(["Public Arc address\n(withdrawals)"])
    EVID[("Checkpoints + evidence JSONL\nlocal, gitignored, self-reported")]
    CHAIN[["Arc Testnet\nfinality + Arcscan explorer"]]

    OP --> ACC --> AUTH --> SDK
    OP --> DEP --> SDK
    OP --> XFR --> SDK
    OP --> SWP --> SDK

    SDK -->|deposit / transfer| POOL
    SDK -->|Phase A: withdraw to EA| EA
    EA -->|Phase B: USDC/EURC| CIRCLE
    EA -->|Phase B: USDC/cirBTC| UNIV2
    CIRCLE -->|returnToPool: re-shield| POOL
    UNIV2 -->|returnToPool: re-shield| POOL
    XFR -->|withdraw| OUT

    SDK --> EVID
    POOL --> CHAIN
    EA --> CHAIN
```

Reading the diagram: every mutation (deposit, transfer, swap, withdraw) is
initiated from the browser via the Unlink SDK, never from the backend — the
backend only issues auth tokens and prepares Circle quote calldata. Swaps are
two-phase: Phase A privately withdraws into a fresh ERC-4337 ExecutionAccount,
Phase B executes the swap publicly from that account and sweeps the output
back into the private pool (`returnToPool`). Every accepted transaction/operation
ID is checkpointed locally before and after submission so a crashed or resumed
session can poll and adopt the same operation instead of duplicating it.

cirBTC swaps are **CLI-only** (`scripts/private-swap.mjs`) — the web app's
swap screen only offers USDC/EURC via Circle App Kit; `requireSwappableToken()`
in `web/src/api/unlinkBackend.ts` rejects cirBTC in the browser.

## Deployed contracts — full transparency

Everything below is Arc Testnet (`chainId 5042002`), taken directly from
[`config/chains.json`](config/chains.json) and
[`deployments/arc-testnet.uniswap-v2-mini.json`](deployments/arc-testnet.uniswap-v2-mini.json).

### Deployed by this repo

Only one thing in this repository has its own deployment transaction: a
minimal Uniswap V2 fork (`@uniswap/v2-core@1.0.1`, unmodified), used as the
fallback swap venue for the USDC/cirBTC pair (Circle App Kit does not route
cirBTC). Deployed and seeded by [`scripts/deploy-univ2-mini.mjs`](scripts/deploy-univ2-mini.mjs),
verified at `2026-07-29T13:04:04.280Z`.

| Contract | Address | Tx hash |
| --- | --- | --- |
| UniswapV2Factory | `0xfa29C0663CF547d089beFcE1925b91f0367a993A` | `0x8252c676f3c30767daaca8e3be4eeaca2d9e5cbe3e119a14b140c14c0a8a5c34` |
| UniswapV2Pair (USDC/cirBTC) | `0x0d2A8c302F74f7df18F845Be1dfA8B9c3507D020` | createPair `0x412a2d30c5408d57292a3ae32bad9be51802e1b1c347baec8105bb72dde138a1` |

- Deployer / LP owner (single testnet EOA, not a multisig): `0xD7E004CBda24E079aA3A657Ba7f8E2915192a966`
- Seed liquidity: 5 USDC + 0.00005 cirBTC (`reserve0=5000000`, `reserve1=5000`, base units)
- Seed tx hashes: USDC `0x037a46341d7392486e26275280f8dd5ecb099db3aa0c6bab4b23ba9db978721b`,
  cirBTC `0x11a4853324a2e11619f73a962dcf0867b3870acde048b27ff43a130bba4cf297`,
  mint `0x76a6ffc2ad5d94fed0ae640b0d49e220285c9cdb201dc207b34ea588ac15fa5d`

This is a testnet-only fallback DEX with trivial liquidity, controlled by one
operator key. It is not audited and is not meant to hold real value.

### Referenced, not deployed by this repo

These are pre-existing Arc Testnet / Unlink / Circle protocol contracts that
`config/chains.json` points at and [`scripts/arc-smoke.mjs`](scripts/arc-smoke.mjs)
verifies has live bytecode before any flow runs. This project does not own,
control, or have deploy rights over any of them.

| Contract | Address | Owner |
| --- | --- | --- |
| USDC (Arc Testnet) | `0x3600000000000000000000000000000000000000` | Arc / Circle |
| EURC | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` | Arc / Circle |
| cirBTC | `0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF` | Arc |
| Unlink Pool | `0x075b8d19b214cd939a0aa6b1eb8e2152b9a5dcda` | Unlink protocol |
| Permit2 | `0x000000000022d473030f116dDEE9F6B43aC78BA3` | canonical Permit2 |
| EntryPoint (ERC-4337 v0.7) | `0x0000000071727De22E5E9d8BAf0eDac6f37da032` | canonical |
| ExecutionAccount factory | `0xc92ac4f6599482d45416e2f9e6ea450cf8c2e410` | Unlink protocol |
| ExecutionAccount implementation | `0xc4f5e6d48eb336bd3f5a54bdfb794da5e20b5069` | Unlink protocol |
| Circle Adapter | `0xBBD70b01a1CAbc96d5b7b129Ae1AAabdf50dd40b` | Circle App Kit |
| Circle Bridge | `0xC5567a5E3370d4DBfB0540025078e283e36A363d` | Circle App Kit |

Protocol fee collector (Unlink account, not a public address):
`unlink1qqvmup67xy2mezvjds0whta4xskl373qgfz9vrrz8xfesg6c7y9g5r029xeyjyzs7fp22htzqzvcjt5wf8zl9lc4pmheg2d4kt95vfr2m522uh`.
Fee owner EOA (swap fee only, paid publicly): `0xD7E004CBda24E079aA3A657Ba7f8E2915192a966`
(same key as the mini-DEX deployer above).

Chain: RPC `https://rpc.testnet.arc.network`, explorer `https://testnet.arcscan.app`.

## Repository structure

| Path | Role |
| --- | --- |
| [`web/`](web) | React/Vite SPA — browser non-custodial UI. See [web/README.md](web/README.md). |
| [`backend/`](backend) | Loopback Node API — Unlink auth + Circle quoting only, never signs. See [backend/README.md](backend/README.md). |
| [`scripts/`](scripts) | CLI reference implementation: deposit, transfer, swap (two-phase), withdraw, recovery, smoke test. |
| [`scripts/lib/`](scripts/lib) | Shared checkpointing, fee math, Unlink/Circle wiring used by the CLI scripts. |
| [`config/chains.json`](config/chains.json) | Single validated chain/address registry (source of truth; the web app's config is generated from this). |
| [`deployments/`](deployments) | Deployment artifacts for contracts this repo deployed itself. |
| `checkpoints/` | Gitignored, per-flow operation state used to resume interrupted CLI runs (not committed). |

## Running the CLI reference flow

```bash
npm install
node scripts/arc-smoke.mjs          # read-only: RPC, bytecode, config checks
node scripts/bridge-to-arc.mjs      # CCTP: USDC from another chain -> Arc
node scripts/private-deposit.mjs    # public balance -> private Unlink balance
node scripts/private-transfer.mjs   # private Unlink -> Unlink transfer
node scripts/private-swap.mjs       # two-phase Unlink-funded swap
node scripts/private-withdraw.mjs   # private balance -> public Arc address
```

Each script persists a checkpoint before submitting and polls/resumes by ID on
rerun rather than blind-resubmitting. `bridge-to-arc.mjs` is the exception and
says so: a CCTP burn cannot be replayed, so an unfinished transfer hard-stops
with the recorded burn hash instead of retrying. It also takes `--dry-run`,
which resolves the route, asserts both endpoints really are the chains the route
claims, reports balances, and stops before writing anything.

Bridge sources are an allowlist in [`config/chains.json`](config/chains.json)
(`bridgeSources`) holding Circle chain identifiers only — **no addresses**.
Every source chain's USDC address, RPC endpoint and CCTP domain is read from
Circle's own chain definitions at run time, and the destination is asserted
against the local registry before anything is burned.

## Running the web app

```bash
npm --prefix web install
npm --prefix web run dev
```

`VITE_BACKEND_MODE=demo` (default) runs entirely against an in-memory mock —
no real transactions. `VITE_BACKEND_MODE=live` drives the real Unlink SDK
against Arc Testnet. Full routing/deployment notes are in
[web/README.md](web/README.md#routes-and-deployment).

`deployments/evidence/*.jsonl` are self-reported verification logs written by
the scripts after their own on-chain checks — useful as an integration-test
trail, not an independent audit.

## Known limitations

- **Testnet only.** Arc Testnet (`5042002`). Nothing here is audited or meant
  to hold real value.
- **The CCTP funding leg is CLI-only and is not privacy-preserving.** It is
  public on both chains by construction, exactly like the deposit it precedes.
  It also cannot be resumed: a burn is irreversible, so an interrupted transfer
  hard-stops with the recorded burn hash rather than retrying.
- **Deposits and withdrawals are public.** Only the Unlink → Unlink leg is
  fully private. See the boundary section above.
- **A swap is not a confidential swap.** Only the funding account is hidden.
- **Supported swap routes:** USDC ↔ EURC through Circle Swap Kit (web + CLI);
  USDC ↔ cirBTC through the self-deployed Uniswap V2 mini pair (**CLI only** —
  `requireSwappableToken()` rejects cirBTC in the browser). The mini pair holds
  5 USDC of seed liquidity, so anything beyond dust slips heavily.
- **One operation at a time per account.** The journal blocks a second mutation
  until the saved one is verified or archived. This is deliberate: it is what
  makes crash-resume safe, but it is not throughput-ready for a real payroll
  batch. Batched multi-recipient payouts are the obvious next build.
- **Live rate display degrades under load.** The `swap-quote` endpoint is rate
  limited to 10/min per IP; past that the UI falls back to a static curve in
  `web/src/config/arc.ts` while the Rate row reads `quoting…`.
- **The public Arc RPC rate-limits parallel bursts.** A 30-way parallel burst
  fails roughly half its calls. The loopback relay in `backend/src/rpc-route.mjs`
  exists specifically to absorb this — 20 readiness-style calls complete in
  ~1.7 s with 0 failures, mostly from cache.

## Circle Product Feedback

### Circle products used on Arc

| Product | Used | How |
| --- | --- | --- |
| **USDC** | Yes | The settlement asset for every flow, and the gas token. `0x3600…0000`, 6 decimals on the ERC-20 interface. |
| **Circle Swap Kit** (`@circle-fin/swap-kit` 1.5.0) | Yes | `estimate` / `swap` / `getSwapStatus` for the USDC ↔ EURC leg, executed from an ERC-4337 ExecutionAccount. |
| **Circle App Kit** (`@circle-fin/app-kit` 1.11.0) | Yes | `ArcTestnet` chain definition; `@circle-fin/adapter-viem-v2` `ViemAdapter` as the signer adapter. |
| **CCTP V2 / Bridge Kit** (via `@circle-fin/app-kit` `kit.bridge()`) | Yes | Funding leg — burn-and-mint USDC from Ethereum Sepolia, Base Sepolia, Avalanche Fuji or Arbitrum Sepolia into Arc (domain 26). CLI: `scripts/bridge-to-arc.mjs`. |
| Circle Wallets | No | Custody is browser non-custodial by design — the Unlink spending key never leaves the tab, so an externally-managed key store would have widened the trust boundary this project exists to narrow. |
| Gateway, USYC, StableFX, Nanopayments | No | Not used. |

### Why we chose these products

We needed a **stablecoin FX leg that works inside an account-abstraction
execution flow**. The swap in this project is not initiated by a user's EOA — it
is executed by a single-use ERC-4337 ExecutionAccount that the Unlink pool
funds privately, so the swap has to be expressible as *calldata we can hand to a
UserOperation*, not as a transaction the SDK broadcasts itself.

Swap Kit was chosen because it is the only route we found that quotes and routes
USDC/EURC natively on Arc, and because Circle owning both sides of the pair
removes a whole class of bridge/oracle risk from a payments story. Arc itself was
chosen for the reason the track exists: USDC as gas means a payout run has no
second asset to provision, and the treasury never has to hold a volatile token
just to move a stable one.

CCTP was chosen for the funding leg because a treasury's USDC is almost never
already on Arc, and burn-and-mint is the only way to get it there without either
an exchange or a wrapped asset. For a payments product the absence of a bridge
custodian is the point: same issuer at both ends, nothing to hack.

### What worked well

- **`estimate` is genuinely strict and returns a usable stop limit.** It echoes
  back the full route — `chainIn`, `chainOut`, `fromAddress`, `toAddress`,
  `tokenIn`, `tokenOut`, `amountIn` — which let us assert the quote matches what
  we asked for before anything is signed (`estimateCircleSwap` in
  [`scripts/lib/circle.mjs`](scripts/lib/circle.mjs)). Many quoting APIs return
  only a number; this one is verifiable.
- **The structured `executeParams` are complete enough to re-derive the
  calldata.** We decode `Adapter.execute` and compare it field-by-field against
  the structured plan the SDK produced. It matched exactly, every time. That is
  what makes it safe for us to sign Circle-built calldata from an account the
  user does not directly control.
- **`ArcTestnet` shipped in `@circle-fin/app-kit/chains`** — no hand-rolled
  chain config, no address drift.
- **The `ViemAdapter` boundary is clean.** Because it is a small, well-defined
  interface, we could wrap it in a `Proxy` and intercept execution (see below).
  A more monolithic SDK would have been unusable here.
- **Live quotes are fast and internally consistent.** Measured 2026-08-06:
  1 USDC → 0.751403 EURC and 1 EURC → 1.331059 USDC in ~1.2 s, mutually
  consistent.

### What could be improved

**1. There is no way to build swap calldata without broadcasting it.** This is
the single biggest gap for anyone using Circle on Arc with account abstraction.
`swap()` assumes the adapter's signer *is* the payer and will send the
transaction. To get executable calldata instead, we had to proxy the adapter,
force `supportsAtomicBatch()` to `true`, and **throw a sentinel error from
`batchExecute` to abort the broadcast and capture the calls**:

```js
if (property === "batchExecute") {
  return async (capturedCalls) => {
    calls = capturedCalls;
    throw sentinel;          // the only way out with the calldata in hand
  };
}
```

Control flow through a thrown error is not something we want in a payments path,
and it is coupled to Swap Kit internals that can change in a patch release.
**Recommendation:** expose a first-class `prepareSwap()` / `buildSwapCalls()`
that returns `{ approval, swapCall, executeParams, minOut, deadline }` without
touching the network. Every ERC-4337 wallet, every smart-account treasury, and
every agent executing on behalf of a user needs this, and today each one will
reinvent this same hack.

**2. The approval action name changes with the input token, and so does the
ABI.** Circle emits `usdc.increaseAllowance` when the input is USDC and
`token.approve` otherwise. The selectors differ, so a caller decoding the
approval must switch ABIs on the action string — we maintain an
`APPROVAL_ACTIONS` lookup for exactly this. **Recommendation:** either normalise
to one action, or return the ABI fragment alongside the action so callers do not
have to hardcode the mapping.

**3. Chain identifiers are inconsistent across surfaces.** `estimate` takes the
`ArcTestnet` object from `app-kit/chains`, `getSwapStatus` takes the string
`"Arc_Testnet"`, and the EVM layer wants `5042002`. We carry all three in
`config/chains.json` (`circleChain`, `chainId`) to keep them straight.
**Recommendation:** accept the chain object everywhere, or export the canonical
string from the same module as the chain object.

**4. `getSwapStatus` can only be queried by transaction hash.** If the process
dies between building the swap and recording the hash, there is no way to ask
Circle "did execution `execId` land?" — even though `execId` is in the calldata
we signed. We had to build our own two-phase checkpoint file
([`scripts/lib/swap-checkpoint.mjs`](scripts/lib/swap-checkpoint.mjs)) to close
that window. **Recommendation:** allow lookup by `execId`. For any unattended
payer — a payroll cron, an AI agent — resume-by-intent is not optional.

**5. Amounts cross the API boundary as human decimal strings.** `estimate`
returns `"0.751403"`, so to compare it against an on-chain base-unit figure we
re-parse it with the token's decimals on every hop. On Arc this is sharper than
usual, because **USDC on Arc has two decimal views** — 18 as the native gas
currency, 6 through the ERC-20 interface. Comparing a raw native value against a
raw ERC-20 value is silently wrong by a factor of 10^12, and nothing in the
tooling stops you. **Recommendation:** return base units alongside the decimal
string, and call the dual-decimal behaviour out loudly in the Arc docs — this
is the trap most likely to cost a team a day.

**6. A kit key is required for a read-only estimate.** Quoting is not a
state-changing operation, but it needs the same key as execution, which forces a
server-side proxy into a browser architecture that otherwise needs no backend
for that call. Ours is [`backend/src/swap-routes.mjs`](backend/src/swap-routes.mjs).
**Recommendation:** allow an origin-scoped public key for `estimate`.

**7. The public Arc testnet RPC is the practical bottleneck, not the chain.**
`https://rpc.testnet.arc.network` answers a single call in ~200–250 ms, but a
30-way parallel burst fails roughly half. A commercial provider endpoint we
tested was not materially better (15/30 failures vs 18/30). This does not show
up in a single-user demo and does show up the moment an audience loads your app
at once. **Recommendation:** publish the actual per-IP limits so builders can
size a relay instead of discovering the ceiling live.

**8. On Arc, a wallet cannot pay for its own first mint.** This one is specific
to Arc and worth calling out loudly. CCTP's `mint` is a transaction on the
destination chain, and Arc charges gas in USDC — so a wallet with a zero Arc
balance cannot receive its first bridged USDC. The chain's headline feature
(USDC as gas) creates a cold-start that does not exist on a chain with a
separate gas token. The Forwarding Service is the answer and we wired
`--use-forwarder` for exactly this, but nothing in the bridge quickstart warns
you, and the failure arrives *after* the burn has already happened.
`scripts/bridge-to-arc.mjs` therefore refuses upfront rather than discovering it
late. **Recommendation:** make the forwarder the default on Arc when the
destination balance cannot cover mint gas, or at minimum fail the estimate
rather than the mint.

**9. `kit.retryBridge()` only works while the process is alive.** It takes the
in-memory result object, so a crash between burn and mint leaves no supported
recovery path — the same resume-by-intent gap as item 4, on the leg where funds
are already burned. We subscribe to `kit.on("*")` and persist each step's hash
as it arrives so an operator at least keeps the burn hash, then hard-stop rather
than retry. **Recommendation:** allow retry from a persisted burn transaction
hash.

**10. Gated tooling has a long pole.** StableFX is exactly the product this
use case wants for the multi-currency payout leg, but the access request →
email → approval loop does not fit inside a hackathon window, so we built the
FX leg on Swap Kit instead. **Recommendation:** a pre-provisioned testnet-only
StableFX sandbox, keyed automatically to any Circle Developer Account, would
have changed what we built.

### Overall

The pieces we used are solid and the verification surface is unusually good —
we could prove Circle's calldata matched Circle's own plan before signing it,
which is not something we can say about most swap SDKs. The gap is that the SDK
is built around *a user with a key pressing a button*. On Arc, where USDC is gas
and the whole design centre is programmable payments, a growing share of callers
will be smart accounts, treasuries, and agents that need calldata rather than a
broadcast. Item 1 above is the one change that would unlock all of them.

The bridge tells the same story from the other side. `kit.bridge()` is close to
a one-liner and it worked first time — but items 8 and 9 are both "what happens
when nobody is watching", and both bite hardest on Arc, where funds can be
burned and then stranded because the receiving wallet cannot afford the gas to
accept them.
