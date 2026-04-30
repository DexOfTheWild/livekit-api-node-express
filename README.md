# LiveKit Token API

Lightweight Node.js 20 + Express compatibility service that mints LiveKit join tokens for a browser VoIP client.

## Warning

This server still supports unauthenticated token issuance for initial bring-up and compatibility testing.

Do not treat public anonymous token minting as a final production design. Before exposing this endpoint broadly, put it behind your game or account authentication layer or enable the optional shared-secret gate described below.

## Endpoints

- `GET /health`
- `GET /token?identity=...`
- `GET /metrics` (local observability endpoint)

All responses include `Cache-Control: no-store` and an `X-Request-Id` response header.

`POST /livekit/webhook` is also available as an internal endpoint for LiveKit server event delivery. It is not meant to be exposed directly to browsers.

## Environment Variables

Required:

- `VOIP_LIVEKIT_API_KEY`
- `VOIP_LIVEKIT_API_SECRET`
- `VOIP_LIVEKIT_WS_URL`
  - LiveKit Cloud example: `wss://your-project.livekit.cloud`
  - self-hosted example: `wss://livekit.example.com`
  - if you accidentally provide `wss://livekit.example.com/rtc`, the service strips the trailing `/rtc`
- `VOIP_ROOM_NAME`

Optional:

- `PORT` default `3000`
- `HOST` default `127.0.0.1`
- `VOIP_LOG_LEVEL` one of `debug`, `info`, `warn`, `error`
- `VOIP_LOG_FORMAT` one of `json` or `text`, default `json`
- `VOIP_TOKEN_TTL_SECONDS` default `900`, max `86400`
- `VOIP_ALLOWED_ORIGIN` optional `http://` or `https://` origin for browser CORS
- `VOIP_TOKEN_AUTH_SECRET` optional shared secret required on `GET /token`
- `VOIP_TOKEN_AUTH_HEADER` optional request header name for the shared secret, default `x-voip-token-auth`
- `VOIP_RATE_LIMIT_MAX_REQUESTS` optional in-memory per-IP rate limit for `GET /token`
- `VOIP_RATE_LIMIT_WINDOW_SECONDS` optional rate-limit window in seconds; set it together with `VOIP_RATE_LIMIT_MAX_REQUESTS`
- `VOIP_TRUST_PROXY` optional Express trust-proxy setting, for example `false`, `true`, `1`, or `loopback`
- `VOIP_SHUTDOWN_TIMEOUT_MS` default `10000`
- `VOIP_HEALTH_EXPOSE_DETAILS` default `true`; set to `false` if you want `/health` to return only `ok` and `serverTime`

## Choosing Your LiveKit Backend

This token API works with either LiveKit Cloud or a self-hosted LiveKit deployment. The `/token` and `/health` endpoints stay the same either way. What changes is where your browser connects for realtime media and which credentials you load into this service.

One important distinction: this repository is still your custom token API. If you choose LiveKit Cloud, LiveKit manages the media plane, but you still need somewhere to run this Express service unless you replace it with another token endpoint.

### LiveKit Cloud

Choose LiveKit Cloud if you want the lowest operational overhead. LiveKit's docs position Cloud as the managed option with a global mesh SFU, nearest-edge client connections, built-in dashboard telemetry, and a 99.99% uptime target.

For this repo:

- set `VOIP_LIVEKIT_WS_URL` to your LiveKit Cloud project URL, for example `wss://your-project.livekit.cloud`
- create an API key and secret in your LiveKit Cloud project and load them into `VOIP_LIVEKIT_API_KEY` and `VOIP_LIVEKIT_API_SECRET`
- deploy this Express token API wherever your browser client can reach it, ideally behind the same public origin via reverse proxy
- keep using this repo if you need the existing same-origin `GET /token?identity=...` contract or want to layer your own auth later

LiveKit also documents a sandbox token server for fast prototyping. That can be useful for experiments, but this repo is the better fit when you want a stable compatibility endpoint that you control.

Example configuration:

```dotenv
VOIP_LIVEKIT_WS_URL=wss://your-project.livekit.cloud
VOIP_LIVEKIT_API_KEY=your-cloud-api-key
VOIP_LIVEKIT_API_SECRET=your-cloud-api-secret
VOIP_ROOM_NAME=whiterun-test
```

### Self-Hosted LiveKit

Choose self-hosted LiveKit if you want full control over infrastructure, data location, network design, scaling, or uptime strategy. LiveKit's self-hosting docs describe this path as you managing the deployment, networking, and related services yourself.

For this repo:

- set `VOIP_LIVEKIT_WS_URL` to the browser-facing websocket base URL of your own LiveKit deployment, for example `wss://livekit.example.com`
- use the API key and secret configured for your LiveKit server
- make sure TLS, DNS, firewall rules, TURN, and reverse proxying are handled as part of your LiveKit deployment
- run this Express token API either on the same host or separately, but keep the browser-facing token endpoint simple and stable

For local development with a local LiveKit instance, a value like `ws://localhost:7800` is fine.

Example configuration:

```dotenv
VOIP_LIVEKIT_WS_URL=wss://livekit.example.com
VOIP_LIVEKIT_API_KEY=your-self-hosted-api-key
VOIP_LIVEKIT_API_SECRET=your-self-hosted-api-secret
VOIP_ROOM_NAME=whiterun-test
```

### Which Should You Pick?

- choose LiveKit Cloud if you want to move fastest, reduce ops work, and let LiveKit manage the realtime infrastructure
- choose self-hosted LiveKit if infrastructure control, private networking, data locality, or custom deployment topology matter more than managed convenience
- keep this token API in front of either option when you need the exact browser contract in this repo or when you want a clear place to add your own auth later

## Local Run

This project targets Node.js 20+.

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a local env file:

   ```bash
   cp .env.example .env
   ```

3. Fill in the required LiveKit values in `.env`.

4. Start the API:

   ```bash
   npm run dev
   ```

For production, export the same environment variables and run:

```bash
npm start
```

## Testing

Run the smoke test suite with:

```bash
npm test
```

The included CI workflow runs the same command on pushes and pull requests.

## Observability

Phase 3 adds a small local-first observability surface:

- the API now logs structured JSON by default, including `requestId`, path, status, and duration
- `GET /metrics` exposes Prometheus-style counters for token issuance results, webhook deliveries, and request totals
- `POST /livekit/webhook` verifies signed LiveKit webhook events and logs room lifecycle and participant activity with the same request correlation model

Examples:

```bash
curl http://127.0.0.1:3000/metrics
```

If you prefer the older human-readable log style while debugging locally, set:

```dotenv
VOIP_LOG_FORMAT=text
```

## Stack CLI

This repo includes a small helper CLI for managing both the token API in this repo and the sibling self-hosted LiveKit stack in `../livekit-deploy`.

It is designed for the setup used on this box:

- the API server runs from `../livekit-api`
- the LiveKit deploy stack runs from `../livekit-deploy`
- Docker Compose manages the deploy stack
- the API process is detached and persisted with a pid file and log file

Basic usage:

```bash
livekit-app start
livekit-app status
livekit-app logs
livekit-app stop
```

Or through npm if you prefer:

```bash
npm run stack -- start
npm run stack -- status
npm run stack -- logs
npm run stack -- stop
```

Targets:

```bash
npm run stack -- start api
npm run stack -- start deploy
npm run stack -- stop api
npm run stack -- logs deploy
```

Direct CLI examples:

```bash
livekit-app start api
livekit-app start deploy
livekit-app stop api
livekit-app logs deploy
```

To install the command on this machine:

```bash
npm link
```

That exposes:

```bash
livekit-app start
livekit-app logs deploy
livekit-app status
```

The older alias still works too:

```bash
voice-stack status
```

Targets through npm:

```bash
npm run stack -- start api
npm run stack -- start deploy
npm run stack -- stop api
npm run stack -- logs deploy
```

What it does:

- `start api` starts `src/server.js` in the background using `.env`
- `start deploy` runs `docker compose up -d` in `../livekit-deploy`
- `logs api` tails the API log file
- `logs deploy` follows `docker compose logs -f`
- `logs` with no target streams both
- `status` reports whether the API pid is alive and which deploy services are running

Runtime files:

- pid file: `.runtime/voice-stack/api.pid`
- log file: `.runtime/voice-stack/api.log`

Notes:

- the CLI assumes `../livekit-deploy` exists relative to this repo
- `docker compose` must be installed for deploy commands
- `start api` refuses to launch if port `3000` is already in use

## Example Requests

Health:

```bash
curl http://127.0.0.1:3000/health
```

Token:

```bash
curl "http://127.0.0.1:3000/token?identity=test-user"
```

Token with the optional shared-secret gate enabled:

```bash
curl \
  -H "x-voip-token-auth: your-shared-secret" \
  "http://127.0.0.1:3000/token?identity=test-user"
```

Metrics:

```bash
curl http://127.0.0.1:3000/metrics
```

Expected token response shape:

```json
{
  "token": "<jwt>",
  "identity": "test-user",
  "roomName": "whiterun-test",
  "wsUrl": "wss://livekit.example.com",
  "serverTime": "2026-04-24T15:00:00.000Z",
  "expiresAt": "2026-04-24T15:15:00.000Z"
}
```

Example error shape:

```json
{
  "error": "invalid_identity",
  "message": "identity is required",
  "requestId": "proxy-request-123"
}
```

## Reverse Proxy Examples

Preferred public layout:

- `https://voice.example.com/token` -> this Express API
- `https://voice.example.com/health` -> this Express API

Your browser UI can stay on another service for now, but it can later be proxied under the same public origin if you want same-origin token requests.

If you use LiveKit Cloud, these reverse proxy examples only need to front this Express API. Your `VOIP_LIVEKIT_WS_URL` should still point at your LiveKit Cloud websocket URL, not at this Node service.

If you self-host LiveKit, you may reverse proxy both this Express API and your LiveKit server, but `VOIP_LIVEKIT_WS_URL` must always be the browser-facing LiveKit websocket origin rather than the `/token` endpoint origin.

If you are running behind a local reverse proxy and want correct client IPs for rate limiting and request logs, set `VOIP_TRUST_PROXY=loopback` or another appropriate Express trust-proxy value.

### Nginx

```nginx
server {
  listen 443 ssl http2;
  server_name voice.example.com;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

### Caddy

```caddy
voice.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

## Operational Notes

- The service binds locally by default to `127.0.0.1:3000`.
- Logs never print the LiveKit API secret or the minted token.
- Failed token mint logs use a one-way identity hash instead of the raw `identity`.
- Invalid or missing `identity` returns `400`.
- Missing or invalid shared-secret auth returns `401` when enabled.
- Rate-limited token requests return `429`.
- Token minting failures return `500`.
- The browser contract uses `GET /token?identity=...`, so the identity may still appear in upstream access logs or browser history if you log raw query strings outside this app.
- `/health` returns `roomName` and `wsUrl` by default because that is part of the current compatibility contract. Set `VOIP_HEALTH_EXPOSE_DETAILS=false` if you want a smaller public health payload.
- LiveKit reference docs:
  - [Self-hosting overview](https://docs.livekit.io/transport/self-hosting.md)
  - [LiveKit Cloud overview](https://docs.livekit.io/home/cloud/)
  - [Connecting clients](https://docs.livekit.io/home/client/connect/)
