const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const db = require('../services/database');
const robloxService = require('../services/robloxService');
const autologService = require('../services/autologService');
const logger = require('../services/logger');
const config = require('../config');

// Roles authorized to run /debug (Command+)
const COMMAND_ROLES = [
  '1522798272144605315', // Command
  '1522793598633119754', // Captain
  '1522793595315294248', // Security Deputy Chief
  '1522793591112466493'  // Security Chief
];

const COMMAND_ROLE_NAMES = [
  'command',
  'captain',
  'security deputy chief',
  'security chief'
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('debug')
    .setDescription('Show logs, errors, and warnings')
    .addUserOption(option =>
      option.setName('target')
        .setDescription('Target officer to inspect')
        .setRequired(false)
    ),

  async execute(interaction) {
    const member = interaction.member;
    const hasCommandRole = member?.roles?.cache?.some(r =>
      COMMAND_ROLES.includes(r.id) ||
      COMMAND_ROLE_NAMES.some(name => r.name.toLowerCase().includes(name))
    ) || member?.permissions?.has?.('Administrator');

    if (!hasCommandRole) {
      return interaction.reply({
        content: 'You must have Command+ Permissions',
        flags: MessageFlags.Ephemeral
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const targetUser = interaction.options.getUser('target');

    try {
      if (targetUser) {
        return await handleTarget(interaction, targetUser);
      }
      return await handleGeneral(interaction);
    } catch (err) {
      return await interaction.editReply({
        content: `Error:\n\`\`\`\n${err.message}\n\`\`\``
      });
    }
  }
};

async function handleGeneral(interaction) {
  const counts = logger.getCounts();
  const errors = logger.getLogs('ERROR', 10);
  const warnings = logger.getLogs('WARN', 10);
  const commandHistory = logger.getCommandHistory(10);
  const activeSessions = db.getAllActiveSessions();

  const isWeekend = logger.isWeekend();
  const scheduleLabel = isWeekend ? 'Every 3 hours (Weekend)' : 'Every 8 hours (Weekday)';
  const nextRefresh = logger.getNextRefreshDate();
  const nextRefreshTs = Math.floor(nextRefresh.getTime() / 1000);

  let errorText = 'None';
  if (errors.length > 0) {
    errorText = errors.map(e => `[${e.category}] ${e.message}${e.meta ? ' (' + e.meta + ')' : ''}`).join('\n');
  }

  let warnText = 'None';
  if (warnings.length > 0) {
    warnText = warnings.map(w => `[${w.category}] ${w.message}${w.meta ? ' (' + w.meta + ')' : ''}`).join('\n');
  }

  let cmdText = 'None';
  if (commandHistory.length > 0) {
    cmdText = commandHistory.map(c => {
      const timeStr = c.timestamp.toLocaleTimeString();
      return `[${timeStr}] /${c.commandName} by ${c.userTag}${c.options ? ' ' + c.options : ''}`;
    }).join('\n');
  }

  let sessionText = 'None';
  if (activeSessions.length > 0) {
    sessionText = activeSessions.map(s => {
      const elapsed = Math.floor((Date.now() - s.start_time) / 1000);
      return `<@${s.user_id}> (${s.roblox_username}) - ${autologService.formatDuration(elapsed)}`;
    }).join('\n');
  }

  const output = [
    `**Logs & Debug Status**`,
    `Errors: ${counts.errors} | Warnings: ${counts.warnings} | Commands Run: ${counts.commands}`,
    `Auto-Refresh: \`${scheduleLabel}\` (Next: <t:${nextRefreshTs}:R>)`,
    ``,
    `Error:`,
    `\`\`\``,
    errorText.substring(0, 800),
    `\`\`\``,
    `Warnings:`,
    `\`\`\``,
    warnText.substring(0, 800),
    `\`\`\``,
    `Command History:`,
    `\`\`\``,
    cmdText.substring(0, 900),
    `\`\`\``,
    `Active Sessions:`,
    sessionText
  ].join('\n');

  await interaction.editReply({ content: output });
}

async function handleTarget(interaction, targetUser) {
  const member = await interaction.guild?.members.fetch(targetUser.id).catch(() => null);
  const candidates = [
    member?.nickname,
    member?.displayName,
    targetUser.globalName,
    targetUser.displayName,
    targetUser.username
  ].filter(Boolean);

  const robloxUser = await robloxService.resolveRobloxUser(candidates);
  let presence = null;
  if (robloxUser) {
    const presences = await robloxService.getUserPresences([robloxUser.id]);
    if (presences && presences.length > 0) {
      presence = presences[0];
    }
  }

  const activeSession = db.getActiveSession(targetUser.id);
  const targetGameId = String(config.roblox.gameId);
  const isOnlineInGame = presence?.userPresenceType === 2;
  const locationMatches = presence?.lastLocation && /harrison/i.test(presence.lastLocation);
  const placeIdStr = presence?.placeId ? String(presence.placeId) : null;
  const isHarrison = placeIdStr === targetGameId ||
                     robloxService.KNOWN_HARRISON_IDS.includes(placeIdStr) ||
                     robloxService.KNOWN_HARRISON_IDS.includes(String(presence?.universeId)) ||
                     locationMatches;

  let presenceStatus = 'Offline';
  if (presence?.userPresenceType === 1) presenceStatus = 'Website / App';
  if (presence?.userPresenceType === 2) presenceStatus = 'In-Game';
  if (presence?.userPresenceType === 3) presenceStatus = 'Studio';

  let detectedError = 'None';
  if (!robloxUser) {
    detectedError = `Could not find Roblox user matching Discord names: ${candidates.join(', ')}. Set Discord server nickname to exact Roblox username.`;
  } else if (!isOnlineInGame) {
    detectedError = `User is not in a Roblox game (Status: ${presenceStatus}). Must be in Harrison County.`;
  } else if (placeIdStr && !isHarrison) {
    detectedError = `User is playing a different game (Place ID: ${placeIdStr}). Must be in Harrison County (${targetGameId}).`;
  } else if (!presence?.placeId && !presence?.universeId) {
    detectedError = `Roblox privacy settings are hiding Place ID. User must set 'Who can join me in experiences' to 'Everyone' in Roblox Settings > Privacy.`;
  }

  const output = [
    `**User Debug: <@${targetUser.id}>**`,
    `Discord ID: \`${targetUser.id}\``,
    `Roblox: ${robloxUser ? `\`${robloxUser.name}\` (ID: \`${robloxUser.id}\`)` : '`Unresolved`'}`,
    `Status: \`${presenceStatus}\``,
    `Place ID: \`${placeIdStr || (isOnlineInGame ? 'Unknown (Privacy Masked)' : 'None')}\``,
    `On Duty: \`${activeSession ? 'Yes' : 'No'}\``,
    ``,
    `Error:`,
    `\`\`\``,
    detectedError,
    `\`\`\``
  ].join('\n');

  await interaction.editReply({ content: output });
}
