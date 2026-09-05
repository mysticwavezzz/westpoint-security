const fs = require('fs');
const path = require('path');

// The web portal's server.js is the only writer of incidents.json - this is
// a read-only lookup so the bot can include an incident count on the Shift
// End Summary Card. Same DATA_DIR convention as server.js, and the same
// relative fallback resolves to the same directory when unset (both
// processes are children of the same project root).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../../data');

function readIncidents() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'incidents.json'), 'utf8'));
  } catch (e) {
    return [];
  }
}

// Counts incidents a given officer filed with a timestamp inside
// [startTime, endTime) - used to show "incidents filed this shift" on the
// Shift End Summary Card.
function getIncidentCountInRange(officerId, startTime, endTime) {
  const incidents = readIncidents();
  return incidents.filter(i => {
    if (i.officerId !== officerId) return false;
    const ts = new Date(i.timestamp).getTime();
    return ts >= startTime && ts <= endTime;
  }).length;
}

module.exports = { getIncidentCountInRange };
