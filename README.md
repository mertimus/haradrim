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
- `SESSION_SECRET`
- `SESSION_COOKIE_NAME`
- `SESSION_WINDOW_MS`
- `SESSION_BUDGET_UNITS`
- `IP_WINDOW_MS`
- `IP_BUDGET_UNITS`
- `CACHE_MAX_ENTRIES`
- `CACHE_MAX_BODY_BYTES`
- `REQUEST_BODY_LIMIT_BYTES`
- `JSON_PROXY_BODY_LIMIT_BYTES`
- `FETCH_TIMEOUT_MS`
- `PROXY_TTL_MS`
- `WALLET_ANALYSIS_TTL_MS`
- `TRACE_ANALYSIS_TTL_MS`
- `MAX_SLICE_CONCURRENCY`
- `MAX_ACCOUNT_TYPE_CONCURRENCY`
- `MAX_WALLET_ANALYSIS_CONCURRENCY`
- `MAX_TRACE_ANALYSIS_CONCURRENCY`
- `MAX_GTFA_RPC_CONCURRENCY`

Optional frontend envs:

- `VITE_PUBLIC_HELIUS_RPC_URL`
- `VITE_PUBLIC_ORIGIN`

No `VITE_*` secrets should be used.

## Heavy Route Protection

Heavy GTFA-based routes are now guarded server-side:

- `GET /api/wallets/:address/analysis`
- `GET /api/traces/:address/flows`
- `POST /api/helius-rpc` only when the RPC method is `getTransactionsForAddress`

Current protections:

- signed anonymous session cookie
- weighted heavy-request budgets per session and per IP
- per-route concurrency caps
- request body limits
- explicit allowlists for public proxy paths and RPC methods
- stripped proxy headers instead of broad header forwarding

Lightweight enrichment calls are intentionally not budgeted in this phase.

GTFA requests from the frontend now always go through the backend proxy, even if `VITE_PUBLIC_HELIUS_RPC_URL` is set for lightweight browser-side reads.

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

## Remaining Edge Work

The backend-side guardrails are in place, but two external pieces are still pending for a production-facing rollout:

- put the app behind a Cloudflare-proxied custom domain
- add Cloudflare WAF / rate-limit / Turnstile rules on the heavy routes

Those are outside this repo and should be layered on top of the backend controls here.
