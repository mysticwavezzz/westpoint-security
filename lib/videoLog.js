// Discord REST helpers for the bodycam video-log feature: per-officer
// channel creation, posting a video (with an embed + Trim button, splitting
// across multiple messages if the file is too big for one upload), fetching
// a message back, and clearing a channel's messages weekly.
//
// Uses discord.js's REST client directly rather than the gateway Client -
// none of this needs a live gateway connection, only the bot process (which
// does hold that connection) needs it, to receive the Trim button's clicks.

const { REST, Routes } = require('discord.js');
const fs = require('fs');

// The commonly-cited "25MB default" is wrong for this bot/guild: probed
// directly against the real westpointsecurity Discord app (both the bot
// testing server and the main guild are boost tier 0) by uploading
// progressively larger files until the API started rejecting them - 20MB
// succeeded, 20.5MB failed with DiscordAPIError 40005 "Request entity too
// large". The real ceiling here is ~21MB, not 25MB. At the old 24MB
// constant, most real shifts (whose parts land in the 20-23MB range) would
// have had every video part silently fail to upload - a likely cause of
// reports that bodycam video uploads just don't go through. 18MB leaves a
// safe margin under the measured ~21MB failure point.
const DISCORD_FILE_LIMIT_BYTES = 18 * 1024 * 1024;

function getClient(token) {
  return new REST({ version: '10' }).setToken(token);
}

function slugifyChannelName(name) {
  const slug = String(name || 'officer')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
  return slug || 'officer';
}

async function fetchChannel(token, channelId) {
  return getClient(token).get(Routes.channel(channelId));
}

// Creates a new text channel for an officer's video logs, nested under
// VIDEO_LOG_PARENT_ID if that's actually a category (Discord rejects
// parent_id pointing at a non-category channel) - falls back to whatever
// category that parent channel itself belongs to, or no category at all.
async function createOfficerChannel(token, guildId, parentId, channelName) {
  const rest = getClient(token);
  let parent = null;
  try {
    parent = await rest.get(Routes.channel(parentId));
  } catch (e) {}

  const body = { name: slugifyChannelName(channelName), type: 0 };
  if (parent && parent.type === 4) {
    body.parent_id = parentId;
  } else if (parent && parent.parent_id) {
    body.parent_id = parent.parent_id;
  }
  return rest.post(Routes.guildChannels(guildId), { body });
}

async function postMessage(token, channelId, payload, filePaths = []) {
  const rest = getClient(token);
  if (!filePaths || filePaths.length === 0) {
    return rest.post(Routes.channelMessages(channelId), { body: payload });
  }
  const files = filePaths.map((f, i) => ({
    name: (f && f.name) || `video-${i}.mp4`,
    data: fs.readFileSync((f && f.path) || f)
  }));
  return rest.post(Routes.channelMessages(channelId), { body: payload, files });
}

async function fetchMessage(token, channelId, messageId) {
  return getClient(token).get(Routes.channelMessage(channelId, messageId));
}

// Deletes every message in a channel. Bulk-delete only accepts messages
// under 14 days old, which always holds here since channels are cleared
// weekly - falls back to one-at-a-time delete for the single-message case
// bulk-delete doesn't support.
async function clearChannel(token, channelId) {
  const rest = getClient(token);
  let cleared = 0;
  for (;;) {
    const messages = await rest.get(Routes.channelMessages(channelId), { query: new URLSearchParams({ limit: '100' }) });
    if (!messages || messages.length === 0) break;
    const ids = messages.map(m => m.id);
    if (ids.length === 1) {
      await rest.delete(Routes.channelMessage(channelId, ids[0])).catch(() => {});
    } else {
      await rest.post(Routes.channelBulkDelete(channelId), { body: { messages: ids } }).catch(() => {});
    }
    cleared += ids.length;
    if (ids.length < 100) break;
  }
  return cleared;
}

module.exports = {
  DISCORD_FILE_LIMIT_BYTES,
  slugifyChannelName,
  fetchChannel,
  createOfficerChannel,
  postMessage,
  fetchMessage,
  clearChannel
};
