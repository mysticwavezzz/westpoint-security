require('dotenv').config();

const requiredEnvVars = [
  'DISCORD_TOKEN',
  'CLIENT_ID',
  'GUILD_ID',
  'DEPARTMENT_LOGS_CHANNEL_ID',
  'AUTOLOG_CHANNEL_ID',
  'AUDIT_LOGS_CHANNEL_ID'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`[CONFIG ERROR] Missing required environment variable: ${envVar}`);
  }
}

module.exports = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID || '1540023346794856540',
  guildId: process.env.GUILD_ID || '1522793078199419022',
  channels: {
    departmentLogs: process.env.DEPARTMENT_LOGS_CHANNEL_ID || '1542980017472929944',
    autolog: process.env.AUTOLOG_CHANNEL_ID || '1540024507761164348',
    auditLogs: process.env.AUDIT_LOGS_CHANNEL_ID || '1540024507761164348'
  },
  roblox: {
    gameId: process.env.ROBLOX_GAME_ID || '10659924817',
    pollIntervalMs: parseInt(process.env.AUTOLOG_POLL_INTERVAL_MS, 10) || 60000
  }
};
