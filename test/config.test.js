const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ConfigError,
  loadConfig,
  normalizeHttpOrigin,
  normalizeWsUrl,
} = require('../src/config');

test('normalizeWsUrl strips a trailing /rtc segment', () => {
  assert.equal(normalizeWsUrl('wss://livekit.example.com/rtc/'), 'wss://livekit.example.com');
});

test('normalizeWsUrl rejects unexpected paths and protocols', () => {
  assert.throws(() => normalizeWsUrl('https://livekit.example.com'), ConfigError);
  assert.throws(() => normalizeWsUrl('wss://livekit.example.com/path'), ConfigError);
  assert.throws(() => normalizeWsUrl('wss://livekit.example.com?foo=bar'), ConfigError);
});

test('normalizeHttpOrigin normalizes a plain origin', () => {
  assert.equal(normalizeHttpOrigin('https://app.example.com/'), 'https://app.example.com');
});

test('normalizeHttpOrigin rejects paths and unsupported protocols', () => {
  assert.throws(() => normalizeHttpOrigin('wss://app.example.com'), ConfigError);
  assert.throws(() => normalizeHttpOrigin('https://app.example.com/path'), ConfigError);
});

test('loadConfig throws when required variables are missing', () => {
  assert.throws(() => loadConfig({}), ConfigError);
});

test('loadConfig returns normalized optional settings', () => {
  const config = loadConfig({
    VOIP_LIVEKIT_API_KEY: 'test-key',
    VOIP_LIVEKIT_API_SECRET: 'test-secret',
    VOIP_LIVEKIT_WS_URL: 'wss://livekit.example.com/rtc',
    VOIP_ROOM_NAME: 'whiterun-test',
    VOIP_ALLOWED_ORIGIN: 'https://app.example.com/',
    VOIP_LOG_LEVEL: 'debug',
    VOIP_LOG_FORMAT: 'text',
    VOIP_TRUST_PROXY: 'loopback',
    VOIP_TOKEN_AUTH_SECRET: 'shared-secret',
    VOIP_TOKEN_AUTH_HEADER: 'X-Voice-Auth',
    VOIP_RATE_LIMIT_MAX_REQUESTS: '5',
    VOIP_RATE_LIMIT_WINDOW_SECONDS: '30',
    VOIP_TOKEN_TTL_SECONDS: '600',
    VOIP_HEALTH_EXPOSE_DETAILS: 'false',
    VOIP_SHUTDOWN_TIMEOUT_MS: '7000',
    PORT: '3001',
  });

  assert.equal(config.wsUrl, 'wss://livekit.example.com');
  assert.equal(config.allowedOrigin, 'https://app.example.com');
  assert.equal(config.logLevel, 'debug');
  assert.equal(config.logFormat, 'text');
  assert.equal(config.trustProxy, 'loopback');
  assert.equal(config.tokenAuth.headerName, 'x-voice-auth');
  assert.equal(config.rateLimit.maxRequests, 5);
  assert.equal(config.rateLimit.windowSeconds, 30);
  assert.equal(config.tokenTtlSeconds, 600);
  assert.equal(config.healthExposeDetails, false);
  assert.equal(config.shutdownTimeoutMs, 7000);
  assert.equal(config.port, 3001);
});

test('loadConfig rejects a TTL above the hard cap', () => {
  assert.throws(
    () =>
      loadConfig({
        VOIP_LIVEKIT_API_KEY: 'test-key',
        VOIP_LIVEKIT_API_SECRET: 'test-secret',
        VOIP_LIVEKIT_WS_URL: 'wss://livekit.example.com',
        VOIP_ROOM_NAME: 'whiterun-test',
        VOIP_TOKEN_TTL_SECONDS: '86401',
      }),
    ConfigError,
  );
});

test('loadConfig rejects an invalid room name', () => {
  assert.throws(
    () =>
      loadConfig({
        VOIP_LIVEKIT_API_KEY: 'test-key',
        VOIP_LIVEKIT_API_SECRET: 'test-secret',
        VOIP_LIVEKIT_WS_URL: 'wss://livekit.example.com',
        VOIP_ROOM_NAME: 'bad\nroom',
      }),
    ConfigError,
  );
});

test('loadConfig rejects a rate-limit window without a max request count', () => {
  assert.throws(
    () =>
      loadConfig({
        VOIP_LIVEKIT_API_KEY: 'test-key',
        VOIP_LIVEKIT_API_SECRET: 'test-secret',
        VOIP_LIVEKIT_WS_URL: 'wss://livekit.example.com',
        VOIP_ROOM_NAME: 'whiterun-test',
        VOIP_RATE_LIMIT_WINDOW_SECONDS: '30',
      }),
    ConfigError,
  );
});

test('loadConfig rejects an invalid trust proxy value', () => {
  assert.throws(
    () =>
      loadConfig({
        VOIP_LIVEKIT_API_KEY: 'test-key',
        VOIP_LIVEKIT_API_SECRET: 'test-secret',
        VOIP_LIVEKIT_WS_URL: 'wss://livekit.example.com',
        VOIP_ROOM_NAME: 'whiterun-test',
        VOIP_TRUST_PROXY: 'everywhere',
      }),
    ConfigError,
  );
});

test('loadConfig rejects an invalid log format', () => {
  assert.throws(
    () =>
      loadConfig({
        VOIP_LIVEKIT_API_KEY: 'test-key',
        VOIP_LIVEKIT_API_SECRET: 'test-secret',
        VOIP_LIVEKIT_WS_URL: 'wss://livekit.example.com',
        VOIP_ROOM_NAME: 'whiterun-test',
        VOIP_LOG_FORMAT: 'yaml',
      }),
    ConfigError,
  );
});
