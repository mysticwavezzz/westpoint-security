const { ActivityType } = require('discord.js');
const { startPresenceMonitor } = require('../services/presenceMonitor');
const { startWeeklyAuditScheduler } = require('../services/weeklyAuditService');

module.exports = {
  name: 'clientReady',
  once: true,
  execute(client) {
    console.log(`[BOT READY] Logged in as ${client.user.tag} (${client.user.id})`);
    
    // Explicitly set presence to online
    try {
      client.user.setPresence({
        activities: [{ name: 'Harrison County | Westpoint', type: ActivityType.Watching }],
        status: 'online'
      });
    } catch (e) {}

    // Start ongoing Roblox presence monitor
    startPresenceMonitor(client);

    // Start Sunday weekly activity quota scheduler
    startWeeklyAuditScheduler(client);
  }
};
