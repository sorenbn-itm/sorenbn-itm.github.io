import { leagueConfig } from './config.js';
import { addDays, dateForMap, LeagueError, mapForDate, mondayOf, parseScore, weekDates } from './domain.js';

const STORAGE_KEY = 'office-open.mock.v1';
const VERSION = 1;
const pause = () => new Promise(resolve => setTimeout(resolve, 180));
const copy = value => structuredClone(value);

const samplePlayers = [
  { id: 'sample-alex', name: 'Alex Morgan', color: '#e4e9d3', ink: '#6b7f4c' },
  { id: 'sample-jamie', name: 'Jamie Chen', color: '#f0e2d5', ink: '#ad7857' },
  { id: 'sample-sam', name: 'Sam Taylor', color: '#e3e7ef', ink: '#71829a' },
  { id: 'sample-robin', name: 'Robin Jensen', color: '#eae1ee', ink: '#9a7da2' },
  { id: 'sample-charlie', name: 'Charlie Davis', color: '#e9e5d7', ink: '#9d8b56' },
  { id: 'sample-morgan', name: 'Morgan Lee', color: '#dce9e3', ink: '#5b8d7c' },
];

function sampleRound(playerId, mapNumber, total) {
  const checkpointCount = 4 + ((mapNumber + 2) % 9);
  const base = Math.floor(total / checkpointCount);
  const remainder = total % checkpointCount;
  const checkpoints = Array.from({ length: checkpointCount }, (_, index) => ({
    index, shots: base + (index < remainder ? 1 : 0),
  })).reverse();
  const rawText = `Kinda Hard Golf #${mapNumber}\n📝 ${total}\n\n${checkpoints.map(checkpoint =>
    `${checkpoint.index}.${checkpoint.index === 0 ? '🏌️' : '⛳'} ${checkpoint.shots}`).join('\n')}\n\nhttps://kindahard.golf/`;
  return { playerId, mapNumber, total, checkpoints, rawText, courseDate: dateForMap(mapNumber, leagueConfig) };
}

function seedDatabase() {
  const start = mondayOf(leagueConfig.today);
  const currentResults = [[18, 23, 21, 22], [21, 25, 19, 24], [22, 24, 23, 20],
    [26, 22, 28, 25], [25, 29, 24, 31], [23, null, 27, null]];
  const scores = [];
  currentResults.forEach((totals, playerIndex) => totals.forEach((total, day) => {
    if (total !== null) scores.push(sampleRound(samplePlayers[playerIndex].id,
      mapForDate(addDays(start, day), leagueConfig), total));
  }));
  for (let week = 1; week <= leagueConfig.archiveWeeks; week++) {
    weekDates(addDays(start, -7 * week), leagueConfig).forEach((date, day) => {
      samplePlayers.forEach((player, index) => {
        const total = 19 + ((index * 5 + day * 7 + week * 3) % 17);
        scores.push(sampleRound(player.id, mapForDate(date, leagueConfig), total));
      });
    });
  }
  return { version: VERSION, identityId: null, players: copy(samplePlayers), scores };
}

function validDatabase(data) {
  if (!data || data.version !== VERSION || !Array.isArray(data.players) || !Array.isArray(data.scores)) return false;
  const ids = new Set();
  const names = new Set();
  for (const player of data.players) {
    if (typeof player.id !== 'string' || typeof player.name !== 'string' || !player.name.trim()
      || player.name.length > 24 || ids.has(player.id) || names.has(player.name.toLocaleLowerCase('en'))) return false;
    ids.add(player.id);
    names.add(player.name.toLocaleLowerCase('en'));
  }
  if (data.identityId !== null && !ids.has(data.identityId)) return false;
  const rounds = new Set();
  for (const score of data.scores) {
    if (!ids.has(score.playerId) || !Number.isSafeInteger(score.mapNumber)
      || !Number.isSafeInteger(score.total) || !Array.isArray(score.checkpoints)) return false;
    const key = `${score.playerId}:${score.mapNumber}`;
    if (rounds.has(key)) return false;
    rounds.add(key);
    try {
      const parsed = parseScore(score.rawText);
      if (parsed.total !== score.total || parsed.mapNumber !== score.mapNumber
        || JSON.stringify(parsed.checkpoints) !== JSON.stringify(score.checkpoints)) return false;
    } catch { return false; }
  }
  return true;
}

function loadDatabase() {
  let serialized;
  try { serialized = localStorage.getItem(STORAGE_KEY); }
  catch { throw new LeagueError('Browser storage is unavailable. Allow site storage to save your name and scores.', 'STORAGE_UNAVAILABLE'); }
  if (!serialized) return seedDatabase();
  try {
    const data = JSON.parse(serialized);
    if (validDatabase(data)) return data;
  } catch { /* Keep an unreadable saved file intact until the player resets it. */ }
  throw new LeagueError('The saved demo data could not be read. Export it for safekeeping or reset the demo below.', 'STORAGE_INVALID');
}

function persist(data) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }
  catch { throw new LeagueError('Your browser couldn’t save this change. Check that site storage is allowed and has space.', 'STORAGE_UNAVAILABLE'); }
}

function identityFrom(data) {
  return data.players.find(player => player.id === data.identityId) ?? null;
}

// Replace this adapter with a Supabase implementation using the same async methods.
// All writes are validated here, independent of the page's input controls.
export const database = {
  async getLeague() {
    await pause();
    const data = loadDatabase();
    return copy({ config: leagueConfig, players: data.players, scores: data.scores, identity: identityFrom(data) });
  },

  async registerPlayer(name) {
    await pause();
    const data = loadDatabase();
    if (identityFrom(data)) throw new LeagueError('This browser already has a name.');
    const cleanName = typeof name === 'string' ? name.normalize('NFKC').replace(/\s+/g, ' ').trim() : '';
    if (cleanName.length < 2 || cleanName.length > 24 || /[\p{Cc}\p{Cf}]/u.test(cleanName)) {
      throw new LeagueError('Choose a name between 2 and 24 characters.');
    }
    if (data.players.some(player => player.name.toLocaleLowerCase('en') === cleanName.toLocaleLowerCase('en'))) {
      throw new LeagueError('That name is already taken. Try adding an initial.');
    }
    const player = { id: crypto.randomUUID(), name: cleanName, color: '#dfe9ce', ink: '#607e42' };
    data.players.push(player);
    data.identityId = player.id;
    persist(data);
    return copy(player);
  },

  async submitScore({ rawText }) {
    await pause();
    const data = loadDatabase();
    const player = identityFrom(data);
    if (!player) throw new LeagueError('Enter your name before submitting a score.', 'IDENTITY_REQUIRED');
    const parsed = parseScore(rawText);
    const courseDate = dateForMap(parsed.mapNumber, leagueConfig);
    const firstDate = addDays(mondayOf(leagueConfig.today), -7 * leagueConfig.archiveWeeks);
    if (courseDate > leagueConfig.today) throw new LeagueError('That map is in the future for this demo. Try map #561 or an earlier weekday.');
    if (courseDate < firstDate) throw new LeagueError('That map is outside this demo’s four-week season. Try the example score.');
    if (!leagueConfig.weekdays.includes(new Date(`${courseDate}T12:00:00Z`).getUTCDay())) {
      throw new LeagueError('That map falls on a weekend. This league counts Monday to Friday.');
    }
    const existingIndex = data.scores.findIndex(score => score.playerId === player.id && score.mapNumber === parsed.mapNumber);
    if (existingIndex >= 0) throw new LeagueError('You already submitted a score for this map. Scores are final.', 'SCORE_EXISTS');
    const result = { ...parsed, playerId: player.id, courseDate, submittedAt: new Date().toISOString() };
    data.scores.push(result);
    persist(data);
    return copy(result);
  },

  async exportData() {
    await pause();
    // Read the saved text directly so export also works for damaged data.
    try { return localStorage.getItem(STORAGE_KEY) ?? JSON.stringify(seedDatabase(), null, 2); }
    catch { throw new LeagueError('Browser storage is unavailable.'); }
  },

  async resetDemo() {
    await pause();
    persist(seedDatabase());
  },
};

export { STORAGE_KEY };
