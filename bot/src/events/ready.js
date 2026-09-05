const { startPresenceMonitor } = require('../services/presenceMonitor');
const { startPresenceUpdater } = require('../services/presenceService');
const { startWeeklyAuditScheduler } = require('../services/weeklyAuditService');

module.exports = {
  name: 'clientReady',
  once: true,
  execute(client) {
    console.log(`[BOT READY] Logged in as ${client.user.tag} (${client.user.id})`);

    // Discord Rich Presence reflecting department-wide duty state (how many
    // officers are on patrol right now), refreshed periodically.
    startPresenceUpdater(client);

    // Start ongoing Roblox presence monitor
    startPresenceMonitor(client);

    // Start Sunday weekly activity quota scheduler
    startWeeklyAuditScheduler(client);
  }
};
