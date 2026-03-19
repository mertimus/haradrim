# Haradrim

Open-source Solana wallet intelligence tool. Trace fund flows, map counterparty relationships, and discover wallet overlap — all computed live from on-chain data with no indexer required.

## Features

- **Wallet relationship graphs** — visualize who a wallet transacts with, weighted by volume and frequency
- **Counterparty analysis** — ranked counterparty tables with flow direction, volume, and connection scoring
- **Multi-wallet comparison** — overlay multiple wallets to find shared counterparties and common funders
- **Trace-based flow inspection** — drill into a wallet's full transfer history with per-asset, per-direction breakdowns and same-tx pass-through detection
- **Balance history** — reconstruct historical SOL and token balance curves from raw transaction data
- **Token forensics** — provenance tracing and holder clustering for SPL tokens
- **Stablecoin dashboard** — aggregated stablecoin flow analytics

## Architecture

The repo is split into a static React frontend and a lightweight Node backend.

```
src/           → Vite + React + TypeScript frontend
backend/src/   → Node.js API server (Express)
tests/         → Vitest test suites (frontend + backend)
scripts/       → Benchmarking and ops utilities
.do/           → DigitalOcean App Platform deployment template
```

The backend owns provider access, API keys, in-memory caching, and the heavier wallet/trace analysis endpoints. The frontend communicates exclusively through same-origin `/api` routes.

### API endpoints

| Route | Purpose |
|---|---|
| `GET /api/healthz` | Health check |
| `GET /api/wallets/:address/analysis` | Full counterparty analysis |
| `GET /api/traces/:address/flows` | Trace-mode flow analysis |
| `POST /api/helius-rpc` | Proxied RPC calls |
| `GET /api/helius-api/*` | Proxied Helius REST API |
| `GET /api/birdeye-api/*` | Proxied Birdeye API |

## Getting started

### Prerequisites

- Node.js 20+
- A [Helius](https://www.helius.dev/) RPC API key (free tier works)
- Optionally, a [Birdeye](https://birdeye.so/) API key for token price data

### Install

```bash
npm ci
```

### Configure

Copy the example env file and fill in your keys:

```bash
cp .env.example .env.local
```

Required:

| Variable | Description |
|---|---|
| `HELIUS_RPC_URL` | Helius mainnet RPC URL with your API key |

Optional:

| Variable | Description |
|---|---|
| `BIRDEYE_API_KEY` | Birdeye API key for token prices |
| `HELIUS_API_KEY` | Helius REST API key (wallet identity, batch endpoints) |
| `DIALECT_API_KEY` | Dialect API key |
| `COINGECKO_API_KEY` | CoinGecko API key |
| `SESSION_SECRET` | Secret for signing anonymous session cookies |
| `VITE_PUBLIC_HELIUS_RPC_URL` | Separate lightweight RPC URL for browser-side reads |

See `.env.example` for the full list of tuning knobs (cache sizes, concurrency limits, TTLs, rate-limit budgets).

### Run

Start the backend and frontend together:

```bash
npm run dev
```

Or separately:

```bash
npm run backend:dev   # backend on :8080
npm run dev:frontend  # Vite dev server on :5173, proxies /api to backend
```

### Build and test

```bash
npm run build
npm run test
npm run lint
```

## Rate limiting

Heavy GTFA-based routes are guarded server-side with:

- Signed anonymous session cookies
- Weighted request budgets per session and per IP
- Per-route concurrency caps
- Request body limits
- Allowlists for proxy paths and RPC methods

## Deployment

A DigitalOcean App Platform template is included in `.do/app.yaml`. See `.do/README.md` for setup instructions. The app can be deployed to any platform that supports a Node backend + static site frontend.

## Contributing

Contributions are welcome. Please open an issue first to discuss significant changes.

## License

MIT
