const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '../../bot_debug.log');
const MAX_MEMORY_LOGS = 100;
const MAX_COMMAND_HISTORY = 50;

class LogBuffer {
  constructor() {
    this.buffer = [];
    this.commandHistory = [];
    this.lastRefreshed = new Date();
    this.scheduleNextAutoPurge();
  }

  // Calculate if today is weekend (Saturday = 6, Sunday = 0)
  isWeekend(d = new Date()) {
    const day = d.getDay();
    return day === 0 || day === 6;
  }

  // Get refresh interval in milliseconds: 3 hours on weekend, 8 hours on weekday
  getRefreshIntervalMs(d = new Date()) {
    return this.isWeekend(d) ? 3 * 60 * 60 * 1000 : 8 * 60 * 60 * 1000;
  }

  getNextRefreshDate() {
    const now = new Date();
    const intervalMs = this.getRefreshIntervalMs(now);
    return new Date(this.lastRefreshed.getTime() + intervalMs);
  }

  scheduleNextAutoPurge() {
    if (this.purgeTimer) {
      clearTimeout(this.purgeTimer);
    }
    const now = new Date();
    const intervalMs = this.getRefreshIntervalMs(now);
    const timeSinceLast = now.getTime() - this.lastRefreshed.getTime();
    const delay = Math.max(1000, intervalMs - timeSinceLast);

    this.purgeTimer = setTimeout(() => {
      this.clear();
      this.lastRefreshed = new Date();
      console.log(`[LOGGER] Debug logs refreshed automatically. Schedule: ${this.isWeekend() ? '3h (Weekend)' : '8h (Weekday)'}. Next at: ${this.getNextRefreshDate().toLocaleTimeString()}`);
      this.scheduleNextAutoPurge();
    }, delay);
  }

  log(level, category, message, meta = null) {
    const timestamp = new Date();
    const entry = {
      timestamp,
      iso: timestamp.toISOString(),
      level: level.toUpperCase(), // 'ERROR', 'WARN', 'INFO', 'CMD'
      category: category.toUpperCase(),
      message: typeof message === 'string' ? message : JSON.stringify(message),
      meta: meta ? (typeof meta === 'object' ? JSON.stringify(meta) : String(meta)) : null
    };

    this.buffer.push(entry);
    if (this.buffer.length > MAX_MEMORY_LOGS) {
      this.buffer.shift();
    }

    try {
      const line = `[${entry.iso}] [${entry.level}] [${entry.category}] ${entry.message}${entry.meta ? ' | ' + entry.meta : ''}\n`;
      fs.appendFileSync(LOG_FILE, line, 'utf8');
    } catch (e) {}

    return entry;
  }

  logCommandRun(commandName, userId, userTag, options = null) {
    const timestamp = new Date();
    const entry = {
      timestamp,
      commandName,
      userId,
      userTag,
      options: options ? JSON.stringify(options) : null
    };

    this.commandHistory.push(entry);
    if (this.commandHistory.length > MAX_COMMAND_HISTORY) {
      this.commandHistory.shift();
    }

    this.log('CMD', 'COMMAND', `/${commandName} executed by ${userTag} (${userId})`, options);
    return entry;
  }

  error(category, message, meta) {
    return this.log('ERROR', category, message, meta);
  }

  warn(category, message, meta) {
    return this.log('WARN', category, message, meta);
  }

  info(category, message, meta) {
    return this.log('INFO', category, message, meta);
  }

  getLogs(filterLevel = null, limit = 20) {
    let filtered = [...this.buffer];
    if (filterLevel) {
      filtered = filtered.filter(l => l.level === filterLevel.toUpperCase());
    }
    return filtered.slice(-limit);
  }

  getCommandHistory(limit = 10) {
    return this.commandHistory.slice(-limit);
  }

  getCounts() {
    let errors = 0;
    let warnings = 0;
    let commands = 0;
    let info = 0;
    for (const l of this.buffer) {
      if (l.level === 'ERROR') errors++;
      else if (l.level === 'WARN') warnings++;
      else if (l.level === 'CMD') commands++;
      else info++;
    }
    return { errors, warnings, commands, info, total: this.buffer.length };
  }

  clear() {
    this.buffer = [];
    this.commandHistory = [];
    try {
      if (fs.existsSync(LOG_FILE)) {
        fs.writeFileSync(LOG_FILE, '', 'utf8');
      }
    } catch (e) {}
  }
}

const logger = new LogBuffer();

// Intercept console.error and console.warn automatically so any system error is captured
const originalError = console.error;
const originalWarn = console.warn;

console.error = function (...args) {
  try {
    const msg = args.map(a => (a instanceof Error ? `${a.message}\n${a.stack}` : (typeof a === 'object' ? JSON.stringify(a) : String(a)))).join(' ');
    logger.error('SYSTEM', msg);
  } catch (e) {}
  originalError.apply(console, args);
};

console.warn = function (...args) {
  try {
    const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    // Ignore benign discord.js deprecation warnings if any sneak through
    if (!msg.includes('Supplying "ephemeral"')) {
      logger.warn('SYSTEM', msg);
    }
  } catch (e) {}
  originalWarn.apply(console, args);
};

module.exports = logger;
