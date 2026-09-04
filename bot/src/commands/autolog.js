const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const db = require('../services/database');
const robloxService = require('../services/robloxService');
const autologService = require('../services/autologService');
const logger = require('../services/logger');
const config = require('../config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('autolog')
    .setDescription('Manage your Roblox staff autolog session')
    .addStringOption(option =>
      option.setName('action')
        .setDescription('Action to perform (Start, End, or Status)')
        .setRequired(true)
        .addChoices(
          { name: 'Start', value: 'start' },
          { name: 'End', value: 'end' },
          { name: 'Status', value: 'status' }
        )
    )
    .addAttachmentOption(option =>
      option.setName('proof')
        .setDescription('Full screenshot proof in Roblox game (Required if your Roblox privacy/joins are off)')
        .setRequired(false)
    ),

  async execute(interaction) {
    const action = interaction.options.getString('action');

    if (action === 'start') {
      await handleStart(interaction);
    } else if (action === 'end') {
      await handleEnd(interaction);
    } else if (action === 'status') {
      await handleStatus(interaction);
    }
  }
};

async function handleStart(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const userId = interaction.user.id;
  const activeSession = db.getActiveSession(userId);
  if (activeSession) {
    const elapsedSeconds = Math.floor((Date.now() - activeSession.start_time) / 1000);
    const embed = new EmbedBuilder()
      .setTitle('Active Session Exists')
      .setColor(0xF1C40F)
      .setDescription(`You already have an active autolog session running for **${autologService.formatDuration(elapsedSeconds)}**.\n\nUse \`/autolog action:End\` to end your current session before starting a new one.`);
    return interaction.editReply({ embeds: [embed] });
  }

  // Gather all name candidates (server nickname, global display name, username)
  const candidates = [
    interaction.member?.nickname,
    interaction.member?.displayName,
    interaction.user?.globalName,
    interaction.user?.displayName,
    interaction.user?.username
  ].filter(Boolean);

  // Verify Roblox in-game presence
  const verification = await robloxService.verifyUserInGame(candidates, config.roblox.gameId);

  if (!verification.inGame) {
    logger.warn('AUTOLOG', `Autolog start failed for ${interaction.user.tag} (${interaction.user.id})`, {
      candidates,
      robloxUser: verification.robloxUsername || 'Unresolved',
      reason: verification.reason
    });

    const embed = new EmbedBuilder()
      .setTitle('Autolog Start Failed')
      .setColor(0xE74C3C)
      .setDescription(verification.reason || `Please ensure you are in [Harrison County](https://www.roblox.com/games/${config.roblox.gameId}) then start your log.`);

    return interaction.editReply({ embeds: [embed] });
  }

  // Check screenshot proof requirement if privacy settings mask place ID
  const proofAttachment = interaction.options.getAttachment('proof');
  const isImage = proofAttachment && proofAttachment.contentType && proofAttachment.contentType.startsWith('image/');

  if (verification.isPrivacyRestricted && !isImage) {
    logger.warn('AUTOLOG', `Autolog rejected: privacy settings restricted without proof attachment for ${interaction.user.tag}`);

    const errorMsg = [
      '**Autolog Start Blocked: Proof Required**',
      '',
      'Error:',
      '```',
      'Your Roblox "Who can join me in experiences" privacy setting is set to Private/Friends.',
      'Because your game location is hidden by Roblox, you MUST attach a full screenshot of yourself in-game in Harrison County to start your shift.',
      '',
      'How to Fix (Pick One):',
      '1. Re-run: /autolog action:Start proof:[upload full screenshot in game]',
      'OR',
      '2. In Roblox, set Settings > Privacy > "Who can join me in experiences" to "Everyone", then run /autolog again.',
      '```'
    ].join('\n');

    return interaction.editReply({ content: errorMsg });
  }

  // Save session
  const startTime = Date.now();
  db.saveActiveSession(userId, String(verification.robloxId), verification.robloxUsername, startTime);

  const embed = new EmbedBuilder()
    .setTitle('Autolog Started')
    .setColor(0x2ECC71)
    .setDescription(`<t:${Math.floor(startTime / 1000)}:F> (<t:${Math.floor(startTime / 1000)}:R>)`);

  if (verification.isPrivacyRestricted && isImage) {
    embed.addFields({
      name: 'Verified via In-Game Proof',
      value: `Verified with attached screenshot proof (${proofAttachment.name}).`
    });
    embed.setImage(proofAttachment.url);
  }

  await interaction.editReply({ embeds: [embed] });
}

async function handleEnd(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const userId = interaction.user.id;
  const result = await autologService.endAutologSession(interaction.client, userId, false);

  if (!result.success) {
    const embed = new EmbedBuilder()
      .setTitle('No Active Session')
      .setColor(0xE74C3C)
      .setDescription(result.reason || 'You do not have an active autolog session running.');
    return interaction.editReply({ embeds: [embed] });
  }

  if (result.logged === false) {
    const embed = new EmbedBuilder()
      .setTitle('Autolog Session Ended (Not Logged)')
      .setColor(0xF1C40F)
      .setDescription(result.reason || 'Session was under the 12-minute minimum requirement and was not added to your weekly quota.')
      .addFields(
        { name: 'Session Duration', value: result.durationFormatted || `${result.elapsedSeconds || 0}s`, inline: true },
        { name: 'Weekly Total', value: result.weeklyTotalFormatted || autologService.formatDuration(db.getWeeklyTotalSeconds(userId)), inline: true }
      );
    return interaction.editReply({ embeds: [embed] });
  }

  const embed = new EmbedBuilder()
    .setTitle('Autolog Ended')
    .setColor(0x3498DB)
    .addFields(
      { name: 'Session Duration', value: result.durationFormatted || `${result.elapsedSeconds || 0}s`, inline: true },
      { name: 'Weekly Total', value: result.weeklyTotalFormatted || autologService.formatDuration(result.weeklyTotalSeconds || 0), inline: true }
    );

  await interaction.editReply({ embeds: [embed] });
}

async function handleStatus(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const userId = interaction.user.id;
  const activeSession = db.getActiveSession(userId);
  const weekKey = db.getWeekKey();
  const weeklySeconds = db.getWeeklyTotalSeconds(userId, weekKey);

  const embed = new EmbedBuilder()
    .setTitle('Autolog Status')
    .setColor(0x95A5A6);

  if (activeSession) {
    const elapsedSeconds = Math.floor((Date.now() - activeSession.start_time) / 1000);
    const startTimestamp = Math.floor(activeSession.start_time / 1000);
    embed.setDescription(`**Active Session Running**\nStarted: <t:${startTimestamp}:F> (<t:${startTimestamp}:R>)\nCurrent Duration: **${autologService.formatDuration(elapsedSeconds)}**\nRoblox Account: **${activeSession.roblox_username}**`);
  } else {
    embed.setDescription('**No Active Session**\nYou are not currently logging duty time.');
  }

  embed.addFields(
    { name: 'Current Weekly Total', value: autologService.formatDuration(weeklySeconds), inline: true },
    { name: 'Week ID', value: `\`${weekKey}\``, inline: true }
  );

  await interaction.editReply({ embeds: [embed] });
}
