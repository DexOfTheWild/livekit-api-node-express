const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const test = require('node:test');

const { AccessToken } = require('livekit-server-sdk');

const { createApp } = require('../src/app');

const baseConfig = {
  apiKey: 'test-key',
  apiSecret: 'test-secret',
  healthExposeDetails: true,
  roomName: 'whiterun-test',
  trustProxy: false,
  wsUrl: 'wss://livekit.example.com',
  allowedOrigin: null,
  tokenAuth: null,
  rateLimit: null,
};

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function createLoggerSpy() {
  const entries = [];

  return {
    entries,
    debug(message, meta) {
      entries.push({ level: 'debug', message, meta });
    },
    info(message, meta) {
      entries.push({ level: 'info', message, meta });
    },
    warn(message, meta) {
      entries.push({ level: 'warn', message, meta });
    },
    error(message, meta) {
      entries.push({ level: 'error', message, meta });
    },
  };
}

async function withServer({ config = {}, mintToken, logger = silentLogger }, callback) {
  const app = createApp({
    config: {
      ...baseConfig,
      ...config,
    },
    mintToken,
    logger,
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    return await callback(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

test('GET /health returns the expected payload', async () => {
  await withServer(
    {
      mintToken: async () => {
        throw new Error('mintToken should not be called for /health');
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`);
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('pragma'), 'no-cache');
      assert.equal(response.headers.get('expires'), '0');
      assert.equal(body.ok, true);
      assert.equal(body.roomName, 'whiterun-test');
      assert.equal(body.wsUrl, 'wss://livekit.example.com');
      assert.ok(Date.parse(body.serverTime));
    },
  );
});

test('GET /health can hide room metadata when configured', async () => {
  await withServer(
    {
      config: {
        healthExposeDetails: false,
      },
      mintToken: async () => {
        throw new Error('mintToken should not be called for /health');
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`);
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.roomName, undefined);
      assert.equal(body.wsUrl, undefined);
      assert.ok(Date.parse(body.serverTime));
    },
  );
});

test('GET /metrics exposes token counters in Prometheus format', async () => {
  await withServer(
    {
      mintToken: async () => ({
        token: 'signed-jwt',
        expiresAt: new Date('2026-04-24T15:15:00.000Z'),
      }),
    },
    async (baseUrl) => {
      const tokenResponse = await fetch(`${baseUrl}/token?identity=test-user`);
      assert.equal(tokenResponse.status, 200);

      const firstMetricsResponse = await fetch(`${baseUrl}/metrics`);
      await firstMetricsResponse.text();

      const metricsResponse = await fetch(`${baseUrl}/metrics`);
      const metricsBody = await metricsResponse.text();

      assert.equal(metricsResponse.status, 200);
      assert.match(metricsResponse.headers.get('content-type'), /text\/plain/);
      assert.match(metricsBody, /voip_token_requests_total\{result="success",service="livekit-token-api"\} 1/);
      assert.match(metricsBody, /voip_http_requests_total\{method="GET",path="\/metrics",service="livekit-token-api",status="200"\} 1/);
    },
  );
});

test('GET /token returns a trimmed identity and token payload', async () => {
  const expiresAt = new Date('2026-04-24T15:15:00.000Z');
  let mintTokenArgs;
  const logger = createLoggerSpy();

  await withServer(
    {
      mintToken: async (args) => {
        mintTokenArgs = args;
        return {
          token: 'signed-jwt',
          expiresAt,
        };
      },
      logger,
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/token?identity=%20test-user%20`);
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.token, 'signed-jwt');
      assert.equal(body.identity, 'test-user');
      assert.equal(body.roomName, 'whiterun-test');
      assert.equal(body.wsUrl, 'wss://livekit.example.com');
      assert.equal(body.expiresAt, expiresAt.toISOString());
      assert.ok(Date.parse(body.serverTime));
      assert.ok(response.headers.get('x-request-id'));

      assert.equal(mintTokenArgs.identity, 'test-user');
      assert.ok(mintTokenArgs.now instanceof Date);

      await new Promise((resolve) => setImmediate(resolve));
      const requestLog = logger.entries.find((entry) => entry.message === 'request completed');
      assert.equal(requestLog.meta.path, '/token');
    },
  );
});

test('POST /livekit/webhook validates and logs LiveKit lifecycle events', async () => {
  const logger = createLoggerSpy();
  const payload = JSON.stringify({
    event: 'participant_joined',
    room: {
      name: 'whiterun-test',
    },
    participant: {
      identity: 'test-user',
      sid: 'PA_test123',
    },
  });
  const sha256 = createHash('sha256').update(payload).digest('base64');
  const token = new AccessToken(baseConfig.apiKey, baseConfig.apiSecret);
  token.sha256 = sha256;

  await withServer(
    {
      logger,
      mintToken: async () => {
        throw new Error('mintToken should not be called for webhook requests');
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/livekit/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/webhook+json',
          Authorization: await token.toJwt(),
        },
        body: payload,
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);

      const webhookLog = logger.entries.find((entry) => entry.message === 'LiveKit webhook received');
      assert.equal(webhookLog.meta.event, 'participant_joined');
      assert.equal(webhookLog.meta.roomName, 'whiterun-test');
      assert.equal(webhookLog.meta.participantIdentity, 'test-user');
    },
  );
});

test('POST /livekit/webhook rejects invalid webhook signatures', async () => {
  await withServer(
    {
      mintToken: async () => {
        throw new Error('mintToken should not be called for webhook requests');
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/livekit/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/webhook+json',
          Authorization: 'not-a-valid-webhook-token',
        },
        body: JSON.stringify({ event: 'participant_left' }),
      });
      const body = await response.json();

      assert.equal(response.status, 401);
      assert.equal(body.error, 'invalid_livekit_webhook');
      assert.ok(body.requestId);
    },
  );
});

test('GET /token reuses a proxy request ID in the response body and header', async () => {
  await withServer(
    {
      mintToken: async () => {
        throw new Error('mintToken should not be called for invalid identity');
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/token`, {
        headers: {
          'X-Request-Id': 'proxy-request-123',
        },
      });
      const body = await response.json();

      assert.equal(response.status, 400);
      assert.equal(response.headers.get('x-request-id'), 'proxy-request-123');
      assert.equal(body.requestId, 'proxy-request-123');
    },
  );
});

test('GET /token rejects missing or invalid identity', async () => {
  await withServer(
    {
      mintToken: async () => {
        throw new Error('mintToken should not be called for invalid identity');
      },
    },
    async (baseUrl) => {
      const missingResponse = await fetch(`${baseUrl}/token`);
      const missingBody = await missingResponse.json();

      assert.equal(missingResponse.status, 400);
      assert.equal(missingBody.error, 'invalid_identity');
      assert.ok(missingBody.requestId);

      const longIdentity = 'x'.repeat(65);
      const tooLongResponse = await fetch(`${baseUrl}/token?identity=${longIdentity}`);
      const tooLongBody = await tooLongResponse.json();

      assert.equal(tooLongResponse.status, 400);
      assert.equal(tooLongBody.error, 'invalid_identity');
      assert.ok(tooLongBody.requestId);
    },
  );
});

test('GET /token can require a shared secret header', async () => {
  await withServer(
    {
      config: {
        tokenAuth: {
          headerName: 'x-voip-token-auth',
          secret: 'shared-secret',
        },
      },
      mintToken: async () => {
        throw new Error('mintToken should not be called when auth fails');
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/token?identity=test-user`);
      const body = await response.json();

      assert.equal(response.status, 401);
      assert.equal(body.error, 'token_auth_required');
      assert.ok(body.requestId);
    },
  );
});

test('GET /token rate limits repeated requests', async () => {
  let mintCount = 0;

  await withServer(
    {
      config: {
        rateLimit: {
          maxRequests: 1,
          windowMs: 60_000,
          windowSeconds: 60,
        },
      },
      mintToken: async () => {
        mintCount += 1;
        return {
          token: 'signed-jwt',
          expiresAt: new Date('2026-04-24T15:15:00.000Z'),
        };
      },
    },
    async (baseUrl) => {
      const firstResponse = await fetch(`${baseUrl}/token?identity=test-user`);
      const secondResponse = await fetch(`${baseUrl}/token?identity=test-user`);
      const secondBody = await secondResponse.json();

      assert.equal(firstResponse.status, 200);
      assert.equal(secondResponse.status, 429);
      assert.equal(secondBody.error, 'rate_limited');
      assert.equal(secondResponse.headers.get('ratelimit-limit'), '1');
      assert.equal(mintCount, 1);
    },
  );
});

test('OPTIONS /token returns CORS headers for an allowed origin', async () => {
  await withServer(
    {
      config: {
        allowedOrigin: 'https://app.example.com',
        tokenAuth: {
          headerName: 'x-voip-token-auth',
          secret: 'shared-secret',
        },
      },
      mintToken: async () => {
        throw new Error('mintToken should not be called for OPTIONS');
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/token`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.example.com',
          'Access-Control-Request-Method': 'GET',
        },
      });

      assert.equal(response.status, 204);
      assert.equal(response.headers.get('access-control-allow-origin'), 'https://app.example.com');
      assert.match(response.headers.get('access-control-allow-headers'), /x-voip-token-auth/);
      assert.equal(response.headers.get('access-control-expose-headers'), 'X-Request-Id');
    },
  );
});

test('OPTIONS /token rejects a disallowed origin', async () => {
  await withServer(
    {
      config: {
        allowedOrigin: 'https://app.example.com',
      },
      mintToken: async () => {
        throw new Error('mintToken should not be called for OPTIONS');
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/token`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://evil.example.com',
          'Access-Control-Request-Method': 'GET',
        },
      });
      const body = await response.json();

      assert.equal(response.status, 403);
      assert.equal(body.error, 'cors_origin_denied');
      assert.ok(body.requestId);
    },
  );
});

test('GET /token returns 500 when token minting fails', async () => {
  await withServer(
    {
      mintToken: async () => {
        throw new Error('boom');
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/token?identity=test-user`);
      const body = await response.json();

      assert.equal(response.status, 500);
      assert.equal(body.error, 'token_mint_failed');
      assert.ok(body.requestId);
    },
  );
});

test('GET /token returns 500 when mintToken returns an invalid expiresAt value', async () => {
  await withServer(
    {
      mintToken: async () => {
        return {
          token: 'signed-jwt',
          expiresAt: 'not-a-date',
        };
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/token?identity=test-user`);
      const body = await response.json();

      assert.equal(response.status, 500);
      assert.equal(body.error, 'token_mint_failed');
      assert.ok(body.requestId);
    },
  );
});

test('unknown routes return a request-scoped 404 payload', async () => {
  await withServer(
    {
      mintToken: async () => {
        throw new Error('mintToken should not be called for 404 routes');
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/missing`);
      const body = await response.json();

      assert.equal(response.status, 404);
      assert.equal(body.error, 'not_found');
      assert.ok(body.requestId);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    },
  );
});
