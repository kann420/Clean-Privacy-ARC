# Clean Privacy for Arc backend

Clean Privacy for Arc is live on Arc Testnet at
<https://arc.cleanprivacy.org>. The deployment runs this backend against the
real Unlink `arc-testnet` environment and real Circle quotes, so private
balances, private transfers and Unlink-funded swaps execute for real. It is
open to everyone: there is no waitlist, no signup, no account and no API key to
request. Bring a browser wallet on Arc Testnet (chain ID `5042002`) and faucet
USDC, and every flow in the application is available immediately.

This minimal Node server hosts the two Unlink browser-auth routes plus the
Circle quote and prepared-plan routes. It never receives the browser spending
key. `UNLINK_API_KEY_ARC_TESTNET` (or `UNLINK_API_KEY`) and
`CIRCLE_APP_KIT_KEY` are loaded from the process or the repository-local
`.env.local` and are never returned or logged.

Open access is what the auth policy is built for: registration and
authorization are deliberately anonymous, which is why any visitor can use the
deployment without credentials. That is a testnet demo policy rather than
production user authentication, so this server runs on Arc Testnet credentials
only. It binds to `127.0.0.1` by default; a non-loopback bind is refused unless
both `BACKEND_BIND_HOST` and `ALLOW_INSECURE_TESTNET_AUTH=1` are set.

The default browser origins are `http://localhost:5173` and
`http://127.0.0.1:5173`. Override them with an exact comma-separated
`BACKEND_ALLOWED_ORIGINS` list. Requests without `Origin`, including curl, are
allowed as same-origin tooling; the loopback bind and per-address rate limit
are the relevant fence. Credentials and cookies are not used.

Cross-device journal coordination is unsupported. The browser uses Web Locks
to serialize live mutations across tabs on one device.

Rate limiting is keyed per client address. Behind a reverse proxy every request
arrives from the proxy, which would put every visitor in one bucket, so
`BACKEND_TRUST_PROXY=1` makes the server read the client address from
`X-Forwarded-For` instead. Enable it only where the proxy overwrites that header
on every request; a directly exposed server must leave it unset, because a
client can otherwise forge the header and evade its own bucket.

Run from the repository root:

```text
npm run backend
```

## Railway deployment

`backend/Dockerfile` builds from the repository root, not from `/backend`, so
that `scripts/lib/*.mjs` and `config/chains.json` stay inside the build context.
The Railway service therefore uses the repository root as its root directory and
`railway.json` selects `backend/Dockerfile`.

The service is reached only over Railway private networking: it has no public
domain, and the `web` service's Caddy origin proxies `/api/*` to
`backend.railway.internal:8787`. That keeps the browser on one origin, so no
cross-origin request is made and the Unlink admin key never leaves the private
network. Private networking is IPv6-only, which is why the bind host is `::`.

Required service variables:

| Variable | Value | Notes |
|---|---|---|
| `UNLINK_API_KEY_ARC_TESTNET` | secret | Unlink admin credential |
| `CIRCLE_APP_KIT_KEY` | secret | Circle quote and calldata key |
| `BACKEND_BIND_HOST` | `::` | Required for private networking |
| `ALLOW_INSECURE_TESTNET_AUTH` | `1` | Acknowledges the anonymous auth policy |
| `BACKEND_ALLOWED_ORIGINS` | `https://arc.cleanprivacy.org` | Exact origin list |
| `BACKEND_TRUST_PROXY` | `1` | Caddy overwrites `X-Forwarded-For` |
| `BACKEND_PORT` | `8787` | Fixed; matches the Caddy upstream |

Anonymous authorization is what makes the public deployment usable by anyone,
and it also means any visitor can register an Unlink account and spend this
deployment's testnet quota. Configure the service with Arc Testnet credentials
only and never point it at a mainnet key.
