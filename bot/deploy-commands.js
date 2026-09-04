const { REST, Routes } = require('discord.js');
const fs = require('fs');

const envPath = 'C:\\Users\\Nolan\\Documents\\antigravity\\resilient-meitner\\.env';
const env = {};
fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
  const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
  if (m) env[m[1]] = m[2].trim();
});

const token = env.DISCORD_TOKEN;
const clientId = env.CLIENT_ID;
const guildId = env.GUILD_ID;

const commands = [
  {
    name: 'autolog',
    description: 'Manage your Roblox staff autolog session',
    options: [
      {
        name: 'action',
        description: 'Action to perform (Start, End, or Status)',
        type: 3,
        required: true,
        choices: [
          { name: 'Start', value: 'start' },
          { name: 'End', value: 'end' },
          { name: 'Status', value: 'status' }
        ]
      }
    ]
  },
  {
    name: 'action',
    description: 'Issue a staff management action',
    options: [
      {
        name: 'type',
        description: 'Type of action to issue',
        type: 3,
        required: true,
        choices: [
          { name: 'Hire', value: 'hire' },
          { name: 'Promote', value: 'promote' },
          { name: 'Demote', value: 'demote' },
          { name: 'Terminate', value: 'terminate' },
          { name: 'Admin Leave', value: 'adminleave' },
          { name: 'Suspend', value: 'suspend' },
          { name: 'Warn', value: 'warn' },
          { name: 'Custom Action', value: 'custom' }
        ]
      }
    ]
  }
];

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    console.log('[DEPLOY] Registering to Primary Guild 1522793078199419022...');
    const g1 = await rest.put(
      Routes.applicationGuildCommands(clientId, guildId),
      { body: commands }
    );
    console.log(`[GUILD 1 SUCCESS] Registered ${g1.length} commands.`);

    console.log('[DEPLOY] Registering to Testing Guild 1540023207082463272...');
    const g2 = await rest.put(
      Routes.applicationGuildCommands(clientId, '1540023207082463272'),
      { body: commands }
    );
    console.log(`[GUILD 2 SUCCESS] Registered ${g2.length} commands.`);

    console.log('[DEPLOY] Registering to Global...');
    const gl = await rest.put(
      Routes.applicationCommands(clientId),
      { body: commands }
    );
    console.log(`[GLOBAL SUCCESS] Registered ${gl.length} commands.`);
  } catch(e) {
    console.error('[DEPLOY ERROR]', e);
  }
})();
