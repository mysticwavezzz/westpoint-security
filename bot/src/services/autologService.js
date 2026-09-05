const { EmbedBuilder } = require('discord.js');
const db = require('./database');
const config = require('../config');
const incidentsService = require('./incidentsService');

/**
 * Formats seconds into human-readable duration (e.g., "1h 25m 10s" or "15m 30s")
 */
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

/**
 * Sends the officer a personal DM "executive receipt" when their shift ends -
 * duration, incidents filed during the shift, and quota progress. Best-
 * effort: a DM failure (closed DMs, blocked bot) never blocks the shift end
 * itself, so this is always wrapped by the caller in a way that can't throw.
 */
async function sendShiftEndSummaryCard(client, userId, { startTime, endTime, elapsedSeconds, weeklyTotalSeconds }) {
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) return;

  const quotaTargetSeconds = db.getQuotaTargetSeconds(userId);
  const incidentCount = incidentsService.getIncidentCountInRange(userId, startTime, endTime);
  const quotaPercent = quotaTargetSeconds > 0 ? Math.min(999, Math.round((weeklyTotalSeconds / quotaTargetSeconds) * 100)) : 100;

  const embed = new EmbedBuilder()
    .setTitle('Shift End Summary')
    .setColor(0x2ECC71)
    .setDescription('Here\'s your executive receipt for the shift you just ended.')
    .addFields(
      { name: 'Shift Duration', value: formatDuration(elapsedSeconds), inline: true },
      { name: 'Incidents Filed This Shift', value: String(incidentCount), inline: true },
      { name: 'Weekly Quota Progress', value: `${formatDuration(weeklyTotalSeconds)} / ${formatDuration(quotaTargetSeconds)} (${quotaPercent}%)`, inline: false }
    )
    .setTimestamp()
    .setFooter({ text: 'Westpoint Security · Autolog Tracking System' });

  await user.send({ embeds: [embed] }).catch(() => {});
}

/**
 * Shared function to finalize and log an autolog session.
 * @param {object} client Discord Client
 * @param {string} userId Discord User ID
 * @param {boolean} isAutoEnded Whether ended automatically (Roblox presence loss, voice channel leave, etc)
 * @param {string|null} customReason Overrides the default "Ending Method" label - used by triggers other than the presence monitor (e.g. Voice Channel Shift Sync)
 */
async function endAutologSession(client, userId, isAutoEnded = false, customReason = null) {
  const session = db.getActiveSession(userId);
  if (!session) {
    return { success: false, reason: 'No active autolog session found.' };
  }

  const now = Date.now();
  const elapsedMs = now - session.start_time;
  const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minDurationMs = 12 * 60 * 1000; // 12 minutes

  db.removeActiveSession(userId);

  if (elapsedMs < minDurationMs) {
    return {
      success: true,
      logged: false,
      elapsedSeconds,
      durationFormatted: formatDuration(elapsedSeconds),
      weeklyTotalFormatted: formatDuration(db.getWeeklyTotalSeconds(userId)),
      reason: `Session lasted **${formatDuration(elapsedSeconds)}**, which is under the 12-minute minimum requirement. Session discarded.`
    };
  }

  // Update weekly totals
  const weekKey = db.getWeekKey();
  db.addWeeklySeconds(userId, elapsedSeconds, weekKey);
  const newWeeklyTotalSeconds = db.getWeeklyTotalSeconds(userId, weekKey);

  // Send embed to Audit Logs channel
  try {
    const channel = await client.channels.fetch(config.channels.auditLogs);
    if (channel && channel.isTextBased()) {
      const user = await client.users.fetch(userId).catch(() => null);
      const userMention = user ? `${user} (${user.tag})` : `<@${userId}>`;

      const embed = new EmbedBuilder()
        .setTitle('Staff Autolog Session Ended')
        .setColor(0x00FF7F) // Spring Green
        .addFields(
          { name: 'Staff Member', value: userMention, inline: true },
          { name: 'Session Duration', value: formatDuration(elapsedSeconds), inline: true },
          { name: 'Weekly Total Logged', value: formatDuration(newWeeklyTotalSeconds), inline: true },
          { name: 'Ending Method', value: customReason || (isAutoEnded ? 'Automatic (Roblox Offline/Left Game)' : 'Manual Command (`/autolog end`)'), inline: false }
        )
        .setTimestamp()
        .setFooter({ text: 'Autolog Tracking System' });

      await channel.send({ embeds: [embed] });
    }
  } catch (error) {
    console.error('[AUTOLOG ERROR] Failed to send Audit Log embed:', error.message);
  }

  // Shift End Summary Card - best-effort personal DM, never blocks the
  // shift-end response even if the user has DMs closed.
  sendShiftEndSummaryCard(client, userId, {
    startTime: session.start_time,
    endTime: now,
    elapsedSeconds,
    weeklyTotalSeconds: newWeeklyTotalSeconds
  }).catch(() => {});

  return {
    success: true,
    logged: true,
    elapsedSeconds,
    weeklyTotalSeconds: newWeeklyTotalSeconds,
    durationFormatted: formatDuration(elapsedSeconds),
    weeklyTotalFormatted: formatDuration(newWeeklyTotalSeconds)
  };
}

module.exports = {
  formatDuration,
  endAutologSession
};
