import { exampleScore, leagueConfig } from './config.js';
import { addDays, awardsForWeek, dateForMap, formatDate, mapForDate, mondayOf, parseScore,
  standingsForWeek, weekNumber, courseForMap, handicapForPlayer, playerStats, roundStats } from './domain.js';
import { loadCourseData } from './course-data.js';
import { database, STORAGE_KEY } from './mock-db.js';

const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const currentStart = mondayOf(leagueConfig.today);
const firstStart = addDays(currentStart, -7 * leagueConfig.archiveWeeks);
let selectedStart = currentStart;
let league;
let preview = null;
let saving = false;
let toastTimeout;
let statsPlayerId;
let courseDataError = false;
const signed = number => number > 0 ? `+${number}` : number === 0 ? 'Even' : String(number);
const globalGroup = value => value < 1 ? 'top <1%' : `top ${Math.round(value)}%`;
const stat = (label, value, detail = '') => `<div class="stat"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>${detail ? `<small>${escapeHtml(detail)}</small>` : ''}</div>`;

function courseNote(course) {
  if (!course) return courseDataError ? 'Game stats unavailable · retry by reloading' : 'Game stats not collected for this map';
  if (course.source === 'sample') return `Sample par ${course.par}${courseDataError ? ' · game stats unavailable' : ''}`;
  const collected = new Intl.DateTimeFormat('en-GB', { timeZone: league.config.timeZone,
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(course.fetchedAt));
  return `Par ${course.par} · collected ${collected} Copenhagen time`;
}

function renderPlayerStats() {
  const select = $('#stats-player');
  if (!league.players.some(player => player.id === statsPlayerId)) statsPlayerId = league.identity?.id ?? league.players[0]?.id;
  select.innerHTML = league.players.map(player => `<option value="${escapeHtml(player.id)}">${escapeHtml(player.name)}</option>`).join('');
  select.value = statsPlayerId ?? '';
  const map = mapForDate(league.config.today, league.config);
  const history = handicapForPlayer(league, statsPlayerId, map);
  const overall = playerStats(league, statsPlayerId);
  const today = league.scores.find(score => score.playerId === statsPlayerId && score.mapNumber === map);
  const result = today ? roundStats(league, today) : null;
  const course = courseForMap(league, map);
  $('#player-stats').innerHTML = `<dl class="stats-grid">${stat('Handicap', history.handicap === null ? '–' : signed(history.handicap), history.handicap === null ? `${history.rounds}/3 rounds with par` : `${history.rounds} earlier rounds`)}${stat('Today’s target', history.expected ?? '–', history.expected === null ? 'Needs a handicap and daily par' : `Par ${course.par} + handicap, rounded`)}${stat('League group today', result ? `Top ${result.topPercent}%` : '–', result ? `Place ${result.rank} of ${result.players} · ties included` : 'Submit today’s score')}${stat('Rounds played', overall.rounds)}${stat('Average shots', overall.average === null ? '–' : overall.average.toFixed(1), 'All submitted rounds')}${stat('Best score', overall.best ?? '–', 'Shots on a single map')}</dl><p class="stats-note">${escapeHtml(courseNote(course))}${result?.versusExpected !== null && result?.versusExpected !== undefined ? `<br>Today: ${escapeHtml(signed(result.versusExpected))} shots against target.` : ''}${course?.source === 'game' ? `<br>Game average ${course.averageScore.toFixed(1)} shots · ${course.percentFinished}% finished · ${course.minScore}–${course.maxScore} shots.` : ''}${result?.global ? `<br>Global: ${globalGroup(result.global.first)} of first daily runs · ${globalGroup(result.global.repeat)} of repeat runs.` : '<br>Global percentile: not collected for this score.'}</p>`;
}

function applyTheme(theme) {
  const dark = theme !== 'light';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('#theme-label').textContent = dark ? 'Light mode' : 'Dark mode';
  $('#theme-icon').textContent = dark ? '☀' : '☾';
  $('#theme-toggle').setAttribute('aria-label', `Switch to ${dark ? 'light' : 'dark'} mode`);
  $('meta[name="theme-color"]').content = dark ? '#222a25' : '#f5f6f1';
}

applyTheme(document.documentElement.dataset.theme);
$('#theme-toggle').addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(theme);
  try { localStorage.setItem('golf.theme', theme); }
  catch { toast('Theme changed for this visit. Browser storage is unavailable.'); }
});

function submittedScore(mapNumber) {
  return league.scores.find(score => score.playerId === league.identity?.id && score.mapNumber === mapNumber);
}

function toast(message) {
  clearTimeout(toastTimeout);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimeout = setTimeout(() => { $('#toast').hidden = true; }, 5000);
}

function rangeLabel(start) {
  const end = addDays(start, 4);
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  return `${formatDate(start, sameMonth ? { day: 'numeric' } : { day: 'numeric', month: 'short' })}–${formatDate(end, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

function openDialog(html) {
  $('#dialog-content').innerHTML = html;
  const heading = $('#dialog-content h2');
  if (heading) {
    heading.id = 'dialog-title';
    $('#detail-dialog').setAttribute('aria-labelledby', heading.id);
  }
  if (!$('#detail-dialog').open) $('#detail-dialog').showModal();
}

function renderIdentity() {
  const player = league.identity;
  $('#player-label').textContent = player ? player.name : 'Set name';
  $('#name-form').hidden = Boolean(player);
  const todayScore = submittedScore(mapForDate(league.config.today, league.config));
  $('#score-form').hidden = Boolean(todayScore);
  $('#submission-intro').hidden = Boolean(todayScore);
  $('#submit-title').textContent = todayScore ? 'Score submitted' : 'Submit score';
  $('#submission-status').hidden = !todayScore;
  $('#submission-status').textContent = todayScore ? `${todayScore.total} shots · Map #${todayScore.mapNumber}` : '';
  $('.submission-footnote').textContent = todayScore ? 'You can submit again tomorrow.' : 'One submission per map. Scores are final.';
}

function renderScorecard() {
  const { dates, maps, dueDates, rows, bestByMap } = standingsForWeek(league, selectedStart);
  const isCurrent = selectedStart === currentStart;
  $('#week-status').textContent = isCurrent ? 'In progress' : 'Final results';
  $('#week-title').textContent = isCurrent ? 'This week' : `Week ${weekNumber(selectedStart)}`;
  $('#week-range').textContent = rangeLabel(selectedStart);
  $('#previous-week').disabled = selectedStart <= firstStart;
  $('#next-week').disabled = isCurrent;
  $('#current-week').disabled = isCurrent;
  $('#table-caption').textContent = `Scores for ${rangeLabel(selectedStart)}. Fewer shots is better. DNF means did not finish; assigned scores count toward weekly totals. Select a score for details.`;
  $('#score-head').innerHTML = `<tr><th scope="col"><span class="sr-only">Place</span>#</th><th scope="col">PLAYER</th>${dates.map((date, index) =>
    `<th scope="col" class="${date === league.config.today ? 'today' : ''}">${formatDate(date, { weekday: 'short' }).toUpperCase()}<small title="Map #${maps[index]}">${formatDate(date, { day: 'numeric', month: 'short' })}</small><small>${courseForMap(league, maps[index]) ? `${courseForMap(league, maps[index]).source === 'sample' ? 'Sample ' : ''}Par ${courseForMap(league, maps[index]).par}` : 'Par –'}</small></th>`).join('')}<th scope="col">TOTAL</th></tr>`;
  $('#score-body').innerHTML = rows.map(row => {
    const own = row.player.id === league.identity?.id;
    return `<tr class="${own ? 'own-row' : ''}"><td>${row.rank === 1 ? '<span class="rank-leader" aria-label="First place">1</span>' : row.rank ?? '–'}</td><td><div class="player-cell"><span class="player-name" title="${escapeHtml(row.player.name)}">${escapeHtml(row.player.name)}${own ? '<small>you</small>' : ''}</span></div></td>${maps.map((map, index) => {
      const score = row.rounds.find(round => round.mapNumber === map);
      if (!score) return `<td><span class="score-empty" aria-label="${dates[index] > league.config.today ? 'Upcoming map' : 'No score submitted'}">${dates[index] > league.config.today ? '·' : '–'}</span></td>`;
      if (score.assigned) return `<td><button class="score-button assigned-score" data-player="${escapeHtml(row.player.id)}" data-map="${map}" aria-label="${escapeHtml(row.player.name)}, map ${map}, ${score.total} shots assigned. Did not finish. View calculation.">${score.total}<small>DNF</small></button></td>`;
      const best = score.total === bestByMap[map];
      return `<td><button class="score-button ${best ? 'best-score' : ''}" data-player="${escapeHtml(row.player.id)}" data-map="${map}" aria-label="${escapeHtml(row.player.name)}, map ${map}, ${score.total} shots${best ? ', daily best' : ''}. View checkpoints.">${score.total}</button></td>`;
    }).join('')}<td class="score-total">${row.rounds.length ? row.total : '–'}<small>${row.rounds.filter(round => !round.assigned).length}/${dates.length} played${row.rounds.some(round => round.assigned) ? `<br>${row.rounds.filter(round => round.assigned).length} assigned` : ''}</small></td></tr>`;
  }).join('') || '<tr><td colspan="8" class="empty-message">No scores submitted.</td></tr>';
  $('#completion-note').textContent = `${rows.filter(row => row.rounds.length).length} players · ${dueDates.length} of ${dates.length} days due`;
  const complete = rows.filter(row => row.complete);
  const leaders = complete.filter(row => row.rank === 1);
  const leaderLabel = isCurrent ? 'Leader' : 'Winner';
  const leaderNames = leaders.length ? leaders.map(row => row.player.name).join(' & ') : 'No eligible player';
  const leaderDetail = leaders.length ? `${leaders[0].total} shots${leaders.length > 1 ? ' · tied' : ''}` : 'Complete all due rounds';
  const lowest = Math.min(...rows.flatMap(row => row.rounds.filter(round => !round.assigned).map(round => round.total)));
  const bestRounds = rows.flatMap(row => row.rounds.filter(round => !round.assigned && round.total === lowest).map(round => ({ ...round, name: row.player.name })));
  const bestNames = [...new Set(bestRounds.map(round => round.name))];
  $('#week-insights').innerHTML = `<div class="insight"><span class="insight-symbol" aria-hidden="true">1</span><div><div class="eyebrow">${leaderLabel}</div><strong>${escapeHtml(leaderNames)}<small>${escapeHtml(leaderDetail)}</small></strong></div></div><div class="insight"><span class="insight-symbol" aria-hidden="true">⚑</span><div><div class="eyebrow">Best daily score</div><strong>${escapeHtml(bestNames.join(' & ') || 'No scores')}<small>${bestRounds.length ? `${lowest} shots` : '–'}</small></strong></div></div>`;
}

function renderArchive() {
  $('#archive-grid').innerHTML = Array.from({ length: league.config.archiveWeeks }, (_, index) => {
    const start = addDays(currentStart, -7 * (index + 1));
    const { winners, last } = awardsForWeek(league, start);
    const award = (rows, label, icon) => `<div class="award-row"><span class="award-icon" aria-hidden="true">${icon}</span><div><div class="eyebrow">${label}${rows.length > 1 ? ' · TIED' : ''}</div><strong>${escapeHtml(rows.map(row => row.player.name).join(' & ') || 'No eligible player')}</strong></div><span class="award-total">${rows[0]?.total ?? '–'}<small>shots</small></span></div>`;
    return `<a href="#leaderboard" class="archive-card" data-week="${start}" aria-label="View week ${weekNumber(start)}, ${escapeHtml(rangeLabel(start))}"><div class="archive-card-top"><span>Week ${weekNumber(start)}</span><span class="arrow" aria-hidden="true">↗</span></div><h3>${escapeHtml(rangeLabel(start))}</h3>${award(winners, 'Winner', '🏆')}${award(last, 'Loser', '🥄')}</a>`;
  }).join('');
}

function render() {
  renderIdentity();
  renderScorecard();
  renderArchive();
  renderPlayerStats();
  $('#course-date').textContent = formatDate(league.config.today, { weekday: 'short', day: 'numeric', month: 'short' });
  $('#course-number').textContent = `Daily map #${mapForDate(league.config.today, league.config)}`;
  $('#course-par').textContent = courseNote(courseForMap(league, mapForDate(league.config.today, league.config)));
  if (preview) showPreview(preview);
}

async function refresh() {
  const saved = await database.getLeague();
  try {
    league = await loadCourseData(saved);
    courseDataError = false;
  } catch {
    league = saved;
    courseDataError = true;
  }
  render();
}

function setWeek(start, scroll = false) {
  if (!league || start < firstStart || start > currentStart) return;
  selectedStart = start;
  renderScorecard();
  if (scroll) $('#leaderboard').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
}

function clearPreview() {
  preview = null;
  $('#score-preview').hidden = true;
  $('#score-error').textContent = '';
  $('#submit-button').disabled = saving;
  $('#submit-button').innerHTML = 'Preview score <span aria-hidden="true">↗</span>';
}

function showPreview(parsed) {
  preview = parsed;
  const date = dateForMap(parsed.mapNumber, league.config);
  const existing = submittedScore(parsed.mapNumber);
  const skipped = parsed.checkpoints.filter(checkpoint => checkpoint.shots === null).length;
  const course = courseForMap(league, parsed.mapNumber);
  const history = handicapForPlayer(league, league.identity?.id, parsed.mapNumber);
  $('#score-preview').className = 'score-preview';
  $('#score-preview').hidden = false;
  $('#score-preview').innerHTML = `<div><span>Map #${parsed.mapNumber}</span><strong>${parsed.total}<span class="sr-only"> shots</span></strong></div><p>${formatDate(date, { weekday: 'short', day: 'numeric', month: 'short' })} · ${parsed.checkpoints.length} checkpoints${skipped ? ` · ${skipped} skipped` : ''}${course ? `<br>${escapeHtml(courseNote(course))} · ${signed(parsed.total - course.par)} shots` : ''}${history.expected !== null ? `<br>Target ${history.expected} · ${signed(parsed.total - history.expected)} shots against target` : ''}${existing ? `<br>You already saved ${existing.total} shots for this map.` : ''}</p>`;
  $('#submit-button').disabled = Boolean(existing) || saving;
  $('#submit-button').innerHTML = existing ? 'Already submitted' : 'Submit score <span aria-hidden="true">↗</span>';
  $('#score-error').textContent = existing ? 'You already submitted a score for this map. Scores are final.' : '';
}

async function saveScore() {
  if (saving || !preview) return;
  saving = true;
  $('#submit-button').disabled = true;
  try {
    const saved = await database.submitScore({ rawText: preview.rawText });
    await refresh();
    selectedStart = mondayOf(saved.courseDate);
    renderScorecard();
    $('#score-text').value = '';
    clearPreview();
    $('#detail-dialog').close();
    if (!$('#submission-status').hidden) $('#submission-status').focus();
    toast(`Submitted: ${saved.total} shots on map #${saved.mapNumber}.`);
  } catch (error) {
    if (error.code === 'SCORE_EXISTS') {
      await refresh();
    }
    $('#score-error').textContent = error.message;
  } finally {
    saving = false;
    $('#submit-button').disabled = Boolean(preview && submittedScore(preview.mapNumber));
  }
}

$('#name-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  $('#name-error').textContent = '';
  try {
    const player = await database.registerPlayer($('#player-name').value);
    statsPlayerId = player.id;
    await refresh();
    toast(`Name saved: ${player.name}.`);
    $('#score-text').focus();
  } catch (error) { $('#name-error').textContent = error.message; }
  finally { button.disabled = false; }
});

$('#score-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!league || saving) return;
  $('#score-error').textContent = '';
  if (!preview) {
    try { showPreview(parseScore($('#score-text').value)); }
    catch (error) { $('#score-error').textContent = error.message; }
    return;
  }
  if (!league.identity) {
    $('#name-error').textContent = 'Enter your name first.';
    $('#player-name').focus();
    return;
  }
  await saveScore();
});

$('#score-text').addEventListener('input', clearPreview);
$('#example-button').addEventListener('click', () => {
  $('#score-text').value = exampleScore;
  clearPreview();
  $('#score-text').focus();
});
$('#previous-week').addEventListener('click', () => setWeek(addDays(selectedStart, -7)));
$('#next-week').addEventListener('click', () => setWeek(addDays(selectedStart, 7)));
$('#current-week').addEventListener('click', () => setWeek(currentStart));
$('#stats-player').addEventListener('change', event => {
  statsPlayerId = event.target.value;
  renderPlayerStats();
});
$('#handicap-button').addEventListener('click', () => {
  openDialog('<h2>Handicap & targets</h2><p>Your handicap is your average shots above or below each map’s par over your last 20 earlier rounds with par data. It appears after 3 rounds. A lower handicap means fewer shots.</p><p>Your target is the map’s par plus your handicap, rounded to whole shots, with a minimum of 1. A round never contributes to its own target. Earlier scores submitted later can change historical targets.</p><p>Par is the game’s rounded daily average and changes throughout the day. We use the latest collected snapshot for each map; sample par is marked in the demo.</p><p>League groups include all submitted scores on the same map. Top percentage includes everyone with an equal or lower score; equal scores share a place. Global groups come from the game, with first and repeat runs shown separately.</p><p>Handicaps and targets are personal statistics. Weekly places and awards use total shots.</p>');
});
$('#archive-grid').addEventListener('click', event => {
  const card = event.target.closest('[data-week]');
  if (card) {
    event.preventDefault();
    setWeek(card.dataset.week, true);
  }
});

$('#score-body').addEventListener('click', event => {
  const button = event.target.closest('[data-map]');
  if (!button || !league) return;
  const score = standingsForWeek(league, selectedStart).scores.find(round => round.playerId === button.dataset.player && round.mapNumber === Number(button.dataset.map));
  if (!score) return;
  const player = league.players.find(person => person.id === score.playerId);
  const own = score.playerId === league.identity?.id;
  if (score.assigned) {
    openDialog(`<div class="eyebrow">Map #${score.mapNumber} · ${escapeHtml(formatDate(score.courseDate, { day: 'numeric', month: 'short' }))}</div><h2>${escapeHtml(player.name)}</h2><div class="dialog-total assigned-total">${score.total}<small>assigned shots</small></div><p><strong>Did not finish.</strong> No score was submitted for this day.</p><p>The highest submitted score was ${score.highestTotal} shots. The assigned score is ${score.highestTotal} + 1 = <strong>${score.total} shots</strong>.</p><p>This counts toward the weekly total and awards. Personal statistics, handicap, and percentiles use played rounds only.</p><p>A late submission replaces this assignment. Assigned scores update when the day’s highest submitted score changes.</p>`);
    return;
  }
  const result = roundStats(league, score);
  const course = courseForMap(league, score.mapNumber);
  openDialog(`<div class="eyebrow">Map #${score.mapNumber} · ${escapeHtml(formatDate(dateForMap(score.mapNumber, league.config), { day: 'numeric', month: 'short' }))}</div><h2>${escapeHtml(player.name)}${own ? ' <small>(you)</small>' : ''}</h2><div class="dialog-total">${score.total}<small>shots</small></div><dl class="dialog-stats">${stat('Against par', result.versusPar === null ? '–' : signed(result.versusPar))}${stat('Against target', result.versusExpected === null ? '–' : signed(result.versusExpected))}${stat('League group', `Top ${result.topPercent}%`, `Place ${result.rank} of ${result.players}`)}${stat('League average', result.average.toFixed(1), 'Shots on this map')}</dl><p>${escapeHtml(courseNote(course))}</p><p>${result.global ? `Global: ${globalGroup(result.global.first)} of first daily runs · ${globalGroup(result.global.repeat)} of repeat runs.` : 'Global percentile not collected for this score.'}</p><div class="eyebrow">Checkpoints</div><ul class="checkpoint-list">${score.checkpoints.map(checkpoint => `<li><span>${checkpoint.index === 0 ? 'Start' : `Checkpoint ${checkpoint.index}`}</span><strong>${checkpoint.shots === null ? 'Skipped' : checkpoint.shots}</strong></li>`).join('')}</ul>`);
});

$('#player-button').addEventListener('click', () => {
  if (!league) return;
  if (!league.identity) {
    $('#player-name').focus();
    return;
  }
  openDialog(`<div class="eyebrow">Name</div><h2>${escapeHtml(league.identity.name)}</h2><p>Your name is fixed for this browser. Clearing site storage or resetting the demo lets you start again.</p><p>Demo scores are saved in this browser only.</p>`);
});

$('#rules-button').addEventListener('click', () => {
  openDialog('<h2>Rules</h2><p><strong>Monday–Friday, Copenhagen time.</strong> The lowest total across all five maps wins. Rankings include played and assigned scores. Today’s score remains due until submitted.</p><p><strong>Missed days.</strong> After a day ends, each player without a submission gets that day’s highest submitted score plus one. Red DNF scores mean did not finish. If nobody submitted, the day stays pending until a score is available.</p><p><strong>Weekly totals and awards include assignments.</strong> Personal statistics, handicap, and percentiles use played rounds only.</p><p><strong>One submission per map.</strong> Submitted scores are final. You can submit a missing score for an earlier weekday; it replaces the assignment. Assignments update when the highest submitted score changes.</p><p><strong>Ties share a place.</strong> The lowest eligible total wins; the highest loses.</p><p><strong>Checkpoint counts vary by map.</strong> A dash means skipped. Checkpoint shots must add up to the total.</p><p>Demo dates: 21 September–15 October 2026. Scores are saved in this browser only.</p>');
});

$('.dialog-close').addEventListener('click', () => $('#detail-dialog').close());
$('#detail-dialog').addEventListener('click', event => {
  if (event.target.closest('[data-close]')) $('#detail-dialog').close();
  const bounds = $('#detail-dialog').getBoundingClientRect();
  if (event.target === $('#detail-dialog') && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) $('#detail-dialog').close();
});

$('#export-button').addEventListener('click', async () => {
  try {
    const data = await database.exportData();
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'golf-scores.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Scores exported.');
  } catch (error) { toast(error.message); }
});

$('#reset-button').addEventListener('click', () => {
  openDialog('<h2>Reset demo?</h2><p>This clears your name and submissions and restores the sample scores. Export first if you want to keep them.</p><div class="dialog-actions"><button class="button button-light" data-close>Cancel</button><button class="button button-green" id="confirm-reset">Reset demo</button></div>');
  $('#confirm-reset').addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    try {
      await database.resetDemo();
      selectedStart = currentStart;
      $('#player-name').value = '';
      $('#score-text').value = '';
      $('#name-error').textContent = '';
      clearPreview();
      await refresh();
      $('#detail-dialog').close();
      toast('Demo reset.');
    } catch (error) { toast(error.message); }
    finally { if ($('#confirm-reset')) $('#confirm-reset').disabled = false; }
  });
});

window.addEventListener('storage', event => {
  if (event.key === 'golf.theme' || event.key === null) applyTheme(event.newValue);
  if (event.key === STORAGE_KEY || event.key === null) refresh().catch(error => toast(error.message));
});

refresh().catch(error => {
  $('#score-body').innerHTML = `<tr><td colspan="8" class="empty-message">${escapeHtml(error.message)}</td></tr>`;
  $('#score-error').textContent = error.message;
  toast(error.message);
});
