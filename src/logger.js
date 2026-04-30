const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta) || Object.keys(meta).length === 0) {
    return undefined;
  }

  return meta;
}

function createLogger(options = {}) {
  const level = typeof options === 'string' ? options : options.level;
  const threshold = LEVELS[level] ?? LEVELS.info;
  const format = typeof options === 'string' ? 'json' : options.format ?? 'json';
  const service = typeof options === 'string' ? 'livekit-token-api' : options.service ?? 'livekit-token-api';
  const version = typeof options === 'string' ? undefined : options.version;

  function write(levelName, message, meta) {
    if (LEVELS[levelName] < threshold) {
      return;
    }

    const timestamp = new Date().toISOString();
    const method = levelName === 'debug' ? 'log' : levelName;
    const payload = {
      timestamp,
      level: levelName,
      service,
      message,
    };

    if (version) {
      payload.version = version;
    }

    const sanitizedMeta = sanitizeMeta(meta);
    if (sanitizedMeta) {
      Object.assign(payload, sanitizedMeta);
    }

    if (format === 'text') {
      const suffix = sanitizedMeta ? ` ${JSON.stringify(sanitizedMeta)}` : '';
      console[method](`${timestamp} ${levelName.toUpperCase()} ${message}${suffix}`);
      return;
    }

    console[method](JSON.stringify(payload));
  }

  return {
    debug(message, meta) {
      write('debug', message, meta);
    },
    info(message, meta) {
      write('info', message, meta);
    },
    warn(message, meta) {
      write('warn', message, meta);
    },
    error(message, meta) {
      write('error', message, meta);
    },
  };
}

module.exports = {
  createLogger,
};
