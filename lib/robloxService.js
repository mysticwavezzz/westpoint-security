const axios = require('axios');

// In-memory cache for resolved Roblox accounts (lowercase candidate name -> { id, name })
const USER_CACHE = new Map();

/**
 * Resolves candidates from Discord profile to a Roblox user.
 * Tries: Nickname, Display Name, Username, and stripped brackets/tags.
 * @param {Array<string>} candidateNames
 * @returns {Promise<{id: number, name: string} | null>}
 */
async function resolveRobloxUser(candidateNames) {
  const cleaned = [];
  for (const raw of candidateNames) {
    if (!raw) continue;
    cleaned.push(raw.trim());
    // Strip common tags like "[CPO] Mystic", "(Sgt) Nolan", "Mystic | CPO"
    const stripped1 = raw.replace(/^\[[^\]]+\]\s*/, '').replace(/^\([^)]+\)\s*/, '').trim();
    if (stripped1 && !cleaned.includes(stripped1)) cleaned.push(stripped1);
    const stripped2 = raw.split('|')[0].trim();
    if (stripped2 && !cleaned.includes(stripped2)) cleaned.push(stripped2);
    const stripped3 = raw.split('-')[0].trim();
    if (stripped3 && !cleaned.includes(stripped3)) cleaned.push(stripped3);
  }

  const uniqueCandidates = Array.from(new Set(cleaned.filter(n => n.length >= 3 && n.length <= 20)));

  // 1. Check in-memory cache
  for (const name of uniqueCandidates) {
    const cached = USER_CACHE.get(name.toLowerCase());
    if (cached) return cached;
  }

  // 2. Try POST usernames/users API
  for (const name of uniqueCandidates) {
    try {
      const response = await axios.post('https://users.roblox.com/v1/usernames/users', {
        usernames: [name],
        excludeBannedUsers: false
      }, {
        timeout: 4000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      if (response.data && response.data.data && response.data.data.length > 0) {
        const user = response.data.data[0];
        const res = { id: user.id, name: user.name };
        USER_CACHE.set(name.toLowerCase(), res);
        USER_CACHE.set(user.name.toLowerCase(), res);
        return res;
      }
    } catch (e) {}
  }

  // 3. Fallback: Try GET users/search endpoint (immune to POST usernames/users 429 rate limit)
  for (const name of uniqueCandidates) {
    try {
      const getRes = await axios.get(`https://users.roblox.com/v1/users/search?keyword=${encodeURIComponent(name)}&limit=10`, {
        timeout: 4000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      const list = getRes.data?.data || [];
      const exact = list.find(u => u.name.toLowerCase() === name.toLowerCase()) || list[0];
      if (exact) {
        const res = { id: exact.id, name: exact.name };
        USER_CACHE.set(name.toLowerCase(), res);
        USER_CACHE.set(exact.name.toLowerCase(), res);
        return res;
      }
    } catch (e) {}
  }

  return null;
}

/**
 * Resolves a Roblox username to a User ID.
 * @param {string} username
 * @returns {Promise<{id: number, name: string} | null>}
 */
async function getUserIdFromUsername(username) {
  return resolveRobloxUser([username]);
}

/**
 * Fetches presence info for an array of Roblox User IDs.
 * @param {number[]} userIds
 * @returns {Promise<Array<object>>}
 */
async function getUserPresences(userIds) {
  try {
    if (!userIds || userIds.length === 0) return [];
    const response = await axios.post('https://presence.roblox.com/v1/presence/users', {
      userIds: userIds.map(id => Number(id))
    });

    if (response.data && response.data.userPresences) {
      return response.data.userPresences;
    }
    return [];
  } catch (error) {
    console.error('[ROBLOX API ERROR] Failed to fetch presences:', error.message);
    return [];
  }
}

/**
 * Known universe/place IDs for Harrison County.
 */
const KNOWN_HARRISON_IDS = [
  '10659924817', // Place ID
  '3864041377'   // Universe ID
];

/**
 * Verifies if a user is currently in the specified Roblox game.
 * @param {string|Array<string>} names Discord nickname / username candidate(s)
 * @param {string|number} targetGameId The required Game/Place ID (e.g. 10659924817)
 * @returns {Promise<{inGame: boolean, reason?: string, robloxId?: number, robloxUsername?: string}>}
 */
async function verifyUserInGame(names, targetGameId) {
  const candidateList = Array.isArray(names) ? names : [names];
  const robloxUser = await resolveRobloxUser(candidateList);

  if (!robloxUser) {
    return {
      inGame: false,
      reason: `Could not find a matching Roblox account for: ${candidateList.filter(Boolean).map(n => `\`${n}\``).join(', ')}. Please make sure your Discord Server Nickname or Username matches your Roblox username.`
    };
  }

  const presences = await getUserPresences([robloxUser.id]);
  if (!presences || presences.length === 0) {
    return {
      inGame: false,
      reason: `Failed to retrieve Roblox presence data for \`${robloxUser.name}\`.`,
      robloxId: robloxUser.id,
      robloxUsername: robloxUser.name
    };
  }

  const presence = presences[0];
  const targetIdStr = String(targetGameId);

  // PresenceType: 2 = InGame, 1 = Online, 3 = Studio
  const isOnlineInGame = presence.userPresenceType === 2;
  const locationMatches = presence.lastLocation && /harrison/i.test(presence.lastLocation);
  const matchesGame = String(presence.placeId) === targetIdStr ||
                      String(presence.rootPlaceId) === targetIdStr ||
                      String(presence.universeId) === targetIdStr ||
                      String(presence.gameId) === targetIdStr ||
                      KNOWN_HARRISON_IDS.includes(String(presence.placeId)) ||
                      KNOWN_HARRISON_IDS.includes(String(presence.rootPlaceId)) ||
                      KNOWN_HARRISON_IDS.includes(String(presence.universeId)) ||
                      locationMatches;

  if (!isOnlineInGame) {
    return {
      inGame: false,
      reason: `User \`${robloxUser.name}\` is not currently in a Roblox game (Presence: ${presence.lastLocation || 'Offline/Website'}). Please launch Roblox and join Harrison County.`,
      robloxId: robloxUser.id,
      robloxUsername: robloxUser.name,
      presence
    };
  }

  // If user is confirmed in an explicitly different game with a known ID
  const isDifferentGame = presence.placeId && !matchesGame;
  if (isDifferentGame) {
    return {
      inGame: false,
      reason: `User \`${robloxUser.name}\` is playing a different game (Place: \`${presence.placeId}\`). Must be in [Harrison County](https://www.roblox.com/games/${targetIdStr}).`,
      robloxId: robloxUser.id,
      robloxUsername: robloxUser.name,
      presence
    };
  }

  // If user is In-Game, but placeId is null (masked by Roblox privacy settings)
  const isPrivacyRestricted = !presence.placeId && !presence.universeId && !locationMatches;
  let privacyNotice = null;
  if (isPrivacyRestricted) {
    privacyNotice = `Notice: Your Roblox Privacy Settings are hiding your game location (Place: private). Set 'Who can join me in experiences' to 'Everyone' in Roblox Privacy settings, or attach in-game screenshot proof.`;
  }

  return {
    inGame: true,
    robloxId: robloxUser.id,
    robloxUsername: robloxUser.name,
    presence,
    isPrivacyRestricted,
    matchesGame,
    privacyNotice
  };
}

module.exports = {
  resolveRobloxUser,
  getUserIdFromUsername,
  getUserPresences,
  verifyUserInGame,
  KNOWN_HARRISON_IDS
};
