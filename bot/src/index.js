const logger = require('./services/logger');
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const config = require('./config');
const actionCommand = require('./commands/action');
const autologCommand = require('./commands/autolog');
const debugCommand = require('./commands/debug');
const readyEvent = require('./events/ready');
const interactionCreateEvent = require('./events/interactionCreate');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

client.commands = new Collection();
client.commands.set(actionCommand.data.name, actionCommand);
client.commands.set(autologCommand.data.name, autologCommand);
client.commands.set(debugCommand.data.name, debugCommand);

// Register events
client.once(readyEvent.name, (...args) => readyEvent.execute(...args));
client.on(interactionCreateEvent.name, (...args) => interactionCreateEvent.execute(...args));

// Register client error handlers to prevent unhandled EventEmitter error crashes
client.on('error', error => {
  console.error('[DISCORD CLIENT ERROR]', error);
});

client.on('shardError', error => {
  console.error('[DISCORD SHARD ERROR]', error);
});

// Graceful shutdown & global error handling
process.on('SIGINT', () => {
  console.log('[BOT SHUTDOWN] Shutting down bot client...');
  client.destroy();
  process.exit(0);
});

process.on('unhandledRejection', error => {
  console.error('[UNHANDLED REJECTION]', error);
});

process.on('uncaughtException', error => {
  console.error('[UNCAUGHT EXCEPTION]', error);
});

client.login(config.token).catch(err => {
  console.error('[LOGIN ERROR] Failed to log in with Discord token:', err.message);
});
