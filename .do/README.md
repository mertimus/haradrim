DigitalOcean App Platform phase-1 layout:

- `web`: static Vite frontend
- `api`: single-instance Node backend with in-memory cache

The app spec in [app.yaml](/Users/mertmumtaz/haradrim/.do/app.yaml) is a template.
Replace:

- `REPLACE_WITH_HELIUS_API_KEY`
- `REPLACE_WITH_BIRDEYE_API_KEY`

Recommended initial deployment choices:

- region: `nyc`
- API instance count: `1`
- API size: `basic-xs`

Notes:

- keep the API at one instance for now because the cache is in-process only
- frontend requests should use same-origin `/api/...`
- the backend expects App Platform ingress to strip the `/api` prefix before forwarding
