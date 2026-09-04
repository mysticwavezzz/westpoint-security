// Handles the "Trim Clip" button posted on bodycam video-log messages
// (server.js finalizeBodycamSession) - opens a modal for a start/end range,
// then trims and replies with the mp4 ephemerally (visible only to whoever
// clicked). Shares lib/video.js with the website rather than duplicating
// the ffmpeg logic - both processes sit in the same westpoint-portal repo
// with one shared node_modules, so a relative require works fine.
const path = require('path');
const fs = require('fs');
const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  MessageFlags
} = require('discord.js');
const video = require(path.join(__dirname, '..', '..', '..', 'lib', 'video.js'));
const videoLog = require(path.join(__dirname, '..', '..', '..', 'lib', 'videoLog.js'));

// Accepts plain seconds ("90") or "MM:SS" / "H:MM:SS" style input.
function parseTimeInput(raw) {
  const str = String(raw || '').trim();
  if (!str) return null;
  if (str.includes(':')) {
    const parts = str.split(':').map(p => Number(p.trim()));
    if (parts.some(p => Number.isNaN(p))) return null;
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  }
  const num = Number(str);
  return Number.isNaN(num) ? null : num;
}

module.exports = {
  // Button click - custom_id: bodycam_trim_open:<bodycamId>:<partIndex>
  async handleOpenModal(interaction) {
    const [, bodycamId, partIndex] = interaction.customId.split(':');

    const modal = new ModalBuilder()
      .setCustomId(`bodycam_trim_submit:${bodycamId}:${partIndex}`)
      .setTitle('Trim Bodycam Clip');

    const startInput = new TextInputBuilder()
      .setCustomId('trim_start')
      .setLabel('Start (seconds or MM:SS)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g. 90 or 1:30')
      .setRequired(true);

    const endInput = new TextInputBuilder()
      .setCustomId('trim_end')
      .setLabel('End (seconds or MM:SS)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g. 150 or 2:30')
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(startInput),
      new ActionRowBuilder().addComponents(endInput)
    );

    await interaction.showModal(modal);
  },

  // Modal submit - custom_id: bodycam_trim_submit:<bodycamId>:<partIndex>
  async handleModalSubmit(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const [, bodycamId, partIndex] = interaction.customId.split(':');
    const startSeconds = parseTimeInput(interaction.fields.getTextInputValue('trim_start'));
    const endSeconds = parseTimeInput(interaction.fields.getTextInputValue('trim_end'));

    if (startSeconds === null || endSeconds === null || endSeconds <= startSeconds) {
      return interaction.editReply({
        content: 'Invalid start/end time - enter seconds (e.g. 90) or MM:SS (e.g. 1:30), with the end after the start.'
      });
    }

    // interaction.message is the video message the button lives on -
    // Discord attaches a freshly-signed attachment URL to the interaction
    // payload itself, so there's no need to re-fetch the message over the
    // REST API here.
    const attachment = interaction.message?.attachments?.first();
    if (!attachment) {
      return interaction.editReply({ content: 'Could not find the video attachment on this message.' });
    }

    let localSource, localTrim;
    try {
      localSource = video.tempPath('webm');
      await video.downloadToFile(attachment.url, localSource);
      localTrim = await video.trimToMp4(localSource, startSeconds, endSeconds);

      const stat = fs.statSync(localTrim);
      if (stat.size > videoLog.DISCORD_FILE_LIMIT_BYTES) {
        return interaction.editReply({
          content: `That range trims to ${(stat.size / 1024 / 1024).toFixed(1)}MB, over Discord's upload limit - pick a shorter range.`
        });
      }

      await interaction.editReply({
        content: `Trimmed clip (${startSeconds}s-${endSeconds}s), visible only to you.`,
        files: [{ attachment: localTrim, name: `bodycam-${bodycamId}-part${Number(partIndex) + 1}-clip.mp4` }]
      });
    } catch (err) {
      console.error('[BODYCAM TRIM ERROR]', err);
      await interaction.editReply({ content: 'Failed to trim that clip - try again in a moment.' });
    } finally {
      [localSource, localTrim].forEach(p => { if (p) { try { fs.unlinkSync(p); } catch (e) {} } });
    }
  }
};
