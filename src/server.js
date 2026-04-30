const { createApp } = require('./app');
const { loadConfig, publicStartupConfig } = require('./config');
const { mintParticipantToken } = require('./livekit');
const { createLogger } = require('./logger');
const packageMetadata = require('../package.json');

const KEEP_ALIVE_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 15000;
const HEADERS_TIMEOUT_MS = 16000;

function buildMintToken(config) {
  return ({ identity, now }) =>
    mintParticipantToken({
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      roomName: config.roomName,
      identity,
      tokenTtlSeconds: config.tokenTtlSeconds,
      now,
    });
}

function configureServer(server) {
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  return server;
}

function createShutdownHandler({ logger, server, shutdownTimeoutMs }) {
  let shuttingDown = false;

  return (signal) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info('shutting down server', { signal, shutdownTimeoutMs });

    const forceShutdownTimer = setTimeout(() => {
      logger.error('forcing server shutdown after timeout', {
        signal,
        shutdownTimeoutMs,
      });

      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }

      process.exit(1);
    }, shutdownTimeoutMs);

    if (typeof forceShutdownTimer.unref === 'function') {
      forceShutdownTimer.unref();
    }

    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }

    server.close((error) => {
      clearTimeout(forceShutdownTimer);

      if (error) {
        logger.error('error while shutting down server', {
          error: error instanceof Error ? error.message : 'Unknown close error',
        });
        process.exit(1);
      }

      process.exit(0);
    });
  };
}

async function start() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown startup error';
    console.error(`${new Date().toISOString()} ERROR ${message}`);
    process.exit(1);
  }

  const logger = createLogger({
    level: config.logLevel,
    format: config.logFormat,
    service: packageMetadata.name,
    version: packageMetadata.version,
  });
  const app = createApp({
    config,
    logger,
    mintToken: buildMintToken(config),
  });

  const server = configureServer(
    app.listen(config.port, config.host, () => {
      logger.info('LiveKit token API listening', publicStartupConfig(config));
    }),
  );

  server.on('error', (error) => {
    logger.error('server failed to start', {
      error: error instanceof Error ? error.message : 'Unknown server error',
    });
    process.exit(1);
  });

  const shutdown = createShutdownHandler({
    logger,
    server,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
  });

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

if (require.main === module) {
  start().catch((error) => {
    console.error(
      `${new Date().toISOString()} ERROR ${
        error instanceof Error ? error.message : 'Unhandled startup error'
      }`,
    );
    process.exit(1);
  });
}

module.exports = {
  start,
};
