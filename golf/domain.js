const DAY_MS = 86_400_000;

export function dateInTimeZone(instant, timeZone = 'Europe/Copenhagen') {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(instant));
  const value = type => parts.find(part => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export class LeagueError extends Error {
  constructor(message, code = 'INVALID_INPUT') {
    super(message);
    this.name = 'LeagueError';
    this.code = code;
  }
}

// Date-only values use UTC arithmetic; no browser time-zone or DST conversion.
export function addDays(date, amount) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + amount * DAY_MS).toISOString().slice(0, 10);
}

export function mondayOf(date) {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

export function mapForDate(date, config) {
  return config.mapAnchor.number + Math.round(
    (Date.parse(`${date}T12:00:00Z`) - Date.parse(`${config.mapAnchor.date}T12:00:00Z`)) / DAY_MS,
  );
}

export function dateForMap(number, config) {
  return addDays(config.mapAnchor.date, number - config.mapAnchor.number);
}

export function weekDates(start, config) {
  return config.weekdays.map(day => addDays(start, (day + 6) % 7)).sort();
}

export function formatDate(date, options = {}) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...options })
    .format(new Date(`${date}T12:00:00Z`));
}

export function weekNumber(date) {
  const thursday = addDays(mondayOf(date), 3);
  const yearStart = `${thursday.slice(0, 4)}-01-01`;
  return Math.floor((Date.parse(`${thursday}T12:00:00Z`) - Date.parse(`${yearStart}T12:00:00Z`)) / DAY_MS / 7) + 1;
}

export function parseScore(input) {
  if (typeof input !== 'string' || input.length > 12000) {
    throw new LeagueError('Paste a single result from the game.');
  }
  const rawText = input.replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n').trim();
  const maps = [...rawText.matchAll(/#(\d+)\b/g)].map(match => Number(match[1]));
  if (maps.length !== 1 || !Number.isSafeInteger(maps[0]) || maps[0] < 1 || maps[0] > 1_000_000) {
    throw new LeagueError('We couldn’t find one map number, such as #561. Paste one complete result.');
  }
  const lines = rawText.split('\n').map(line => line.trim()).filter(Boolean);
  const totalLines = lines.filter(line => line.includes('📝'));
  const totalMatch = totalLines.length === 1 && totalLines[0].match(/^📝\uFE0F?\s*(\d+)\s*$/u);
  const total = totalMatch ? Number(totalMatch[1]) : NaN;
  if (!Number.isSafeInteger(total) || total < 1 || total > 10000) {
    throw new LeagueError('We couldn’t read the total. Include the line that looks like 📝 25.');
  }
  const checkpoints = [];
  for (const line of lines.filter(line => /^\d+\s*\./u.test(line))) {
    const match = line.match(/^(\d+)\.\s*(?:⛳\uFE0F?|🏌\uFE0F?(?:\u200D[♂♀]\uFE0F?)?)\s*(\d+|[-–—])\s*$/u);
    if (!match) throw new LeagueError('One checkpoint line looks incomplete. Paste the full result from the game.');
    const index = Number(match[1]);
    const shots = /^\d+$/.test(match[2]) ? Number(match[2]) : null;
    if (!Number.isSafeInteger(index) || checkpoints.some(checkpoint => checkpoint.index === index)) {
      throw new LeagueError('The checkpoint numbers look incorrect or repeated. Try copying the result again.');
    }
    if (shots !== null && (!Number.isSafeInteger(shots) || shots > 10000)) {
      throw new LeagueError('One checkpoint has an invalid shot count.');
    }
    checkpoints.push({ index, shots });
  }
  if (!checkpoints.length || !checkpoints.some(checkpoint => checkpoint.index === 0)) {
    throw new LeagueError('Include the checkpoint breakdown, starting with 0.🏌️.');
  }
  if (checkpoints.reduce((sum, checkpoint) => sum + (checkpoint.shots ?? 0), 0) !== total) {
    throw new LeagueError('The checkpoint shots don’t add up to the total. Paste the complete result again.');
  }
  return { mapNumber: maps[0], total, checkpoints: checkpoints.sort((a, b) => b.index - a.index), rawText };
}

export function standingsForWeek(league, start) {
  const dates = weekDates(start, league.config);
  const dueDates = dates.filter(date => date <= league.config.today);
  const maps = dates.map(date => mapForDate(date, league.config));
  const dueMaps = dueDates.map(date => mapForDate(date, league.config));
  const submittedScores = league.scores.filter(score => !score.assigned && dueMaps.includes(score.mapNumber));
  const scores = [...submittedScores];
  for (const date of dates.filter(date => date < league.config.today)) {
    const mapNumber = mapForDate(date, league.config);
    const played = submittedScores.filter(score => score.mapNumber === mapNumber);
    if (!played.length) continue;
    const highestTotal = Math.max(...played.map(score => score.total));
    for (const player of league.players) {
      if (!played.some(score => score.playerId === player.id)) {
        scores.push({ playerId: player.id, mapNumber, courseDate: date,
          total: highestTotal + 1, assigned: true, highestTotal });
      }
    }
  }
  const rows = league.players.map(player => {
    const rounds = scores.filter(score => score.playerId === player.id);
    const total = rounds.reduce((sum, round) => sum + round.total, 0);
    const complete = dueDates.length > 0 && rounds.length === dueDates.length;
    return { player, rounds, total, complete, rank: null };
  }).filter(row => row.rounds.length || row.player.id === league.identity?.id);
  rows.sort((a, b) => Number(b.complete) - Number(a.complete)
    || (a.complete ? a.total - b.total : b.rounds.length - a.rounds.length || a.total - b.total)
    || a.player.name.localeCompare(b.player.name));
  let lastTotal;
  let lastRank;
  rows.filter(row => row.complete).forEach((row, index) => {
    row.rank = row.total === lastTotal ? lastRank : index + 1;
    lastTotal = row.total;
    lastRank = row.rank;
  });
  const bestByMap = Object.fromEntries(maps.map(map => {
    const totals = submittedScores.filter(score => score.mapNumber === map).map(score => score.total);
    return [map, totals.length ? Math.min(...totals) : null];
  }));
  return { dates, maps, dueDates, rows, bestByMap, scores };
}

export function awardsForWeek(league, start) {
  const standings = standingsForWeek(league, start);
  const complete = standings.rows.filter(row => row.complete);
  if (!complete.length) return { winners: [], last: [], standings };
  return {
    winners: complete.filter(row => row.total === complete[0].total),
    last: complete.length > 1 ? complete.filter(row => row.total === complete.at(-1).total) : [],
    standings,
  };
}

export function courseForMap(league, mapNumber) {
  return league.courses?.find(course => course.mapNumber === mapNumber
    && course.courseDate === dateForMap(mapNumber, league.config)) ?? null;
}

export function handicapForPlayer(league, playerId, beforeMap) {
  const rounds = league.scores.filter(score => !score.assigned && score.playerId === playerId && score.mapNumber < beforeMap)
    .map(score => ({ score, course: courseForMap(league, score.mapNumber) }))
    .filter(({ course }) => Number.isSafeInteger(course?.par) && course.par > 0)
    .sort((a, b) => b.score.mapNumber - a.score.mapNumber).slice(0, 20);
  const handicap = rounds.length >= 3
    ? Math.round(rounds.reduce((sum, { score, course }) => sum + score.total - course.par, 0) / rounds.length * 10) / 10
    : null;
  const course = courseForMap(league, beforeMap);
  return { handicap, rounds: rounds.length,
    expected: handicap !== null && course ? Math.max(1, Math.round(course.par + handicap)) : null };
}

export function roundStats(league, score) {
  const totals = league.scores.filter(round => !round.assigned && round.mapNumber === score.mapNumber).map(round => round.total);
  const course = courseForMap(league, score.mapNumber);
  const historical = handicapForPlayer(league, score.playerId, score.mapNumber);
  return {
    players: totals.length,
    rank: 1 + totals.filter(total => total < score.total).length,
    topPercent: totals.length ? Math.ceil(totals.filter(total => total <= score.total).length / totals.length * 100) : null,
    average: totals.length ? totals.reduce((sum, total) => sum + total, 0) / totals.length : null,
    versusPar: course ? score.total - course.par : null,
    versusExpected: historical.expected === null ? null : score.total - historical.expected,
    global: course?.source === 'game' ? course.percentiles?.[score.total] ?? null : null,
  };
}

export function playerStats(league, playerId) {
  const rounds = league.scores.filter(score => !score.assigned && score.playerId === playerId
    && score.mapNumber <= mapForDate(league.config.today, league.config));
  return { rounds: rounds.length,
    average: rounds.length ? rounds.reduce((sum, score) => sum + score.total, 0) / rounds.length : null,
    best: rounds.length ? Math.min(...rounds.map(score => score.total)) : null,
  };
}

export function bonusStandings(league, mapNumber) {
  const rows = (league.bonusScores ?? []).filter(score => score.mapNumber === mapNumber)
    .map(score => ({ score, player: league.players.find(player => player.id === score.playerId) }))
    .filter(row => row.player)
    .sort((a, b) => a.score.total - b.score.total || a.player.name.localeCompare(b.player.name));
  let lastTotal;
  let lastRank;
  return rows.map((row, index) => {
    const rank = row.score.total === lastTotal ? lastRank : index + 1;
    lastTotal = row.score.total;
    lastRank = rank;
    return { ...row, rank };
  });
}
