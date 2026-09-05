const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const querystring = require('querystring');
const crypto = require('crypto');

const BASE_DIR = __dirname;
// Falls back to BASE_DIR itself so the same server.js works both in the source
// layout (views/, public/ subfolders) and in a flattened deploy (dist/) where
// pages and assets sit directly at the root.
const VIEWS_DIR = fs.existsSync(path.join(BASE_DIR, 'views')) ? path.join(BASE_DIR, 'views') : BASE_DIR;
const PUBLIC_DIR = fs.existsSync(path.join(BASE_DIR, 'public')) ? path.join(BASE_DIR, 'public') : BASE_DIR;
// Overridable (e.g. DATA_DIR=/data/app-data on a mounted Railway Volume) so
// sessions/reports/incidents survive redeploys instead of living on the
// container's ephemeral disk, which gets wiped on every deploy otherwise.
const DATA_DIR = process.env.DATA_DIR || path.join(BASE_DIR, 'data');
const robloxService = require('./lib/robloxService.js');
const r2 = require('./lib/r2.js');
const video = require('./lib/video.js');
const videoLog = require('./lib/videoLog.js');
const { REST: DiscordREST, Routes: DiscordRoutes } = require('discord.js');
const webpush = require('web-push');
// Shared with the Discord bot (resilient-meitner). That bot currently only
// runs on this machine, so this only resolves where the bot's SQLite file is
// actually reachable on disk — override with BOT_DB_PATH in .env for any
// other host (e.g. if the bot and portal are later deployed to the same box).
const BOT_DB_PATH = process.env.BOT_DB_PATH || 'C:/Users/Nolan/Documents/antigravity/resilient-meitner/bot.db';

// Simple .env Loader
function loadEnv() {
  const envPath = path.join(BASE_DIR, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        // A real environment variable (Railway's own config, or a test
        // harness overriding PORT to run an isolated instance) always wins
        // over the checked-in .env file's default - matches standard
        // dotenv-style precedence. Discovered this was backwards while
        // writing test/smoke.test.js: spawning the server with an
        // overridden PORT still came up on .env's PORT=8080 every time,
        // silently clobbering the override.
        if (Object.prototype.hasOwnProperty.call(process.env, match[1])) continue;
        let value = (match[2] || '').trim();
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
        process.env[match[1]] = value;
      }
    }
  }
}
loadEnv();

const PORT = process.env.PORT || 8080;
const DISCORD_BOT_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.CLIENT_ID || '1540023346794856540';
const DISCORD_CLIENT_SECRET = process.env.CLIENT_SECRET;
const GUILD_ID = process.env.GUILD_ID || '1522793078199419022';
// These four are `let`, not `const`: the Admin Channel Config panel
// (GET/POST /api/admin/channels) overwrites them in-memory and persists the
// change to channel-config.json, so an edit there applies immediately with
// no redeploy - same "seed from env, override from a saved JSON file" idea
// as role-permissions.json, just without needing every call site to go
// through a getter function since these were already plain top-level
// constants referenced directly throughout the file.
let DEPT_LOGS_CHANNEL_ID = process.env.DEPARTMENT_LOGS_CHANNEL_ID || '1542980017472929944';
let AUDIT_LOGS_CHANNEL_ID = process.env.AUDIT_LOGS_CHANNEL_ID || '1540024507761164348';
// Bodycam video logs post to a *different* server than the main guild (per-
// officer channels get created under this one, next to the "video logs"
// channel/category originally given).
let VIDEO_LOG_GUILD_ID = process.env.VIDEO_LOG_GUILD_ID || '1540023207082463272';
let VIDEO_LOG_PARENT_ID = process.env.VIDEO_LOG_PARENT_ID || '1545537864677331105';

// Applied once at startup, right after loadEnv() below - overwrites the
// `let` defaults above with anything Command has saved via the Admin
// Channel Config panel.
function loadChannelConfigOverrides() {
  const saved = readJSONFile('channel-config.json', null);
  if (!saved) return;
  if (saved.deptLogsChannelId) DEPT_LOGS_CHANNEL_ID = saved.deptLogsChannelId;
  if (saved.auditLogsChannelId) AUDIT_LOGS_CHANNEL_ID = saved.auditLogsChannelId;
  if (saved.videoLogGuildId) VIDEO_LOG_GUILD_ID = saved.videoLogGuildId;
  if (saved.videoLogParentId) VIDEO_LOG_PARENT_ID = saved.videoLogParentId;
}
loadChannelConfigOverrides();

// Discord validates redirect_uri against exactly what's registered in the app's
// developer portal, so it must match the domain the request actually arrived
// on (custom domain, Railway subdomain, or localhost during dev) rather than
// a single hardcoded value. PUBLIC_URL in .env overrides this when the Host
// header can't be trusted (e.g. behind a proxy that doesn't forward it).
function getRedirectUri(req) {
  if (process.env.PUBLIC_URL) {
    return `${process.env.PUBLIC_URL.replace(/\/+$/, '')}/auth/discord/callback`;
  }
  const proto = req.headers['x-forwarded-proto'] || (req.connection.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}/auth/discord/callback`;
}

if (!DISCORD_BOT_TOKEN || !DISCORD_CLIENT_SECRET) {
  console.warn('[SECURITY WARNING] DISCORD_TOKEN or CLIENT_SECRET is not configured in environment!');
}

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// -------------------------------------------------------------
// IN-MEMORY ANTI-DDOS / ABUSE RATE LIMITING ENGINE
// -------------------------------------------------------------
const RATE_LIMIT_WINDOWS = new Map(); // ip -> { count, resetTime }

function checkRateLimit(ip, limit = 120, windowMs = 60000) {
  const now = Date.now();
  const entry = RATE_LIMIT_WINDOWS.get(ip);
  if (!entry || now > entry.resetTime) {
    RATE_LIMIT_WINDOWS.set(ip, { count: 1, resetTime: now + windowMs });
    return { allowed: true, remaining: limit - 1 };
  }
  entry.count++;
  if (entry.count > limit) {
    const retryAfter = Math.ceil((entry.resetTime - now) / 1000);
    return { allowed: false, retryAfter };
  }
  return { allowed: true, remaining: limit - entry.count };
}

// Clean up stale rate limits every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of RATE_LIMIT_WINDOWS.entries()) {
    if (now > entry.resetTime) RATE_LIMIT_WINDOWS.delete(ip);
  }
}, 300000);

// Global HTTP Security Headers
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  // media-src/connect-src include R2 (*.r2.cloudflarestorage.com) since
  // bodycam chunks and playback are fetched directly from presigned R2 URLs,
  // not proxied through this server - without this the browser silently
  // blocks every one of those requests as a CSP violation.
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://discord.com https://cdn.discordapp.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://cdn.discordapp.com; font-src 'self'; media-src 'self' blob: https://*.r2.cloudflarestorage.com; connect-src 'self' https://discord.com https://*.roblox.com https://*.r2.cloudflarestorage.com; frame-ancestors 'none';"
};

// In-memory active officer web sessions
// Persistent officer sessions
const SESSIONS = new Map();
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

// Confirmation codes for destructive Command actions - NOT real two-factor
// auth (no independent device/channel like SMS/authenticator/email), just a
// stronger "type to confirm" pattern using a server-issued one-time code
// instead of a fixed phrase. Proves the confirmation happened through a
// live server round-trip rather than a client-side-only confirm() dialog
// that devtools could bypass. The code is returned directly to the caller -
// the friction is the deliberate second step, not secrecy of the code.
const CONFIRMATION_CODES = new Map(); // key: `${userId}:${action}` -> { code, expiresAt }

// Validates and single-use-consumes a confirmation code for the given user
// and action. Returns true/false; deletes the entry either way so a code
// can never be replayed, expired or not.
function consumeConfirmationCode(userId, action, providedCode) {
  const key = `${userId}:${action}`;
  const entry = CONFIRMATION_CODES.get(key);
  CONFIRMATION_CODES.delete(key);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) return false;
  return String(providedCode) === entry.code;
}

function loadPersistedSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      const now = Date.now();
      const maxAgeMs = 24 * 60 * 60 * 1000; // 24 hours expiry
      for (const [k, v] of Object.entries(data)) {
        if (v && v.loginTime && (now - new Date(v.loginTime).getTime()) < maxAgeMs) {
          SESSIONS.set(k, v);
        }
      }
      console.log(`[AUTH] Loaded ${SESSIONS.size} valid active sessions from disk.`);
    }
  } catch (e) {
    console.error('[AUTH SESSION LOAD ERROR]', e.message);
  }
}
loadPersistedSessions();

function persistSessions() {
  try {
    const obj = Object.fromEntries(SESSIONS);
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    console.error('[AUTH SESSION SAVE ERROR]', e.message);
  }
}

// Which Discord roles in the guild grant staff access, and what each one
// unlocks, used to be hardcoded here and only changeable by editing this
// file and redeploying. It's now data - stored in role-permissions.json
// (DATA_DIR, so it lives on the same persistent Volume as everything else)
// and editable from the Command Center's Role Permissions panel. These are
// only the seed values used the first time that file doesn't exist yet, so
// a fresh deploy behaves exactly as it always did until Command edits
// something - after that, this constant is never read again.
// Seed positions.json the first time it's read (readJSONFile's default
// value, not written to disk until Command actually edits something) -
// listed and visibly closed rather than an empty list, matching the
// original site-wide "APPLICATIONS CLOSED" notice this feature replaces.
const DEFAULT_POSITIONS = [
  { id: 'POS-1001', title: 'Security Officer', department: 'Field Operations', description: 'Entry-level patrol and response duties across Harrison County.', status: 'closed', createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'POS-1002', title: 'Dispatcher', department: 'Operations Center', description: 'Coordinate officer response and radio traffic from the operations desk.', status: 'closed', createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'POS-1003', title: 'Field Supervisor', department: 'Field Operations', description: 'Oversee patrol shifts and mentor junior officers.', status: 'closed', createdAt: '2026-01-01T00:00:00.000Z' }
];

// FTO (Field Training Officer) checklist stages - fixed list rather than
// free text, so progress is actually queryable/consistent across trainees.
const FTO_STAGES = ['Radio Procedures', 'Traffic Stops', 'Report Writing', 'Use of Force Policy', 'Final Ride-Along'];

// Predefined staff flag vocabulary - Command picks from this list rather
// than free-typing, so flags stay consistent/filterable. Extensible later;
// "FTO Trainee" is set/cleared automatically by the FTO endpoints below,
// the rest are Command's to apply manually from the Staff Directory.
const STAFF_FLAGS = ['Awaiting Field Eval', 'On Leave', 'Under Review', 'FTO Trainee', 'FTO Trainer'];

// Fixed bodycam clip tag vocabulary, for faster search/filtering.
const BODYCAM_TAGS = ['Traffic Stop', 'Pursuit', 'Arrest', 'Use of Force', 'Standard Patrol', 'Other'];

// How many ready recordings the Bodycam Audit Randomizer selects per run.
const AUDIT_RANDOMIZER_COUNT = 3;

function setStaffFlag(userId, flagName, setBy) {
  getBotDb().prepare(`
    INSERT INTO staff_flags (user_id, flag_name, set_by, set_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, flag_name) DO UPDATE SET set_by = excluded.set_by, set_at = excluded.set_at
  `).run(userId, flagName, setBy, Date.now());
}

function clearStaffFlag(userId, flagName) {
  getBotDb().prepare('DELETE FROM staff_flags WHERE user_id = ? AND flag_name = ?').run(userId, flagName);
}

const LEGACY_ROLE_SEED = {
  '1522793591112466493': { displayName: 'Security Chief', isCommand: true },
  '1522793595315294248': { displayName: 'Security Deputy Chief', isCommand: true },
  '1522793598633119754': { displayName: 'Captain', isCommand: true },
  '1522793602449670204': { displayName: 'Lieutenant', isSupervisor: true },
  '1522793605683613877': { displayName: 'Sergeant', isSupervisor: true },
  '1522793608988721252': { displayName: 'Corporal' },
  '1522793612394627162': { displayName: 'Senior Security Officer' },
  '1522793615884161126': { displayName: 'Security Officer' },
  '1522793618908381286': { displayName: 'Probationary Security Officer' },
  '1522798272144605315': { displayName: 'Command', isCommand: true },
  '1522798280000405625': { displayName: 'Supervisor', isSupervisor: true },
  '1522798554580783124': { displayName: 'Internal Affairs', isInternalAffairs: true },
  '1544515568563126303': { displayName: 'Westpoint Security' }
};

let roleConfigCache = null;
function getRoleConfig() {
  if (roleConfigCache) return roleConfigCache;
  const existing = readJSONFile('role-permissions.json', null);
  if (existing) {
    roleConfigCache = existing;
    return existing;
  }
  const seeded = {};
  Object.entries(LEGACY_ROLE_SEED).forEach(([id, cfg], index) => {
    seeded[id] = {
      displayName: cfg.displayName,
      position: 1000 - index, // arbitrary but stable ordering until a real Discord position is saved over it
      enabled: true,
      isSupervisor: !!cfg.isSupervisor || !!cfg.isCommand,
      isCommand: !!cfg.isCommand,
      isInternalAffairs: !!cfg.isInternalAffairs || !!cfg.isCommand,
      // 900s (15min) matches the bot's previous single global
      // WEEKLY_QUOTA_SECONDS constant, so a fresh deploy behaves exactly as
      // it always did until Command customizes a role's target.
      weeklyQuotaSeconds: 900
    };
  });
  writeJSONFile('role-permissions.json', seeded);
  roleConfigCache = seeded;
  return seeded;
}

// Given the raw Discord role IDs a guild member holds, looks each one up in
// the (admin-editable) role config and derives what they're allowed to do.
// isOfficer just means "holds at least one enabled staff role" - the other
// flags are independent (a role can grant Supervisor without Command, etc.),
// matching how multiple roles combine for a real member.
function computePermissionsFromDiscordRoles(discordRoleIds) {
  const config = getRoleConfig();
  const matched = (discordRoleIds || []).map(id => config[id]).filter(r => r && r.enabled);

  const isOfficer = matched.length > 0;
  const isCommand = matched.some(r => r.isCommand);
  const isSupervisor = isCommand || matched.some(r => r.isSupervisor);
  const isInternalAffairs = isCommand || matched.some(r => r.isInternalAffairs);

  let tier = 0;
  let tierLabel = 'Verified Citizen';
  if (isCommand) {
    tier = 3;
    tierLabel = 'High Command';
  } else if (isSupervisor) {
    tier = 2;
    tierLabel = 'Field Supervisor';
  } else if (isOfficer) {
    tier = 1;
    tierLabel = 'Field Officer';
  }

  const roleNames = matched
    .slice()
    .sort((a, b) => (b.position || 0) - (a.position || 0))
    .map(r => r.displayName);

  // A member holding multiple roles is held to the HIGHEST target among
  // them - e.g. a Captain who also holds a base Officer role shouldn't get
  // to coast on the lower bar just because they still hold that role too.
  const quotaTargetSeconds = matched.reduce((max, r) => Math.max(max, Number(r.weeklyQuotaSeconds) || 0), 0);

  return {
    permissions: { isOfficer, isSupervisor, isCommand, isInternalAffairs, tier, tierLabel },
    roles: roleNames,
    highestRank: roleNames[0] || null,
    quotaTargetSeconds
  };
}

const ACTION_COLORS = {
  hire: 0x2ECC71,
  promote: 0x3498DB,
  demote: 0xE74C3C,
  terminate: 0x992D22,
  adminleave: 0x9B59B6,
  suspend: 0xE67E22,
  warn: 0xF1C40F,
  custom: 0x1ABC9C
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const ROUTE_VIEWS = {
  '/': 'index.html',
  '/index': 'index.html',
  '/about': 'about.html',
  '/services': 'services.html',
  '/service-area': 'service-area.html',
  '/careers': 'careers.html',
  '/newsroom': 'newsroom.html',
  '/report-misconduct': 'report-misconduct.html',
  '/contact': 'contact.html',
  '/terms': 'terms.html',
  '/privacy': 'privacy.html',
  '/employee': 'employee.html',
  '/employee/dashboard': 'employee-dashboard.html',
  '/site-map': 'site-map.html',
  '/blotter': 'blotter.html',
  '/transparency': 'transparency.html'
};

function serveViewFile(res, filename) {
  const filePath = path.join(VIEWS_DIR, filename);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
      return res.end('500 Server Error');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
    res.end(data);
  });
}

// Database Connection Helper
let botDbInstance = null;
function getBotDb() {
  if (botDbInstance) return botDbInstance;
  try {
    const Database = require('better-sqlite3');
    let targetDbPath = BOT_DB_PATH;
    if (!fs.existsSync(targetDbPath)) {
      // Fallback for Railway / standalone deployments without direct access to local bot.db
      targetDbPath = path.join(DATA_DIR, 'portal.db');
    }
    botDbInstance = new Database(targetDbPath, { timeout: 5000 });
    botDbInstance.pragma('journal_mode = WAL');
    botDbInstance.pragma('busy_timeout = 5000');
    // Ensure all required tables exist
    botDbInstance.exec(`
      CREATE TABLE IF NOT EXISTS active_sessions (
        user_id TEXT PRIMARY KEY,
        roblox_id TEXT NOT NULL,
        roblox_username TEXT NOT NULL,
        start_time INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS weekly_totals (
        user_id TEXT NOT NULL,
        week_key TEXT NOT NULL,
        total_seconds INTEGER DEFAULT 0,
        PRIMARY KEY (user_id, week_key)
      );
      CREATE TABLE IF NOT EXISTS user_action_states (
        target_user_id TEXT PRIMARY KEY,
        last_action_type TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS staff_members (
        user_id TEXT PRIMARY KEY,
        roblox_id TEXT,
        roblox_username TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS weekly_audits (
        week_key TEXT PRIMARY KEY,
        audited_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS shift_history (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        roblox_username TEXT,
        start_time INTEGER NOT NULL,
        end_time INTEGER NOT NULL,
        duration_seconds INTEGER NOT NULL,
        week_key TEXT NOT NULL,
        bodycam_id TEXT
      );
      CREATE TABLE IF NOT EXISTS bodycam_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        week_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'recording',
        chunk_count INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        duration_seconds INTEGER,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS officer_video_channels (
        user_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS video_channel_clears (
        week_key TEXT PRIMARY KEY,
        cleared_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fto_assignments (
        id TEXT PRIMARY KEY,
        trainee_user_id TEXT NOT NULL,
        trainer_user_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        notes TEXT
      );
      CREATE TABLE IF NOT EXISTS fto_signoffs (
        id TEXT PRIMARY KEY,
        assignment_id TEXT NOT NULL,
        stage_name TEXT NOT NULL,
        signed_off_by TEXT NOT NULL,
        signed_off_at INTEGER NOT NULL,
        notes TEXT
      );
      CREATE TABLE IF NOT EXISTS staff_flags (
        user_id TEXT NOT NULL,
        flag_name TEXT NOT NULL,
        set_by TEXT NOT NULL,
        set_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, flag_name)
      );
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        user_id TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, endpoint)
      );
    `);
    // Older bot.db files predate these columns/tables.
    try {
      botDbInstance.exec('ALTER TABLE active_sessions ADD COLUMN bodycam_id TEXT');
    } catch (e) {} // already exists
    try {
      botDbInstance.exec('ALTER TABLE bodycam_sessions ADD COLUMN discord_channel_id TEXT');
    } catch (e) {}
    try {
      botDbInstance.exec('ALTER TABLE bodycam_sessions ADD COLUMN discord_message_ids TEXT');
    } catch (e) {}
    try {
      botDbInstance.exec('ALTER TABLE bodycam_sessions ADD COLUMN shift_number INTEGER');
    } catch (e) {}
    try {
      botDbInstance.exec('ALTER TABLE shift_history ADD COLUMN shift_number INTEGER');
    } catch (e) {}
    try {
      botDbInstance.exec('ALTER TABLE staff_members ADD COLUMN quota_target_seconds INTEGER');
    } catch (e) {}
    try {
      botDbInstance.exec('ALTER TABLE staff_members ADD COLUMN last_known_rank TEXT');
    } catch (e) {}
    try {
      botDbInstance.exec('ALTER TABLE bodycam_sessions ADD COLUMN tags TEXT');
    } catch (e) {}
    try {
      botDbInstance.exec("ALTER TABLE bodycam_sessions ADD COLUMN review_status TEXT DEFAULT 'unreviewed'");
    } catch (e) {}
    try {
      botDbInstance.exec('ALTER TABLE bodycam_sessions ADD COLUMN reviewed_by TEXT');
    } catch (e) {}
    try {
      botDbInstance.exec('ALTER TABLE bodycam_sessions ADD COLUMN reviewed_at INTEGER');
    } catch (e) {}
    try {
      botDbInstance.exec('ALTER TABLE bodycam_sessions ADD COLUMN audit_selected_at INTEGER');
    } catch (e) {}
    return botDbInstance;
  } catch (e) {
    logger.error('[DATABASE CONNECT ERROR] ' + e.message);
  }
  return null;
}

function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (rc) {
    rc.split(';').forEach(cookie => {
      const parts = cookie.split('=');
      list[parts.shift().trim()] = decodeURI(parts.join('='));
    });
  }
  return list;
}

function sendJSON(res, status, data, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...SECURITY_HEADERS,
    ...headers
  });
  res.end(JSON.stringify(data));
}

// Bodycam chunks are binary video blobs, not JSON, and much larger than the
// 64KB cap every other endpoint uses - a raw Buffer reader with its own
// (much bigger, since a few seconds of screen-share video isn't tiny) limit.
function readRawBody(req, maxBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytesReceived = 0;
    let exceeded = false;

    req.on('data', chunk => {
      if (exceeded) return;
      bytesReceived += chunk.length;
      if (bytesReceived > maxBytes) {
        exceeded = true;
        req.pause();
        const err = new Error('PAYLOAD_TOO_LARGE');
        err.code = 'PAYLOAD_TOO_LARGE';
        reject(err);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (exceeded) return;
      resolve(Buffer.concat(chunks));
    });

    req.on('error', () => {
      if (!exceeded) resolve(Buffer.concat(chunks));
    });
  });
}

function parseBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let bodyStr = '';
    let bytesReceived = 0;
    let exceeded = false;

    req.on('data', chunk => {
      if (exceeded) return;
      bytesReceived += chunk.length;
      if (bytesReceived > maxBytes) {
        exceeded = true;
        req.pause();
        const err = new Error('PAYLOAD_TOO_LARGE');
        err.code = 'PAYLOAD_TOO_LARGE';
        reject(err);
        return;
      }
      bodyStr += chunk;
    });

    req.on('end', () => {
      if (exceeded) return;
      try {
        const parsed = JSON.parse(bodyStr || '{}');
        // Prevent Object prototype pollution
        if (parsed && typeof parsed === 'object') {
          delete parsed['__proto__'];
          delete parsed['constructor'];
          delete parsed['prototype'];
        }
        resolve(parsed);
      } catch (e) {
        resolve({});
      }
    });

    req.on('error', (err) => {
      if (!exceeded) {
        resolve({});
      }
    });
  });
}

function readJSONFile(filename, defaultVal = []) {
  const filePath = path.join(DATA_DIR, filename);
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {}
  return defaultVal;
}

function writeJSONFile(filename, data) {
  const filePath = path.join(DATA_DIR, filename);
  try {
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    console.error(`[FS WRITE ERROR: ${filename}]`, e.message);
  }
}

function formatDuration(totalSeconds) {
  if (!totalSeconds || isNaN(totalSeconds) || totalSeconds <= 0) return '0s';
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

function getWeekKey(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

// Send Discord Channel Embed via REST API
function postDiscordMessage(channelId, embed) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ embeds: [embed] });
    const options = {
      hostname: 'discord.com',
      path: `/api/v10/channels/${channelId}/messages`,
      method: 'POST',
      headers: {
        'Authorization': `Bot ${DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'WestpointPortal/1.0'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch(e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', (err) => resolve({ status: 500, error: err.message }));
    req.write(payload);
    req.end();
  });
}

// Structured logging: writes JSON lines to data/logs/ and, for errors only,
// posts a deduped alert embed to the audit log channel via the Discord
// poster above. Not a replacement for every console.error in this file -
// prioritizes DB errors, Discord API failures, and the top-level request
// handler catch, since those are the ones that indicate a real operational
// problem rather than an expected/handled edge case.
// Wrapped in a closure (rather than passing AUDIT_LOGS_CHANNEL_ID directly)
// so a Command-panel channel-config change is picked up immediately - that
// `let` gets reassigned at runtime, and a plain value captured here would
// go stale after the first change.
const logger = require('./lib/logger.js').createLogger((embed) => postDiscordMessage(AUDIT_LOGS_CHANNEL_ID, embed));

// Uploads citizen/officer-submitted evidence (photos, PDFs, etc, sent from
// the browser as base64 data URLs) to Discord and returns a link to the
// message they land in - same "Discord as file host" pattern already used
// for bodycam video (see lib/videoLog.js), just for one-off evidence
// instead of a whole shift recording. Caps per-file and total file count
// well under Discord's real upload ceiling for this bot (~21MB - see
// lib/videoLog.js) since evidence is expected to be a couple of photos, not
// bulk data.
async function uploadEvidenceToDiscord(evidenceItems, embedTitle, embedFields) {
  if (!Array.isArray(evidenceItems) || evidenceItems.length === 0 || !DISCORD_BOT_TOKEN) return null;
  const MAX_FILES = 5;
  const MAX_FILE_BYTES = 4 * 1024 * 1024;
  const localPaths = [];
  try {
    const files = [];
    for (const item of evidenceItems.slice(0, MAX_FILES)) {
      if (!item || typeof item.dataUrl !== 'string') continue;
      const match = item.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) continue;
      const buffer = Buffer.from(match[2], 'base64');
      if (buffer.length === 0 || buffer.length > MAX_FILE_BYTES) continue;
      const ext = (String(item.name || '').match(/\.([a-zA-Z0-9]+)$/) || [, 'bin'])[1];
      const localPath = video.tempPath(ext);
      fs.writeFileSync(localPath, buffer);
      localPaths.push(localPath);
      files.push({ path: localPath, name: String(item.name || `evidence.${ext}`).slice(0, 100) });
    }
    if (files.length === 0) return null;

    const embed = { title: embedTitle, color: 0x546675, fields: embedFields || [] };
    const msg = await videoLog.postMessage(DISCORD_BOT_TOKEN, AUDIT_LOGS_CHANNEL_ID, { embeds: [embed] }, files);
    return `https://discord.com/channels/${GUILD_ID}/${AUDIT_LOGS_CHANNEL_ID}/${msg.id}`;
  } catch (e) {
    logger.error('[EVIDENCE UPLOAD ERROR] ' + e.message);
    return null;
  } finally {
    localPaths.forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });
  }
}

// Sends a Discord DM to a citizen when their IA case resolves. Opens (or
// reuses) a DM channel via the bot token, same as any other Discord bot -
// a citizen can only receive this if their DMs are open to server members,
// which is out of this app's control; a failure here is logged but never
// blocks the actual case update from saving.
async function dmDiscordUser(userId, content, embeds = null) {
  if (!DISCORD_BOT_TOKEN || !userId) return false;
  try {
    const rest = new DiscordREST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);
    const dmChannel = await rest.post(DiscordRoutes.userChannels(), { body: { recipient_id: userId } });
    const body = { content };
    if (embeds) body.embeds = embeds;
    await rest.post(DiscordRoutes.channelMessages(dmChannel.id), { body });
    return true;
  } catch (e) {
    console.error('[DISCORD DM ERROR]', userId, e.message);
    return false;
  }
}

// Web Push setup - only configured if both VAPID env vars are set (they
// have no hardcoded fallback, unlike the Discord IDs elsewhere in this
// file, since they're secret and per-deployment). Generate a keypair once
// via `require('web-push').generateVAPIDKeys()` and set the two env vars;
// never reuse the same keypair across dev and production.
const VAPID_CONFIGURED = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (VAPID_CONFIGURED) {
  webpush.setVapidDetails('mailto:admin@westpointsecurity.xyz', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}

// Sends a web push notification to every subscription a user has
// registered (they may have more than one - multiple browsers/devices).
// Prunes subscriptions the push service reports as gone (410/404) rather
// than retrying them forever.
async function pushToUser(userId, payload) {
  if (!VAPID_CONFIGURED) return;
  const db = getBotDb();
  if (!db) return;
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload)
      );
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(sub.endpoint);
      } else {
        console.error('[PUSH ERROR]', userId, e.message);
      }
    }
  }
}

// Quota-compliance push reminder. There is no shift-scheduling system in
// this app (nothing assigns officers to a future shift time), so "shift
// reminders" is interpreted as nudging officers under their weekly quota
// target as the week runs out, on the same week-key convention used by the
// leaderboard/CSV export above.
async function sendQuotaReminders() {
  if (!VAPID_CONFIGURED) return;
  const db = getBotDb();
  if (!db) return;
  try {
    const weekKey = getWeekKey();
    const atRisk = db.prepare(`
      SELECT sh.user_id AS userId,
             COALESCE(wt.total_seconds, 0) AS totalSeconds,
             COALESCE(s.quota_target_seconds, 900) AS quotaTargetSeconds
      FROM (SELECT DISTINCT user_id FROM shift_history WHERE week_key = ?) sh
      LEFT JOIN weekly_totals wt ON wt.user_id = sh.user_id AND wt.week_key = ?
      LEFT JOIN staff_members s ON s.user_id = sh.user_id
    `).all(weekKey, weekKey).filter(r => r.totalSeconds < r.quotaTargetSeconds);

    for (const row of atRisk) {
      const remaining = formatDuration(Math.max(0, row.quotaTargetSeconds - row.totalSeconds));
      await pushToUser(row.userId, {
        title: 'Quota Reminder',
        body: `You're ${remaining} short of this week's quota. Log a shift before the week resets.`,
        url: '/employee/dashboard'
      });
    }
  } catch (e) {
    console.error('[QUOTA REMINDER ERROR]', e.message);
  }
}
// Runs once a day; only actually pushes to officers who are both under quota
// and have an active push subscription (most days this is a fast no-op).
setInterval(sendQuotaReminders, 24 * 60 * 60 * 1000);

// Bodycam Audit Randomizer: picks a small random sample of 'ready'
// recordings that haven't already been through this and flags them for
// mandatory supervisor review - a lightweight compliance spot-check rather
// than requiring every clip to be watched. Reuses the existing
// review_status column/queue rather than a separate system.
function runBodycamAuditRandomizer(count = AUDIT_RANDOMIZER_COUNT) {
  const db = getBotDb();
  if (!db) return [];
  const candidates = db.prepare(`
    SELECT id FROM bodycam_sessions
    WHERE status = 'ready' AND audit_selected_at IS NULL
  `).all();
  if (candidates.length === 0) return [];
  // Fisher-Yates shuffle, take the first N - avoids bias toward
  // whatever SQLite's default row order happens to be.
  const pool = candidates.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const chosen = pool.slice(0, count);
  const now = Date.now();
  const update = db.prepare("UPDATE bodycam_sessions SET audit_selected_at = ?, review_status = 'flagged' WHERE id = ?");
  chosen.forEach(c => update.run(now, c.id));
  return chosen.map(c => c.id);
}
// Runs weekly (Saturday, matching the bot's existing weekly-audit schedule
// pattern) so mandatory audits happen on a predictable cadence rather than
// only when someone remembers to click the manual button.
setInterval(() => {
  if (new Date().getUTCDay() === 6) runBodycamAuditRandomizer();
}, 24 * 60 * 60 * 1000);

// Automated bot.db backups to R2. VACUUM INTO gives a consistent snapshot
// of the live database without locking it for writers. Keeps the most
// recent 14 backups (roughly two weeks at a daily cadence) and prunes the
// rest so the bucket doesn't grow without bound.
const BODYCAM_BACKUP_RETAIN_COUNT = 14;
async function backupDatabaseToR2() {
  const db = getBotDb();
  if (!db || !r2.isConfigured()) return;
  const snapshotPath = video.tempPath('db');
  try {
    db.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);
    const buffer = fs.readFileSync(snapshotPath);
    const key = `backups/bot-db-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
    await r2.putObject(key, buffer, 'application/octet-stream');

    const existing = await r2.listObjectsWithSize('backups/bot-db-');
    if (existing.length > BODYCAM_BACKUP_RETAIN_COUNT) {
      const toDelete = existing.sort((a, b) => a.key < b.key ? -1 : 1).slice(0, existing.length - BODYCAM_BACKUP_RETAIN_COUNT);
      await r2.deleteObjects(toDelete.map(o => o.key));
    }
    logger.info('[DB BACKUP] Snapshot uploaded: ' + key);
  } catch (e) {
    logger.error('[DATABASE BACKUP ERROR] ' + e.message);
  } finally {
    try { fs.unlinkSync(snapshotPath); } catch (e) {}
  }
}
setInterval(backupDatabaseToR2, 24 * 60 * 60 * 1000);

// Fetch Guild Member via Bot Token
function fetchGuildMember(discordUserId) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'discord.com',
      path: `/api/v10/guilds/${GUILD_ID}/members/${discordUserId}`,
      method: 'GET',
      headers: {
        'Authorization': `Bot ${DISCORD_BOT_TOKEN}`,
        'User-Agent': 'WestpointPortal/1.0'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            resolve({ success: true, member: JSON.parse(data) });
          } else {
            resolve({ success: false, status: res.statusCode, error: data });
          }
        } catch(e) {
          resolve({ success: false, error: e.message });
        }
      });
    });

    req.on('error', (err) => resolve({ success: false, error: err.message }));
    req.end();
  });
}

// Fetch every role in the guild via Bot Token, for the Command Center's
// Role Permissions panel to list and edit.
function fetchGuildRoles() {
  return new Promise((resolve) => {
    const options = {
      hostname: 'discord.com',
      path: `/api/v10/guilds/${GUILD_ID}/roles`,
      method: 'GET',
      headers: {
        'Authorization': `Bot ${DISCORD_BOT_TOKEN}`,
        'User-Agent': 'WestpointPortal/1.0'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            resolve({ success: true, roles: JSON.parse(data) });
          } else {
            resolve({ success: false, status: res.statusCode, error: data });
          }
        } catch (e) {
          resolve({ success: false, error: e.message });
        }
      });
    });

    req.on('error', (err) => resolve({ success: false, error: err.message }));
    req.end();
  });
}

const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // matches the wp_session cookie's Max-Age
const ROLE_RECHECK_INTERVAL_MS = 10 * 60 * 1000;

// Bumped whenever Command saves a role permissions change (see
// POST /api/admin/roles below). Comparing a session's lastRoleCheck against
// this is what makes a permission edit apply "as soon as they refresh"
// instead of waiting out the normal 10-minute interval - resets on every
// process restart too, which just means everyone gets one extra re-check
// right after a deploy, which is harmless.
let roleConfigUpdatedAt = Date.now();

// Called on every request that carries a session. Three jobs: expire
// sessions past their 24h TTL (previously only checked once, at process
// start, so a stolen cookie stayed valid indefinitely for as long as the
// server kept running), periodically re-fetch guild roles so a demoted or
// removed officer loses elevated access within minutes instead of up to
// 24h, and re-check immediately (regardless of the interval) if Command has
// edited role permissions since this session was last checked. Runs for
// every session, not just current officers, so a citizen whose role just
// got granted staff access picks that up too, not just the reverse.
async function revalidateSession(sessionId, session) {
  const loginTimeMs = session.loginTime ? new Date(session.loginTime).getTime() : 0;
  if (!loginTimeMs || (Date.now() - loginTimeMs) > SESSION_MAX_AGE_MS) {
    SESSIONS.delete(sessionId);
    persistSessions();
    return null;
  }

  const lastCheckMs = session.lastRoleCheck ? new Date(session.lastRoleCheck).getTime() : 0;
  const configChangedSinceLastCheck = lastCheckMs < roleConfigUpdatedAt;
  if (configChangedSinceLastCheck || (Date.now() - lastCheckMs) > ROLE_RECHECK_INTERVAL_MS) {
    try {
      const memRes = await fetchGuildMember(session.id);
      if (memRes.success && memRes.member) {
        const { permissions, roles, highestRank, quotaTargetSeconds } = computePermissionsFromDiscordRoles(memRes.member.roles || []);
        session.roles = roles;
        session.highestRank = highestRank;
        session.permissions = permissions;
        session.quotaTargetSeconds = quotaTargetSeconds;
      }
      // On lookup failure (rate limit, network blip) keep the cached
      // permissions rather than punishing the user for a Discord hiccup.
    } catch (e) {}
    session.lastRoleCheck = new Date().toISOString();
    SESSIONS.set(sessionId, session);
    persistSessions();
  }

  return session;
}

// -------------------------------------------------------------
// BODYCAM STORAGE CAP: R2 now only holds chunks for a shift that's still
// recording (used for the near-live viewer) - the finished recording lives
// on Discord instead (see videoLog.js), so R2 is bounded by how much
// footage is being actively recorded right now, not by total archive size.
// The 10GB-month free tier cap is kept as a cheap in-memory running total
// (incremented/decremented as chunks are written/deleted) rather than a
// live bucket listing on every request - a full ListObjectsV2 walk is
// itself a billed Class A operation, so doing that per-chunk-upload would
// work against the exact goal here. Corrected periodically against the
// real bucket total in case anything drifts (a crashed finalize job,
// manual bucket edits, etc.).
// -------------------------------------------------------------
const BODYCAM_STORAGE_LIMIT_BYTES = 9.9 * 1024 * 1024 * 1024; // 9.9 GiB, just under the 10GB-month free tier
const BODYCAM_SEGMENT_MS = 20000; // must match BODYCAM_SEGMENT_MS in employee-dashboard.html
let bodycamStorageBytes = 0;
let bodycamStorageReady = false;

async function refreshBodycamStorageTotal() {
  if (!r2.isConfigured()) return;
  try {
    bodycamStorageBytes = await r2.getBucketTotalBytes();
    bodycamStorageReady = true;
  } catch (e) {
    console.error('[BODYCAM STORAGE REFRESH ERROR]', e.message);
  }
}
refreshBodycamStorageTotal();
setInterval(refreshBodycamStorageTotal, 30 * 60 * 1000); // drift-correction safety net

function isBodycamStorageFull() {
  return bodycamStorageReady && bodycamStorageBytes >= BODYCAM_STORAGE_LIMIT_BYTES;
}

// Given an officer's user id, returns (creating if needed) the Discord
// channel id for their video-log channel. Reuses a previously-created
// channel from officer_video_channels; if that channel was since deleted
// out from under us, createOfficerChannel makes a fresh one and this
// overwrites the stale row.
async function getOrCreateOfficerChannel(db, userId, displayName) {
  const existing = db.prepare('SELECT channel_id FROM officer_video_channels WHERE user_id = ?').get(userId);
  if (existing) {
    try {
      await videoLog.fetchChannel(DISCORD_BOT_TOKEN, existing.channel_id);
      return existing.channel_id;
    } catch (e) {
      // channel is gone or inaccessible - fall through and recreate it
    }
  }
  const channel = await videoLog.createOfficerChannel(DISCORD_BOT_TOKEN, VIDEO_LOG_GUILD_ID, VIDEO_LOG_PARENT_ID, displayName);
  db.prepare(`
    INSERT INTO officer_video_channels (user_id, channel_id, created_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET channel_id = excluded.channel_id, created_at = excluded.created_at
  `).run(userId, channel.id, Date.now());
  return channel.id;
}

// Sequential per-officer, per-week number shown in the log embeds/splitters
// ("SHIFT LOG #N") - counts this officer's already-finalized sessions this
// week and adds one.
function nextShiftNumber(db, userId, weekKey) {
  const row = db.prepare("SELECT COUNT(*) AS c FROM bodycam_sessions WHERE user_id = ? AND week_key = ? AND status = 'ready'").get(userId, weekKey);
  return (row?.c || 0) + 1;
}

// Converts the merged webm to mp4 (so it plays inline in Discord's own
// clients instead of just as a downloadable file), splits it if needed, and
// posts the "SHIFT LOG #N" splitter / video(s) with embed+Trim button /
// closer sequence to the officer's Discord channel. Returns { channelId,
// messageIds }; leaves mergedPath itself alone but cleans up the mp4
// conversion and any split parts.
async function postShiftVideoToDiscord(db, bcSession, mergedPath, durationSeconds, shiftNumber) {
  const mp4Path = await video.convertToMp4(mergedPath, durationSeconds, Math.floor(bcSession.started_at / 1000));
  const partPaths = await video.splitBySize(mp4Path, videoLog.DISCORD_FILE_LIMIT_BYTES, durationSeconds);
  const staffRow = db.prepare('SELECT roblox_username FROM staff_members WHERE user_id = ?').get(bcSession.user_id);
  const displayName = staffRow?.roblox_username || bcSession.user_id;
  const channelId = await getOrCreateOfficerChannel(db, bcSession.user_id, displayName);
  const messageIds = [];

  try {
    const opener = await videoLog.postMessage(DISCORD_BOT_TOKEN, channelId, {
      content: `**═══════ SHIFT LOG #${shiftNumber} ═══════**\n<@${bcSession.user_id}> (${displayName}) • Duration: ${formatDuration(durationSeconds)} • ${new Date(bcSession.started_at).toLocaleString()}`
    });
    messageIds.push({ id: opener.id, type: 'splitter' });

    for (let i = 0; i < partPaths.length; i++) {
      const partLabel = partPaths.length > 1 ? ` (Part ${i + 1}/${partPaths.length})` : '';
      const embed = {
        title: `Shift Log #${shiftNumber}${partLabel}`,
        color: 0x9E2A2B,
        fields: [
          { name: 'Officer', value: `<@${bcSession.user_id}> (${displayName})`, inline: true },
          { name: 'Duration', value: formatDuration(durationSeconds), inline: true },
          { name: 'Recorded', value: new Date(bcSession.started_at).toLocaleString(), inline: false }
        ]
      };
      const button = {
        type: 1,
        components: [{ type: 2, style: 2, label: 'Trim Clip', custom_id: `bodycam_trim_open:${bcSession.id}:${i}` }]
      };
      const msg = await videoLog.postMessage(
        DISCORD_BOT_TOKEN,
        channelId,
        { embeds: [embed], components: [button] },
        [{ path: partPaths[i], name: `shift-${shiftNumber}${partPaths.length > 1 ? `-part${i + 1}` : ''}.mp4` }]
      );
      messageIds.push({ id: msg.id, type: 'video', part: i + 1, total: partPaths.length });
    }

    const closer = await videoLog.postMessage(DISCORD_BOT_TOKEN, channelId, {
      content: `**═══════ END SHIFT LOG #${shiftNumber} ═══════**`
    });
    messageIds.push({ id: closer.id, type: 'splitter' });
  } finally {
    partPaths.forEach(p => { if (p !== mp4Path) { try { fs.unlinkSync(p); } catch (e) {} } });
    try { fs.unlinkSync(mp4Path); } catch (e) {}
  }

  return { channelId, messageIds };
}

// Downloads every uploaded chunk for a finished bodycam session, stream-copy
// concatenates them into one webm (no re-encoding - see lib/video.js for why
// that matters), then posts it to the officer's Discord video-log channel
// (splitting into multiple parts first if it's too big for one upload) and
// drops the now-redundant R2 chunk objects. Runs after the response to
// /api/bodycam/stop has already gone out, though the whole point of the
// stream-copy approach is that this no longer takes long enough for that to
// matter much.
async function finalizeBodycamSession(bodycamId) {
  const db = getBotDb();
  const bcSession = db.prepare('SELECT * FROM bodycam_sessions WHERE id = ?').get(bodycamId);
  const chunks = await r2.listObjectsWithSize(`bodycam/${bodycamId}/chunk-`);
  if (chunks.length === 0) {
    db.prepare("UPDATE bodycam_sessions SET status = 'ready', duration_seconds = 0 WHERE id = ?").run(bodycamId);
    return;
  }

  let localChunkPaths = [];
  let mergedPath = null;
  try {
    // Downloaded in parallel - chunks.map preserves order in the results
    // regardless of which finishes first, which concatenation depends on.
    localChunkPaths = await Promise.all(chunks.map(async chunk => {
      const { stream } = await r2.getObjectStream(chunk.key);
      const localPath = video.tempPath('webm');
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(localPath);
        stream.pipe(out);
        stream.on('error', reject);
        out.on('finish', resolve);
        out.on('error', reject);
      });
      return localPath;
    }));

    const merged = await video.mergeChunksToWebm(localChunkPaths);
    mergedPath = merged.path;
    // Estimated from segment count, not probed from the file - see
    // lib/video.js for why (no bundled ffprobe binary). The last segment of
    // a shift is sometimes shorter than a full 20s (duty ended mid-clip),
    // so this can run slightly long, which is fine for display/trim-range
    // purposes.
    const durationSeconds = chunks.length * (BODYCAM_SEGMENT_MS / 1000);

    const shiftNumber = nextShiftNumber(db, bcSession.user_id, bcSession.week_key);
    const { channelId, messageIds } = await postShiftVideoToDiscord(db, bcSession, mergedPath, durationSeconds, shiftNumber);

    await r2.deleteObjects(chunks.map(c => c.key));
    const chunkBytesFreed = chunks.reduce((sum, c) => sum + c.size, 0);
    bodycamStorageBytes -= chunkBytesFreed;

    db.prepare(`
      UPDATE bodycam_sessions
      SET status = 'ready', duration_seconds = ?, discord_channel_id = ?, discord_message_ids = ?, shift_number = ?
      WHERE id = ?
    `).run(durationSeconds || 0, channelId, JSON.stringify(messageIds), shiftNumber, bodycamId);
  } finally {
    localChunkPaths.forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });
    if (mergedPath) { try { fs.unlinkSync(mergedPath); } catch (e) {} }
  }
}

// Bodycam recordings expire when the weekly quota resets, same as the user
// asked for. The video itself now lives on Discord (not R2), so "expiry"
// here just flips old sessions' status for shift-history labeling on the
// website; the actual cleanup is clearing every officer's video-log channel,
// once, the first tick after the week actually rolls over - guarded by
// video_channel_clears so this doesn't wipe channels again on every hourly
// tick within the same week.
setInterval(async () => {
  try {
    const db = getBotDb();
    if (!db) return;
    const currentWeek = getWeekKey();

    db.prepare("UPDATE bodycam_sessions SET status = 'expired' WHERE status = 'ready' AND week_key != ?").run(currentWeek);

    const alreadyCleared = db.prepare('SELECT 1 FROM video_channel_clears WHERE week_key = ?').get(currentWeek);
    if (!alreadyCleared && DISCORD_BOT_TOKEN) {
      // Only clear if we've actually seen a prior week's data - otherwise a
      // fresh deploy mid-week would wipe channels that were never meant to
      // be cleared yet.
      const rolledOver = db.prepare("SELECT 1 FROM bodycam_sessions WHERE week_key != ? LIMIT 1").get(currentWeek);
      if (rolledOver) {
        const channels = db.prepare('SELECT channel_id FROM officer_video_channels').all();
        for (const { channel_id } of channels) {
          try {
            await videoLog.clearChannel(DISCORD_BOT_TOKEN, channel_id);
          } catch (e) {
            console.error('[VIDEO CHANNEL CLEAR ERROR]', channel_id, e.message);
          }
        }
      }
      db.prepare('INSERT OR REPLACE INTO video_channel_clears (week_key, cleared_at) VALUES (?, ?)').run(currentWeek, Date.now());
    }
  } catch (e) {}
}, 60 * 60 * 1000);

const server = http.createServer(async (req, res) => {
  try {
    // Extract client IP address (supporting reverse proxies like Railway/Cloudflare).
    // The LAST hop is the one appended by our own trusted proxy on the direct
    // connection it received — the client can freely forge everything earlier
    // in the chain, so trusting the first hop (as before) let anyone bypass
    // rate limiting just by sending their own X-Forwarded-For header.
    const forwarded = req.headers['x-forwarded-for'];
    const clientIp = forwarded
      ? forwarded.split(',').map(s => s.trim()).filter(Boolean).pop()
      : (req.socket.remoteAddress || '127.0.0.1');

    const parsedUrl = url.parse(req.url, true);
    let pathname = parsedUrl.pathname;

    // Rate Limiting Protection:
    // General routes: 120 req/min
    // Form/Auth sensitive routes: 10 req/min
    // Tracked as separate buckets per IP - sharing one counter meant ordinary
    // page loads (HTML + CSS + assets + background fetches) burned through
    // the tight sensitive-route ceiling before a sensitive route was ever hit.
    const isSensitive = ['/api/contact/staff', '/api/report', '/api/duty/start', '/auth/discord/callback'].includes(pathname);
    const rateLimitKey = `${clientIp}:${isSensitive ? 'sensitive' : 'general'}`;
    const limitRule = checkRateLimit(rateLimitKey, isSensitive ? 10 : 120, 60000);
    if (!limitRule.allowed) {
      res.writeHead(429, {
        'Content-Type': 'application/json; charset=utf-8',
        'Retry-After': String(limitRule.retryAfter),
        ...SECURITY_HEADERS
      });
      return res.end(JSON.stringify({
        error: 'Too Many Requests: Rate limit exceeded. Please wait before retrying.',
        retryAfterSeconds: limitRule.retryAfter
      }));
    }

    const cookies = parseCookies(req);
    const sessionId = cookies.wp_session;
    let currentSession = sessionId ? SESSIONS.get(sessionId) : null;
    if (!currentSession && sessionId) {
      try {
        if (fs.existsSync(SESSIONS_FILE)) {
          const fileSessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
          if (fileSessions[sessionId]) {
            currentSession = fileSessions[sessionId];
            SESSIONS.set(sessionId, currentSession);
          }
        }
      } catch(e) {}
    }
    if (currentSession) {
      currentSession = await revalidateSession(sessionId, currentSession);
    }

  // API: GET /api/health (Public - wired to Railway's Healthcheck Path).
  // Deliberately cheap and unauthenticated: no Discord API calls, just
  // local process/DB state, so it can't itself become a source of failed
  // deploys under Discord rate limits.
  if (pathname === '/api/health' && req.method === 'GET') {
    const db = getBotDb();
    let dbOk = false;
    if (db) {
      try {
        db.prepare('SELECT 1').get();
        dbOk = true;
      } catch (e) {}
    }
    return sendJSON(res, 200, {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      database: dbOk,
      r2Configured: r2.isConfigured(),
      discordTokenConfigured: !!DISCORD_BOT_TOKEN,
      timestamp: new Date().toISOString()
    });
  }

  // 1. DISCORD OAUTH2 REDIRECT
  if (pathname === '/auth/discord') {
    // Carried through Discord's own state param so the callback knows which
    // page to send the browser back to - contact.html and employee.html both
    // link here, and a citizen signing in from Contact shouldn't get bounced
    // to the employee login page just because they don't hold a staff role.
    const next = ['employee', 'contact'].includes(parsedUrl.query.next) ? parsedUrl.query.next : 'contact';
    const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(getRedirectUri(req))}&response_type=code&scope=identify&state=${encodeURIComponent(next)}`;
    res.writeHead(302, { 'Location': discordAuthUrl });
    return res.end();
  }

  // 2. DISCORD OAUTH2 CALLBACK
  if (pathname === '/auth/discord/callback') {
    const code = parsedUrl.query.code;
    const next = ['employee', 'contact'].includes(parsedUrl.query.state) ? parsedUrl.query.state : 'contact';
    if (!code) {
      res.writeHead(302, { 'Location': '/employee?error=no_code' });
      return res.end();
    }

    const tokenBody = querystring.stringify({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: getRedirectUri(req)
    });

    const tokenReq = https.request({
      hostname: 'discord.com',
      path: '/api/v10/oauth2/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(tokenBody)
      }
    }, (tokenRes) => {
      let tData = '';
      tokenRes.on('data', chunk => tData += chunk);
      tokenRes.on('end', async () => {
        try {
          const tokenJson = JSON.parse(tData);
          if (tokenJson.access_token) {
            const userReq = https.request({
              hostname: 'discord.com',
              path: '/api/v10/users/@me',
              method: 'GET',
              headers: { 'Authorization': `Bearer ${tokenJson.access_token}` }
            }, (uRes) => {
              let uData = '';
              uRes.on('data', c => uData += c);
              uRes.on('end', async () => {
                try {
                  const userObj = JSON.parse(uData);
                  const memRes = await fetchGuildMember(userObj.id);
                  const member = (memRes.success && memRes.member) ? memRes.member : null;

                  // Any verified Discord identity gets a real session, whether
                  // or not they hold a staff role in the guild — holding no
                  // enabled role just means computePermissionsFromDiscordRoles
                  // gives them the "Verified Citizen" tier (isOfficer: false)
                  // instead of a staff tier. This is what lets the public
                  // contact/report desk actually work: it used to require an
                  // officer role to get a session at all, so a real citizen
                  // could never successfully submit a misconduct report or
                  // commendation.
                  const { permissions: perms, roles: matchingRanks, highestRank, quotaTargetSeconds } =
                    computePermissionsFromDiscordRoles(member ? (member.roles || []) : []);
                  const candidateNames = [(member && member.nick), userObj.global_name, userObj.username].filter(Boolean);
                  let robloxInfo = null;
                  try {
                    robloxInfo = await robloxService.resolveRobloxUser(candidateNames);
                  } catch (e) {}

                  // Cryptographically strong 256-bit entropy session token
                  const newSessionId = 'WP-' + crypto.randomBytes(32).toString('hex');
                  SESSIONS.set(newSessionId, {
                    id: userObj.id,
                    username: userObj.username,
                    displayName: (member && member.nick) || userObj.global_name || userObj.username,
                    robloxUsername: robloxInfo ? robloxInfo.name : null,
                    robloxId: robloxInfo ? robloxInfo.id : null,
                    avatar: userObj.avatar ? `https://cdn.discordapp.com/avatars/${userObj.id}/${userObj.avatar}.png` : '/assets/logo.png',
                    roles: matchingRanks,
                    highestRank: highestRank,
                    permissions: perms,
                    quotaTargetSeconds: quotaTargetSeconds,
                    loginTime: new Date().toISOString(),
                    lastRoleCheck: new Date().toISOString()
                  });
                  persistSessions();

                  const isHttps = (req.headers['x-forwarded-proto'] === 'https') || req.connection.encrypted;
                  // Only someone who came from the Employee Access page sees
                  // the "you don't have the required role" message - a
                  // citizen signing in from the Contact page just lands back
                  // there, signed in, regardless of whether they hold staff
                  // roles (their session works for the citizen forms either way).
                  let redirectTo;
                  if (next === 'employee') {
                    redirectTo = perms.isOfficer ? '/employee/dashboard' : '/employee?error=unauthorized_role';
                  } else {
                    redirectTo = '/contact';
                  }
                  res.writeHead(302, {
                    'Set-Cookie': `wp_session=${newSessionId}; Path=/; Max-Age=86400; SameSite=Lax; HttpOnly${isHttps ? '; Secure' : ''}`,
                    'Location': redirectTo,
                    ...SECURITY_HEADERS
                  });
                  return res.end();
                } catch(e) {
                  res.writeHead(302, { 'Location': '/employee?error=profile_error', ...SECURITY_HEADERS });
                  return res.end();
                }
              });
            });
            userReq.end();
            return;
          } else {
            console.error('[OAuth2 Error]', tData);
            res.writeHead(302, { 'Location': '/employee?error=token_exchange_failed', ...SECURITY_HEADERS });
            return res.end();
          }
        } catch(e) {
          res.writeHead(302, { 'Location': '/employee?error=server_error', ...SECURITY_HEADERS });
          return res.end();
        }
      });
    });

    tokenReq.write(tokenBody);
    tokenReq.end();
    return;
  }

  // 3. API: GET /api/auth/me
  if (pathname === '/api/auth/me') {
    if (!currentSession) return sendJSON(res, 401, { authenticated: false });
    return sendJSON(res, 200, { authenticated: true, ...currentSession });
  }

  // 4. API: GET /api/auth/logout
  if (pathname === '/api/auth/logout') {
    if (sessionId) {
      SESSIONS.delete(sessionId);
      persistSessions();
    }
    res.writeHead(302, {
      'Set-Cookie': 'wp_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      'Location': '/employee'
    });
    return res.end();
  }

  // API: GET /api/staff-directory (Officer+ - every staff member ever
  // tracked, not just this week's activity like /api/duty-roster's
  // leaderboard. Rank/quota are a snapshot from each member's last duty
  // start, not live - same staleness as roblox_username already has here,
  // refreshed whenever they next start a shift.)
  if (pathname === '/api/staff-directory' && req.method === 'GET') {
    if (!currentSession || !currentSession.permissions.isOfficer) return sendJSON(res, 401, { error: 'Unauthorized' });
    const db = getBotDb();
    if (!db) return sendJSON(res, 500, { error: 'Database unavailable' });
    const rows = db.prepare('SELECT * FROM staff_members ORDER BY roblox_username COLLATE NOCASE ASC').all();
    const allFlags = db.prepare('SELECT * FROM staff_flags').all();
    const flagsByUser = {};
    allFlags.forEach(f => {
      if (!flagsByUser[f.user_id]) flagsByUser[f.user_id] = [];
      flagsByUser[f.user_id].push(f.flag_name);
    });
    return sendJSON(res, 200, {
      staff: rows.map(r => ({
        userId: r.user_id,
        robloxUsername: r.roblox_username || 'Unknown',
        rank: r.last_known_rank || 'Unranked',
        lastActive: r.updated_at,
        flags: flagsByUser[r.user_id] || []
      }))
    });
  }

  // API: POST /api/admin/staff-flags (Command Only - add or remove a
  // predefined flag on any staff member, shown on the Staff Directory)
  if (pathname === '/api/admin/staff-flags' && req.method === 'POST') {
    if (!currentSession || !currentSession.permissions.isCommand) {
      return sendJSON(res, 403, { error: 'Access Denied: High Command rank required.' });
    }
    const body = await parseBody(req);
    if (!STAFF_FLAGS.includes(body.flagName)) return sendJSON(res, 400, { error: 'Unknown flag name.' });
    if (!body.userId) return sendJSON(res, 400, { error: 'Missing userId.' });
    if (body.action === 'remove') {
      clearStaffFlag(body.userId, body.flagName);
    } else {
      setStaffFlag(body.userId, body.flagName, currentSession.displayName);
    }
    return sendJSON(res, 200, { success: true });
  }

  // API: GET /api/staff-flags/options (Officer+ - the fixed flag vocabulary,
  // for populating the manage-flags UI)
  if (pathname === '/api/staff-flags/options' && req.method === 'GET') {
    if (!currentSession || !currentSession.permissions.isOfficer) return sendJSON(res, 401, { error: 'Unauthorized' });
    return sendJSON(res, 200, { flags: STAFF_FLAGS });
  }

  // API: GET /api/push/vapid-public-key (Officer+)
  if (pathname === '/api/push/vapid-public-key' && req.method === 'GET') {
    if (!currentSession || !currentSession.permissions.isOfficer) return sendJSON(res, 401, { error: 'Unauthorized' });
    if (!VAPID_CONFIGURED) return sendJSON(res, 503, { error: 'Push notifications are not configured on this server.' });
    return sendJSON(res, 200, { publicKey: process.env.VAPID_PUBLIC_KEY });
  }

  // API: POST /api/push/subscribe (Officer+ - body is a browser
  // PushSubscription.toJSON() shape)
  if (pathname === '/api/push/subscribe' && req.method === 'POST') {
    if (!currentSession || !currentSession.permissions.isOfficer) return sendJSON(res, 401, { error: 'Unauthorized' });
    const body = await parseBody(req);
    if (!body.endpoint || !body.keys || !body.keys.p256dh || !body.keys.auth) {
      return sendJSON(res, 400, { error: 'Invalid subscription.' });
    }
    const db = getBotDb();
    if (!db) return sendJSON(res, 500, { error: 'Database unavailable' });
    db.prepare(`
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth
    `).run(currentSession.id, body.endpoint, body.keys.p256dh, body.keys.auth, Date.now());
    return sendJSON(res, 200, { success: true });
  }

  // API: POST /api/push/unsubscribe (Officer+)
  if (pathname === '/api/push/unsubscribe' && req.method === 'POST') {
    if (!currentSession || !currentSession.permissions.isOfficer) return sendJSON(res, 401, { error: 'Unauthorized' });
    const body = await parseBody(req);
    const db = getBotDb();
    if (db && body.endpoint) db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(currentSession.id, body.endpoint);
    return sendJSON(res, 200, { success: true });
  }

  // API: GET /api/fto/stages (Officer+ - the fixed checklist stage list)
  if (pathname === '/api/fto/stages' && req.method === 'GET') {
    if (!currentSession || !currentSession.permissions.isOfficer) return sendJSON(res, 401, { error: 'Unauthorized' });
    return sendJSON(res, 200, { stages: FTO_STAGES });
  }

  // API: POST /api/command/fto/assign (Command Only)
  if (pathname === '/api/command/fto/assign' && req.method === 'POST') {
    if (!currentSession || !currentSession.permissions.isCommand) {
      return sendJSON(res, 403, { error: 'Access Denied: High Command rank required.' });
    }
    const body = await parseBody(req);
    if (!body.traineeUserId || !body.trainerUserId) return sendJSON(res, 400, { error: 'Missing traineeUserId or trainerUserId.' });
    const db = getBotDb();
    if (!db) return sendJSON(res, 500, { error: 'Database unavailable' });
    const assignmentId = 'FTO-' + Math.floor(100000 + Math.random() * 900000);
    db.prepare(`
      INSERT INTO fto_assignments (id, trainee_user_id, trainer_user_id, status, started_at)
      VALUES (?, ?, ?, 'active', ?)
    `).run(assignmentId, body.traineeUserId, body.trainerUserId, Date.now());
    setStaffFlag(body.traineeUserId, 'FTO Trainee', currentSession.displayName);
    setStaffFlag(body.trainerUserId, 'FTO Trainer', currentSession.displayName);
    return sendJSON(res, 200, { success: true, assignmentId });
  }

  // API: GET /api/command/fto/assignments (Command Only - all assignments,
  // joined with staff_members for display names)
  if (pathname === '/api/command/fto/assignments' && req.method === 'GET') {
    if (!currentSession || !currentSession.permissions.isCommand) {
      return sendJSON(res, 403, { error: 'Access Denied: High Command rank required.' });
    }
    const db = getBotDb();
    if (!db) return sendJSON(res, 500, { error: 'Database unavailable' });
    const assignments = db.prepare('SELECT * FROM fto_assignments ORDER BY started_at DESC').all();
    const staffMap = {};
    db.prepare('SELECT user_id, roblox_username FROM staff_members').all().forEach(s => { staffMap[s.user_id] = s.roblox_username; });
    return sendJSON(res, 200, {
      assignments: assignments.map(a => ({
        id: a.id,
        traineeUserId: a.trainee_user_id,
        traineeName: staffMap[a.trainee_user_id] || a.trainee_user_id,
        trainerUserId: a.trainer_user_id,
        trainerName: staffMap[a.trainer_user_id] || a.trainer_user_id,
        status: a.status,
        startedAt: a.started_at,
        completedAt: a.completed_at
      }))
    });
  }

  // API: GET /api/fto/my-progress (Officer+ - the caller's own active
  // assignment as trainee; ?userId= lets a trainer/Supervisor view someone
  // else's, gated to isSupervisor for that case)
  if (pathname === '/api/fto/my-progress' && req.method === 'GET') {
    if (!currentSession || !currentSession.permissions.isOfficer) return sendJSON(res, 401, { error: 'Unauthorized' });
    const targetUserId = parsedUrl.query.userId || currentSession.id;
    if (targetUserId !== currentSession.id && !currentSession.permissions.isSupervisor) {
      return sendJSON(res, 403, { error: 'Access denied' });
    }
    const db = getBotDb();
    if (!db) return sendJSON(res, 500, { error: 'Database unavailable' });
    const assignment = db.prepare("SELECT * FROM fto_assignments WHERE trainee_user_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1").get(targetUserId);
    if (!assignment) return sendJSON(res, 200, { assignment: null });
    const signoffs = db.prepare('SELECT * FROM fto_signoffs WHERE assignment_id = ?').all(assignment.id);
    const signoffByStage = {};
    signoffs.forEach(s => { signoffByStage[s.stage_name] = s; });
    return sendJSON(res, 200, {
      assignment: {
        id: assignment.id,
        trainerUserId: assignment.trainer_user_id,
        startedAt: assignment.started_at,
        stages: FTO_STAGES.map(stage => ({
          stage,
          signedOff: !!signoffByStage[stage],
          signedOffBy: signoffByStage[stage]?.signed_off_by || null,
          signedOffAt: signoffByStage[stage]?.signed_off_at || null
        }))
      }
    });
  }

  // API: POST /api/fto/signoff (the assignment's trainer, or isSupervisor)
  if (pathname === '/api/fto/signoff' && req.method === 'POST') {
    if (!currentSession || !currentSession.permissions.isOfficer) return sendJSON(res, 401, { error: 'Unauthorized' });
    const body = await parseBody(req);
    if (!FTO_STAGES.includes(body.stageName)) return sendJSON(res, 400, { error: 'Unknown stage name.' });
    const db = getBotDb();
    if (!db) return sendJSON(res, 500, { error: 'Database unavailable' });
    const assignment = db.prepare('SELECT * FROM fto_assignments WHERE id = ?').get(body.assignmentId);
    if (!assignment) return sendJSON(res, 404, { error: 'Assignment not found' });
    if (assignment.trainer_user_id !== currentSession.id && !currentSession.permissions.isSupervisor) {
      return sendJSON(res, 403, { error: 'Only the assigned trainer or a Supervisor can sign off this assignment.' });
    }
    db.prepare(`
      INSERT INTO fto_signoffs (id, assignment_id, stage_name, signed_off_by, signed_off_at, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('SIGN-' + Math.floor(100000 + Math.random() * 900000), body.assignmentId, body.stageName, currentSession.displayName, Date.now(), body.notes || null);

    const doneCount = db.prepare('SELECT COUNT(DISTINCT stage_name) AS c FROM fto_signoffs WHERE assignment_id = ?').get(body.assignmentId).c;
    if (doneCount >= FTO_STAGES.length) {
      db.prepare("UPDATE fto_assignments SET status = 'completed', completed_at = ? WHERE id = ?").run(Date.now(), body.assignmentId);
      clearStaffFlag(assignment.trainee_user_id, 'FTO Trainee');
    }
    return sendJSON(res, 200, { success: true, completed: doneCount >= FTO_STAGES.length });
  }

  // API: GET /api/officer/stats (Officer+ - personal career stats: lifetime
  // duty hours, incidents filed, commendations received. Commendation
  // count is best-effort: reports.json's "officer" field is free text the
  // citizen typed in ("Officer John Doe, Unit 4"), not a real foreign key
  // to a user id, so this matches by substring against the officer's
  // display name rather than an exact/guaranteed-accurate count - the
  // frontend labels it as such.)
  if (pathname === '/api/officer/stats' && req.method === 'GET') {
    if (!currentSession || !currentSession.permissions.isOfficer) return sendJSON(res, 401, { error: 'Unauthorized' });
    const db = getBotDb();
    if (!db) return sendJSON(res, 500, { error: 'Database unavailable' });
    const lifetimeRow = db.prepare('SELECT SUM(duration_seconds) AS total FROM shift_history WHERE user_id = ?').get(currentSession.id);
    const lifetimeSeconds = lifetimeRow?.total || 0;

    const incidents = readJSONFile('incidents.json', []);
    const incidentsFiled = incidents.filter(i => i.officerId === currentSession.id).length;

    const reports = readJSONFile('reports.json', []);
    const nameNeedle = String(currentSession.displayName || '').toLowerCase();
    const commendationsReceived = nameNeedle
      ? reports.filter(r => r.type === 'Commendation' && String(r.officer || '').toLowerCase().includes(nameNeedle)).length
      : 0;

    return sendJSON(res, 200, {
      lifetimeSeconds,
      lifetimeFormatted: formatDuration(lifetimeSeconds),
      incidentsFiled,
      commendationsReceived
    });
  }

  // 5. API: GET /api/duty-roster (Real-time in-game autolog sessions & weekly stats from bot.db)
  if (pathname === '/api/duty-roster') {
    if (!currentSession || !currentSession.permissions.isOfficer) return sendJSON(res, 401, { error: 'Unauthorized' });
    const db = getBotDb();
    const activeSessions = [];
    const leaderboard = [];

    if (db) {
      try {
        const rows = db.prepare('SELECT * FROM active_sessions').all();
        const now = Date.now();
        rows.forEach(r => {
          const elapsedSec = Math.floor((now - r.start_time) / 1000);
          activeSessions.push({
            userId: r.user_id,
            robloxId: r.roblox_id,
            robloxUsername: r.roblox_username,
            startTime: r.start_time,
            elapsedSeconds: elapsedSec,
            elapsedFormatted: formatDuration(elapsedSec),
            location: 'Harrison County',
            bodycamId: r.bodycam_id || null
          });
        });

        const weekKey = getWeekKey();
        // Built from shift_history, not weekly_totals directly - an officer
        // whose only shift this week was under the 12-minute credit minimum
        // has no weekly_totals row at all, which used to make them (and
        // their shift log / bodycam footage) invisible here entirely. They
        // still show up now, just with 0 credited seconds - the shift
        // happened and is reviewable, it just didn't count toward quota.
        const topWeekly = db.prepare(`
          SELECT sh.user_id,
                 COALESCE(wt.total_seconds, 0) AS total_seconds,
                 COALESCE(s.roblox_username, sh.roblox_username) AS roblox_username,
                 s.quota_target_seconds AS quota_target_seconds
          FROM (SELECT DISTINCT user_id, roblox_username FROM shift_history WHERE week_key = ?) sh
          LEFT JOIN weekly_totals wt ON wt.user_id = sh.user_id AND wt.week_key = ?
          LEFT JOIN staff_members s ON s.user_id = sh.user_id
          ORDER BY total_seconds DESC
          LIMIT 12
        `).all(weekKey, weekKey);

        topWeekly.forEach(row => {
          // Falls back to the app-wide 900s (15min) default for anyone whose
          // staff_members row predates this feature or was never set.
          const quotaTarget = Number.isFinite(row.quota_target_seconds) ? row.quota_target_seconds : 900;
          leaderboard.push({
            userId: row.user_id,
            robloxUsername: row.roblox_username || 'Officer',
            totalSeconds: row.total_seconds,
            totalFormatted: formatDuration(row.total_seconds),
            quotaTargetSeconds: quotaTarget,
            quotaTargetFormatted: formatDuration(quotaTarget),
            quotaMet: row.total_seconds >= quotaTarget,
            quotaPercent: quotaTarget > 0 ? Math.min(999, Math.round((row.total_seconds / quotaTarget) * 100)) : 100
          });
        });
      } catch (dbErr) {
        logger.error('[ROSTER DB ERROR] ' + dbErr.message);
      }
    }

    return sendJSON(res, 200, {
      activeSessions,
      weeklyQuotaLeaderboard: leaderboard,
      totalActiveOfficers: activeSessions.length,
      weekKey: getWeekKey()
    });
  }

  // API: GET /api/public/blotter (Public - redacted incident blotter).
  // Strips everything that identifies a specific officer, suspect, or
  // citizen (officer, officerId, rank, suspect, and the free-text summary,
  // which officers write themselves and could name either) - only the
  // incident type, general location, and date are public information here.
  if (pathname === '/api/public/blotter' && req.method === 'GET') {
    const allIncidents = readJSONFile('incidents.json', []);
    const redacted = allIncidents
      .slice(0, 100)
      .map(inc => ({
        id: inc.id,
        date: (inc.timestamp || '').split('T')[0],
        location: inc.location || 'Harrison County',
        action: inc.action || 'Standard Patrol Action'
      }));
    return sendJSON(res, 200, { blotter: redacted });
  }

  // API: GET /api/public/transparency (Public - aggregate-only incident
  // stats, same redaction philosophy as the blotter above: only counts by
  // month and by action category ever leave this endpoint, never an
  // officer name, location, suspect, or summary.)
  if (pathname === '/api/public/transparency' && req.method === 'GET') {
    const allIncidents = readJSONFile('incidents.json', []);
    const byMonth = {};
    const byAction = {};
    for (const inc of allIncidents) {
      const month = (inc.timestamp || '').split('T')[0].slice(0, 7);
      if (month) byMonth[month] = (byMonth[month] || 0) + 1;
      const action = inc.action || 'Standard Patrol Action';
      byAction[action] = (byAction[action] || 0) + 1;
    }
    return sendJSON(res, 200, {
      byMonth: Object.entries(byMonth).map(([month, count]) => ({ month, count })).sort((a, b) => a.month.localeCompare(b.month)),
      byAction: Object.entries(byAction).map(([action, count]) => ({ action, count })).sort((a, b) => b.count - a.count),
      totalIncidents: allIncidents.length
    });
  }

  // 6. API: GET /api/officer/incidents
  if (pathname === '/api/officer/incidents' && req.method === 'GET') {
    if (!currentSession || !currentSession.permissions.isOfficer) return sendJSON(res, 401, { error: 'Unauthorized' });
    const allIncidents = readJSONFile('incidents.json', []);
    const isSup = currentSession.permissions.isSupervisor;
    const filtered = isSup ? allIncidents : allIncidents.filter(inc => inc.officerId === currentSession.id);
    return sendJSON(res, 200, { incidents: filtered });
  }

  // 7. API: POST /api/officer/incident
  if (pathname === '/api/officer/incident' && req.method === 'POST') {
    if (!currentSession || !currentSession.permissions.isOfficer) return sendJSON(res, 401, { error: 'Unauthorized' });
    const body = await parseBody(req, 8 * 1024 * 1024); // raised from the 64KB default - evidence photos are sent as base64 in this same JSON body
    const incident = {
      id: 'INC-' + Math.floor(100000 + Math.random() * 900000),
      officer: currentSession.displayName,
      officerId: currentSession.id,
      rank: currentSession.highestRank || 'Security Officer',
      location: body.location || 'Harrison County',
      suspect: body.suspect || 'N/A',
      action: body.action || 'Standard Patrol Action',
      summary: body.summary || '',
      evidenceLink: null,
      timestamp: new Date().toISOString()
    };

    incident.evidenceLink = await uploadEvidenceToDiscord(body.evidence, `Evidence: Incident ${incident.id}`, [
      { name: 'Officer', value: incident.officer, inline: true },
      { name: 'Location', value: incident.location, inline: true }
    ]);

    const incidents = readJSONFile('incidents.json', []);
    incidents.unshift(incident);
    if (incidents.length > 500) incidents.length = 500; // Cap historical log size
    writeJSONFile('incidents.json', incidents);
    return sendJSON(res, 200, { success: true, record: incident });
  }

  // 8. API: POST /api/report (Misconduct & Commendations - Authentication Required)
  if (pathname === '/api/report' && req.method === 'POST') {
    if (!currentSession) {
      return sendJSON(res, 401, {
        error: 'Authentication Required: You must be signed in with Discord to submit a report or commendation.'
      });
    }
    const body = await parseBody(req, 8 * 1024 * 1024); // raised from the 64KB default - evidence photos are sent as base64 in this same JSON body
    const rawReport = String(body.report || '').trim();
    if (!rawReport) {
      return sendJSON(res, 400, { error: 'Please provide statement details.' });
    }

    const discordTag = currentSession.displayName ? `${currentSession.displayName} (@${currentSession.username})` : `@${currentSession.username}`;
    const robloxName = currentSession.robloxUsername || 'Unlinked / N/A';

    const report = {
      id: 'DESK-' + Math.floor(100000 + Math.random() * 900000),
      type: body.type === 'Commendation' ? 'Commendation' : 'Misconduct',
      citizen: discordTag,
      reporterId: String(currentSession.id).slice(0, 32),
      reporterDiscordUsername: currentSession.username,
      reporterRobloxUsername: currentSession.robloxUsername || null,
      reporterRobloxId: currentSession.robloxId || null,
      officer: String(body.officer || 'Unspecified').trim().slice(0, 100),
      location: String(body.location || 'Harrison County').trim().slice(0, 150),
      report: rawReport.slice(0, 4000),
      status: 'New',
      assignedIA: null,
      findings: '',
      evidenceLink: null,
      timestamp: new Date().toISOString()
    };

    report.evidenceLink = await uploadEvidenceToDiscord(body.evidence, `Evidence: Case ${report.id}`, [
      { name: 'Type', value: report.type, inline: true },
      { name: 'Reported Officer', value: report.officer, inline: true },
      { name: 'Filer Discord', value: `<@${currentSession.id}> (${currentSession.username})`, inline: true },
      { name: 'Filer Roblox', value: robloxName, inline: true }
    ]);

    const reports = readJSONFile('reports.json', []);
    reports.unshift(report);
    if (reports.length > 500) reports.length = 500;
    writeJSONFile('reports.json', reports);
    return sendJSON(res, 200, { success: true, record: report });
  }

  // API: GET /api/report/:id/status (Public - citizen status lookup by their
  // DESK-###### ID, like a package tracking number). No auth required since
  // possessing the exact random ID is itself the credential - deliberately
  // returns only status/type/date, never the report body, officer name, or
  // IA findings, which stay staff-only via /api/ia/reports.
  if (pathname.startsWith('/api/report/') && pathname.endsWith('/status') && req.method === 'GET') {
    const reportId = pathname.slice('/api/report/'.length, -'/status'.length).toUpperCase();
    const reports = readJSONFile('reports.json', []);
    const found = reports.find(r => r.id.toUpperCase() === reportId);
    if (!found) return sendJSON(res, 404, { error: 'No report found with that ID.' });
    return sendJSON(res, 200, {
      id: found.id,
      type: found.type,
      status: found.status,
      submitted: (found.timestamp || '').split('T')[0]
    });
  }

  // API: GET /api/careers/positions (Public - lists every position,
  // including closed ones, so citizens can see what exists even when
  // nothing is currently hiring - matches the original "APPLICATIONS
  // CLOSED" notice this replaces, just per-position instead of site-wide.)
  if (pathname === '/api/careers/positions' && req.method === 'GET') {
    return sendJSON(res, 200, { positions: readJSONFile('positions.json', DEFAULT_POSITIONS) });
  }

  // API: POST /api/careers/apply (any signed-in user - citizens and staff
  // alike can apply)
  if (pathname === '/api/careers/apply' && req.method === 'POST') {
    if (!currentSession) return sendJSON(res, 401, { error: 'Authentication Required: You must be signed in with Discord to apply.' });
    const body = await parseBody(req);
    const positions = readJSONFile('positions.json', DEFAULT_POSITIONS);
    const position = positions.find(p => p.id === body.positionId);
    if (!position) return sendJSON(res, 404, { error: 'Position not found.' });
    if (position.status !== 'open') return sendJSON(res, 400, { error: 'This position is not currently accepting applications.' });

    const application = {
      id: 'APP-' + Math.floor(100000 + Math.random() * 900000),
      applicantId: currentSession.id,
      applicantName: currentSession.displayName || currentSession.username,
      positionId: position.id,
      positionTitle: position.title,
      coverLetter: String(body.coverLetter || '').trim().slice(0, 3000),
      status: 'New',
      timestamp: new Date().toISOString()
    };
    const applications = readJSONFile('applications.json', []);
    applications.unshift(application);
    if (applications.length > 500) applications.length = 500;
    writeJSONFile('applications.json', applications);
    return sendJSON(res, 200, { success: true, record: application });
  }

  // API: GET /api/admin/careers/applications (Command Only)
  if (pathname === '/api/admin/careers/applications' && req.method === 'GET') {
    if (!currentSession || !currentSession.permissions.isCommand) {
      return sendJSON(res, 403, { error: 'Access Denied: High Command rank required.' });
    }
    return sendJSON(res, 200, { applications: readJSONFile('applications.json', []) });
  }

  // API: POST /api/admin/careers/applications/update (Command Only)
  if (pathname === '/api/admin/careers/applications/update' && req.method === 'POST') {
    if (!currentSession || !currentSession.permissions.isCommand) {
      return sendJSON(res, 403, { error: 'Access Denied: High Command rank required.' });
    }
    const body = await parseBody(req);
    const applications = readJSONFile('applications.json', []);
    const target = applications.find(a => a.id === body.applicationId);
    if (!target) return sendJSON(res, 404, { error: 'Application not found' });
    target.status = body.status || target.status;
    target.updatedAt = new Date().toISOString();
    writeJSONFile('applications.json', applications);
    return sendJSON(res, 200, { success: true, record: target });
  }

  // API: POST /api/admin/careers/positions (Command Only - create new or
  // update existing by id, e.g. to flip open/closed)
  if (pathname === '/api/admin/careers/positions' && req.method === 'POST') {
    if (!currentSession || !currentSession.permissions.isCommand) {
      return sendJSON(res, 403, { error: 'Access Denied: High Command rank required.' });
    }
    const body = await parseBody(req);
    const positions = readJSONFile('positions.json', DEFAULT_POSITIONS);
    if (body.id) {
      const existing = positions.find(p => p.id === body.id);
      if (!existing) return sendJSON(res, 404, { error: 'Position not found' });
      existing.title = String(body.title || existing.title).trim().slice(0, 100);
      existing.department = String(body.department || existing.department).trim().slice(0, 100);
      existing.description = String(body.description || existing.description).trim().slice(0, 2000);
      existing.status = body.status === 'open' ? 'open' : 'closed';
      writeJSONFile('positions.json', positions);
      return sendJSON(res, 200, { success: true, record: existing });
    }
    const newPosition = {
      id: 'POS-' + Math.floor(1000 + Math.random() * 9000),
      title: String(body.title || 'Untitled Position').trim().slice(0, 100),
      department: String(body.department || 'General').trim().slice(0, 100),
      description: String(body.description || '').trim().slice(0, 2000),
      status: body.status === 'open' ? 'open' : 'closed',
      createdAt: new Date().toISOString()
    };
    positions.push(newPosition);
    writeJSONFile('positions.json', positions);
    return sendJSON(res, 200, { success: true, record: newPosition });
  }

  // API: GET /api/my-reports (Public but authenticated - "My Reports"
  // dashboard for citizens. Any signed-in user, not just staff, matching
  // /api/report's own gate - reports.json already carries reporterId from
  // submission.)
  if (pathname === '/api/my-reports' && req.method === 'GET') {
    if (!currentSession) return sendJSON(res, 401, { error: 'Unauthorized' });
    const reports = readJSONFile('reports.json', [])
      .filter(r => r.reporterId === currentSession.id)
      .map(r => {
        const { assignedIA, reporterId, ...rest } = r;
        return rest;
      });
    return sendJSON(res, 200, { reports });
  }

  // 8B. API: POST /api/contact/staff (Reach Out to Staff Form)
  if (pathname === '/api/contact/staff' && req.method === 'POST') {
    if (!currentSession) {
      return sendJSON(res, 401, {
        error: 'Authentication Required: You must be signed in with Discord to send a message to staff.'
      });
    }
    const body = await parseBody(req);
    const customOrg = String(body.senderName || '').trim().slice(0, 100);
    const discordTag = currentSession.displayName ? `${currentSession.displayName} (@${currentSession.username})` : `@${currentSession.username}`;
    const robloxName = currentSession.robloxUsername || 'Unlinked / N/A';
    const category = String(body.category || 'General Staff Inquiry').trim().slice(0, 100);
    const message = String(body.message || '').trim().slice(0, 2500);

    if (!message) {
      return sendJSON(res, 400, { error: 'Please provide a message description.' });
    }

    const contactEntry = {
      id: 'MSG-' + Math.floor(100000 + Math.random() * 900000),
      senderName: customOrg || discordTag,
      discordUser: discordTag,
      discordId: currentSession.id,
      discordUsername: currentSession.username,
      robloxUsername: currentSession.robloxUsername || null,
      robloxId: currentSession.robloxId || null,
      category,
      message,
      timestamp: new Date().toISOString()
    };

    const inquiries = readJSONFile('inquiries.json', []);
    inquiries.unshift(contactEntry);
    if (inquiries.length > 500) inquiries.length = 500;
    writeJSONFile('inquiries.json', inquiries);

    // Send notification embed to Discord channel 1540024507761164348
    if (DISCORD_BOT_TOKEN) {
      const fromField = customOrg ? `${customOrg} · <@${currentSession.id}> (\`${currentSession.username}\`)` : `<@${currentSession.id}> (\`${currentSession.username}\`)`;
      const discordEmbed = {
        title: `Citizen Inquiry: ${category}`,
        color: 0x3498DB,
        description: `**From:** ${fromField}\n**Roblox:** \`${robloxName}\`\n**Topic:** ${category}\n\n**Message:**\n> ${message.replace(/>/g, '\\>')}`,
        footer: { text: `Reference ID: ${contactEntry.id} · Westpoint Public Portal` },
        timestamp: contactEntry.timestamp
      };
      await postDiscordMessage(AUDIT_LOGS_CHANNEL_ID, discordEmbed);
    }

    return sendJSON(res, 200, { success: true, id: contactEntry.id });
  }

  // 9. API: GET /api/ia/reports (Internal Affairs & Command Only)
  if (pathname === '/api/ia/reports' && req.method === 'GET') {
    if (!currentSession || !currentSession.permissions.isInternalAffairs) {
      return sendJSON(res, 403, { error: 'Access Denied: Internal Affairs or Command rank required.' });
    }
    const reports = readJSONFile('reports.json', []);
    return sendJSON(res, 200, { reports });
  }

  // 10. API: POST /api/ia/report/update (Internal Affairs & Command Only)
  if (pathname === '/api/ia/report/update' && req.method === 'POST') {
    if (!currentSession || !currentSession.permissions.isInternalAffairs) {
      return sendJSON(res, 403, { error: 'Access Denied: Internal Affairs rank required.' });
    }
    const body = await parseBody(req);
    const reports = readJSONFile('reports.json', []);
    const target = reports.find(r => r.id === body.reportId);
    if (!target) return sendJSON(res, 404, { error: 'Report not found' });

    const previousStatus = target.status;
    const previousFindings = target.findings;
    target.status = body.status || target.status;
    target.findings = body.findings !== undefined ? body.findings : target.findings;
    target.assignedIA = currentSession.displayName;
    target.updatedAt = new Date().toISOString();

    // Case-history log: who changed what, when - separate from
    // assignedIA/updatedAt, which only ever reflect the LAST change.
    if (!Array.isArray(target.history)) target.history = [];
    target.history.push({
      by: currentSession.displayName,
      at: target.updatedAt,
      statusFrom: previousStatus,
      statusTo: target.status,
      findingsChanged: target.findings !== previousFindings
    });
    if (target.history.length > 50) target.history = target.history.slice(-50);

    writeJSONFile('reports.json', reports);

    // DM the citizen who filed it once their case actually resolves - only
    // on the transition into a resolved state, not every edit an IA agent
    // makes while it's still under review (which would spam them).
    const RESOLVED_STATUSES = ['Resolved - Action Taken', 'Unfounded / Dismissed'];
    if (RESOLVED_STATUSES.includes(target.status) && target.status !== previousStatus && target.reporterId) {
      await dmDiscordUser(
        target.reporterId,
        `Your Westpoint Security case **${target.id}** has been updated.\n\n**Status:** ${target.status}\n\nYou can check its status anytime at https://westpointsecurity.xyz/contact using your case number.`
      );
    }

    return sendJSON(res, 200, { success: true, record: target });
  }

  // 11. API: POST /api/command/action (High Command Only - Issues Staff Action & Sends Discord Embed)
  if (pathname === '/api/command/action' && req.method === 'POST') {
    if (!currentSession || !currentSession.permissions.isCommand) {
      return sendJSON(res, 403, { error: 'Access Denied: High Command rank required.' });
    }
    const body = await parseBody(req);
    const actionType = (body.type || 'custom').toLowerCase();
    const targetUser = String(body.targetUser || 'Staff Member').trim().slice(0, 100);
    const targetUserId = String(body.targetUserId || '').trim().slice(0, 32);
    const roleRank = String(body.roleRank || '').trim().slice(0, 100);
    const context = String(body.context || '').trim().slice(0, 200);
    // Discord embed field values cap at 1024 chars; leave headroom for the "Notes" label wrapper.
    const notes = String(body.notes || '').trim().slice(0, 1000);
    const executor = currentSession.displayName;
    const color = ACTION_COLORS[actionType] || ACTION_COLORS.custom;

    // Construct body sentence matching bot format
    let bodySentence = '';
    if (actionType === 'hire') {
      bodySentence = `**${targetUser}** has been **hired**`;
      if (roleRank) bodySentence += ` as **${roleRank}**`;
      bodySentence += '.';
    } else if (actionType === 'promote' || actionType === 'demote') {
      bodySentence = `**${targetUser}** has been **${actionType}d** to **${roleRank}**`;
      if (context) bodySentence += ` and **${context}**`;
      bodySentence += '.';
    } else if (actionType === 'adminleave') {
      bodySentence = `**${targetUser}** has been **placed on admin leave**.`;
    } else if (actionType === 'suspend') {
      bodySentence = `**${targetUser}** has been **suspended**`;
      if (context) bodySentence += ` **${context}**`;
      bodySentence += '.';
    } else if (actionType === 'terminate') {
      bodySentence = `**${targetUser}** has been **terminated** from staff.`;
    } else if (actionType === 'warn') {
      bodySentence = `**${targetUser}** has been **warned**.`;
    } else {
      const verb = body.customVerb || 'modified';
      bodySentence = `**${targetUser}** has been **${verb}**`;
      if (roleRank) bodySentence += ` to **${roleRank}**`;
      if (context) bodySentence += ` and **${context}**`;
      bodySentence += '.';
    }

    const discordEmbed = {
      title: 'Department Action',
      color: color,
      description: bodySentence,
      footer: { text: executor },
      timestamp: new Date().toISOString()
    };
    if (notes) {
      discordEmbed.fields = [{ name: 'Notes', value: notes }];
    }

    // Post to Discord #administrative-log
    const discordRes = await postDiscordMessage(DEPT_LOGS_CHANNEL_ID, discordEmbed);

    // Save state in bot.db if stateful
    const db = getBotDb();
    if (db && targetUserId && ['demote', 'adminleave', 'suspend'].includes(actionType)) {
      try {
        const msgId = discordRes.body?.id || 'WEB-' + Date.now();
        db.prepare(`
          INSERT INTO user_action_states (target_user_id, last_action_type, channel_id, message_id, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(target_user_id) DO UPDATE SET
            last_action_type = excluded.last_action_type,
            channel_id = excluded.channel_id,
            message_id = excluded.message_id,
            updated_at = excluded.updated_at
        `).run(targetUserId, actionType, DEPT_LOGS_CHANNEL_ID, msgId, Date.now());
      } catch (e) {
        logger.error('[ACTION STATE DB ERROR] ' + e.message);
      }
    }

    // Save in web actions audit log
    const actionRecord = {
      id: 'ACT-' + Math.floor(100000 + Math.random() * 900000),
      type: actionType,
      targetUser,
      targetUserId,
      roleRank,
      context,
      notes,
      executor,
      timestamp: new Date().toISOString(),
      discordMessageId: discordRes.body?.id || null
    };

    const actions = readJSONFile('actions.json', []);
    actions.unshift(actionRecord);
    writeJSONFile('actions.json', actions);

    return sendJSON(res, 200, { success: true, record: actionRecord, discordStatus: discordRes.status });
  }

  // 12. API: GET /api/command/actions (High Command Staff Action History)
  if (pathname === '/api/command/actions' && req.method === 'GET') {
    if (!currentSession || !currentSession.permissions.isCommand) {
      return sendJSON(res, 403, { error: 'Access Denied: High Command rank required.' });
    }
    const actions = readJSONFile('actions.json', []);
    return sendJSON(res, 200, { actions });
  }

  // API: GET /api/admin/export/:kind.csv (Command Only - CSV export of
  // actions, weekly quota standings, or citizen reports for spreadsheet use)
  if (pathname.startsWith('/api/admin/export/') && pathname.endsWith('.csv') && req.method === 'GET') {
    if (!currentSession || !currentSession.permissions.isCommand) {
      return sendJSON(res, 403, { error: 'Access Denied: High Command rank required.' });
    }
    const kind = pathname.slice('/api/admin/export/'.length, -'.csv'.length);
    let rows = [];
    let columns = [];

    if (kind === 'actions') {
      columns = ['id', 'type', 'targetUser', 'targetUserId', 'roleRank', 'context', 'notes', 'executor', 'timestamp'];
      rows = readJSONFile('actions.json', []);
    } else if (kind === 'reports') {
      columns = ['id', 'type', 'citizen', 'officer', 'location', 'status', 'assignedIA', 'findings', 'timestamp'];
      rows = readJSONFile('reports.json', []);
    } else if (kind === 'quota') {
      columns = ['userId', 'robloxUsername', 'totalSeconds', 'quotaTargetSeconds', 'quotaMet', 'weekKey'];
      const db = getBotDb();
      const weekKey = getWeekKey();
      if (db) {
        try {
          rows = db.prepare(`
            SELECT sh.user_id AS userId,
                   COALESCE(s.roblox_username, sh.roblox_username) AS robloxUsername,
                   COALESCE(wt.total_seconds, 0) AS totalSeconds,
                   COALESCE(s.quota_target_seconds, 900) AS quotaTargetSeconds,
                   ? AS weekKey
            FROM (SELECT DISTINCT user_id, roblox_username FROM shift_history WHERE week_key = ?) sh
            LEFT JOIN weekly_totals wt ON wt.user_id = sh.user_id AND wt.week_key = ?
            LEFT JOIN staff_members s ON s.user_id = sh.user_id
            ORDER BY totalSeconds DESC
          `).all(weekKey, weekKey, weekKey);
          rows.forEach(r => { r.quotaMet = r.totalSeconds >= r.quotaTargetSeconds; });
        } catch (e) {
          console.error('[CSV EXPORT ERROR]', e.message);
        }
      }
    } else {
      return sendJSON(res, 404, { error: 'Unknown export type. Use actions, reports, or quota.' });
    }

    const escapeCsvField = (val) => {
      const str = val === null || val === undefined ? '' : String(val);
      return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
    };
    const csvLines = [columns.join(',')];
    rows.forEach(row => csvLines.push(columns.map(col => escapeCsvField(row[col])).join(',')));
    const csv = csvLines.join('\n');

    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="westpoint-${kind}-${getWeekKey()}.csv"`,
      ...SECURITY_HEADERS
    });
    return res.end(csv);
  }

  // API: GET /api/public/patrol-count (Public - live "X officers on patrol"
  // counter for the homepage). Counts active_sessions directly rather than
  // going through /api/duty-roster (which requires isOfficer) - this is
  // deliberately public and reveals nothing beyond a headcount.
  if (pathname === '/api/public/patrol-count' && req.method === 'GET') {
    const db = getBotDb();
    if (!db) return sendJSON(res, 200, { count: 0 });
    try {
      const row = db.prepare('SELECT COUNT(*) AS c FROM active_sessions').get();
      return sendJSON(res, 200, { count: row?.c || 0 });
    } catch (e) {
      return sendJSON(res, 200, { count: 0 });
    }
  }

  // 13. API: GET /api/news (Public News List)
  if (pathname === '/api/news' && req.method === 'GET') {
    const news = readJSONFile('news.json', []);
    return sendJSON(res, 200, { news });
  }

  // 13B. API: GET /api/news/:id (Public - single article, for the permalink
  // page). Placed before the general /api/news/:id DELETE check further
  // down doesn't apply here since that's method-gated to DELETE only.
  if (pathname.startsWith('/api/news/') && req.method === 'GET') {
    const articleId = pathname.slice('/api/news/'.length);
    const news = readJSONFile('news.json', []);
    const article = news.find(n => n.id === articleId);
    if (!article) return sendJSON(res, 404, { error: 'Article not found' });
    return sendJSON(res, 200, { article });
  }

  // 14. API: POST /api/news (Command Only - Publish Bulletin)
  if (pathname === '/api/news' && req.method === 'POST') {
    if (!currentSession || !currentSession.permissions.isCommand) {
      return sendJSON(res, 403, { error: 'Access Denied: High Command rank required.' });
    }
    const body = await parseBody(req);
    const newArticle = {
      id: 'NEWS-' + Math.floor(1000 + Math.random() * 9000),
      title: String(body.title || 'Official Notice').trim().slice(0, 150),
      author: currentSession.displayName,
      date: new Date().toISOString().split('T')[0],
      category: String(body.category || 'Department Notice').trim().slice(0, 100),
      summary: String(body.summary || '').trim().slice(0, 2000),
      // Full article body for the permalink page - summary alone (capped at
      // 2000 chars, meant for list previews) stays as the list-view excerpt.
      content: String(body.content || '').trim().slice(0, 10000)
    };

    const news = readJSONFile('news.json', []);
    news.unshift(newArticle);
    writeJSONFile('news.json', news);
    return sendJSON(res, 200, { success: true, record: newArticle });
  }

  // 15. API: DELETE /api/news/:id (Command Only - Delete Bulletin)
  if (pathname.startsWith('/api/news/') && req.method === 'DELETE') {
    if (!currentSession || !currentSession.permissions.isCommand) {
      return sendJSON(res, 403, { error: 'Access Denied: High Command rank required.' });
    }
    const articleId = pathname.replace('/api/news/', '');
    let news = readJSONFile('news.json', []);
    news = news.filter(n => n.id !== articleId);
    writeJSONFile('news.json', news);
    return sendJSON(res, 200, { success: true });
  }

  // API: GET /api/admin/analytics (Command Only - weekly time-series for
  // the Analytics dashboard: total duty hours, distinct active officers,
  // and quota compliance % for each of the last 8 week keys, oldest first)
  if (pathname === '/api/admin/analytics' && req.method === 'GET') {
    if (!currentSession || !currentSession.permissions.isCommand) {
      return sendJSON(res, 403, { error: 'Access Denied: High Command rank required.' });
    }
    const db = getBotDb();
    if (!db) return sendJSON(res, 500, { error: 'Database unavailable' });
    const WEEKS_BACK = 8;
    const weeks = [];
    try {
      for (let i = WEEKS_BACK - 1; i >= 0; i--) {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - i * 7);
        const weekKey = getWeekKey(d);

        const totalRow = db.prepare('SELECT COALESCE(SUM(total_seconds), 0) AS total FROM weekly_totals WHERE week_key = ?').get(weekKey);
        const activeRow = db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM shift_history WHERE week_key = ?').get(weekKey);
        const complianceRows = db.prepare(`
          SELECT sh.user_id,
                 COALESCE(wt.total_seconds, 0) AS totalSeconds,
                 COALESCE(s.quota_target_seconds, 900) AS quotaTargetSeconds
          FROM (SELECT DISTINCT user_id FROM shift_history WHERE week_key = ?) sh
          LEFT JOIN weekly_totals wt ON wt.user_id = sh.user_id AND wt.week_key = ?
          LEFT JOIN staff_members s ON s.user_id = sh.user_id
        `).all(weekKey, weekKey);
        const compliancePercent = complianceRows.length
          ? Math.round((complianceRows.filter(r => r.totalSeconds >= r.quotaTargetSeconds).length / complianceRows.length) * 100)
          : 0;

        weeks.push({
          weekKey,
          totalHours: Math.round((totalRow.total / 3600) * 10) / 10,
          activeOfficers: activeRow.n,
          compliancePercent
        });
      }
    } catch (e) {
      console.error('[ANALYTICS ERROR]', e.message);
      return sendJSON(res, 500, { error: 'Failed to compute analytics.' });
    }
    return sendJSON(res, 200, { weeks });
  }

  // API: GET /api/admin/flags/quota-risk (Command Only - officers under
  // their quota target for every one of the last N weeks running, not just
  // the current week)
  if (pathname === '/api/admin/flags/quota-risk' && req.method === 'GET') {
    if (!currentSession || !currentSession.permissions.isCommand) {
      return sendJSON(res, 403, { error: 'Access Denied: High Command rank required.' });
    }
    const db = getBotDb();
    if (!db) return sendJSON(res, 500, { error: 'Database unavailable' });
    const QUOTA_RISK_WEEKS = 3;
    try {
      const perOfficer = new Map();
      for (let i = 0; i < QUOTA_RISK_WEEKS; i++) {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - i * 7);
        const weekKey = getWeekKey(d);
        const rows = db.prepare(`
          SELECT sh.user_id AS userId,
                 COALESCE(s.roblox_username, sh.roblox_username) AS robloxUsername,
                 COALESCE(wt.total_seconds, 0) AS totalSeconds,
                 COALESCE(s.quota_target_seconds, 900) AS quotaTargetSeconds
          FROM (SELECT DISTINCT user_id, roblox_username FROM shift_history WHERE week_key = ?) sh
          LEFT JOIN weekly_totals wt ON wt.user_id = sh.user_id AND wt.week_key = ?
          LEFT JOIN staff_members s ON s.user_id = sh.user_id
        `).all(weekKey, weekKey);
        for (const row of rows) {
          const entry = perOfficer.get(row.userId) || { userId: row.userId, robloxUsername: row.robloxUsername || 'Officer', weeksChecked: 0, weeksUnderQuota: 0 };
          entry.weeksChecked += 1;
          if (row.totalSeconds < row.quotaTargetSeconds) entry.weeksUnderQuota += 1;
          perOfficer.set(row.userId, entry);
        }
      }
      const flagged = Array.from(perOfficer.values())
        .filter(e => e.weeksChecked >= QUOTA_RISK_WEEKS && e.weeksUnderQuota === QUOTA_RISK_WEEKS)
        .map(({ userId, robloxUsername, weeksUnderQuota }) => ({ userId, robloxUsername, weeksUnderQuota }));
      return sendJSON(res, 200, { flagged });
    } catch (e) {
      console.error('[QUOTA RISK ERROR]', e.message);
      return sendJSON(res, 500, { error: 'Failed to compute quota risk.' });
    }
  }

  // API: GET /api/admin/flags/stale-ia (Command Only - IA cases open longer
  // than a threshold and still unresolved)
  if (pathname === '/api/admin/flags/stale-ia' && req.method === 'GET') {
    if (!currentSession || !currentSession.permissions.isCommand) {
      return sendJSON(res, 403, { error: 'Access Denied: High Command rank required.' });
    }
    const STALE_IA_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
    const RESOLVED_STATUSES = ['Resolved - Action Taken', 'Unfounded / Dismissed'];
    const now = Date.now();
    const stale = readJSONFile('reports.json', [])
      .filter(r => !RESOLVED_STATUSES.includes(r.status) && now - new Date(r.timestamp).getTime() > STALE_IA_THRESHOLD_MS)
      .map(r => ({
        id: r.id,
        type: r.type,
        status: r.status,
        ageDays: Math.floor((now - new Date(r.timestamp).getTime()) / (24 * 60 * 60 * 1000))
      }))
      .sort((a, b) => b.ageDays - a.ageDays);
    return sendJSON(res, 200, { stale });
  }

  // API: POST /api/admin/request-confirmation (Command Only - issues a
  // one-time code for a named destructive action, valid for 2 minutes)
  if (pathname === '/api/admin/request-confirmation' && req.method === 'POST') {
    if (!currentSession || !currentSession.permissions.isCommand) {
      return sendJSON(res, 403, { error: 'Access Denied: High Command rank required.' });
    }
    const body = await parseBody(req);
    if (!['reset-quota', 'channel-config'].includes(body.action)) {
      return sendJSON(res, 400, { error: 'Unknown action.' });
    }
    const code = String(Math.floor(100000 + Math.random() * 900000));
    CONFIRMATION_CODES.set(`${currentSession.id}:${body.action}`, { code, expiresAt: Date.now() + 2 * 60 * 1000 });
    return sendJSON(res, 200, { code });
  }

  // API: POST /api/admin/backup-now (Command Only - manual on-demand
  // trigger for the same snapshot the daily scheduled backup runs)
  if (pathname === '/api/admin/backup-now' && req.method === 'POST') {
    if (!currentSession || !currentSession.permissions.isCommand) {
      return sendJSON(res, 403, { error: 'Access Denied: High Command rank required.' });
    }
    if (!r2.isConfigured()) return sendJSON(res, 503, { error: 'R2 storage is not configured on this server.' });
    await backupDatabaseToR2();
    return sendJSON(res, 200, { success: true });
  }

  // API: POST /api/admin/reset-quota-logs (Command Only - wipe weekly quota
  // totals and shift history for a clean slate. Does not touch active
  // sessions, the staff roster, or bodycam video logs on Discord - those
  // clear on their own normal weekly schedule.)
  if (pathname === '/api/admin/reset-quota-logs' && req.method === 'POST') {
    if (!currentSession || !currentSession.permissions.isCommand) {
      return sendJSON(res, 403, { error: 'Access Denied: High Command rank required.' });
    }
    const resetBody = await parseBody(req);
    if (!consumeConfirmationCode(currentSession.id, 'reset-quota', resetBody.confirmationCode)) {
      return sendJSON(res, 400, { error: 'Invalid or expired confirmation code - request a new one and try again.' });
    }
    const db = getBotDb();
    if (!db) return sendJSON(res, 500, { error: 'Database unavailable' });
    try {
      const totals = db.prepare('DELETE FROM weekly_totals').run();
      const shifts = db.prepare('DELETE FROM shift_history').run();
      return sendJSON(res, 200, {
        success: true,
        weeklyTotalsDeleted: totals.changes,
        shiftHistoryDeleted: shifts.changes
      });
    } catch (e) {
      console.error('[QUOTA RESET ERROR]', e.message);
      return sendJSON(res, 500, { error: 'Failed to reset quota logs' });
    }
  }

  // API: GET /api/admin/roles (Command Only - list every guild role, live
  // from Discord, merged with the saved enabled/tier config for each)
  if (pathname === '/api/admin/roles' && req.method === 'GET') {
    if (!currentSession || !currentSession.permissions.isCommand) {
      return sendJSON(res, 403, { error: 'Access Denied: High Command rank required.' });
    }
    const liveRes = await fetchGuildRoles();
    if (!liveRes.success) {
      return sendJSON(res, 502, { error: 'Failed to fetch roles from Discord: ' + (liveRes.error || liveRes.status) });
    }
    const config = getRoleConfig();
    const roles = liveRes.roles
      .filter(r => r.id !== GUILD_ID && !r.managed) // @everyone and bot/integration-managed roles can't be assigned to staff manually
      .map(r => {
        const c = config[r.id] || {};
        return {
          id: r.id,
          name: r.name,
          color: r.color ? '#' + r.color.toString(16).padStart(6, '0') : null,
          position: r.position,
          enabled: !!c.enabled,
          isSupervisor: !!c.isSupervisor,
          isCommand: !!c.isCommand,
          isInternalAffairs: !!c.isInternalAffairs,
          weeklyQuotaSeconds: Number(c.weeklyQuotaSeconds) || 0
        };
      })
      .sort((a, b) => b.position - a.position);
    return sendJSON(res, 200, { roles });
  }

  // API: POST /api/admin/roles (Command Only - save the full edited role
  // config. Replaces the whole file rather than merging, since the client
  // always has the complete current list from the GET above.)
  if (pathname === '/api/admin/roles' && req.method === 'POST') {
    if (!currentSession || !currentSession.permissions.isCommand) {
      return sendJSON(res, 403, { error: 'Access Denied: High Command rank required.' });
    }
    const body = await parseBody(req);
    if (!Array.isArray(body.roles)) return sendJSON(res, 400, { error: 'Missing roles array' });

    const config = {};
    body.roles.forEach(r => {
      if (!r || !r.id) return;
      config[String(r.id)] = {
        displayName: String(r.name || 'Role').trim().slice(0, 100),
        position: Number(r.position) || 0,
        enabled: !!r.enabled,
        isSupervisor: !!r.isSupervisor,
        isCommand: !!r.isCommand,
        isInternalAffairs: !!r.isInternalAffairs,
        weeklyQuotaSeconds: Math.max(0, Math.round(Number(r.weeklyQuotaSeconds)) || 0)
      };
    });
    writeJSONFile('role-permissions.json', config);
    roleConfigCache = config;
    roleConfigUpdatedAt = Date.now();
    return sendJSON(res, 200, { success: true, roleCount: Object.keys(config).length });
  }

  // API: GET /api/admin/channels (Command Only - current channel/guild IDs,
  // whether each is a saved override or still the env/hardcoded default)
  if (pathname === '/api/admin/channels' && req.method === 'GET') {
    if (!currentSession || !currentSession.permissions.isCommand) {
      return sendJSON(res, 403, { error: 'Access Denied: High Command rank required.' });
    }
    return sendJSON(res, 200, {
      channels: {
        deptLogsChannelId: DEPT_LOGS_CHANNEL_ID,
        auditLogsChannelId: AUDIT_LOGS_CHANNEL_ID,
        videoLogGuildId: VIDEO_LOG_GUILD_ID,
        videoLogParentId: VIDEO_LOG_PARENT_ID
      }
    });
  }

  // API: POST /api/admin/channels (Command Only - save + apply immediately,
  // no redeploy needed. Only updates this process's in-memory values - the
  // bot process has its own copy of DEPARTMENT_LOGS_CHANNEL_ID/
  // AUDIT_LOGS_CHANNEL_ID in bot/src/config.js, unaffected by this panel.)
  if (pathname === '/api/admin/channels' && req.method === 'POST') {
    if (!currentSession || !currentSession.permissions.isCommand) {
      return sendJSON(res, 403, { error: 'Access Denied: High Command rank required.' });
    }
    const body = await parseBody(req);
    if (!consumeConfirmationCode(currentSession.id, 'channel-config', body.confirmationCode)) {
      return sendJSON(res, 400, { error: 'Invalid or expired confirmation code - request a new one and try again.' });
    }
    const clean = (val) => String(val || '').trim().replace(/[^0-9]/g, '').slice(0, 32);
    const next = {
      deptLogsChannelId: clean(body.deptLogsChannelId) || DEPT_LOGS_CHANNEL_ID,
      auditLogsChannelId: clean(body.auditLogsChannelId) || AUDIT_LOGS_CHANNEL_ID,
      videoLogGuildId: clean(body.videoLogGuildId) || VIDEO_LOG_GUILD_ID,
      videoLogParentId: clean(body.videoLogParentId) || VIDEO_LOG_PARENT_ID
    };
    writeJSONFile('channel-config.json', next);
    DEPT_LOGS_CHANNEL_ID = next.deptLogsChannelId;
    AUDIT_LOGS_CHANNEL_ID = next.auditLogsChannelId;
    VIDEO_LOG_GUILD_ID = next.videoLogGuildId;
    VIDEO_LOG_PARENT_ID = next.videoLogParentId;
    return sendJSON(res, 200, { success: true, channels: next });
  }

  // API: GET /api/duty/status (Check current officer active session in bot.db)
  if (pathname === '/api/duty/status' && req.method === 'GET') {
    if (!currentSession || !currentSession.permissions.isOfficer) return sendJSON(res, 401, { error: 'Unauthorized' });
    const db = getBotDb();
    if (db) {
      try {
        const row = db.prepare('SELECT * FROM active_sessions WHERE user_id = ?').get(currentSession.id);
        if (row) {
          const elapsedSec = Math.floor((Date.now() - row.start_time) / 1000);
          return sendJSON(res, 200, {
            active: true,
            startTime: row.start_time,
            elapsedSeconds: elapsedSec,
            robloxUsername: row.roblox_username,
            robloxId: row.roblox_id,
            bodycamId: row.bodycam_id || null
          });
        }
      } catch (e) {
        logger.error('[DUTY STATUS DB ERROR] ' + e.message);
      }
    }
    return sendJSON(res, 200, { active: false });
  }

  // API: POST /api/duty/start (Verify Roblox In-Game Presence before starting shift)
  if (pathname === '/api/duty/start' && req.method === 'POST') {
    if (!currentSession || !currentSession.permissions.isOfficer) return sendJSON(res, 401, { error: 'Unauthorized' });
    const db = getBotDb();
    if (!db) return sendJSON(res, 500, { error: 'Database unavailable' });

    // Check if session already active
    const existing = db.prepare('SELECT * FROM active_sessions WHERE user_id = ?').get(currentSession.id);
    if (existing) {
      const elapsed = Math.floor((Date.now() - existing.start_time) / 1000);
      return sendJSON(res, 200, {
        success: true,
        alreadyActive: true,
        startTime: existing.start_time,
        elapsedSeconds: elapsed,
        robloxUsername: existing.roblox_username
      });
    }

    // Verify Roblox presence
    const candidates = [
      currentSession.displayName,
      currentSession.username,
      currentSession.displayName?.split('|')[0]?.trim(),
      currentSession.displayName?.split(']')[1]?.trim()
    ].filter(Boolean);

    const verification = await robloxService.verifyUserInGame(candidates, '10659924817');

    if (!verification.inGame) {
      return sendJSON(res, 400, {
        success: false,
        error: verification.reason || 'Verification Failed: You are not currently in Harrison County on Roblox. Please join the game before starting your shift.'
      });
    }

    // Save active session
    const startTime = Date.now();
    try {
      db.prepare(`
        INSERT INTO staff_members (user_id, roblox_id, roblox_username, quota_target_seconds, last_known_rank, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          roblox_id = COALESCE(excluded.roblox_id, staff_members.roblox_id),
          roblox_username = COALESCE(excluded.roblox_username, staff_members.roblox_username),
          quota_target_seconds = excluded.quota_target_seconds,
          last_known_rank = excluded.last_known_rank,
          updated_at = excluded.updated_at
      `).run(currentSession.id, String(verification.robloxId), verification.robloxUsername, currentSession.quotaTargetSeconds || 0, currentSession.highestRank || null, startTime);

      db.prepare(`
        INSERT INTO active_sessions (user_id, roblox_id, roblox_username, start_time)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          roblox_id = excluded.roblox_id,
          roblox_username = excluded.roblox_username,
          start_time = excluded.start_time
      `).run(currentSession.id, String(verification.robloxId), verification.robloxUsername, startTime);
    } catch (e) {
      logger.error('[DUTY START DB ERROR] ' + e.message);
      return sendJSON(res, 500, { error: 'Failed to record duty session in database' });
    }

    return sendJSON(res, 200, {
      success: true,
      startTime: startTime,
      robloxUsername: verification.robloxUsername,
      robloxId: verification.robloxId
    });
  }

  // API: POST /api/duty/end (End duty shift, update weekly totals, post Discord embed)
  if (pathname === '/api/duty/end' && req.method === 'POST') {
    if (!currentSession || !currentSession.permissions.isOfficer) return sendJSON(res, 401, { error: 'Unauthorized' });
    const db = getBotDb();
    if (!db) return sendJSON(res, 500, { error: 'Database unavailable' });

    const session = db.prepare('SELECT * FROM active_sessions WHERE user_id = ?').get(currentSession.id);
    if (!session) {
      return sendJSON(res, 400, { success: false, error: 'No active duty session found.' });
    }

    const now = Date.now();
    const elapsedMs = now - session.start_time;
    const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
    const minDurationMs = 12 * 60 * 1000; // 12 minutes

    db.prepare('DELETE FROM active_sessions WHERE user_id = ?').run(currentSession.id);

    const weekKey = getWeekKey();
    let logged = false;
    let newWeeklyTotalSeconds = 0;

    // Every shift gets a history row regardless of whether it met the
    // quota-crediting minimum - "every shift they've logged" on the profile
    // view is a separate concern from whether it counted toward the quota.
    db.prepare(`
      INSERT INTO shift_history (id, user_id, roblox_username, start_time, end_time, duration_seconds, week_key, bodycam_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'SHIFT-' + crypto.randomBytes(8).toString('hex'),
      currentSession.id,
      session.roblox_username || null,
      session.start_time,
      now,
      elapsedSeconds,
      weekKey,
      session.bodycam_id || null
    );

    // Safety net: if the officer ends duty without explicitly stopping the
    // bodycam first, finalize it here too rather than leaving it recording
    // against a shift that's already over.
    if (session.bodycam_id) {
      const bcSession = db.prepare('SELECT * FROM bodycam_sessions WHERE id = ?').get(session.bodycam_id);
      if (bcSession && bcSession.status === 'recording') {
        db.prepare("UPDATE bodycam_sessions SET status = 'processing', finished_at = ? WHERE id = ?").run(now, session.bodycam_id);
        finalizeBodycamSession(session.bodycam_id).catch(err => {
          console.error('[BODYCAM FINALIZE ERROR]', session.bodycam_id, err.message);
          try {
            getBotDb()?.prepare("UPDATE bodycam_sessions SET status = 'failed', error = ? WHERE id = ?").run(err.message.slice(0, 500), session.bodycam_id);
          } catch (e) {}
        });
      }
    }

    if (elapsedMs >= minDurationMs) {
      db.prepare(`
        INSERT INTO weekly_totals (user_id, week_key, total_seconds)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id, week_key) DO UPDATE SET
          total_seconds = total_seconds + excluded.total_seconds
      `).run(currentSession.id, weekKey, elapsedSeconds);

      const totalRow = db.prepare('SELECT total_seconds FROM weekly_totals WHERE user_id = ? AND week_key = ?').get(currentSession.id, weekKey);
      newWeeklyTotalSeconds = totalRow ? totalRow.total_seconds : elapsedSeconds;
      logged = true;

      // Send embed to Discord Audit Logs channel
      const AUDIT_CHANNEL = process.env.AUDIT_LOGS_CHANNEL_ID || '1540024507761164348';
      const embed = {
        title: 'Staff Autolog Session Ended',
        color: 0x00FF7F,
        fields: [
          { name: 'Staff Member', value: `<@${currentSession.id}> (${currentSession.username})`, inline: true },
          { name: 'Session Duration', value: formatDuration(elapsedSeconds), inline: true },
          { name: 'Weekly Total Logged', value: formatDuration(newWeeklyTotalSeconds), inline: true },
          { name: 'Ending Method', value: 'Web Portal Officer Workbench (`/employee/dashboard`)', inline: false }
        ],
        timestamp: new Date().toISOString(),
        footer: { text: 'Autolog Tracking System · Web Portal' }
      };
      postDiscordMessage(AUDIT_CHANNEL, embed).catch(() => {});

      // Shift End Summary Card - same "executive receipt" DM the bot sends
      // for /autolog end and Voice Channel Shift Sync, mirrored here since
      // ending duty from the web dashboard is a separate code path (this
      // process has no discord.js client, just the same bot token over
      // raw REST via dmDiscordUser).
      const incidentCount = readJSONFile('incidents.json', [])
        .filter(i => i.officerId === currentSession.id && new Date(i.timestamp).getTime() >= session.start_time && new Date(i.timestamp).getTime() <= now)
        .length;
      const quotaTargetSeconds = currentSession.quotaTargetSeconds || 900;
      const quotaPercent = quotaTargetSeconds > 0 ? Math.min(999, Math.round((newWeeklyTotalSeconds / quotaTargetSeconds) * 100)) : 100;
      const summaryEmbed = {
        title: 'Shift End Summary',
        color: 0x2ECC71,
        description: "Here's your executive receipt for the shift you just ended.",
        fields: [
          { name: 'Shift Duration', value: formatDuration(elapsedSeconds), inline: true },
          { name: 'Incidents Filed This Shift', value: String(incidentCount), inline: true },
          { name: 'Weekly Quota Progress', value: `${formatDuration(newWeeklyTotalSeconds)} / ${formatDuration(quotaTargetSeconds)} (${quotaPercent}%)`, inline: false }
        ],
        timestamp: new Date().toISOString(),
        footer: { text: 'Westpoint Security · Autolog Tracking System' }
      };
      dmDiscordUser(currentSession.id, 'Your shift has ended - see the summary below.', [summaryEmbed]).catch(() => {});
    }

    return sendJSON(res, 200, {
      success: true,
      logged: logged,
      elapsedSeconds: elapsedSeconds,
      durationFormatted: formatDuration(elapsedSeconds),
      weeklyTotalFormatted: formatDuration(newWeeklyTotalSeconds),
      message: logged ? 'Shift ended and logged to weekly quota!' : `Shift lasted ${formatDuration(elapsedSeconds)}, which is under the 12-minute requirement (discarded).`
    });
  }

  // ===============================================================
  // BODYCAM: chunked live recording -> R2, near-live viewing for
  // Supervisors+, end-of-shift merge, archive playback/trim/download.
  // ===============================================================

  // API: GET /api/bodycam/storage-status (Officer - shown next to the bodycam controls)
  if (pathname === '/api/bodycam/storage-status' && req.method === 'GET') {
    if (!currentSession || !currentSession.permissions.isOfficer) return sendJSON(res, 401, { error: 'Unauthorized' });
    return sendJSON(res, 200, {
      configured: r2.isConfigured(),
      usedBytes: bodycamStorageBytes,
      limitBytes: BODYCAM_STORAGE_LIMIT_BYTES,
      usedGB: Number((bodycamStorageBytes / 1024 / 1024 / 1024).toFixed(2)),
      limitGB: Number((BODYCAM_STORAGE_LIMIT_BYTES / 1024 / 1024 / 1024).toFixed(2)),
      full: isBodycamStorageFull()
    });
  }

  // API: POST /api/bodycam/start (Officer, must already be on duty)
  if (pathname === '/api/bodycam/start' && req.method === 'POST') {
    if (!currentSession || !currentSession.permissions.isOfficer) return sendJSON(res, 401, { error: 'Unauthorized' });
    if (!r2.isConfigured()) return sendJSON(res, 503, { error: 'Bodycam storage is not configured yet.' });
    if (isBodycamStorageFull()) {
      return sendJSON(res, 507, {
        error: `Bodycam storage limit reached (${(bodycamStorageBytes / 1024 / 1024 / 1024).toFixed(2)}GB / 9.9GB) - recording is disabled until space is freed.`
      });
    }
    const db = getBotDb();
    if (!db) return sendJSON(res, 500, { error: 'Database unavailable' });

    const activeShift = db.prepare('SELECT * FROM active_sessions WHERE user_id = ?').get(currentSession.id);
    if (!activeShift) return sendJSON(res, 400, { error: 'Start your duty shift before starting your bodycam.' });
    if (activeShift.bodycam_id) {
      return sendJSON(res, 200, { success: true, bodycamId: activeShift.bodycam_id, alreadyActive: true });
    }

    const bodycamId = 'BC-' + crypto.randomBytes(8).toString('hex');
    db.prepare(`
      INSERT INTO bodycam_sessions (id, user_id, week_key, status, chunk_count, started_at)
      VALUES (?, ?, ?, 'recording', 0, ?)
    `).run(bodycamId, currentSession.id, getWeekKey(), Date.now());
    db.prepare('UPDATE active_sessions SET bodycam_id = ? WHERE user_id = ?').run(bodycamId, currentSession.id);

    return sendJSON(res, 200, { success: true, bodycamId });
  }

  // API: POST /api/bodycam/chunk?bodycamId=X&index=N (Officer, raw video/webm body)
  if (pathname === '/api/bodycam/chunk' && req.method === 'POST') {
    if (!currentSession || !currentSession.permissions.isOfficer) return sendJSON(res, 401, { error: 'Unauthorized' });
    const bodycamId = parsedUrl.query.bodycamId;
    const chunkIndex = parseInt(parsedUrl.query.index, 10);
    if (!bodycamId || Number.isNaN(chunkIndex)) return sendJSON(res, 400, { error: 'Missing bodycamId or index' });

    const db = getBotDb();
    if (!db) return sendJSON(res, 500, { error: 'Database unavailable' });
    const bcSession = db.prepare('SELECT * FROM bodycam_sessions WHERE id = ?').get(bodycamId);
    if (!bcSession || bcSession.user_id !== currentSession.id) return sendJSON(res, 403, { error: 'Not your bodycam session' });
    if (bcSession.status !== 'recording') return sendJSON(res, 409, { error: 'This bodycam session is no longer recording' });

    if (isBodycamStorageFull()) {
      // Close this session out properly (rather than leaving it dangling in
      // 'recording' forever) instead of just rejecting the chunk.
      db.prepare("UPDATE bodycam_sessions SET status = 'processing', finished_at = ? WHERE id = ?").run(Date.now(), bodycamId);
      finalizeBodycamSession(bodycamId).catch(err => {
        console.error('[BODYCAM FINALIZE ERROR]', bodycamId, err.message);
        try {
          getBotDb()?.prepare("UPDATE bodycam_sessions SET status = 'failed', error = ? WHERE id = ?").run(err.message.slice(0, 500), bodycamId);
        } catch (e) {}
      });
      return sendJSON(res, 507, { error: 'storage_limit_reached', message: 'Bodycam storage limit reached - recording stopped automatically.' });
    }

    let chunkBody;
    try {
      chunkBody = await readRawBody(req);
    } catch (e) {
      return sendJSON(res, 413, { error: 'Chunk too large' });
    }
    if (!chunkBody || chunkBody.length === 0) return sendJSON(res, 400, { error: 'Empty chunk' });

    try {
      await r2.putObject(`bodycam/${bodycamId}/chunk-${String(chunkIndex).padStart(6, '0')}.webm`, chunkBody, 'video/webm');
      db.prepare('UPDATE bodycam_sessions SET chunk_count = chunk_count + 1 WHERE id = ?').run(bodycamId);
      bodycamStorageBytes += chunkBody.length;
    } catch (e) {
      console.error('[BODYCAM CHUNK UPLOAD ERROR]', e.message);
      return sendJSON(res, 500, { error: 'Failed to store chunk' });
    }

    return sendJSON(res, 200, { success: true });
  }

  // API: POST /api/bodycam/stop (Officer - finalize & merge runs in the background)
  if (pathname === '/api/bodycam/stop' && req.method === 'POST') {
    if (!currentSession || !currentSession.permissions.isOfficer) return sendJSON(res, 401, { error: 'Unauthorized' });
    const stopBody = await parseBody(req);
    const bodycamId = stopBody.bodycamId;
    const db = getBotDb();
    if (!db) return sendJSON(res, 500, { error: 'Database unavailable' });
    const bcSession = db.prepare('SELECT * FROM bodycam_sessions WHERE id = ?').get(bodycamId);
    if (!bcSession || bcSession.user_id !== currentSession.id) return sendJSON(res, 403, { error: 'Not your bodycam session' });

    if (bcSession.status === 'recording') {
      db.prepare("UPDATE bodycam_sessions SET status = 'processing', finished_at = ? WHERE id = ?").run(Date.now(), bodycamId);
      finalizeBodycamSession(bodycamId).catch(err => {
        console.error('[BODYCAM FINALIZE ERROR]', bodycamId, err.message);
        try {
          getBotDb()?.prepare("UPDATE bodycam_sessions SET status = 'failed', error = ? WHERE id = ?").run(err.message.slice(0, 500), bodycamId);
        } catch (e) {}
      });
    }

    return sendJSON(res, 200, { success: true, status: 'processing' });
  }

  // API: GET /api/bodycam/:id/status
  if (pathname.startsWith('/api/bodycam/') && pathname.endsWith('/status') && req.method === 'GET') {
    if (!currentSession) return sendJSON(res, 401, { error: 'Unauthorized' });
    const bodycamId = pathname.split('/')[3];
    const db = getBotDb();
    const bcSession = db && db.prepare('SELECT * FROM bodycam_sessions WHERE id = ?').get(bodycamId);
    if (!bcSession) return sendJSON(res, 404, { error: 'Not found' });
    if (bcSession.user_id !== currentSession.id && !currentSession.permissions.isSupervisor) {
      return sendJSON(res, 403, { error: 'Access denied' });
    }
    return sendJSON(res, 200, {
      status: bcSession.status,
      chunkCount: bcSession.chunk_count,
      durationSeconds: bcSession.duration_seconds,
      error: bcSession.error || null
    });
  }

  // API: GET /api/bodycam/:id/chunks?since=N (Supervisor+ or self - near-live viewer polling)
  if (pathname.startsWith('/api/bodycam/') && pathname.endsWith('/chunks') && req.method === 'GET') {
    if (!currentSession) return sendJSON(res, 401, { error: 'Unauthorized' });
    const bodycamId = pathname.split('/')[3];
    const db = getBotDb();
    const bcSession = db && db.prepare('SELECT * FROM bodycam_sessions WHERE id = ?').get(bodycamId);
    if (!bcSession) return sendJSON(res, 404, { error: 'Not found' });
    if (bcSession.user_id !== currentSession.id && !currentSession.permissions.isSupervisor) {
      return sendJSON(res, 403, { error: 'Access denied' });
    }
    const since = parseInt(parsedUrl.query.since, 10);
    const sinceIndex = Number.isNaN(since) ? -1 : since;
    const isFirstPoll = sinceIndex === -1;
    try {
      const keys = await r2.listObjects(`bodycam/${bodycamId}/chunk-`);
      let withIndex = keys
        .map(k => ({ key: k, index: parseInt((k.match(/chunk-(\d+)\.webm$/) || [])[1] || '-1', 10) }))
        .filter(k => k.index > sinceIndex)
        .sort((a, b) => a.index - b.index);
      // Joining an already-running shift only needs the latest segment (the
      // client immediately discards everything else anyway - see
      // pollBodycamLiveFirst in employee-dashboard.html) - presigning every
      // chunk recorded so far did real, unnecessary work and shipped a
      // growing payload the longer a shift had been running before someone
      // opened the viewer.
      if (isFirstPoll && withIndex.length > 0) {
        withIndex = [withIndex[withIndex.length - 1]];
      }
      const chunks = await Promise.all(withIndex.map(async k => ({
        index: k.index,
        url: await r2.presignedGetUrl(k.key, 300)
      })));
      return sendJSON(res, 200, { chunks, status: bcSession.status });
    } catch (e) {
      console.error('[BODYCAM CHUNKS LIST ERROR]', e.message);
      return sendJSON(res, 500, { error: 'Failed to list chunks' });
    }
  }

  // API: GET /api/bodycam/:id/playback (Supervisor+ or self - finished
  // recording) - the archive lives entirely on Discord now, so this just
  // builds message links from data already in bot.db (channel id, per-part
  // message ids, the stored shift number) with no Discord API call needed.
  // Watching or trimming both happen in Discord itself from here.
  if (pathname.startsWith('/api/bodycam/') && pathname.endsWith('/playback') && req.method === 'GET') {
    if (!currentSession) return sendJSON(res, 401, { error: 'Unauthorized' });
    const bodycamId = pathname.split('/')[3];
    const db = getBotDb();
    const bcSession = db && db.prepare('SELECT * FROM bodycam_sessions WHERE id = ?').get(bodycamId);
    if (!bcSession) return sendJSON(res, 404, { error: 'Not found' });
    if (bcSession.user_id !== currentSession.id && !currentSession.permissions.isSupervisor) {
      return sendJSON(res, 403, { error: 'Access denied' });
    }
    if (bcSession.status !== 'ready') return sendJSON(res, 409, { error: `Recording is ${bcSession.status}, not ready yet.` });
    if (!bcSession.discord_channel_id || !bcSession.discord_message_ids) {
      return sendJSON(res, 404, { error: 'This recording has no video log on file.' });
    }
    const videoMessages = JSON.parse(bcSession.discord_message_ids).filter(m => m.type === 'video');
    if (videoMessages.length === 0) return sendJSON(res, 404, { error: 'Video is no longer available on Discord.' });
    const parts = videoMessages.map(m => ({
      part: m.part,
      total: m.total,
      messageLink: `https://discord.com/channels/${VIDEO_LOG_GUILD_ID}/${bcSession.discord_channel_id}/${m.id}`
    }));
    return sendJSON(res, 200, { shiftNumber: bcSession.shift_number, parts, durationSeconds: bcSession.duration_seconds });
  }

  // API: POST /api/bodycam/:id/tags (session owner or Supervisor+ - clip tagging)
  if (pathname.startsWith('/api/bodycam/') && pathname.endsWith('/tags') && req.method === 'POST') {
    if (!currentSession) return sendJSON(res, 401, { error: 'Unauthorized' });
    const bodycamId = pathname.split('/')[3];
    const db = getBotDb();
    const bcSession = db && db.prepare('SELECT * FROM bodycam_sessions WHERE id = ?').get(bodycamId);
    if (!bcSession) return sendJSON(res, 404, { error: 'Not found' });
    if (bcSession.user_id !== currentSession.id && !currentSession.permissions.isSupervisor) {
      return sendJSON(res, 403, { error: 'Access denied' });
    }
    const body = await parseBody(req);
    const tags = Array.isArray(body.tags) ? body.tags : [];
    if (tags.some(t => !BODYCAM_TAGS.includes(t))) {
      return sendJSON(res, 400, { error: 'Invalid tag. Valid tags: ' + BODYCAM_TAGS.join(', ') });
    }
    db.prepare('UPDATE bodycam_sessions SET tags = ? WHERE id = ?').run(JSON.stringify(tags), bodycamId);
    return sendJSON(res, 200, { success: true, tags });
  }

  // API: GET /api/admin/bodycam/review-queue (Supervisor+ - clips awaiting
  // or flagged for review, most recent first)
  if (pathname === '/api/admin/bodycam/review-queue' && req.method === 'GET') {
    if (!currentSession || !currentSession.permissions.isSupervisor) {
      return sendJSON(res, 403, { error: 'Access Denied: Supervisor rank required.' });
    }
    const db = getBotDb();
    if (!db) return sendJSON(res, 500, { error: 'Database unavailable' });
    const rows = db.prepare(`
      SELECT b.*, COALESCE(s.roblox_username, b.user_id) AS roblox_username
      FROM bodycam_sessions b
      LEFT JOIN staff_members s ON s.user_id = b.user_id
      WHERE b.status = 'ready' AND b.review_status IN ('unreviewed', 'flagged')
      ORDER BY b.started_at DESC
      LIMIT 100
    `).all();
    return sendJSON(res, 200, {
      queue: rows.map(r => ({
        id: r.id,
        userId: r.user_id,
        robloxUsername: r.roblox_username,
        startedAt: r.started_at,
        durationSeconds: r.duration_seconds,
        durationFormatted: formatDuration(r.duration_seconds || 0),
        reviewStatus: r.review_status || 'unreviewed',
        tags: r.tags ? JSON.parse(r.tags) : [],
        wasAuditSelected: !!r.audit_selected_at,
        discordLink: r.discord_channel_id ? `https://discord.com/channels/${VIDEO_LOG_GUILD_ID}/${r.discord_channel_id}` : null
      }))
    });
  }

  // API: POST /api/bodycam/:id/review (Supervisor+ - flag for review or mark reviewed)
  if (pathname.startsWith('/api/bodycam/') && pathname.endsWith('/review') && req.method === 'POST') {
    if (!currentSession || !currentSession.permissions.isSupervisor) {
      return sendJSON(res, 403, { error: 'Access Denied: Supervisor rank required.' });
    }
    const bodycamId = pathname.split('/')[3];
    const db = getBotDb();
    const bcSession = db && db.prepare('SELECT * FROM bodycam_sessions WHERE id = ?').get(bodycamId);
    if (!bcSession) return sendJSON(res, 404, { error: 'Not found' });
    const body = await parseBody(req);
    if (body.action === 'flag') {
      db.prepare("UPDATE bodycam_sessions SET review_status = 'flagged' WHERE id = ?").run(bodycamId);
    } else if (body.action === 'mark-reviewed') {
      db.prepare("UPDATE bodycam_sessions SET review_status = 'reviewed', reviewed_by = ?, reviewed_at = ? WHERE id = ?")
        .run(currentSession.displayName || currentSession.username, Date.now(), bodycamId);
    } else {
      return sendJSON(res, 400, { error: "action must be 'flag' or 'mark-reviewed'." });
    }
    return sendJSON(res, 200, { success: true });
  }

  // API: GET /api/admin/bodycam/search (Supervisor+ - cross-officer shift
  // log search by date/tag/officer, optional filters combine with AND)
  if (pathname === '/api/admin/bodycam/search' && req.method === 'GET') {
    if (!currentSession || !currentSession.permissions.isSupervisor) {
      return sendJSON(res, 403, { error: 'Access Denied: Supervisor rank required.' });
    }
    const db = getBotDb();
    if (!db) return sendJSON(res, 500, { error: 'Database unavailable' });
    const { date, tag, userId } = parsedUrl.query;
    const clauses = [];
    const params = [];
    if (date) { clauses.push("date(b.started_at / 1000, 'unixepoch') = ?"); params.push(date); }
    if (tag) { clauses.push('b.tags LIKE ?'); params.push('%' + tag + '%'); }
    if (userId) { clauses.push('b.user_id = ?'); params.push(userId); }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    const rows = db.prepare(`
      SELECT b.*, COALESCE(s.roblox_username, b.user_id) AS roblox_username
      FROM bodycam_sessions b
      LEFT JOIN staff_members s ON s.user_id = b.user_id
      ${where}
      ORDER BY b.started_at DESC
      LIMIT 200
    `).all(...params);
    return sendJSON(res, 200, {
      results: rows.map(r => ({
        id: r.id,
        userId: r.user_id,
        robloxUsername: r.roblox_username,
        startedAt: r.started_at,
        status: r.status,
        durationFormatted: formatDuration(r.duration_seconds || 0),
        reviewStatus: r.review_status || 'unreviewed',
        tags: r.tags ? JSON.parse(r.tags) : [],
        discordLink: r.discord_channel_id ? `https://discord.com/channels/${VIDEO_LOG_GUILD_ID}/${r.discord_channel_id}` : null
      }))
    });
  }

  // API: POST /api/admin/bodycam/audit-randomizer/run (Supervisor+ - picks
  // AUDIT_RANDOMIZER_COUNT random 'ready' recordings not already selected
  // this week and flags them for mandatory review, same runs weekly on
  // a schedule via runBodycamAuditRandomizer() below)
  if (pathname === '/api/admin/bodycam/audit-randomizer/run' && req.method === 'POST') {
    if (!currentSession || !currentSession.permissions.isSupervisor) {
      return sendJSON(res, 403, { error: 'Access Denied: Supervisor rank required.' });
    }
    const selected = runBodycamAuditRandomizer();
    return sendJSON(res, 200, { success: true, selected });
  }

  // API: GET /api/admin/bodycam/audit-randomizer/history (Supervisor+)
  if (pathname === '/api/admin/bodycam/audit-randomizer/history' && req.method === 'GET') {
    if (!currentSession || !currentSession.permissions.isSupervisor) {
      return sendJSON(res, 403, { error: 'Access Denied: Supervisor rank required.' });
    }
    const db = getBotDb();
    if (!db) return sendJSON(res, 500, { error: 'Database unavailable' });
    const rows = db.prepare(`
      SELECT b.*, COALESCE(s.roblox_username, b.user_id) AS roblox_username
      FROM bodycam_sessions b
      LEFT JOIN staff_members s ON s.user_id = b.user_id
      WHERE b.audit_selected_at IS NOT NULL
      ORDER BY b.audit_selected_at DESC
      LIMIT 50
    `).all();
    return sendJSON(res, 200, {
      history: rows.map(r => ({
        id: r.id,
        robloxUsername: r.roblox_username,
        auditSelectedAt: r.audit_selected_at,
        reviewStatus: r.review_status || 'unreviewed'
      }))
    });
  }

  // API: GET /api/officer/:userId/shifts (Supervisor+ or self - shift history + bodycam refs)
  if (pathname.startsWith('/api/officer/') && pathname.endsWith('/shifts') && req.method === 'GET') {
    if (!currentSession || !currentSession.permissions.isOfficer) return sendJSON(res, 401, { error: 'Unauthorized' });
    const targetUserId = pathname.split('/')[3];
    if (targetUserId !== currentSession.id && !currentSession.permissions.isSupervisor) {
      return sendJSON(res, 403, { error: 'Access denied' });
    }
    const db = getBotDb();
    if (!db) return sendJSON(res, 500, { error: 'Database unavailable' });
    const shifts = db.prepare('SELECT * FROM shift_history WHERE user_id = ? ORDER BY start_time DESC LIMIT 200').all(targetUserId);
    const bodycamIds = shifts.map(s => s.bodycam_id).filter(Boolean);
    const bodycamMap = {};
    if (bodycamIds.length) {
      const placeholders = bodycamIds.map(() => '?').join(',');
      db.prepare(`SELECT * FROM bodycam_sessions WHERE id IN (${placeholders})`).all(...bodycamIds).forEach(b => { bodycamMap[b.id] = b; });
    }
    return sendJSON(res, 200, {
      shifts: shifts.map(s => ({
        id: s.id,
        startTime: s.start_time,
        endTime: s.end_time,
        durationSeconds: s.duration_seconds,
        durationFormatted: formatDuration(s.duration_seconds),
        weekKey: s.week_key,
        bodycam: s.bodycam_id ? {
          id: s.bodycam_id,
          status: bodycamMap[s.bodycam_id]?.status || 'expired',
          tags: bodycamMap[s.bodycam_id]?.tags ? JSON.parse(bodycamMap[s.bodycam_id].tags) : []
        } : null
      }))
    });
  }

  // 16. Protected Employee Dashboard Route
  if (pathname === '/employee/dashboard') {
    if (!currentSession || !currentSession.permissions.isOfficer) {
      // No session at all -> plain login prompt. Has a session but lost (or
      // never had) staff access -> the same "required role" message as a
      // failed employee sign-in, since from their side it's the same thing:
      // they tried to reach the dashboard and can't.
      const dest = currentSession ? '/employee?error=unauthorized_role' : '/employee';
      res.writeHead(302, { 'Location': dest, ...SECURITY_HEADERS });
      return res.end();
    }
    const filePath = path.join(VIEWS_DIR, 'employee-dashboard.html');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
        return res.end('500 Server Error');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
      res.end(data);
    });
    return;
  }

  // API Docs page (Command Only - documents internal admin routes too, so
  // gated tighter than the dashboard itself)
  if (pathname === '/employee/api-docs') {
    if (!currentSession || !currentSession.permissions.isCommand) {
      const dest = currentSession ? '/employee?error=unauthorized_role' : '/employee';
      res.writeHead(302, { 'Location': dest, ...SECURITY_HEADERS });
      return res.end();
    }
    const filePath = path.join(VIEWS_DIR, 'api-docs.html');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
        return res.end('500 Server Error');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
      res.end(data);
    });
    return;
  }

  // 17. Static Page Views
  // Auto-redirect to dashboard if already authenticated as staff
  if (pathname === '/employee' && currentSession && currentSession.permissions.isOfficer) {
    res.writeHead(302, { 'Location': '/employee/dashboard', ...SECURITY_HEADERS });
    return res.end();
  }

  // News article permalink: /news/NEWS-1234 - the page itself is a static
  // shell (news-article.html) that fetches /api/news/:id client-side, same
  // pattern as every other view in this app.
  if (pathname.startsWith('/news/') && pathname.length > '/news/'.length) {
    serveViewFile(res, 'news-article.html');
    return;
  }

  if (ROUTE_VIEWS[pathname]) {
    const filePath = path.join(VIEWS_DIR, ROUTE_VIEWS[pathname]);
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
        return res.end('500 Server Error');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
      res.end(data);
    });
    return;
  }

  // 18. Static Public Assets
  const publicPath = path.resolve(PUBLIC_DIR, '.' + pathname);
  const isInsidePublicDir = publicPath === PUBLIC_DIR || publicPath.startsWith(PUBLIC_DIR + path.sep);
  if (isInsidePublicDir && fs.existsSync(publicPath) && fs.statSync(publicPath).isFile()) {
    const ext = path.extname(publicPath);
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    fs.readFile(publicPath, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
        return res.end('500 Server Error');
      }
      res.writeHead(200, { 'Content-Type': mime, ...SECURITY_HEADERS });
      res.end(data);
    });
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
  res.end('<h1>404 Not Found</h1><p><a href="/">Return to Home</a></p>');
  } catch (err) {
    if (err.message === 'PAYLOAD_TOO_LARGE' || err.code === 'PAYLOAD_TOO_LARGE') {
      res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
      return res.end(JSON.stringify({ error: 'Payload Too Large: Maximum allowed size is 64KB.' }));
    }
    logger.error('[UNHANDLED SERVER ERROR] ' + (err && err.stack || err));
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[WESTPOINT PORTAL] Live at http://localhost:${PORT}`);
  console.log(`[WESTPOINT PORTAL] Operational Hub & Discord Bot Integration Active`);
});
