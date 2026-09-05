const Database = require('better-sqlite3');
const path = require('path');

// The web portal (server.js) reads/writes this same file - BOT_DB_PATH must
// point both processes at the same path. Locally that's each project's own
// relative default; in the merged Railway deployment both are pointed at a
// Volume mount (e.g. BOT_DB_PATH=/data/bot.db) so the data survives restarts
// and redeploys instead of living in the container's ephemeral disk.
const dbPath = process.env.BOT_DB_PATH || path.join(__dirname, '../../bot.db');
const db = new Database(dbPath, { timeout: 5000 });

// Enable WAL mode for performance & busy timeout
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// Initialize schema
db.exec(`
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
`);

// The web portal's server.js adds this column via its own ALTER TABLE on
// startup - guarded here too in case the bot process starts first against a
// fresh volume before server.js has had a chance to run.
try {
  db.exec('ALTER TABLE staff_members ADD COLUMN quota_target_seconds INTEGER');
} catch (e) {} // already exists

/**
 * Returns the ISO week key (e.g. "2026-W34") for Monday-Sunday calculation
 */
function getWeekKey(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

// Active session queries
const getActiveSessionStmt = db.prepare('SELECT * FROM active_sessions WHERE user_id = ?');
const getAllActiveSessionsStmt = db.prepare('SELECT * FROM active_sessions');
const saveActiveSessionStmt = db.prepare(`
  INSERT INTO active_sessions (user_id, roblox_id, roblox_username, start_time)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    roblox_id = excluded.roblox_id,
    roblox_username = excluded.roblox_username,
    start_time = excluded.start_time
`);
const removeActiveSessionStmt = db.prepare('DELETE FROM active_sessions WHERE user_id = ?');

// Staff member queries
const saveStaffMemberStmt = db.prepare(`
  INSERT INTO staff_members (user_id, roblox_id, roblox_username, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    roblox_id = COALESCE(excluded.roblox_id, staff_members.roblox_id),
    roblox_username = COALESCE(excluded.roblox_username, staff_members.roblox_username),
    updated_at = excluded.updated_at
`);

const getAllTrackedStaffStmt = db.prepare(`
  SELECT DISTINCT user_id, roblox_id, roblox_username FROM (
    SELECT user_id, roblox_id, roblox_username FROM staff_members
    UNION
    SELECT user_id, roblox_id, roblox_username FROM active_sessions
    UNION
    SELECT user_id, NULL as roblox_id, NULL as roblox_username FROM weekly_totals
  )
`);

// Weekly total queries
const getWeeklyTotalStmt = db.prepare('SELECT total_seconds FROM weekly_totals WHERE user_id = ? AND week_key = ?');
const getAllWeeklyTotalsForWeekStmt = db.prepare('SELECT user_id, total_seconds FROM weekly_totals WHERE week_key = ?');
const addWeeklyTimeStmt = db.prepare(`
  INSERT INTO weekly_totals (user_id, week_key, total_seconds)
  VALUES (?, ?, ?)
  ON CONFLICT(user_id, week_key) DO UPDATE SET
    total_seconds = total_seconds + excluded.total_seconds
`);

// Weekly audit logs queries
const hasWeeklyAuditRunStmt = db.prepare('SELECT 1 FROM weekly_audits WHERE week_key = ?');
const recordWeeklyAuditStmt = db.prepare('INSERT OR REPLACE INTO weekly_audits (week_key, audited_at) VALUES (?, ?)');

// Quota target queries - falls back to the app-wide 15-minute default,
// matching server.js's own fallback for staff whose row predates this column.
const getQuotaTargetStmt = db.prepare('SELECT quota_target_seconds FROM staff_members WHERE user_id = ?');

// Action state queries
const getActionStateStmt = db.prepare('SELECT * FROM user_action_states WHERE target_user_id = ?');
const saveActionStateStmt = db.prepare(`
  INSERT INTO user_action_states (target_user_id, last_action_type, channel_id, message_id, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(target_user_id) DO UPDATE SET
    last_action_type = excluded.last_action_type,
    channel_id = excluded.channel_id,
    message_id = excluded.message_id,
    updated_at = excluded.updated_at
`);

module.exports = {
  getWeekKey,
  getActiveSession(userId) {
    return getActiveSessionStmt.get(userId);
  },
  getAllActiveSessions() {
    return getAllActiveSessionsStmt.all();
  },
  saveActiveSession(userId, robloxId, robloxUsername, startTime) {
    saveStaffMemberStmt.run(userId, robloxId, robloxUsername, Date.now());
    return saveActiveSessionStmt.run(userId, robloxId, robloxUsername, startTime);
  },
  removeActiveSession(userId) {
    return removeActiveSessionStmt.run(userId);
  },
  saveStaffMember(userId, robloxId = null, robloxUsername = null) {
    return saveStaffMemberStmt.run(userId, robloxId, robloxUsername, Date.now());
  },
  getAllTrackedStaff() {
    return getAllTrackedStaffStmt.all();
  },
  getWeeklyTotalSeconds(userId, weekKey = getWeekKey()) {
    const row = getWeeklyTotalStmt.get(userId, weekKey);
    return row ? row.total_seconds : 0;
  },
  getWeeklyTotal(userId, weekKey = getWeekKey()) {
    const row = getWeeklyTotalStmt.get(userId, weekKey);
    return row ? row.total_seconds : 0;
  },
  getAllWeeklyTotalsForWeek(weekKey = getWeekKey()) {
    return getAllWeeklyTotalsForWeekStmt.all(weekKey);
  },
  getAllWeeklyTotals(weekKey = getWeekKey()) {
    return getAllWeeklyTotalsForWeekStmt.all(weekKey);
  },
  addWeeklySeconds(userId, seconds, weekKey = getWeekKey()) {
    return addWeeklyTimeStmt.run(userId, weekKey, seconds);
  },
  getQuotaTargetSeconds(userId) {
    const row = getQuotaTargetStmt.get(userId);
    return (row && Number.isFinite(row.quota_target_seconds)) ? row.quota_target_seconds : 900;
  },
  hasWeeklyAuditRun(weekKey) {
    return !!hasWeeklyAuditRunStmt.get(weekKey);
  },
  recordWeeklyAudit(weekKey) {
    return recordWeeklyAuditStmt.run(weekKey, Date.now());
  },
  getActionState(targetUserId) {
    return getActionStateStmt.get(targetUserId);
  },
  saveActionState(targetUserId, lastActionType, channelId, messageId, updatedAt = Date.now()) {
    return saveActionStateStmt.run(targetUserId, lastActionType, channelId, messageId, updatedAt);
  }
};
