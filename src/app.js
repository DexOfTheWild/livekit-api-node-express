const { createHash, randomUUID, timingSafeEqual } = require('node:crypto');

const express = require('express');
const { WebhookReceiver } = require('livekit-server-sdk');

const { createMetricsRegistry } = require('./metrics');

const REQUEST_ID_HEADERS = ['x-request-id', 'x-correlation-id'];
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,100}$/;

function applyNoStoreHeaders(res) {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
}

function applySecurityHeaders(res) {
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
}

function applyCorsHeaders(req, res, config) {
  if (!config.allowedOrigin) {
    return false;
  }

  const requestOrigin = req.get('Origin');
  if (requestOrigin !== config.allowedOrigin) {
    return false;
  }

  const allowedHeaders = ['Content-Type'];
  if (config.tokenAuth) {
    allowedHeaders.push(config.tokenAuth.headerName);
  }

  res.set('Access-Control-Allow-Origin', config.allowedOrigin);
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', allowedHeaders.join(', '));
  res.set('Access-Control-Expose-Headers', 'X-Request-Id');
  res.append('Vary', 'Origin');
  return true;
}

function sendJson(res, statusCode, payload) {
  applyNoStoreHeaders(res);
  applySecurityHeaders(res);
  return res.status(statusCode).json(payload);
}

function sendText(res, statusCode, payload, contentType = 'text/plain; version=0.0.4; charset=utf-8') {
  applyNoStoreHeaders(res);
  applySecurityHeaders(res);
  res.type(contentType);
  return res.status(statusCode).send(payload);
}

function sendError(res, statusCode, error, message, requestId, extra = {}) {
  return sendJson(res, statusCode, {
    error,
    message,
    requestId,
    ...extra,
  });
}

function validateIdentity(rawIdentity) {
  if (typeof rawIdentity !== 'string') {
    return { ok: false, message: 'identity is required' };
  }

  const identity = rawIdentity.trim();
  if (identity === '') {
    return { ok: false, message: 'identity is required' };
  }

  if (identity.length > 64) {
    return { ok: false, message: 'identity must be 64 characters or fewer' };
  }

  return { ok: true, identity };
}

function readRequestId(req) {
  for (const headerName of REQUEST_ID_HEADERS) {
    const value = req.get(headerName);
    if (typeof value !== 'string') {
      continue;
    }

    const trimmed = value.trim();
    if (REQUEST_ID_PATTERN.test(trimmed)) {
      return trimmed;
    }
  }

  return randomUUID();
}

function getClientAddress(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function hashIdentity(identity) {
  return createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

function secureCompare(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function isTokenRequestAuthorized(req, tokenAuth) {
  if (!tokenAuth) {
    return true;
  }

  const providedSecret = req.get(tokenAuth.headerName);
  if (typeof providedSecret !== 'string' || providedSecret.trim() === '') {
    return false;
  }

  return secureCompare(providedSecret.trim(), tokenAuth.secret);
}

function createRateLimiter(rateLimitConfig) {
  if (!rateLimitConfig) {
    return null;
  }

  const entries = new Map();
  let requestCount = 0;

  function pruneExpiredEntries(now) {
    for (const [key, entry] of entries) {
      if (entry.resetAt <= now) {
        entries.delete(key);
      }
    }
  }

  return {
    check(key) {
      const now = Date.now();
      requestCount += 1;

      if (requestCount % 100 === 0) {
        pruneExpiredEntries(now);
      }

      let entry = entries.get(key);
      if (!entry || entry.resetAt <= now) {
        entry = {
          count: 0,
          resetAt: now + rateLimitConfig.windowMs,
        };
        entries.set(key, entry);
      }

      entry.count += 1;

      return {
        allowed: entry.count <= rateLimitConfig.maxRequests,
        remaining: Math.max(rateLimitConfig.maxRequests - entry.count, 0),
        resetAt: new Date(entry.resetAt),
      };
    },
  };
}

function getRouteLabel(req, res) {
  if (typeof res.locals.routeLabel === 'string' && res.locals.routeLabel.trim() !== '') {
    return res.locals.routeLabel;
  }

  if (req.route?.path) {
    return req.route.path;
  }

  return 'unmatched';
}

function createApp({ config, mintToken, logger = console, metrics = createMetricsRegistry() }) {
  if (!config) {
    throw new Error('config is required');
  }

  if (typeof mintToken !== 'function') {
    throw new Error('mintToken must be a function');
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ?? false);

  const rateLimiter = createRateLimiter(config.rateLimit);
  const webhookReceiver = new WebhookReceiver(config.apiKey, config.apiSecret);

  app.use((req, res, next) => {
    const startedAt = Date.now();
    req.requestId = readRequestId(req);

    res.set('X-Request-Id', req.requestId);
    applyNoStoreHeaders(res);
    applySecurityHeaders(res);

    const corsApplied = applyCorsHeaders(req, res, config);

    if (req.method === 'OPTIONS' && config.allowedOrigin) {
      if (corsApplied) {
        return res.sendStatus(204);
      }

      return sendError(res, 403, 'cors_origin_denied', 'Origin not allowed', req.requestId);
    }

    res.on('finish', () => {
      const durationMs = Date.now() - startedAt;
      const routeLabel = getRouteLabel(req, res);

      metrics.increment('voip_http_requests_total', {
        method: req.method,
        path: routeLabel,
        status: String(res.statusCode),
      });
      metrics.observeDuration(
        'voip_http_request_duration_ms',
        {
          method: req.method,
          path: routeLabel,
          status: String(res.statusCode),
        },
        durationMs,
      );

      logger.info('request completed', {
        requestId: req.requestId,
        method: req.method,
        path: routeLabel,
        statusCode: res.statusCode,
        durationMs,
        ip: getClientAddress(req),
      });
    });

    next();
  });

  app.get('/health', (req, res) => {
    res.locals.routeLabel = '/health';

    const payload = {
      ok: true,
      serverTime: new Date().toISOString(),
    };

    if (config.healthExposeDetails !== false) {
      payload.roomName = config.roomName;
      payload.wsUrl = config.wsUrl;
    }

    return sendJson(res, 200, payload);
  });

  app.get('/metrics', (req, res) => {
    res.locals.routeLabel = '/metrics';
    return sendText(res, 200, metrics.render());
  });

  app.get('/token', async (req, res) => {
    res.locals.routeLabel = '/token';
    const clientAddress = getClientAddress(req);

    if (rateLimiter) {
      const rateLimitResult = rateLimiter.check(clientAddress);
      const resetInSeconds = Math.max(
        Math.ceil((rateLimitResult.resetAt.getTime() - Date.now()) / 1000),
        0,
      );

      res.set('RateLimit-Limit', String(config.rateLimit.maxRequests));
      res.set('RateLimit-Remaining', String(rateLimitResult.remaining));
      res.set('RateLimit-Reset', String(resetInSeconds));

      if (!rateLimitResult.allowed) {
        res.set('Retry-After', String(resetInSeconds));
        metrics.increment('voip_token_requests_total', { result: 'rate_limited' });
        logger.warn('token request rate limited', {
          requestId: req.requestId,
          ip: clientAddress,
        });

        return sendError(
          res,
          429,
          'rate_limited',
          'Too many token requests. Please retry later.',
          req.requestId,
        );
      }
    }

    if (!isTokenRequestAuthorized(req, config.tokenAuth)) {
      metrics.increment('voip_token_requests_total', { result: 'unauthorized' });
      logger.warn('token request rejected by shared-secret gate', {
        requestId: req.requestId,
        ip: clientAddress,
      });

      return sendError(
        res,
        401,
        'token_auth_required',
        'Valid token authorization header is required.',
        req.requestId,
      );
    }

    const validationResult = validateIdentity(req.query.identity);
    if (!validationResult.ok) {
      metrics.increment('voip_token_requests_total', { result: 'invalid_identity' });
      return sendError(
        res,
        400,
        'invalid_identity',
        validationResult.message,
        req.requestId,
      );
    }

    const serverTime = new Date();

    try {
      const result = await mintToken({
        identity: validationResult.identity,
        now: serverTime,
      });

      const expiresAt = new Date(result.expiresAt);
      if (
        typeof result.token !== 'string' ||
        result.token.trim() === '' ||
        Number.isNaN(expiresAt.getTime())
      ) {
        throw new Error('mintToken returned an invalid token payload');
      }

      metrics.increment('voip_token_requests_total', { result: 'success' });
      return sendJson(res, 200, {
        token: result.token,
        identity: validationResult.identity,
        roomName: config.roomName,
        wsUrl: config.wsUrl,
        serverTime: serverTime.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });
    } catch (error) {
      logger.error('token minting failed', {
        requestId: req.requestId,
        identityHash: hashIdentity(validationResult.identity),
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      metrics.increment('voip_token_requests_total', { result: 'mint_failed' });

      return sendError(
        res,
        500,
        'token_mint_failed',
        'Unable to mint LiveKit token',
        req.requestId,
      );
    }
  });

  app.post('/livekit/webhook', express.text({ type: ['application/webhook+json', 'application/json'] }), async (req, res) => {
    res.locals.routeLabel = '/livekit/webhook';
    const rawBody = typeof req.body === 'string' ? req.body : '';

    if (rawBody.trim() === '') {
      metrics.increment('voip_livekit_webhook_receive_total', { result: 'invalid_body' });
      logger.warn('LiveKit webhook rejected due to empty body', {
        requestId: req.requestId,
      });

      return sendError(
        res,
        400,
        'invalid_livekit_webhook_body',
        'LiveKit webhook body is required.',
        req.requestId,
      );
    }

    try {
      const event = await webhookReceiver.receive(rawBody, req.get('Authorization'));
      const eventName = event.event || 'unknown';

      metrics.increment('voip_livekit_webhook_receive_total', { result: 'success' });
      metrics.increment('voip_livekit_webhook_events_total', { event: eventName });

      logger.info('LiveKit webhook received', {
        requestId: req.requestId,
        event: eventName,
        roomName: event.room?.name ?? null,
        participantIdentity: event.participant?.identity ?? null,
        participantSid: event.participant?.sid ?? null,
      });

      return sendJson(res, 200, {
        ok: true,
        requestId: req.requestId,
      });
    } catch (error) {
      metrics.increment('voip_livekit_webhook_receive_total', { result: 'verification_failed' });
      logger.warn('LiveKit webhook rejected', {
        requestId: req.requestId,
        error: error instanceof Error ? error.message : 'Unknown webhook error',
      });

      return sendError(
        res,
        401,
        'invalid_livekit_webhook',
        'Unable to verify LiveKit webhook.',
        req.requestId,
      );
    }
  });

  app.use((req, res) => {
    res.locals.routeLabel = 'unmatched';
    return sendError(res, 404, 'not_found', 'Route not found', req.requestId);
  });

  return app;
}

module.exports = {
  createApp,
  validateIdentity,
};
