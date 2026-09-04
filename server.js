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
const DEPT_LOGS_CHANNEL_ID = process.env.DEPARTMENT_LOGS_CHANNEL_ID || '1542980017472929944';
const AUDIT_LOGS_CHANNEL_ID = process.env.AUDIT_LOGS_CHANNEL_ID || '1540024507761164348';
// Bodycam video logs post to a *different* server than the main guild (per-
// officer channels get created under this one, next to the "video logs"
// channel/category originally given).
const VIDEO_LOG_GUILD_ID = process.env.VIDEO_LOG_GUILD_ID || '1540023207082463272';
const VIDEO_LOG_PARENT_ID = process.env.VIDEO_LOG_PARENT_ID || '1545537864677331105';

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
      isInternalAffairs: !!cfg.isInternalAffairs || !!cfg.isCommand
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

  return {
    permissions: { isOfficer, isSupervisor, isCommand, isInternalAffairs, tier, tierLabel },
    roles: roleNames,
    highestRank: roleNames[0] || null
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
  '/site-map': 'site-map.html'
};

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
      botDbInstance.exec('ALTER TABLE shift_history ADD COLUMN shift_number INTEGER');
    } catch (e) {}
    return botDbInstance;
  } catch (e) {
    console.error('[DATABASE CONNECT ERROR]', e.message);
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
        const { permissions, roles, highestRank } = computePermissionsFromDiscordRoles(memRes.member.roles || []);
        session.roles = roles;
        session.highestRank = highestRank;
        session.permissions = permissions;
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

// Splits a merged shift video if needed and posts the "SHIFT LOG #N"
// splitter / video(s) with embed+Trim button / closer sequence to the
// officer's Discord channel. Shared by the live finalize path below and the
// one-off R2->Discord backfill (migrateR2BodycamToDiscordAndReset) - the
// only difference between those two callers is how shiftNumber gets
// computed, since a bulk backfill can't just count already-'ready' rows the
// way the live one-at-a-time path does (some of those rows might be other
// not-yet-backfilled sessions from the same week). Returns { channelId,
// messageIds }; leaves mergedPath itself alone but cleans up any split parts.
async function postShiftVideoToDiscord(db, bcSession, mergedPath, durationSeconds, shiftNumber) {
  const partPaths = await video.splitBySize(mergedPath, videoLog.DISCORD_FILE_LIMIT_BYTES, durationSeconds);
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
        [{ path: partPaths[i], name: `shift-${shiftNumber}${partPaths.length > 1 ? `-part${i + 1}` : ''}.webm` }]
      );
      messageIds.push({ id: msg.id, type: 'video', part: i + 1, total: partPaths.length });
    }

    const closer = await videoLog.postMessage(DISCORD_BOT_TOKEN, channelId, {
      content: `**═══════ END SHIFT LOG #${shiftNumber} ═══════**`
    });
    messageIds.push({ id: closer.id, type: 'splitter' });
  } finally {
    partPaths.forEach(p => { if (p !== mergedPath) { try { fs.unlinkSync(p); } catch (e) {} } });
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
      SET status = 'ready', duration_seconds = ?, discord_channel_id = ?, discord_message_ids = ?
      WHERE id = ?
    `).run(durationSeconds || 0, channelId, JSON.stringify(messageIds), bodycamId);
  } finally {
    localChunkPaths.forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });
    if (mergedPath) { try { fs.unlinkSync(mergedPath); } catch (e) {} }
  }
}

// One-off backfill: everything still sitting in R2 from before the
// Discord-native archive existed gets posted to its officer's channel, then
// deleted from R2 once that post is confirmed. Never deletes a session's R2
// data unless it either posted successfully or has no matching
// bodycam_sessions row at all (nothing to attribute it to). Triggered by
// POST /api/admin/migrate-bodycam-to-discord; progress/results live in
// bodycamMigrationState for the companion GET .../status endpoint to read.
let bodycamMigrationState = { status: 'idle', log: [], startedAt: null, finishedAt: null, result: null };

async function migrateR2BodycamToDiscordAndReset() {
  const log = (msg) => {
    bodycamMigrationState.log.push({ t: Date.now(), msg });
    console.log('[BODYCAM MIGRATION]', msg);
  };
  bodycamMigrationState = { status: 'running', log: [], startedAt: Date.now(), finishedAt: null, result: null };

  const db = getBotDb();
  if (!db) throw new Error('Database unavailable');
  if (!r2.isConfigured()) throw new Error('R2 is not configured');

  const allObjects = await r2.listObjectsWithSize('bodycam/');
  const byId = {};
  for (const obj of allObjects) {
    const m = obj.key.match(/^bodycam\/([^/]+)\//);
    if (!m) continue;
    const id = m[1];
    byId[id] = byId[id] || { keys: [], hasFinal: false, chunkKeys: [] };
    byId[id].keys.push(obj.key);
    if (/\/final\.webm$/.test(obj.key)) byId[id].hasFinal = true;
    if (/\/chunk-\d+\.webm$/.test(obj.key)) byId[id].chunkKeys.push(obj.key);
  }
  log(`Found ${Object.keys(byId).length} bodycam id(s) in R2 across ${allObjects.length} object(s).`);

  const attributable = [];
  const orphaned = [];
  for (const [id, info] of Object.entries(byId)) {
    const bcSession = db.prepare('SELECT * FROM bodycam_sessions WHERE id = ?').get(id);
    if (bcSession) attributable.push({ id, info, bcSession });
    else orphaned.push({ id, info });
  }
  attributable.sort((a, b) => a.bcSession.started_at - b.bcSession.started_at);
  log(`${attributable.length} session(s) matched a database record; ${orphaned.length} orphaned (no matching record).`);

  const migrated = [];
  const failed = [];
  const seedCounts = {};

  for (const { id, info, bcSession } of attributable) {
    try {
      log(`Processing ${id} (user ${bcSession.user_id}, week ${bcSession.week_key})...`);
      const localPaths = [];
      let mergedPath;
      let durationSeconds = bcSession.duration_seconds;

      if (info.hasFinal) {
        const { stream } = await r2.getObjectStream(`bodycam/${id}/final.webm`);
        mergedPath = video.tempPath('webm');
        localPaths.push(mergedPath);
        await new Promise((resolve, reject) => {
          const out = fs.createWriteStream(mergedPath);
          stream.pipe(out);
          stream.on('error', reject);
          out.on('finish', resolve);
          out.on('error', reject);
        });
        if (!durationSeconds) {
          // No chunk count on record for a pre-existing final.webm - fall
          // back to an estimate from the file's size at the app's standard
          // bitrate rather than leaving it at 0.
          durationSeconds = Math.round(fs.statSync(mergedPath).size / (300000 / 8));
        }
      } else {
        const sortedChunkKeys = info.chunkKeys.slice().sort();
        const chunkPaths = await Promise.all(sortedChunkKeys.map(async key => {
          const { stream } = await r2.getObjectStream(key);
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
        localPaths.push(...chunkPaths);
        const merged = await video.mergeChunksToWebm(chunkPaths);
        mergedPath = merged.path;
        localPaths.push(mergedPath);
        if (!durationSeconds) durationSeconds = sortedChunkKeys.length * (BODYCAM_SEGMENT_MS / 1000);
      }

      const seedKey = `${bcSession.user_id}:${bcSession.week_key}`;
      if (!(seedKey in seedCounts)) {
        const row = db.prepare("SELECT COUNT(*) AS c FROM bodycam_sessions WHERE user_id = ? AND week_key = ? AND status = 'ready' AND discord_channel_id IS NOT NULL").get(bcSession.user_id, bcSession.week_key);
        seedCounts[seedKey] = row?.c || 0;
      }
      const shiftNumber = ++seedCounts[seedKey];

      const { channelId, messageIds } = await postShiftVideoToDiscord(db, bcSession, mergedPath, durationSeconds, shiftNumber);

      db.prepare(`
        UPDATE bodycam_sessions
        SET status = 'ready', duration_seconds = ?, discord_channel_id = ?, discord_message_ids = ?
        WHERE id = ?
      `).run(durationSeconds || 0, channelId, JSON.stringify(messageIds), id);

      localPaths.forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });

      await r2.deleteObjects(info.keys);
      log(`  -> posted as Shift Log #${shiftNumber} in <#${channelId}>, ${info.keys.length} R2 object(s) freed.`);
      migrated.push({ id, userId: bcSession.user_id, channelId, shiftNumber, objectsDeleted: info.keys.length });
    } catch (e) {
      console.error('[BODYCAM MIGRATION ERROR]', id, e);
      log(`  -> FAILED: ${e.message} - leaving its R2 data in place for retry.`);
      failed.push({ id, error: e.message });
    }
  }

  let orphanedDeleted = 0;
  for (const { id, info } of orphaned) {
    try {
      await r2.deleteObjects(info.keys);
      orphanedDeleted += info.keys.length;
      log(`Deleted orphaned R2 data for ${id} (${info.keys.length} object(s)) - no database record, could not attribute to an officer.`);
    } catch (e) {
      log(`Failed to delete orphaned data for ${id}: ${e.message}`);
    }
  }

  await refreshBodycamStorageTotal();
  log(`Done. Migrated ${migrated.length}, failed ${failed.length}, orphaned-and-deleted ${orphaned.length} (${orphanedDeleted} objects). Remaining R2 usage: ${(bodycamStorageBytes / 1024 / 1024).toFixed(2)}MB.`);

  bodycamMigrationState.status = 'done';
  bodycamMigrationState.finishedAt = Date.now();
  bodycamMigrationState.result = { migrated, failed, orphaned: orphaned.map(o => o.id), orphanedObjectsDeleted: orphanedDeleted, remainingBytes: bodycamStorageBytes };
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
                  const { permissions: perms, roles: matchingRanks, highestRank } =
                    computePermissionsFromDiscordRoles(member ? (member.roles || []) : []);
                  // Cryptographically strong 256-bit entropy session token
                  const newSessionId = 'WP-' + crypto.randomBytes(32).toString('hex');
                  SESSIONS.set(newSessionId, {
                    id: userObj.id,
                    username: userObj.username,
                    displayName: (member && member.nick) || userObj.global_name || userObj.username,
                    avatar: userObj.avatar ? `https://cdn.discordapp.com/avatars/${userObj.id}/${userObj.avatar}.png` : '/assets/logo.png',
                    roles: matchingRanks,
                    highestRank: highestRank,
                    permissions: perms,
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
                 COALESCE(s.roblox_username, sh.roblox_username) AS roblox_username
          FROM (SELECT DISTINCT user_id, roblox_username FROM shift_history WHERE week_key = ?) sh
          LEFT JOIN weekly_totals wt ON wt.user_id = sh.user_id AND wt.week_key = ?
          LEFT JOIN staff_members s ON s.user_id = sh.user_id
          ORDER BY total_seconds DESC
          LIMIT 12
        `).all(weekKey, weekKey);

        topWeekly.forEach(row => {
          leaderboard.push({
            userId: row.user_id,
            robloxUsername: row.roblox_username || 'Officer',
            totalSeconds: row.total_seconds,
            totalFormatted: formatDuration(row.total_seconds)
          });
        });
      } catch (dbErr) {
        console.error('[ROSTER DB ERROR]', dbErr.message);
      }
    }

    return sendJSON(res, 200, {
      activeSessions,
      weeklyQuotaLeaderboard: leaderboard,
      totalActiveOfficers: activeSessions.length,
      weekKey: getWeekKey()
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
    const body = await parseBody(req);
    const incident = {
      id: 'INC-' + Math.floor(100000 + Math.random() * 900000),
      officer: currentSession.displayName,
      officerId: currentSession.id,
      rank: currentSession.highestRank || 'Security Officer',
      location: body.location || 'Harrison County',
      suspect: body.suspect || 'N/A',
      action: body.action || 'Standard Patrol Action',
      summary: body.summary || '',
      timestamp: new Date().toISOString()
    };

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
    const body = await parseBody(req);
    const rawReport = String(body.report || '').trim();
    if (!rawReport) {
      return sendJSON(res, 400, { error: 'Please provide statement details.' });
    }

    const report = {
      id: 'DESK-' + Math.floor(100000 + Math.random() * 900000),
      type: body.type === 'Commendation' ? 'Commendation' : 'Misconduct',
      citizen: String(currentSession.displayName || currentSession.username).slice(0, 100),
      reporterId: String(currentSession.id).slice(0, 32),
      officer: String(body.officer || 'Unspecified').trim().slice(0, 100),
      location: String(body.location || 'Harrison County').trim().slice(0, 150),
      report: rawReport.slice(0, 4000),
      status: 'New',
      assignedIA: null,
      findings: '',
      timestamp: new Date().toISOString()
    };

    const reports = readJSONFile('reports.json', []);
    reports.unshift(report);
    if (reports.length > 500) reports.length = 500;
    writeJSONFile('reports.json', reports);
    return sendJSON(res, 200, { success: true, record: report });
  }

  // 8B. API: POST /api/contact/staff (Reach Out to Staff Form)
  if (pathname === '/api/contact/staff' && req.method === 'POST') {
    if (!currentSession) {
      return sendJSON(res, 401, {
        error: 'Authentication Required: You must be signed in with Discord to send a message to staff.'
      });
    }
    const body = await parseBody(req);
    const senderName = String(body.senderName || 'Anonymous Citizen').trim().slice(0, 100);
    const contactHandle = String(body.contactHandle || 'Unspecified').trim().slice(0, 100);
    const category = String(body.category || 'General Staff Inquiry').trim().slice(0, 100);
    const message = String(body.message || '').trim().slice(0, 2500);

    if (!message) {
      return sendJSON(res, 400, { error: 'Please provide a message description.' });
    }

    const contactEntry = {
      id: 'MSG-' + Math.floor(100000 + Math.random() * 900000),
      senderName,
      contactHandle,
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
      const discordEmbed = {
        title: `Citizen Inquiry: ${category}`,
        color: 0x3498DB,
        description: `**From:** ${senderName} (\`${contactHandle}\`)\n**Topic:** ${category}\n\n**Message:**\n> ${message.replace(/>/g, '\\>')}`,
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

    target.status = body.status || target.status;
    target.findings = body.findings !== undefined ? body.findings : target.findings;
    target.assignedIA = currentSession.displayName;
    target.updatedAt = new Date().toISOString();

    writeJSONFile('reports.json', reports);
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
        console.error('[ACTION STATE DB ERROR]', e.message);
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

  // 13. API: GET /api/news (Public News List)
  if (pathname === '/api/news' && req.method === 'GET') {
    const news = readJSONFile('news.json', []);
    return sendJSON(res, 200, { news });
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
      summary: String(body.summary || '').trim().slice(0, 2000)
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

  // API: POST /api/admin/reset-quota-logs (Command Only - wipe weekly quota
  // totals and shift history for a clean slate. Does not touch active
  // sessions, the staff roster, or bodycam video logs on Discord - those
  // clear on their own normal weekly schedule.)
  if (pathname === '/api/admin/reset-quota-logs' && req.method === 'POST') {
    if (!currentSession || !currentSession.permissions.isCommand) {
      return sendJSON(res, 403, { error: 'Access Denied: High Command rank required.' });
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

  // API: POST /api/admin/migrate-bodycam-to-discord (Command Only - one-time
  // backfill for videos that were archived to R2 before the Discord-native
  // video log existed: posts each one to its officer's channel, then wipes
  // it from R2 once posted. Runs in the background - some of these files are
  // hundreds of MB, so this responds immediately and the companion GET
  // below reports progress/results.)
  if (pathname === '/api/admin/migrate-bodycam-to-discord' && req.method === 'POST') {
    if (!currentSession || !currentSession.permissions.isCommand) {
      return sendJSON(res, 403, { error: 'Access Denied: High Command rank required.' });
    }
    if (bodycamMigrationState.status === 'running') {
      return sendJSON(res, 409, { error: 'A migration is already running - check status first.' });
    }
    migrateR2BodycamToDiscordAndReset().catch(err => {
      console.error('[BODYCAM MIGRATION ERROR]', err);
      bodycamMigrationState.status = 'failed';
      bodycamMigrationState.finishedAt = Date.now();
      bodycamMigrationState.log.push({ t: Date.now(), msg: 'Fatal error: ' + err.message });
    });
    return sendJSON(res, 200, { started: true });
  }

  // API: GET /api/admin/migrate-bodycam-to-discord/status (Command Only)
  if (pathname === '/api/admin/migrate-bodycam-to-discord/status' && req.method === 'GET') {
    if (!currentSession || !currentSession.permissions.isCommand) {
      return sendJSON(res, 403, { error: 'Access Denied: High Command rank required.' });
    }
    return sendJSON(res, 200, bodycamMigrationState);
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
          isInternalAffairs: !!c.isInternalAffairs
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
        isInternalAffairs: !!r.isInternalAffairs
      };
    });
    writeJSONFile('role-permissions.json', config);
    roleConfigCache = config;
    roleConfigUpdatedAt = Date.now();
    return sendJSON(res, 200, { success: true, roleCount: Object.keys(config).length });
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
        console.error('[DUTY STATUS DB ERROR]', e.message);
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
        INSERT INTO staff_members (user_id, roblox_id, roblox_username, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          roblox_id = COALESCE(excluded.roblox_id, staff_members.roblox_id),
          roblox_username = COALESCE(excluded.roblox_username, staff_members.roblox_username),
          updated_at = excluded.updated_at
      `).run(currentSession.id, String(verification.robloxId), verification.robloxUsername, startTime);

      db.prepare(`
        INSERT INTO active_sessions (user_id, roblox_id, roblox_username, start_time)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          roblox_id = excluded.roblox_id,
          roblox_username = excluded.roblox_username,
          start_time = excluded.start_time
      `).run(currentSession.id, String(verification.robloxId), verification.robloxUsername, startTime);
    } catch (e) {
      console.error('[DUTY START DB ERROR]', e.message);
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

  // API: GET /api/bodycam/:id/playback (Supervisor+ or self - finished recording)
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
    try {
      // Video lives on Discord now, not R2 - message attachment URLs carry a
      // signature that expires, so re-fetch the message fresh on every
      // playback request rather than caching the URL.
      const videoMessages = JSON.parse(bcSession.discord_message_ids).filter(m => m.type === 'video');
      const parts = await Promise.all(videoMessages.map(async (m) => {
        try {
          const msg = await videoLog.fetchMessage(DISCORD_BOT_TOKEN, bcSession.discord_channel_id, m.id);
          const attachment = msg.attachments && msg.attachments[0];
          return attachment ? { part: m.part, total: m.total, url: attachment.url, filename: attachment.filename } : null;
        } catch (e) {
          return null;
        }
      }));
      const validParts = parts.filter(Boolean);
      if (validParts.length === 0) return sendJSON(res, 404, { error: 'Video is no longer available on Discord.' });
      return sendJSON(res, 200, { parts: validParts, durationSeconds: bcSession.duration_seconds });
    } catch (e) {
      console.error('[BODYCAM PLAYBACK ERROR]', e.message);
      return sendJSON(res, 500, { error: 'Failed to fetch recording from Discord.' });
    }
  }

  // API: POST /api/bodycam/:id/trim (Supervisor+ or self) - trims one part
  // (trimBody.part, 1-based) of a shift's video and streams the result back
  // directly as an MP4 download. Not re-uploaded anywhere - it's a one-off
  // export for whoever requested it, not a persistent artifact.
  if (pathname.startsWith('/api/bodycam/') && pathname.endsWith('/trim') && req.method === 'POST') {
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

    const trimBody = await parseBody(req);
    const startSeconds = Math.max(0, Number(trimBody.startSeconds) || 0);
    const endSeconds = Math.max(startSeconds + 1, Number(trimBody.endSeconds) || startSeconds + 1);
    const partNumber = Math.max(1, parseInt(trimBody.part, 10) || 1);

    let localSource, localTrim;
    try {
      const videoMessages = JSON.parse(bcSession.discord_message_ids).filter(m => m.type === 'video');
      const target = videoMessages.find(m => m.part === partNumber) || videoMessages[0];
      if (!target) return sendJSON(res, 404, { error: 'No video part found to trim.' });
      const msg = await videoLog.fetchMessage(DISCORD_BOT_TOKEN, bcSession.discord_channel_id, target.id);
      const attachment = msg.attachments && msg.attachments[0];
      if (!attachment) return sendJSON(res, 404, { error: 'Video attachment is no longer available on Discord.' });

      localSource = video.tempPath('webm');
      await video.downloadToFile(attachment.url, localSource);

      // This is the one path that does still transcode (to H.264 mp4, for
      // broad download compatibility) - on demand, only when someone's
      // actively waiting on a specific clip, unlike the merge step above.
      localTrim = await video.trimToMp4(localSource, startSeconds, endSeconds);
      const stat = fs.statSync(localTrim);
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="bodycam-${bodycamId}-part${partNumber}-clip.mp4"`,
        ...SECURITY_HEADERS
      });
      await new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(localTrim);
        readStream.pipe(res);
        readStream.on('end', resolve);
        readStream.on('error', reject);
        res.on('close', resolve);
      });
      return;
    } catch (e) {
      console.error('[BODYCAM TRIM ERROR]', e.message);
      if (!res.headersSent) return sendJSON(res, 500, { error: 'Failed to trim recording' });
      return;
    } finally {
      [localSource, localTrim].forEach(p => { if (p) { try { fs.unlinkSync(p); } catch (e) {} } });
    }
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
        bodycam: s.bodycam_id ? { id: s.bodycam_id, status: bodycamMap[s.bodycam_id]?.status || 'expired' } : null
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

  // 17. Static Page Views
  // Auto-redirect to dashboard if already authenticated as staff
  if (pathname === '/employee' && currentSession && currentSession.permissions.isOfficer) {
    res.writeHead(302, { 'Location': '/employee/dashboard', ...SECURITY_HEADERS });
    return res.end();
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
    console.error('[UNHANDLED SERVER ERROR]', err);
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
