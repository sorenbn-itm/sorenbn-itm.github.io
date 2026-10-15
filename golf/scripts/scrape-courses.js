import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { validateCourse } from '../course-data.js';

const GAME_URL = 'https://kindahardgolf.com/';
const DAY_MS = 86_400_000;

export function discoverSource(html, script) {
  const launchDate = html.match(/const\s+utcLaunchDate\s*=\s*["'](\d{4}-\d{2}-\d{2})["']/)?.[1];
  const offset = html.match(/const\s+offsetHours\s*=\s*(\d+)/)?.[1];
  const statsPath = script.match(/fetch\(["'](\/api\/stats\?score=)["']/)?.[1];
  if (!launchDate || offset === undefined || Number(offset) > 23 || !statsPath) {
    throw new Error('The game page has changed; daily map and stats discovery needs updating.');
  }
  return { launchDate, offsetHours: Number(offset), statsPath };
}

export function courseIdentity(source, now) {
  const courseDate = new Date(now.getTime() - source.offsetHours * 3_600_000).toISOString().slice(0, 10);
  const mapNumber = Math.round((Date.parse(`${courseDate}T00:00:00Z`) - Date.parse(`${source.launchDate}T00:00:00Z`)) / DAY_MS);
  return { courseDate, mapNumber };
}

function validateStats(stats) {
  if (!stats || !['averageScore', 'minScore', 'maxScore', 'percentFinished', 'percentile', 'firstAttemptPercentile']
    .every(key => typeof stats[key] === 'number' && Number.isFinite(stats[key]))
    || stats.averageScore <= 0 || stats.averageScore > 10000
    || !Number.isSafeInteger(stats.minScore) || stats.minScore < 1
    || !Number.isSafeInteger(stats.maxScore) || stats.maxScore < stats.minScore
    || !['percentFinished', 'percentile', 'firstAttemptPercentile'].every(key => stats[key] >= 0 && stats[key] <= 100)) {
    throw new Error('The game returned invalid daily statistics.');
  }
  return stats;
}

export async function scrapeCourse({ request = fetch, now = () => new Date(),
  delay = ms => new Promise(done => setTimeout(done, ms)), maxScores = 500 } = {}) {
  const get = async url => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await request(url, { signal: AbortSignal.timeout(15000), headers: {
          'User-Agent': 'GolfScoresDailyStats/1.0 (+https://sorenbn-itm.github.io/golf/)',
        } });
        if (response.ok) return response;
        if (attempt < 2 && (response.status === 429 || response.status >= 500)) {
          await delay((attempt + 1) * 3000);
          continue;
        }
        throw new Error(`Game data request failed: HTTP ${response.status} (${new URL(url).pathname})`);
      } catch (error) {
        if (attempt === 2 || /HTTP/.test(error.message)) throw error;
        await delay((attempt + 1) * 3000);
      }
    }
  };
  const html = await (await get(GAME_URL)).text();
  const scriptPath = html.match(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']/i)?.[1];
  if (!scriptPath) throw new Error('The game module could not be found.');
  const scriptUrl = new URL(scriptPath, GAME_URL);
  if (scriptUrl.origin !== new URL(GAME_URL).origin) throw new Error('Unexpected game module origin.');
  const source = discoverSource(html, await (await get(scriptUrl)).text());
  const identity = courseIdentity(source, now());
  const readStats = async score => validateStats(await (await get(new URL(`${source.statsPath}${score}`, GAME_URL))).json());
  const initial = await readStats(1);
  const percentiles = { 1: { first: initial.firstAttemptPercentile, repeat: initial.percentile } };
  for (let score = 2; score <= Math.min(initial.maxScore, maxScores); score++) {
    await delay(150);
    const stats = await readStats(score);
    percentiles[score] = { first: stats.firstAttemptPercentile, repeat: stats.percentile };
  }
  if (courseIdentity(source, now()).courseDate !== identity.courseDate) {
    throw new Error('The daily course changed during collection. Run the scraper again.');
  }
  const course = { ...identity, source: 'game', sourceUrl: GAME_URL, fetchedAt: now().toISOString(),
    par: Math.round(initial.averageScore), averageScore: initial.averageScore,
    percentFinished: initial.percentFinished, minScore: initial.minScore, maxScore: initial.maxScore, percentiles };
  if (!validateCourse(course)) throw new Error('Collected course data failed validation.');
  return course;
}

export function updateFeed(feed, course) {
  if (feed?.version !== 1 || !Array.isArray(feed.courses) || !feed.courses.every(validateCourse)) {
    throw new Error('The existing course archive is invalid; it was left intact.');
  }
  return { version: 1, courses: [...feed.courses.filter(saved => saved.courseDate !== course.courseDate), course]
    .sort((a, b) => a.courseDate.localeCompare(b.courseDate)) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const target = new URL('../data/courses.json', import.meta.url);
    const feed = JSON.parse(await readFile(target, 'utf8'));
    const course = await scrapeCourse();
    const updated = updateFeed(feed, course);
    const temporary = new URL('../data/courses.json.tmp', import.meta.url);
    await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`);
    await rename(temporary, target);
    console.log(`Saved map #${course.mapNumber} (${course.courseDate}), par ${course.par}, ${Object.keys(course.percentiles).length} score percentiles.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
