import { activeMap, leagueConfig } from './config.js';
import { addDays, awardsForWeek, dateForMap, formatDate, mapForDate, mondayOf, parseScore,
  standingsForWeek, weekNumber, courseForMap, handicapForPlayer, playerStats, roundStats, bonusStandings } from './domain.js';
import { loadCourseData } from './course-data.js';
import { database, onIdentityChange } from './database.js';

const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
let currentStart = mondayOf(leagueConfig.today);
let firstStart = mondayOf(leagueConfig.seasonStart);
let selectedStart = currentStart;
let league;
let preview = null;
let saving = false;
let toastTimeout;
let statsPlayerId;
let courseDataError = false;
let refreshInProgress;
let accountMode = 'login';
let accountBusy = false;
let selectedTab = 'weekly';
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
  select.innerHTML = league.players.map(player => `<option value="${escapeHtml(player.id)}">${escapeHtml(player.name)}</option>`).join('') || '<option value="">No players yet</option>';
  select.disabled = league.players.length === 0;
  select.value = statsPlayerId ?? '';
  const map = activeMap(league.config);
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
  const signedIn = Boolean(league.account && player);
  const upgrading = Boolean(player && !league.account);
  $('#player-label').textContent = signedIn ? player.name : upgrading ? 'Set password' : 'Sign in';
  $('#account-panel').hidden = signedIn;
  $('#account-tabs').hidden = upgrading;
  $('#account-intro').textContent = upgrading
    ? `Create a login for ${player.name}. Your name and scores will stay with this account.`
    : 'Use your account on any browser or device.';
  setAccountMode(upgrading ? 'register' : accountMode);
  const bonus = selectedTab === 'bonus';
  const map = activeMap(league.config);
  const todayScore = bonus ? league.bonusScores?.find(score => score.playerId === player?.id && score.mapNumber === map)
    : submittedScore(map);
  const available = bonus ? Boolean(league.bonusScores) && league.config.activeCourseDate >= league.config.seasonStart
    : league.config.acceptingScores;
  if ($('#bonus-form').dataset.map !== String(map) || $('#bonus-form').dataset.player !== (player?.id ?? '')) {
    $('#bonus-form').reset();
    $('#bonus-error').textContent = '';
    $('#bonus-form').dataset.map = String(map);
    $('#bonus-form').dataset.player = player?.id ?? '';
  }
  $('#score-form').hidden = bonus || !signedIn || Boolean(todayScore) || !available;
  $('#bonus-form').hidden = !bonus || !signedIn || Boolean(todayScore) || !available;
  $('#submission-intro').hidden = !signedIn || Boolean(todayScore) || !available;
  $('#submission-intro').textContent = bonus ? 'Played the bonus level? Add your shot count.' : 'Paste the result copied from the game.';
  $('#submit-title').textContent = !signedIn ? 'Your account' : todayScore ? (bonus ? 'Bonus score submitted' : 'Score submitted')
    : available ? (bonus ? 'Submit bonus score' : 'Submit score') : bonus ? 'Bonus entry unavailable' : 'No weekday map';
  $('#submission-status').hidden = !signedIn || !todayScore;
  $('#submission-status').textContent = todayScore ? `${todayScore.total} shots · Map #${todayScore.mapNumber}` : '';
  $('.submission-footnote').textContent = !signedIn ? 'The leaderboard is public. Sign in to submit scores.' : bonus
    ? todayScore ? 'Come back for the next daily bonus level.' : available ? 'One optional bonus score per day. Resets at 04:00 UTC.' : 'Bonus score entry is not available yet.'
    : todayScore ? 'You can submit when the next weekday map opens.'
    : available ? 'One submission per map. Scores are final.' : 'Score entry opens with the next weekday map.';
}

function renderBonus() {
  const map = activeMap(league.config);
  const rows = bonusStandings(league, map);
  $('#bonus-map-label').textContent = `Bonus · Map #${map}`;
  $('#bonus-player-count').textContent = `${rows.length} ${rows.length === 1 ? 'player' : 'players'}`;
  $('#bonus-body').innerHTML = rows.map(({ player, score, rank }) => {
    const own = player.id === league.identity?.id;
    return `<tr class="${own ? 'own-row' : ''}"><td>${rank}</td><td><span class="player-name">${escapeHtml(player.name)}${own ? '<small>you</small>' : ''}</span></td><td class="score-total">${score.total}</td></tr>`;
  }).join('') || `<tr><td colspan="3" class="empty-message">${league.bonusScores ? 'No bonus scores yet today.' : 'The bonus leaderboard is being set up.'}</td></tr>`;
}

function setTab(tab, focus = false) {
  if (saving || accountBusy) return;
  selectedTab = tab;
  const bonus = tab === 'bonus';
  for (const name of ['weekly', 'bonus']) {
    const button = $(`#${name}-tab`);
    button.setAttribute('aria-selected', String(name === tab));
    button.tabIndex = name === tab ? 0 : -1;
  }
  $('#leaderboard').hidden = bonus;
  $('#bonus-leaderboard').hidden = !bonus;
  $('#archive').hidden = bonus;
  $('#page-title').textContent = bonus ? 'Daily bonus leaderboard' : 'Weekly leaderboard';
  $('#page-subtitle').textContent = bonus ? 'An optional daily challenge · Fewest shots first' : 'Monday–Friday · Copenhagen time';
  $('#course-par').hidden = bonus;
  if (league) renderIdentity();
  if (focus) $(`#${tab}-tab`).focus();
}

function setAccountMode(mode) {
  accountMode = mode;
  const creating = mode === 'register';
  $('#account-title').textContent = creating ? 'Create your account' : 'Sign in to submit scores';
  $('#login-tab').setAttribute('aria-pressed', String(!creating));
  $('#register-tab').setAttribute('aria-pressed', String(creating));
  $('#account-submit').textContent = creating ? 'Create account' : 'Sign in';
  $('#account-password').autocomplete = creating ? 'new-password' : 'current-password';
  $('#account-password').minLength = creating ? 8 : 1;
  $('#password-help').hidden = !creating;
  $('#confirm-password-row').hidden = !creating;
  $('#confirm-password').required = creating;
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
  $('#table-caption').textContent = `Scores for ${rangeLabel(selectedStart)}. Fewer shots is better. Signed numbers beside submitted scores show shots against par. DNF means did not finish; assigned scores count toward weekly totals. Select a score for details.`;
  $('#score-head').innerHTML = `<tr><th scope="col"><span class="sr-only">Place</span>#</th><th scope="col">PLAYER</th>${dates.map((date, index) =>
    `<th scope="col" class="${date === league.config.today ? 'today' : ''}">${formatDate(date, { weekday: 'short' }).toUpperCase()}<small title="Map #${maps[index]}">${formatDate(date, { day: 'numeric', month: 'short' })}</small><small>${courseForMap(league, maps[index]) ? `${courseForMap(league, maps[index]).source === 'sample' ? 'Sample ' : ''}Par ${courseForMap(league, maps[index]).par}` : 'Par –'}</small></th>`).join('')}<th scope="col">TOTAL</th></tr>`;
  $('#score-body').innerHTML = rows.map(row => {
    const own = row.player.id === league.identity?.id;
    return `<tr class="${own ? 'own-row' : ''}"><td>${row.rank === 1 ? '<span class="rank-leader" aria-label="First place">1</span>' : row.rank ?? '–'}</td><td><div class="player-cell"><span class="player-name" title="${escapeHtml(row.player.name)}">${escapeHtml(row.player.name)}${own ? '<small>you</small>' : ''}</span></div></td>${maps.map((map, index) => {
      const score = row.rounds.find(round => round.mapNumber === map);
      if (!score) return `<td><span class="score-empty" aria-label="${dates[index] > league.config.today ? 'Upcoming map' : 'No score submitted'}">${dates[index] > league.config.today ? '·' : '–'}</span></td>`;
      if (score.assigned) return `<td><button class="score-button assigned-score" data-player="${escapeHtml(row.player.id)}" data-map="${map}" aria-label="${escapeHtml(row.player.name)}, map ${map}, ${score.total} shots assigned. Did not finish. View calculation.">${score.total}<small>DNF</small></button></td>`;
      const best = score.total === bestByMap[map];
      const course = courseForMap(league, map);
      const difference = course ? score.total - course.par : null;
      const parLabel = difference === null ? '' : difference === 0 ? 'even par'
        : `${Math.abs(difference)} shot${Math.abs(difference) === 1 ? '' : 's'} ${difference < 0 ? 'under' : 'over'} par`;
      const comparison = difference === null ? '' : `<span class="score-par ${difference < 0 ? 'under-par' : difference > 0 ? 'over-par' : ''}" title="${parLabel} (par ${course.par})" aria-hidden="true">${difference === 0 ? '±0' : signed(difference)}</span>`;
      return `<td><span class="score-with-par"><button class="score-button ${best ? 'best-score' : ''}" data-player="${escapeHtml(row.player.id)}" data-map="${map}" aria-label="${escapeHtml(row.player.name)}, map ${map}, ${score.total} shots${parLabel ? `, ${parLabel}` : ''}${best ? ', daily best' : ''}. View checkpoints.">${score.total}</button>${comparison}</span></td>`;
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
  const weeks = Math.min(league.config.archiveWeeks, Math.round((Date.parse(currentStart) - Date.parse(firstStart)) / 604800000));
  $('#archive-grid').innerHTML = Array.from({ length: weeks }, (_, index) => {
    const start = addDays(currentStart, -7 * (index + 1));
    const { winners, last } = awardsForWeek(league, start);
    const award = (rows, label, icon) => `<div class="award-row"><span class="award-icon" aria-hidden="true">${icon}</span><div><div class="eyebrow">${label}${rows.length > 1 ? ' · TIED' : ''}</div><strong>${escapeHtml(rows.map(row => row.player.name).join(' & ') || 'No eligible player')}</strong></div><span class="award-total">${rows[0]?.total ?? '–'}<small>shots</small></span></div>`;
    return `<a href="#leaderboard" class="archive-card" data-week="${start}" aria-label="View week ${weekNumber(start)}, ${escapeHtml(rangeLabel(start))}"><div class="archive-card-top"><span>Week ${weekNumber(start)}</span><span class="arrow" aria-hidden="true">↗</span></div><h3>${escapeHtml(rangeLabel(start))}</h3>${award(winners, 'Winner', '🏆')}${award(last, 'Loser', '🥄')}</a>`;
  }).join('') || '<p class="empty-message">No completed weeks yet.</p>';
}

function render() {
  renderIdentity();
  renderScorecard();
  renderArchive();
  renderPlayerStats();
  renderBonus();
  $('#course-date').textContent = formatDate(league.config.activeCourseDate, { weekday: 'short', day: 'numeric', month: 'short' });
  $('#course-number').textContent = `Daily map #${activeMap(league.config)}`;
  $('#course-par').textContent = courseNote(courseForMap(league, activeMap(league.config)));
  $('#connection-status').hidden = true;
  if (preview) showPreview(preview);
}

async function refresh() {
  if (refreshInProgress) await refreshInProgress.catch(() => {});
  const work = refreshLeague();
  refreshInProgress = work;
  try { await work; }
  finally { if (refreshInProgress === work) refreshInProgress = null; }
}

async function refreshLeague() {
  const saved = await database.getLeague();
  const viewingCurrent = selectedStart === currentStart;
  currentStart = mondayOf(saved.config.today);
  firstStart = mondayOf(saved.config.seasonStart);
  if (viewingCurrent || selectedStart < firstStart || selectedStart > currentStart) selectedStart = currentStart;
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
  setTab('weekly');
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

$('#login-tab').addEventListener('click', () => { setAccountMode('login'); $('#account-error').textContent = ''; });
$('#register-tab').addEventListener('click', () => { setAccountMode('register'); $('#account-error').textContent = ''; });
$('#account-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (accountBusy) return;
  const creating = accountMode === 'register';
  $('#account-error').textContent = '';
  if (creating && $('#account-password').value !== $('#confirm-password').value) {
    $('#account-error').textContent = 'The passwords do not match.';
    $('#confirm-password').focus();
    return;
  }
  accountBusy = true;
  $('#account-form').setAttribute('aria-busy', 'true');
  $('#account-panel').querySelectorAll('button, input').forEach(input => { input.disabled = true; });
  try {
    const username = $('#account-username').value;
    const password = $('#account-password').value;
    if (creating) await database.registerAccount(username, password);
    else await database.signIn(username, password);
    clearPreview();
    $('#score-text').value = '';
    await refresh();
    if (!league.account || !league.identity) throw new Error('Your account needs administrator setup. Please contact the league administrator.');
    statsPlayerId = league.identity.id;
    renderPlayerStats();
    $('#account-form').reset();
    toast(creating ? 'Account created. You’re signed in.' : `Signed in as ${league.identity.name}.`);
    if (!$('#score-form').hidden) $('#score-text').focus();
    else if (!$('#bonus-form').hidden) $('#bonus-total').focus();
    else $('#player-button').focus();
  } catch (error) { $('#account-error').textContent = error.message; }
  finally {
    $('#account-password').value = '';
    $('#confirm-password').value = '';
    accountBusy = false;
    $('#account-form').removeAttribute('aria-busy');
    $('#account-panel').querySelectorAll('button, input').forEach(input => { input.disabled = false; });
  }
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
  if (!league.account || !league.identity) {
    $('#account-error').textContent = 'Sign in before submitting a score.';
    $('#account-username').focus();
    return;
  }
  await saveScore();
});

$('#score-text').addEventListener('input', clearPreview);
$('#bonus-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!league || saving || !league.account || !league.identity) return;
  saving = true;
  $('#bonus-submit').disabled = true;
  $('#bonus-error').textContent = '';
  try {
    const saved = await database.submitBonusScore({ mapNumber: Number($('#bonus-form').dataset.map), total: Number($('#bonus-total').value) });
    $('#bonus-form').reset();
    await refresh();
    $('#submission-status').focus();
    toast(`Bonus submitted: ${saved.total} shots on map #${saved.mapNumber}.`);
  } catch (error) {
    if (error.code === 'SCORE_EXISTS') await refresh().catch(showConnectionError);
    $('#bonus-error').textContent = error.message;
    if ($('#bonus-form').hidden) toast(error.message);
  } finally {
    saving = false;
    $('#bonus-submit').disabled = false;
  }
});
$('#bonus-total').addEventListener('input', () => { $('#bonus-error').textContent = ''; });
for (const name of ['weekly', 'bonus']) {
  $(`#${name}-tab`).addEventListener('click', () => setTab(name));
  $(`#${name}-tab`).addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      setTab(event.key === 'Home' ? 'weekly' : event.key === 'End' ? 'bonus' : name === 'weekly' ? 'bonus' : 'weekly', true);
    }
  });
}
document.querySelectorAll('a[href="#leaderboard"], a[href="#archive"]').forEach(link => {
  link.addEventListener('click', () => setTab('weekly'));
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
  if (!league || accountBusy || saving) return;
  if (!league.account || !league.identity) {
    $('#account-panel').scrollIntoView({ block: 'center' });
    $('#account-username').focus();
    return;
  }
  openDialog(`<div class="eyebrow">Your account</div><h2>${escapeHtml(league.identity.name)}</h2><p>Username: <strong>${escapeHtml(league.account.username)}</strong></p><p>Sign in with this username on any browser or device.</p><form id="display-name-form" class="account-panel"><h3>Display name</h3><label for="display-name">Name shown on the leaderboard</label><input id="display-name" name="display-name" autocomplete="nickname" value="${escapeHtml(league.identity.name)}" maxlength="48" required aria-describedby="display-name-help"><small id="display-name-help">2–24 characters. You can change this whenever you like.</small><p id="display-name-error" class="form-error" role="alert"></p><button class="button button-green" type="submit">Save display name</button></form><form id="password-form" class="account-panel"><h3>Change password</h3><input name="username" autocomplete="username" value="${escapeHtml(league.account.username)}" hidden><label for="current-password">Current password</label><input id="current-password" name="current-password" type="password" autocomplete="current-password" required><label for="new-password">New password</label><input id="new-password" name="new-password" type="password" autocomplete="new-password" minlength="8" required><small>At least 8 characters.</small><label for="repeat-password">Confirm new password</label><input id="repeat-password" name="repeat-password" type="password" autocomplete="new-password" minlength="8" required><p id="password-error" class="form-error" role="alert"></p><button class="button button-green" type="submit">Change password</button></form><p class="account-help">Forgot your password? Ask the league administrator.</p><button class="button" id="sign-out" type="button">Sign out</button>`);
  $('#display-name-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (accountBusy) return;
    const form = event.currentTarget;
    const input = form.querySelector('input');
    const errorLabel = $('#display-name-error');
    const controls = $('#dialog-content').querySelectorAll('button, input');
    errorLabel.textContent = '';
    accountBusy = true;
    controls.forEach(control => { control.disabled = true; });
    form.setAttribute('aria-busy', 'true');
    try {
      const player = await database.updateDisplayName(input.value);
      await refresh();
      if (form.isConnected) {
        input.value = player.name;
        $('#dialog-title').textContent = player.name;
      }
      toast('Display name saved.');
    } catch (error) { errorLabel.textContent = error.message; }
    finally {
      accountBusy = false;
      controls.forEach(control => { control.disabled = false; });
      form.removeAttribute('aria-busy');
    }
  });
  $('#password-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (accountBusy) return;
    const form = event.currentTarget;
    $('#password-error').textContent = '';
    if ($('#new-password').value !== $('#repeat-password').value) {
      $('#password-error').textContent = 'The passwords do not match.';
      return;
    }
    accountBusy = true;
    const button = form.querySelector('button');
    const signOutButton = $('#sign-out');
    const errorLabel = $('#password-error');
    button.disabled = true;
    signOutButton.disabled = true;
    try {
      await database.changePassword($('#current-password').value, $('#new-password').value);
      if (form.isConnected) $('#detail-dialog').close();
      toast('Password changed.');
    } catch (error) { errorLabel.textContent = error.message; }
    finally {
      form.reset();
      accountBusy = false;
      button.disabled = false;
      signOutButton.disabled = false;
    }
  });
  $('#sign-out').addEventListener('click', async event => {
    if (accountBusy) return;
    accountBusy = true;
    event.currentTarget.disabled = true;
    try {
      await database.signOut();
      $('#detail-dialog').close();
      $('#dialog-content').replaceChildren();
      $('#score-text').value = '';
      clearPreview();
      setAccountMode('login');
      await refresh();
      toast('Signed out.');
    } catch (error) { toast(error.message); }
    finally { accountBusy = false; if ($('#sign-out')) $('#sign-out').disabled = false; }
  });
});

$('#rules-button').addEventListener('click', () => {
  openDialog('<h2>Rules</h2><p><strong>Monday–Friday, Copenhagen time.</strong> The lowest total across all five maps wins. Rankings include played and assigned scores. Today’s score remains due until submitted.</p><p><strong>Missed days.</strong> After a day ends, each player without a submission gets that day’s highest submitted score plus one. Red DNF scores mean did not finish. If nobody submitted, the day stays pending until a score is available.</p><p><strong>Weekly totals and awards include assignments.</strong> Personal statistics, handicap, and percentiles use played rounds only.</p><p><strong>One submission per map.</strong> Submitted scores are final. Missing earlier weekday scores can be submitted before the current map is submitted. They replace assignments.</p><p><strong>Daily maps reset at 04:00 UTC.</strong> The active game map can differ from the Copenhagen calendar date overnight.</p><p><strong>Ties share a place.</strong> The lowest eligible total wins; the highest loses.</p><p><strong>Checkpoint counts vary by map.</strong> A dash means skipped. Checkpoint shots must add up to the total.</p>');
});

$('.dialog-close').addEventListener('click', () => $('#detail-dialog').close());
$('#detail-dialog').addEventListener('close', () => $('#dialog-content').replaceChildren());
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

function showConnectionError(error) {
  $('#connection-status').hidden = false;
  $('#connection-status').textContent = error.message;
  if (!league) {
    $('#account-panel').hidden = true;
    $('#score-form').hidden = true;
    $('#score-body').innerHTML = `<tr><td colspan="8" class="empty-message">${escapeHtml(error.message)}</td></tr>`;
  }
}

function refreshWhenVisible() {
  if (document.visibilityState === 'visible' && !refreshInProgress && !saving && !accountBusy) refresh().catch(showConnectionError);
}

window.addEventListener('storage', event => {
  if (event.key === 'golf.theme' || event.key === null) applyTheme(event.newValue);
});
window.addEventListener('focus', refreshWhenVisible);
document.addEventListener('visibilitychange', refreshWhenVisible);
setInterval(refreshWhenVisible, 60_000);
onIdentityChange(refreshWhenVisible);
refresh().catch(showConnectionError);
