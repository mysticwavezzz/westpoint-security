const fs = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');
const db = require('./database');
const autologService = require('./autologService');
const config = require('../config');

// 900s (15min) - kept as the fallback for any role with no configured
// weeklyQuotaSeconds and for staff who couldn't be resolved to a Discord
// member at all (left the server, etc.) - matches server.js's own seed
// default so behavior is identical until Command sets a real per-role
// target in the website's Role Permissions panel.
const WEEKLY_QUOTA_SECONDS = 15 * 60;

// Shares data/role-permissions.json with the website (server.js) rather
// than keeping its own copy of quota targets - both processes run as one
// merged Railway service on the same Volume, so DATA_DIR resolves to the
// same real directory for both.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', '..', 'data');

function getRoleConfig() {
  try {
    const filePath = path.join(DATA_DIR, 'role-permissions.json');
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {
    console.error('[WEEKLY AUDIT] Failed to read role-permissions.json:', e.message);
  }
  return {};
}

// A member holding multiple roles is held to the highest target among them
// - same reasoning as computePermissionsFromDiscordRoles in server.js.
function getQuotaTargetSeconds(roleConfig, discordRoleIds) {
  const matched = (discordRoleIds || []).map(id => roleConfig[id]).filter(r => r && r.enabled);
  if (matched.length === 0) return WEEKLY_QUOTA_SECONDS;
  const target = matched.reduce((max, r) => Math.max(max, Number(r.weeklyQuotaSeconds) || 0), 0);
  return target || WEEKLY_QUOTA_SECONDS;
}

let auditCheckInterval = null;

/**
 * Executes the weekly in-game quota audit for staff members.
 * @param {object} client Discord Client
 * @param {string} [customWeekKey] Optional week key override
 * @param {boolean} [force=false] If true, ignores whether audit already ran
 */
async function runWeeklyQuotaAudit(client, customWeekKey = null, force = false) {
  const weekKey = customWeekKey || db.getWeekKey();

  if (!force && db.hasWeeklyAuditRun(weekKey)) {
    return { success: false, reason: 'Audit for week ' + weekKey + ' has already executed.' };
  }

  const staffList = db.getAllTrackedStaff();
  if (!staffList || staffList.length === 0) {
    console.log('[WEEKLY AUDIT] No tracked staff found for week ' + weekKey + '.');
    db.recordWeeklyAudit(weekKey);
    return { success: true, failedMembers: [] };
  }

  const failedMembers = [];
  const passedMembers = [];
  const roleConfig = getRoleConfig();
  const guild = await client.guilds.fetch(config.guildId).catch(() => null);

  for (const staff of staffList) {
    const totalSeconds = db.getWeeklyTotalSeconds(staff.user_id, weekKey);
    // Live Discord roles, not a cached value - this only runs once a week,
    // so the per-call cost of fetching each member is a non-issue.
    const member = guild ? await guild.members.fetch(staff.user_id).catch(() => null) : null;
    const quotaSeconds = getQuotaTargetSeconds(roleConfig, member ? [...member.roles.cache.keys()] : []);
    const staffInfo = {
      userId: staff.user_id,
      robloxUsername: staff.roblox_username,
      totalSeconds: totalSeconds,
      formattedTime: autologService.formatDuration(totalSeconds),
      quotaSeconds: quotaSeconds,
      quotaFormatted: autologService.formatDuration(quotaSeconds)
    };

    if (totalSeconds < quotaSeconds) {
      failedMembers.push(staffInfo);
    } else {
      passedMembers.push(staffInfo);
    }
  }

  console.log('[WEEKLY AUDIT] Week ' + weekKey + ': ' + failedMembers.length + ' staff failed their quota, ' + passedMembers.length + ' passed.');

  // Send warning embed to the autolog / audit channel
  try {
    const channel = await client.channels.fetch(config.channels.auditLogs).catch(() => null);
    if (channel && channel.isTextBased()) {
      if (failedMembers.length > 0) {
        const failureLines = failedMembers.map((m, idx) => {
          const robloxTag = m.robloxUsername ? ' (' + m.robloxUsername + ')' : '';
          return (idx + 1) + '. <@' + m.userId + '>' + robloxTag + ' - **' + m.formattedTime + '** / ' + m.quotaFormatted + ' requirement';
        });

        // Split into chunks if long
        const descriptionChunks = [];
        let currentChunk = '';
        for (const line of failureLines) {
          if ((currentChunk + '\n' + line).length > 3800) {
            descriptionChunks.push(currentChunk);
            currentChunk = line;
          } else {
            currentChunk = currentChunk ? currentChunk + '\n' + line : line;
          }
        }
        if (currentChunk) descriptionChunks.push(currentChunk);

        for (let i = 0; i < descriptionChunks.length; i++) {
          const embed = new EmbedBuilder()
            .setTitle(i === 0 ? 'Weekly In-Game Activity Quota: Warning Notice' : 'Activity Quota: Warning Notice (Cont.)')
            .setColor(0xE74C3C) // Red
            .setDescription('The following staff members failed to meet their rank\'s minimum weekly in-game quota in [Harrison County](https://www.roblox.com/games/' + config.roblox.gameId + ') for week **`' + weekKey + '`**:\n\n' + descriptionChunks[i])
            .addFields(
              { name: 'Requirement', value: 'Per-Rank Weekly Minimum (see Role Permissions)', inline: true },
              { name: 'Total Non-Compliant', value: failedMembers.length + ' Staff Member(s)', inline: true }
            )
            .setTimestamp()
            .setFooter({ text: 'Westpoint Security - Weekly Activity Audit' });

          await channel.send({ embeds: [embed] });
        }
      } else {
        const embed = new EmbedBuilder()
          .setTitle('Weekly In-Game Activity Audit: All Compliant')
          .setColor(0x2ECC71)
          .setDescription('All active staff members successfully met their rank\'s weekly in-game duty requirement for week **`' + weekKey + '`**!')
          .setTimestamp()
          .setFooter({ text: 'Westpoint Security - Weekly Activity Audit' });

        await channel.send({ embeds: [embed] });
      }
    } else {
      console.warn('[WEEKLY AUDIT] Audit channel ' + config.channels.auditLogs + ' not accessible.');
    }
  } catch (err) {
    console.error('[WEEKLY AUDIT ERROR] Failed to send weekly quota embed:', err.message);
  }

  db.recordWeeklyAudit(weekKey);
  return { success: true, failedMembers, passedMembers };
}

/**
 * Starts the weekly Sunday audit timer checker.
 * @param {object} client Discord Client
 */
function startWeeklyAuditScheduler(client) {
  if (auditCheckInterval) {
    clearInterval(auditCheckInterval);
  }

  console.log('[WEEKLY AUDIT] Started Sunday weekly activity quota scheduler.');

  // Check every 5 minutes
  auditCheckInterval = setInterval(async () => {
    try {
      const now = new Date();
      // Check if Sunday (day 0) and at or after 20:00 (8:00 PM) local / UTC
      const isSunday = now.getDay() === 0;
      const isEvening = now.getHours() >= 20 || (now.getUTCDay() === 0 && now.getUTCHours() >= 22);

      if (isSunday && isEvening) {
        const weekKey = db.getWeekKey();
        if (!db.hasWeeklyAuditRun(weekKey)) {
          console.log('[WEEKLY AUDIT] Sunday evening reached. Triggering audit for week ' + weekKey + '...');
          await runWeeklyQuotaAudit(client, weekKey);
        }
      }
    } catch (err) {
      console.error('[WEEKLY AUDIT ERROR] Scheduler check failed:', err.message);
    }
  }, 5 * 60 * 1000);
}

function stopWeeklyAuditScheduler() {
  if (auditCheckInterval) {
    clearInterval(auditCheckInterval);
    auditCheckInterval = null;
  }
}

module.exports = {
  WEEKLY_QUOTA_SECONDS,
  runWeeklyQuotaAudit,
  startWeeklyAuditScheduler,
  stopWeeklyAuditScheduler
};
