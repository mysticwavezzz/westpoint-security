const db = require('./database');
const robloxService = require('./robloxService');
const autologService = require('./autologService');
const config = require('../config');

let monitorInterval = null;

/**
 * Starts the background presence monitor loop.
 * @param {object} client Discord Client
 */
function startPresenceMonitor(client) {
  if (monitorInterval) {
    clearInterval(monitorInterval);
  }

  console.log(`[PRESENCE MONITOR] Started background monitor (polling every ${config.roblox.pollIntervalMs / 1000}s).`);

  monitorInterval = setInterval(async () => {
    try {
      const activeSessions = db.getAllActiveSessions();
      if (activeSessions.length === 0) return;

      for (const session of activeSessions) {
        const robloxId = session.roblox_id;
        const presences = await robloxService.getUserPresences([robloxId]);

        let inGame = false;
        if (presences && presences.length > 0) {
          const presence = presences[0];
          const targetIdStr = String(config.roblox.gameId);
          const isOnlineInGame = presence.userPresenceType === 2;
          const locationMatches = presence.lastLocation && /harrison/i.test(presence.lastLocation);
          const matchesGame = String(presence.placeId) === targetIdStr ||
                              String(presence.rootPlaceId) === targetIdStr ||
                              String(presence.universeId) === targetIdStr ||
                              String(presence.gameId) === targetIdStr ||
                              robloxService.KNOWN_HARRISON_IDS.includes(String(presence.placeId)) ||
                              robloxService.KNOWN_HARRISON_IDS.includes(String(presence.rootPlaceId)) ||
                              robloxService.KNOWN_HARRISON_IDS.includes(String(presence.universeId)) ||
                              locationMatches;

          const isKnownDifferentGame = presence.placeId && !matchesGame;

          // Stay in game if confirmed Harrison OR if privacy-masked while actively in-game
          if (isOnlineInGame && !isKnownDifferentGame) {
            inGame = true;
          }
        }

        if (!inGame) {
          console.log(`[PRESENCE MONITOR] User ${session.user_id} (${session.roblox_username}) is no longer in Roblox game ${config.roblox.gameId}. Auto-ending autolog session.`);
          await autologService.endAutologSession(client, session.user_id, true);
        }
      }
    } catch (error) {
      console.error('[PRESENCE MONITOR ERROR] Error in monitor loop:', error.message);
    }
  }, config.roblox.pollIntervalMs);
}

function stopPresenceMonitor() {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
    console.log('[PRESENCE MONITOR] Stopped background monitor.');
  }
}

module.exports = {
  startPresenceMonitor,
  stopPresenceMonitor
};
