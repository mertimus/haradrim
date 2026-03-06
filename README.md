# HARADRIM

HARADRIM is a Solana wallet intelligence app for:

- wallet relationship graphs
- counterparty analysis
- overlap discovery across wallets
- trace-based flow inspection

The repo is split into a static React frontend and a lightweight Node backend. The backend owns provider access, API keys, in-memory caching, and the heavier wallet/trace analysis endpoints.

## Architecture

Current request flow:

- `frontend` (`src/`): Vite + React UI
- `backend` (`backend/src/`): same-origin API service
- `providers`: Helius RPC, Helius wallet API, Birdeye

Important backend endpoints:

- `GET /api/healthz`
- `GET /api/wallets/:address/analysis`
- `GET /api/traces/:address/flows`
- `POST /api/helius-rpc`
- `GET /api/helius-api/...`
- `GET /api/birdeye-api/...`

## Local Development

Install dependencies:

```bash
npm ci
```

Run the backend:

```bash
npm run backend:dev
```

Run the frontend:

```bash
npm run dev
```

The Vite dev server proxies `/api` to `http://localhost:8080` by default. Override that with `BACKEND_DEV_ORIGIN` if needed.

## Environment

Copy `.env.example` to `.env` and fill in the backend values.

Required backend envs:

- `HELIUS_RPC_URL`
- `BIRDEYE_API_KEY`

Optional backend envs:

- `HELIUS_API_KEY`
- `CACHE_MAX_ENTRIES`
- `CACHE_MAX_BODY_BYTES`
- `FETCH_TIMEOUT_MS`
- `PROXY_TTL_MS`
- `WALLET_ANALYSIS_TTL_MS`
- `TRACE_ANALYSIS_TTL_MS`
- `MAX_SLICE_CONCURRENCY`
- `MAX_ACCOUNT_TYPE_CONCURRENCY`

Optional frontend envs:

- `VITE_PUBLIC_HELIUS_RPC_URL`
- `VITE_PUBLIC_ORIGIN`

No `VITE_*` secrets should be used.

## Quality Checks

```bash
npm run lint
npm run build
npm run test
```

## DigitalOcean

Deployment files live in [.do/app.yaml](/Users/mertmumtaz/haradrim/.do/app.yaml) and [.do/README.md](/Users/mertmumtaz/haradrim/.do/README.md).

The intended phase-1 topology is:

- `web`: App Platform static site
- `api`: single Node web service

Keep the API single-instance for now because cache is process-local.

## Deferred Hardening

The most important deferred production task is backend proxy hardening. It was intentionally left for a follow-up pass because it is broader than the current backend migration.

Come back to item `1` before public launch:

- request auth / abuse controls
- rate limiting
- body size limits
- upstream timeouts and cancellation review
- strict header allowlist instead of broad header forwarding

The backend is usable for internal/private deployment now, but that hardening pass should happen before open internet exposure at scale.
