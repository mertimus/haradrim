DigitalOcean App Platform phase-1 layout:

- `web`: static Vite frontend
- `api`: single-instance Node backend with in-memory cache

The app spec in [app.yaml](.do/app.yaml) is a template.
Replace:

- `REPLACE_WITH_BACKEND_HELIUS_RPC_URL`
- `REPLACE_WITH_HELIUS_API_KEY` if you still use Helius wallet REST endpoints
- `REPLACE_WITH_BIRDEYE_API_KEY`
- `REPLACE_WITH_FRONTEND_HELIUS_RPC_URL`

Recommended initial deployment choices:

- region: `nyc`
- API instance count: `1`
- API size: `basic-xs`

Notes:

- keep the API at one instance for now because the cache is in-process only
- frontend requests should use same-origin `/api/...`
- the backend expects App Platform ingress to strip the `/api` prefix before forwarding
- the backend `HELIUS_RPC_URL` should point at the mainnet Helius RPC URL that supports GTFA full-page `limit=1000`
- the frontend can optionally use `VITE_PUBLIC_HELIUS_RPC_URL` for lightweight direct browser RPC reads
- deferred follow-up before public launch: backend proxy hardening, rate limiting, and header allowlisting
