const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const querystring = require('querystring');
const crypto = require('crypto');

const BASE_DIR = __dirname;
const VIEWS_DIR = path.join(BASE_DIR, 'views');
const PUBLIC_DIR = path.join(BASE_DIR, 'public');
const DATA_DIR = path.join(BASE_DIR, 'data');
const robloxService = require('C:/Users/Nolan/Documents/antigravity/resilient-meitner/src/services/robloxService.js');
const BOT_DB_PATH = 'C:/Users/Nolan/Documents/antigravity/resilient-meitner/bot.db';

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
const REDIRECT_URI = `http://localhost:${PORT}/auth/discord/callback`;

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
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://discord.com https://cdn.discordapp.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://cdn.discordapp.com; font-src 'self'; connect-src 'self' https://discord.com https://*.roblox.com; frame-ancestors 'none';"
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

// Officer Ranks in Guild 1522793078199419022
const RANK_PRIORITY = [
  'Security Chief',
  'Security Deputy Chief',
  'Captain',
  'Lieutenant',
  'Sergeant',
  'Corporal',
  'Senior Security Officer',
  'Security Officer',
  'Probationary Security Officer',
  'Internal Affairs',
  'Command',
  'Supervisor',
  'Westpoint Security'
];

const OFFICER_ROLES = {
  '1522793591112466493': 'Security Chief',
  '1522793595315294248': 'Security Deputy Chief',
  '1522793598633119754': 'Captain',
  '1522793602449670204': 'Lieutenant',
  '1522793605683613877': 'Sergeant',
  '1522793608988721252': 'Corporal',
  '1522793612394627162': 'Senior Security Officer',
  '1522793615884161126': 'Security Officer',
  '1522793618908381286': 'Probationary Security Officer',
  '1522798272144605315': 'Command',
  '1522798280000405625': 'Supervisor',
  '1522798554580783124': 'Internal Affairs',
  '1544515568563126303': 'Westpoint Security'
};

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
  '/employee': 'employee.html',
  '/employee/dashboard': 'employee-dashboard.html',
  '/site-map': 'site-map.html'
};

// Database Connection Helper
let botDbInstance = null;
function getBotDb() {
  if (botDbInstance) return botDbInstance;
  try {
    const Database = require('C:/Users/Nolan/Documents/antigravity/resilient-meitner/node_modules/better-sqlite3');
    if (fs.existsSync(BOT_DB_PATH)) {
      botDbInstance = new Database(BOT_DB_PATH, { timeout: 5000 });
      return botDbInstance;
    }
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

function computePermissions(roles = []) {
  const isCommand = roles.some(r => ['Security Chief', 'Security Deputy Chief', 'Captain', 'Command'].includes(r));
  const isSupervisor = isCommand || roles.some(r => ['Lieutenant', 'Sergeant', 'Supervisor'].includes(r));
  const isIA = isCommand || roles.includes('Internal Affairs');
  const isOfficer = true;

  let tier = 1;
  let tierLabel = 'Field Officer';
  if (isCommand) {
    tier = 3;
    tierLabel = 'High Command';
  } else if (isSupervisor) {
    tier = 2;
    tierLabel = 'Field Supervisor';
  }

  return {
    isOfficer,
    isSupervisor,
    isCommand,
    isInternalAffairs: isIA,
    tier,
    tierLabel
  };
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

const server = http.createServer(async (req, res) => {
  try {
    // Extract client IP address (supporting reverse proxies like Railway/Cloudflare)
    const forwarded = req.headers['x-forwarded-for'];
    const clientIp = forwarded ? forwarded.split(',')[0].trim() : (req.socket.remoteAddress || '127.0.0.1');

    const parsedUrl = url.parse(req.url, true);
    let pathname = parsedUrl.pathname;

    // Rate Limiting Protection:
    // General routes: 120 req/min
    // Form/Auth sensitive routes: 10 req/min
    const isSensitive = ['/api/contact/staff', '/api/report', '/api/duty/start', '/auth/discord/callback'].includes(pathname);
    const limitRule = checkRateLimit(clientIp, isSensitive ? 10 : 120, 60000);
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

  // 1. DISCORD OAUTH2 REDIRECT
  if (pathname === '/auth/discord') {
    const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify`;
    res.writeHead(302, { 'Location': discordAuthUrl });
    return res.end();
  }

  // 2. DISCORD OAUTH2 CALLBACK
  if (pathname === '/auth/discord/callback') {
    const code = parsedUrl.query.code;
    if (!code) {
      res.writeHead(302, { 'Location': '/employee?error=no_code' });
      return res.end();
    }

    const tokenBody = querystring.stringify({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: REDIRECT_URI
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
                  if (memRes.success && memRes.member) {
                    const member = memRes.member;
                    const matchingRanks = (member.roles || []).map(r => OFFICER_ROLES[r]).filter(Boolean);

                    if (matchingRanks.length > 0) {
                      matchingRanks.sort((a, b) => {
                        const ia = RANK_PRIORITY.indexOf(a);
                        const ib = RANK_PRIORITY.indexOf(b);
                        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
                      });
                      const perms = computePermissions(matchingRanks);
                      // Cryptographically strong 256-bit entropy session token
                      const newSessionId = 'WP-' + crypto.randomBytes(32).toString('hex');
                      SESSIONS.set(newSessionId, {
                        id: userObj.id,
                        username: userObj.username,
                        displayName: member.nick || userObj.global_name || userObj.username,
                        avatar: userObj.avatar ? `https://cdn.discordapp.com/avatars/${userObj.id}/${userObj.avatar}.png` : '/assets/logo.png',
                        roles: matchingRanks,
                        highestRank: matchingRanks[0] || 'Security Officer',
                        permissions: perms,
                        loginTime: new Date().toISOString()
                      });
                      persistSessions();

                      const isHttps = (req.headers['x-forwarded-proto'] === 'https') || req.connection.encrypted;
                      res.writeHead(302, {
                        'Set-Cookie': `wp_session=${newSessionId}; Path=/; Max-Age=86400; SameSite=Lax; HttpOnly${isHttps ? '; Secure' : ''}`,
                        'Location': '/employee/dashboard',
                        ...SECURITY_HEADERS
                      });
                      return res.end();
                    }
                  }
                  res.writeHead(302, { 'Location': '/employee?error=unauthorized_role', ...SECURITY_HEADERS });
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
    if (!currentSession) return sendJSON(res, 401, { error: 'Unauthorized' });
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
            location: 'Harrison County'
          });
        });

        const weekKey = getWeekKey();
        const topWeekly = db.prepare(`
          SELECT w.user_id, w.total_seconds, s.roblox_username
          FROM weekly_totals w
          LEFT JOIN staff_members s ON w.user_id = s.user_id
          WHERE w.week_key = ?
          ORDER BY w.total_seconds DESC
          LIMIT 12
        `).all(weekKey);

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
    if (!currentSession) return sendJSON(res, 401, { error: 'Unauthorized' });
    const allIncidents = readJSONFile('incidents.json', []);
    const isSup = currentSession.permissions.isSupervisor;
    const filtered = isSup ? allIncidents : allIncidents.filter(inc => inc.officerId === currentSession.id);
    return sendJSON(res, 200, { incidents: filtered });
  }

  // 7. API: POST /api/officer/incident
  if (pathname === '/api/officer/incident' && req.method === 'POST') {
    if (!currentSession) return sendJSON(res, 401, { error: 'Unauthorized' });
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

    // Send notification embed to #administrative-log in Discord
    if (DISCORD_BOT_TOKEN) {
      const discordEmbed = {
        title: `Citizen Inquiry: ${category}`,
        color: 0x3498DB,
        description: `**From:** ${senderName} (\`${contactHandle}\`)\n**Topic:** ${category}\n\n**Message:**\n> ${message.replace(/>/g, '\\>')}`,
        footer: { text: `Reference ID: ${contactEntry.id} · Westpoint Public Portal` },
        timestamp: contactEntry.timestamp
      };
      await postDiscordMessage(DEPT_LOGS_CHANNEL_ID, discordEmbed);
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
    const targetUser = body.targetUser || 'Staff Member';
    const targetUserId = body.targetUserId || '';
    const roleRank = body.roleRank || '';
    const context = body.context || '';
    const notes = body.notes || '';
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
      title: body.title || 'Official Notice',
      author: currentSession.displayName,
      date: new Date().toISOString().split('T')[0],
      category: body.category || 'Department Notice',
      summary: body.summary || ''
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


  // API: GET /api/duty/status (Check current officer active session in bot.db)
  if (pathname === '/api/duty/status' && req.method === 'GET') {
    if (!currentSession) return sendJSON(res, 401, { error: 'Unauthorized' });
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
            robloxId: row.roblox_id
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
    if (!currentSession) return sendJSON(res, 401, { error: 'Unauthorized' });
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
    if (!currentSession) return sendJSON(res, 401, { error: 'Unauthorized' });
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

  // 16. Protected Employee Dashboard Route
  if (pathname === '/employee/dashboard') {
    if (!currentSession) {
      res.writeHead(302, { 'Location': '/employee', ...SECURITY_HEADERS });
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
  // Auto-redirect to dashboard if already authenticated
  if (pathname === '/employee' && currentSession) {
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
  let publicPath = path.join(PUBLIC_DIR, pathname);
  if (fs.existsSync(publicPath) && fs.statSync(publicPath).isFile()) {
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
