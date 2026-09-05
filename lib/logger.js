// Westpoint Security Portal - Structured Logger
// Emits structured JSON entries for log aggregators, with dev-friendly fallbacks.

const LOG_LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL?.toLowerCase()] || LOG_LEVELS.info;

function formatLog(level, message, context = {}, error = null) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    message: typeof message === 'string' ? message : JSON.stringify(message),
    ...context
  };

  if (error) {
    entry.error = {
      message: error.message || String(error),
      code: error.code || undefined,
      stack: error.stack || undefined
    };
  }

  // In production (or when LOG_FORMAT=json), emit single-line JSON
  if (process.env.NODE_ENV === 'production' || process.env.LOG_FORMAT === 'json') {
    return JSON.stringify(entry);
  }

  // Dev format
  const errSnippet = entry.error ? ` | Error: ${entry.error.message}` : '';
  const ctxSnippet = Object.keys(context).length > 0 ? ` ${JSON.stringify(context)}` : '';
  return `[${entry.timestamp}] [${entry.level}] ${entry.message}${ctxSnippet}${errSnippet}`;
}

const logger = {
  debug(msg, context) {
    if (currentLevel <= LOG_LEVELS.debug) {
      console.log(formatLog('debug', msg, context));
    }
  },

  info(msg, context) {
    if (currentLevel <= LOG_LEVELS.info) {
      console.log(formatLog('info', msg, context));
    }
  },

  warn(msg, context, err) {
    if (currentLevel <= LOG_LEVELS.warn) {
      console.warn(formatLog('warn', msg, context, err));
    }
  },

  error(msg, context, err) {
    if (currentLevel <= LOG_LEVELS.error) {
      console.error(formatLog('error', msg, context, err));
    }
  }
};

module.exports = logger;
