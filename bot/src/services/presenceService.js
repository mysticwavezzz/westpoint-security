const { ActivityType } = require('discord.js');
const db = require('./database');

// Discord Rich Presence / Activity: a bot account can only set its OWN
// presence, never an officer's personal Discord profile (that's a platform
// limitation, not something any bot can work around) - so this reflects
// department-wide server state instead: how many officers are currently on
// duty. Refreshes periodically rather than only at login, so it stays
// accurate as shifts start and end throughout the day.
const REFRESH_INTERVAL_MS = 60 * 1000;
let presenceInterval = null;

function updatePresence(client) {
  try {
    const activeCount = db.getAllActiveSessions().length;
    const name = activeCount === 1
      ? '1 officer on patrol'
      : activeCount > 1
        ? `${activeCount} officers on patrol`
        : 'Harrison County | Westpoint';
    client.user.setPresence({
      activities: [{ name, type: ActivityType.Watching }],
      status: 'online'
    });
  } catch (e) {
    console.error('[PRESENCE SERVICE ERROR]', e.message);
  }
}

function startPresenceUpdater(client) {
  if (presenceInterval) clearInterval(presenceInterval);
  updatePresence(client);
  presenceInterval = setInterval(() => updatePresence(client), REFRESH_INTERVAL_MS);
}

module.exports = { startPresenceUpdater, updatePresence };
