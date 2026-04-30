const REQUIRED_ENV_VARS = [
  'VOIP_LIVEKIT_API_KEY',
  'VOIP_LIVEKIT_API_SECRET',
  'VOIP_LIVEKIT_WS_URL',
  'VOIP_ROOM_NAME',
];

const VALID_LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const VALID_LOG_FORMATS = new Set(['json', 'text']);
const VALID_TRUST_PROXY_VALUES = new Set(['loopback', 'linklocal', 'uniquelocal']);
const ROOM_NAME_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]+$/;

const MAX_TOKEN_TTL_SECONDS = 86_400;
const MAX_ROOM_NAME_LENGTH = 128;

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function readRequiredString(env, key) {
  const value = env[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`Missing required environment variable: ${key}`);
  }

  return value.trim();
}

function readOptionalString(env, key, fallback) {
  const value = env[key];
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function readPositiveInteger(env, key, fallback) {
  const rawValue = readOptionalString(env, key, String(fallback));
  const parsed = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${key} must be a positive integer`);
  }

  return parsed;
}

function readOptionalPositiveInteger(env, key, fallback = null) {
  const rawValue = readOptionalString(env, key, null);
  if (rawValue === null) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${key} must be a positive integer`);
  }

  return parsed;
}

function readBoolean(env, key, fallback) {
  const rawValue = readOptionalString(env, key, null);
  if (rawValue === null) {
    return fallback;
  }

  const normalized = rawValue.toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }

  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }

  throw new ConfigError(`${key} must be true or false`);
}

function normalizeWsUrl(rawWsUrl) {
  const trimmed = String(rawWsUrl).trim();

  let parsedUrl;
  try {
    parsedUrl = new URL(trimmed);
  } catch (error) {
    throw new ConfigError('VOIP_LIVEKIT_WS_URL must be a valid ws:// or wss:// URL');
  }

  if (parsedUrl.protocol !== 'ws:' && parsedUrl.protocol !== 'wss:') {
    throw new ConfigError('VOIP_LIVEKIT_WS_URL must use ws:// or wss://');
  }

  if (parsedUrl.search || parsedUrl.hash) {
    throw new ConfigError('VOIP_LIVEKIT_WS_URL must not include query parameters or fragments');
  }

  const normalizedPath = parsedUrl.pathname.replace(/\/+$/, '');
  if (normalizedPath !== '' && normalizedPath !== '/' && normalizedPath !== '/rtc') {
    throw new ConfigError(
      'VOIP_LIVEKIT_WS_URL must be the base LiveKit URL and may only include an optional trailing /rtc',
    );
  }

  return `${parsedUrl.protocol}//${parsedUrl.host}`;
}

function normalizeHttpOrigin(rawOrigin, key = 'VOIP_ALLOWED_ORIGIN') {
  const trimmed = String(rawOrigin).trim();

  let parsedUrl;
  try {
    parsedUrl = new URL(trimmed);
  } catch (error) {
    throw new ConfigError(`${key} must be a valid http:// or https:// origin`);
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new ConfigError(`${key} must use http:// or https://`);
  }

  if (parsedUrl.search || parsedUrl.hash) {
    throw new ConfigError(`${key} must not include query parameters or fragments`);
  }

  const normalizedPath = parsedUrl.pathname.replace(/\/+$/, '');
  if (normalizedPath !== '' && normalizedPath !== '/') {
    throw new ConfigError(`${key} must be an origin only and must not include a path`);
  }

  return `${parsedUrl.protocol}//${parsedUrl.host}`;
}

function validateRoomName(rawRoomName) {
  const roomName = String(rawRoomName).trim();
  if (roomName === '') {
    throw new ConfigError('VOIP_ROOM_NAME must not be empty');
  }

  if (roomName.length > MAX_ROOM_NAME_LENGTH) {
    throw new ConfigError(`VOIP_ROOM_NAME must be ${MAX_ROOM_NAME_LENGTH} characters or fewer`);
  }

  if (ROOM_NAME_CONTROL_CHARACTERS.test(roomName)) {
    throw new ConfigError('VOIP_ROOM_NAME must not contain control characters');
  }

  return roomName;
}

function parseTrustProxy(env) {
  const rawValue = readOptionalString(env, 'VOIP_TRUST_PROXY', null);
  if (rawValue === null) {
    return false;
  }

  const normalized = rawValue.toLowerCase();
  if (normalized === 'true') {
    return true;
  }

  if (normalized === 'false') {
    return false;
  }

  if (VALID_TRUST_PROXY_VALUES.has(normalized)) {
    return normalized;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (String(parsed) === rawValue && Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }

  throw new ConfigError(
    'VOIP_TRUST_PROXY must be true, false, a positive integer, or one of: loopback, linklocal, uniquelocal',
  );
}

function readTokenAuthConfig(env) {
  const secret = readOptionalString(env, 'VOIP_TOKEN_AUTH_SECRET', null);
  if (secret === null) {
    return null;
  }

  const headerName = readOptionalString(env, 'VOIP_TOKEN_AUTH_HEADER', 'x-voip-token-auth').toLowerCase();
  if (!HEADER_NAME_PATTERN.test(headerName)) {
    throw new ConfigError('VOIP_TOKEN_AUTH_HEADER must be a valid HTTP header name');
  }

  return {
    headerName,
    secret,
  };
}

function readRateLimitConfig(env) {
  const rateLimitMaxRequests = readOptionalPositiveInteger(env, 'VOIP_RATE_LIMIT_MAX_REQUESTS', null);
  const hasWindowOverride =
    typeof env.VOIP_RATE_LIMIT_WINDOW_SECONDS === 'string' &&
    env.VOIP_RATE_LIMIT_WINDOW_SECONDS.trim() !== '';

  if (rateLimitMaxRequests === null && hasWindowOverride) {
    throw new ConfigError(
      'VOIP_RATE_LIMIT_WINDOW_SECONDS requires VOIP_RATE_LIMIT_MAX_REQUESTS to also be set',
    );
  }

  if (rateLimitMaxRequests === null) {
    return null;
  }

  const windowSeconds = readPositiveInteger(env, 'VOIP_RATE_LIMIT_WINDOW_SECONDS', 60);
  return {
    maxRequests: rateLimitMaxRequests,
    windowMs: windowSeconds * 1000,
    windowSeconds,
  };
}

function loadConfig(env = process.env) {
  const missingVars = REQUIRED_ENV_VARS.filter((key) => {
    const value = env[key];
    return typeof value !== 'string' || value.trim() === '';
  });

  if (missingVars.length > 0) {
    throw new ConfigError(`Missing required environment variables: ${missingVars.join(', ')}`);
  }

  const logLevel = readOptionalString(env, 'VOIP_LOG_LEVEL', 'info').toLowerCase();
  if (!VALID_LOG_LEVELS.has(logLevel)) {
    throw new ConfigError('VOIP_LOG_LEVEL must be one of: debug, info, warn, error');
  }

  const logFormat = readOptionalString(env, 'VOIP_LOG_FORMAT', 'json').toLowerCase();
  if (!VALID_LOG_FORMATS.has(logFormat)) {
    throw new ConfigError('VOIP_LOG_FORMAT must be one of: json, text');
  }

  const port = readPositiveInteger(env, 'PORT', 3000);
  if (port > 65535) {
    throw new ConfigError('PORT must be 65535 or lower');
  }

  const tokenTtlSeconds = readPositiveInteger(env, 'VOIP_TOKEN_TTL_SECONDS', 900);
  if (tokenTtlSeconds > MAX_TOKEN_TTL_SECONDS) {
    throw new ConfigError(
      `VOIP_TOKEN_TTL_SECONDS must be ${MAX_TOKEN_TTL_SECONDS} seconds or fewer`,
    );
  }

  const allowedOriginValue = readOptionalString(env, 'VOIP_ALLOWED_ORIGIN', null);

  return {
    apiKey: readRequiredString(env, 'VOIP_LIVEKIT_API_KEY'),
    apiSecret: readRequiredString(env, 'VOIP_LIVEKIT_API_SECRET'),
    wsUrl: normalizeWsUrl(readRequiredString(env, 'VOIP_LIVEKIT_WS_URL')),
    roomName: validateRoomName(readRequiredString(env, 'VOIP_ROOM_NAME')),
    tokenTtlSeconds,
    host: readOptionalString(env, 'HOST', '127.0.0.1'),
    port,
    allowedOrigin: allowedOriginValue ? normalizeHttpOrigin(allowedOriginValue) : null,
    logLevel,
    logFormat,
    trustProxy: parseTrustProxy(env),
    shutdownTimeoutMs: readPositiveInteger(env, 'VOIP_SHUTDOWN_TIMEOUT_MS', 10000),
    healthExposeDetails: readBoolean(env, 'VOIP_HEALTH_EXPOSE_DETAILS', true),
    tokenAuth: readTokenAuthConfig(env),
    rateLimit: readRateLimitConfig(env),
  };
}

function publicStartupConfig(config) {
  return {
    host: config.host,
    port: config.port,
    roomName: config.roomName,
    wsUrl: config.wsUrl,
    tokenTtlSeconds: config.tokenTtlSeconds,
    allowedOrigin: config.allowedOrigin,
    logLevel: config.logLevel,
    logFormat: config.logFormat,
    trustProxy: config.trustProxy,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    healthExposeDetails: config.healthExposeDetails,
    tokenAuthEnabled: Boolean(config.tokenAuth),
    tokenAuthHeader: config.tokenAuth?.headerName ?? null,
    rateLimit: config.rateLimit
      ? {
          maxRequests: config.rateLimit.maxRequests,
          windowSeconds: config.rateLimit.windowSeconds,
        }
      : null,
  };
}

module.exports = {
  ConfigError,
  loadConfig,
  normalizeHttpOrigin,
  normalizeWsUrl,
  publicStartupConfig,
};
