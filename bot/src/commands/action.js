const { 
  SlashCommandBuilder, 
  EmbedBuilder, 
  ActionRowBuilder, 
  UserSelectMenuBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  ModalBuilder, 
  TextInputBuilder, 
  TextInputStyle,
  MessageFlags
} = require('discord.js');
const db = require('../services/database');
const config = require('../config');

// Visual styling config per action type
const ACTION_STYLES = {
  hire: { color: 0x2ECC71, verb: 'hired' },
  promote: { color: 0x3498DB, verb: 'promoted' },
  demote: { color: 0xE74C3C, verb: 'demoted' },
  terminate: { color: 0x992D22, verb: 'terminated' },
  adminleave: { color: 0x9B59B6, verb: 'placed on admin leave' },
  suspend: { color: 0xE67E22, verb: 'suspended' },
  warn: { color: 0xF1C40F, verb: 'warned' },
  custom: { color: 0x1ABC9C, verb: 'custom' }
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('action')
    .setDescription('Issue a staff management action')
    .addStringOption(option =>
      option.setName('type')
        .setDescription('Type of action to issue')
        .setRequired(true)
        .addChoices(
          { name: 'Hire', value: 'hire' },
          { name: 'Promote', value: 'promote' },
          { name: 'Demote', value: 'demote' },
          { name: 'Terminate', value: 'terminate' },
          { name: 'Admin Leave', value: 'adminleave' },
          { name: 'Suspend', value: 'suspend' },
          { name: 'Warn', value: 'warn' },
          { name: 'Custom Action', value: 'custom' }
        )
    ),

  async execute(interaction) {
    const actionType = interaction.options.getString('type');
    const style = ACTION_STYLES[actionType] || ACTION_STYLES.custom;

    const embed = new EmbedBuilder()
      .setTitle(`Department Action Initiated: ${actionType.toUpperCase()}`)
      .setColor(style.color)
      .setDescription('**Step 1:** Select the target staff member below to proceed.')
      .setFooter({ text: 'This prompt is ephemeral and visible only to you.' });

    const userSelect = new UserSelectMenuBuilder()
      .setCustomId(`action_select_user:${actionType}`)
      .setPlaceholder('Select target staff member');

    const row = new ActionRowBuilder().addComponents(userSelect);

    await interaction.reply({
      embeds: [embed],
      components: [row],
      flags: MessageFlags.Ephemeral
    });
  },

  /**
   * Handles user selection from the UserSelectMenu
   */
  async handleUserSelect(interaction) {
    const customId = interaction.customId; // action_select_user:<actionType>
    const [, actionType] = customId.split(':');
    const selectedUserId = interaction.values[0];
    const style = ACTION_STYLES[actionType] || ACTION_STYLES.custom;

    const embed = new EmbedBuilder()
      .setTitle(`Target Member Selected`)
      .setColor(style.color)
      .setDescription(`Target User: <@${selectedUserId}>\nAction Type: **${actionType.toUpperCase()}**\n\n**Step 2:** Click the button below to fill in action details.`)
      .setFooter({ text: 'This prompt is ephemeral and visible only to you.' });

    const button = new ButtonBuilder()
      .setCustomId(`action_open_modal:${actionType}:${selectedUserId}`)
      .setLabel('Fill Action Details')
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(button);

    await interaction.update({
      embeds: [embed],
      components: [row]
    });
  },

  /**
   * Opens action-specific modal when user clicks button
   */
  async handleOpenModal(interaction) {
    const [, actionType, targetUserId] = interaction.customId.split(':');

    const modal = new ModalBuilder()
      .setCustomId(`action_modal_submit:${actionType}:${targetUserId}`)
      .setTitle(`Department Action Details`);

    // Dynamically build modal fields based on action type
    if (actionType === 'custom') {
      const customNameInput = new TextInputBuilder()
        .setCustomId('custom_action_name')
        .setLabel('Custom Action Verb')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. transferred, reinstated')
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(customNameInput));

      const rankInput = new TextInputBuilder()
        .setCustomId('role_rank')
        .setLabel('Target Role / Rank (Optional)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. Inspector')
        .setRequired(false);
      modal.addComponents(new ActionRowBuilder().addComponents(rankInput));

      const contextInput = new TextInputBuilder()
        .setCustomId('additional_context')
        .setLabel('Additional Context / Transfer (Optional)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. transferred to Standards Division')
        .setRequired(false);
      modal.addComponents(new ActionRowBuilder().addComponents(contextInput));
    } else if (actionType === 'promote' || actionType === 'demote') {
      const rankInput = new TextInputBuilder()
        .setCustomId('role_rank')
        .setLabel('New Rank / Role')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. Inspector')
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(rankInput));

      const contextInput = new TextInputBuilder()
        .setCustomId('additional_context')
        .setLabel('Additional Context / Transfer (Optional)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. transferred to Standards Division')
        .setRequired(false);
      modal.addComponents(new ActionRowBuilder().addComponents(contextInput));
    } else if (actionType === 'hire') {
      const rankInput = new TextInputBuilder()
        .setCustomId('role_rank')
        .setLabel('Assigned Role / Rank (Optional)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. Security Officer')
        .setRequired(false);
      modal.addComponents(new ActionRowBuilder().addComponents(rankInput));
    } else if (actionType === 'suspend') {
      const contextInput = new TextInputBuilder()
        .setCustomId('additional_context')
        .setLabel('Suspension Duration / Context (Optional)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. for 7 days')
        .setRequired(false);
      modal.addComponents(new ActionRowBuilder().addComponents(contextInput));
    }

    // Notes is optional for all actions
    const notesInput = new TextInputBuilder()
      .setCustomId('notes')
      .setLabel('Notes (Optional)')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('Enter notes or context for this action...')
      .setRequired(false);

    modal.addComponents(new ActionRowBuilder().addComponents(notesInput));

    await interaction.showModal(modal);
  },

  /**
   * Finalizes and posts/updates action embed upon modal submission
   */
  async handleModalSubmit(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const [, actionType, targetUserId] = interaction.customId.split(':');
    
    // Safely retrieve values
    const roleRank = interaction.fields.fields.has('role_rank') ? interaction.fields.getTextInputValue('role_rank')?.trim() : null;
    const additionalContext = interaction.fields.fields.has('additional_context') ? interaction.fields.getTextInputValue('additional_context')?.trim() : null;
    const notes = interaction.fields.getTextInputValue('notes')?.trim();
    let customName = interaction.fields.fields.has('custom_action_name') ? interaction.fields.getTextInputValue('custom_action_name')?.trim() : null;

    const style = ACTION_STYLES[actionType] || ACTION_STYLES.custom;
    const targetUser = await interaction.client.users.fetch(targetUserId).catch(() => null);
    const targetMember = await interaction.guild?.members.fetch(targetUserId).catch(() => null);

    const targetDisplayName = targetMember?.displayName || targetUser?.displayName || targetUser?.username || 'Staff Member';
    const executorDisplayName = interaction.member?.displayName || interaction.user.displayName || interaction.user.username;

    const actionVerb = customName || style.verb || actionType;

    // Construct description dynamically based on action type
    let bodySentence = '';

    if (actionType === 'hire') {
      bodySentence = `**${targetDisplayName}** has been **hired**`;
      if (roleRank) bodySentence += ` as **${roleRank}**`;
      bodySentence += '.';
    } else if (actionType === 'promote' || actionType === 'demote') {
      bodySentence = `**${targetDisplayName}** has been **${actionVerb}** to **${roleRank}**`;
      if (additionalContext) {
        if (additionalContext.toLowerCase().startsWith('and ')) {
          bodySentence += ` ${additionalContext}`;
        } else {
          bodySentence += ` and **${additionalContext}**`;
        }
      }
      bodySentence += '.';
    } else if (actionType === 'adminleave') {
      bodySentence = `**${targetDisplayName}** has been **placed on admin leave**.`;
    } else if (actionType === 'suspend') {
      bodySentence = `**${targetDisplayName}** has been **suspended**`;
      if (additionalContext) bodySentence += ` **${additionalContext}**`;
      bodySentence += '.';
    } else if (actionType === 'terminate') {
      bodySentence = `**${targetDisplayName}** has been **terminated** from staff.`;
    } else if (actionType === 'warn') {
      bodySentence = `**${targetDisplayName}** has been **warned**.`;
    } else {
      // Custom action
      bodySentence = `**${targetDisplayName}** has been **${actionVerb}**`;
      if (roleRank) bodySentence += ` to **${roleRank}**`;
      if (additionalContext) {
        if (additionalContext.toLowerCase().startsWith('and ')) {
          bodySentence += ` ${additionalContext}`;
        } else {
          bodySentence += ` and **${additionalContext}**`;
        }
      }
      bodySentence += '.';
    }

    const embed = new EmbedBuilder()
      .setTitle('Department Action')
      .setColor(style.color)
      .setDescription(bodySentence)
      .setFooter({ text: executorDisplayName });

    if (notes) {
      embed.addFields({ name: 'Notes', value: notes });
    }

    // Check Department Logs channel
    const deptLogsChannel = await interaction.client.channels.fetch(config.channels.departmentLogs).catch(() => null);
    if (!deptLogsChannel || !deptLogsChannel.isTextBased()) {
      return interaction.editReply({
        content: `Error: Department Logs channel (\`${config.channels.departmentLogs}\`) could not be found or is invalid.`
      });
    }

    // Check state update for demote, adminleave, suspend
    const statefulActions = ['demote', 'adminleave', 'suspend'];
    const isStateful = statefulActions.includes(actionType);
    let updatedExisting = false;

    if (isStateful) {
      const existingState = db.getActionState(targetUserId);
      if (existingState && existingState.message_id) {
        try {
          const existingMsg = await deptLogsChannel.messages.fetch(existingState.message_id).catch(() => null);
          if (existingMsg) {
            // Update existing embed description & notes
            const updatedEmbed = EmbedBuilder.from(embed);
            await existingMsg.edit({ embeds: [updatedEmbed] });
            db.saveActionState(targetUserId, actionType, deptLogsChannel.id, existingMsg.id);
            updatedExisting = true;
          }
        } catch (err) {
          console.error('[ACTION ERROR] Error updating existing embed:', err.message);
        }
      }
    }

    if (!updatedExisting) {
      const sentMsg = await deptLogsChannel.send({ embeds: [embed] });
      db.saveActionState(targetUserId, actionType, deptLogsChannel.id, sentMsg.id);
    }

    await interaction.editReply({
      content: `Department Action for **${targetDisplayName}** has been posted to <#${config.channels.departmentLogs}>.`
    });
  }
};
