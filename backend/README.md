# Clean Privacy for Arc backend

This minimal Node server hosts the two Unlink browser-auth routes plus the
Circle quote and prepared-plan routes. It never receives the browser spending
key. `UNLINK_API_KEY_ARC_TESTNET` (or `UNLINK_API_KEY`) and
`CIRCLE_APP_KIT_KEY` are loaded from the process or the repository-local
`.env.local` and are never returned or logged.

The auth policy is intentionally anonymous for this Arc Testnet demo:
registration and authorization are not production user authentication. The
server binds to `127.0.0.1` by default. A non-loopback bind is refused unless
both `BACKEND_BIND_HOST` and `ALLOW_INSECURE_TESTNET_AUTH=1` are set.

The default browser origins are `http://localhost:5173` and
`http://127.0.0.1:5173`. Override them with an exact comma-separated
`BACKEND_ALLOWED_ORIGINS` list. Requests without `Origin`, including curl, are
allowed as same-origin tooling; the loopback bind and per-address rate limit
are the relevant fence. Credentials and cookies are not used.

Cross-device journal coordination is unsupported. The browser uses Web Locks
to serialize live mutations across tabs on one device.

Run from the repository root:

```text
npm run backend
```
