const { MessageFlags } = require('discord.js');
const actionCommand = require('../commands/action');
const bodycamTrim = require('../commands/bodycamTrim');
const logger = require('../services/logger');

module.exports = {
  name: 'interactionCreate',
  async execute(interaction) {
    try {
      if (interaction.isChatInputCommand()) {
        const command = interaction.client.commands.get(interaction.commandName);
        if (!command) {
          console.error(`No command matching ${interaction.commandName} was found.`);
          return;
        }

        // Log every command execution to history
        const opts = {};
        interaction.options.data.forEach(o => {
          opts[o.name] = o.value ?? (o.user ? o.user.tag : true);
        });
        logger.logCommandRun(interaction.commandName, interaction.user.id, interaction.user.tag, opts);

        await command.execute(interaction);
        return;
      }

      if (interaction.isUserSelectMenu()) {
        if (interaction.customId.startsWith('action_select_user:')) {
          await actionCommand.handleUserSelect(interaction);
        }
        return;
      }

      if (interaction.isButton()) {
        if (interaction.customId.startsWith('action_open_modal:')) {
          await actionCommand.handleOpenModal(interaction);
        } else if (interaction.customId.startsWith('bodycam_trim_open:')) {
          await bodycamTrim.handleOpenModal(interaction);
        }
        return;
      }

      if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith('action_modal_submit:')) {
          await actionCommand.handleModalSubmit(interaction);
        } else if (interaction.customId.startsWith('bodycam_trim_submit:')) {
          await bodycamTrim.handleModalSubmit(interaction);
        }
        return;
      }
    } catch (error) {
      console.error('[EVENT ERROR] Error in interactionCreate event:', error);
      const errorMessage = {
        content: 'An error occurred while processing this interaction.',
        flags: MessageFlags.Ephemeral
      };

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(errorMessage).catch(() => {});
      } else {
        await interaction.reply(errorMessage).catch(() => {});
      }
    }
  }
};
