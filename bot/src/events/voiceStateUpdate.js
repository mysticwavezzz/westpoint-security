const config = require('../config');
const db = require('../services/database');
const robloxService = require('../services/robloxService');
const autologService = require('../services/autologService');

// Voice Channel Shift Sync: joining the configured "Patrol Comms" voice
// channel auto-starts a shift (after the same Roblox in-game verification
// /autolog start requires - joining voice alone isn't proof of being on
// patrol), and disconnecting from it auto-ends one. Disabled entirely until
// PATROL_COMMS_VOICE_CHANNEL_ID is configured, since guessing a channel ID
// wrong would silently clock people in/out of the wrong place.
async function handleJoin(member, client) {
  const userId = member.id;
  if (db.getActiveSession(userId)) return; // already on duty, nothing to sync

  const candidates = [
    member.nickname,
    member.displayName,
    member.user?.globalName,
    member.user?.username
  ].filter(Boolean);

  const verification = await robloxService.verifyUserInGame(candidates, config.roblox.gameId);

  if (!verification.inGame || verification.isPrivacyRestricted) {
    // Can't auto-verify (not in-game, or privacy-masked with no way to
    // attach screenshot proof from a voice event) - stay silent rather than
    // DMing on every voice join, since this fires constantly for anyone who
    // just hangs out in the channel without being on patrol.
    return;
  }

  const startTime = Date.now();
  db.saveActiveSession(userId, String(verification.robloxId), verification.robloxUsername, startTime);

  try {
    const channel = await client.channels.fetch(config.channels.auditLogs);
    if (channel && channel.isTextBased()) {
      await channel.send(`<@${userId}> auto-clocked in via **Voice Channel Shift Sync** (joined Patrol Comms, verified in-game as \`${verification.robloxUsername}\`).`);
    }
  } catch (e) {}
}

async function handleLeave(member, client) {
  const userId = member.id;
  if (!db.getActiveSession(userId)) return; // nothing to end
  await autologService.endAutologSession(client, userId, true, 'Automatic (Left Patrol Comms Voice Channel)');
}

module.exports = {
  name: 'voiceStateUpdate',
  async execute(oldState, newState) {
    const channelId = config.patrolCommsVoiceChannelId;
    if (!channelId) return; // feature not configured - no-op

    const wasIn = oldState.channelId === channelId;
    const isIn = newState.channelId === channelId;
    if (wasIn === isIn) return; // moved between two other channels, or no change

    const client = newState.client;
    const member = newState.member || oldState.member;
    if (!member) return;

    try {
      if (isIn && !wasIn) {
        await handleJoin(member, client);
      } else if (wasIn && !isIn) {
        await handleLeave(member, client);
      }
    } catch (error) {
      console.error('[VOICE SHIFT SYNC ERROR]', member.id, error.message);
    }
  }
};
