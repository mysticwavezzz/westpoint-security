const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'logs') : path.join(__dirname, '..', 'data', 'logs');
const recentAlerts = new Map(); // dedupe key -> last-sent timestamp

function logToFile(level, message, meta) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const line = JSON.stringify({ level, message, meta, timestamp: new Date().toISOString() }) + '\n';
    const file = path.join(LOG_DIR, `${level}-${new Date().toISOString().slice(0, 10)}.log`);
    fs.appendFileSync(file, line);
  } catch (e) { /* never let logging itself crash the app */ }
}

// alertFn: pass in a (embed) => Promise callback, e.g. a closure over
// server.js's postDiscordMessage(channelId, embed), so this module doesn't
// need its own Discord client or channel-id state. Errors are deduped by
// message prefix for 10 minutes so a tight failure loop can't spam the
// channel.
function createLogger(alertFn) {
  return {
    error(message, meta = {}) {
      console.error(message, meta);
      logToFile('error', message, meta);
      const dedupeKey = message.slice(0, 100);
      const now = Date.now();
      if (!recentAlerts.has(dedupeKey) || now - recentAlerts.get(dedupeKey) > 10 * 60 * 1000) {
        recentAlerts.set(dedupeKey, now);
        if (typeof alertFn === 'function') {
          Promise.resolve(alertFn({
            title: 'Application Error',
            color: 0xE74C3C,
            description: message.slice(0, 2000),
            timestamp: new Date().toISOString()
          })).catch(() => {});
        }
      }
    },
    warn(message, meta = {}) {
      console.warn(message, meta);
      logToFile('warn', message, meta);
    },
    info(message, meta = {}) {
      console.log(message, meta);
      logToFile('info', message, meta);
    }
  };
}

module.exports = { createLogger };
