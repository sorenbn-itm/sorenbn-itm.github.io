import { dateForMap } from './domain.js';

export function validateCourse(course) {
  if (!course || course.source !== 'game' || !Number.isSafeInteger(course.mapNumber) || course.mapNumber < 1
    || !/^\d{4}-\d{2}-\d{2}$/.test(course.courseDate) || !Number.isFinite(Date.parse(course.fetchedAt))
    || !Number.isFinite(course.averageScore) || course.averageScore <= 0 || course.averageScore > 10000
    || course.par !== Math.round(course.averageScore)
    || !Number.isFinite(course.percentFinished) || course.percentFinished < 0 || course.percentFinished > 100
    || !Number.isSafeInteger(course.minScore) || course.minScore < 1
    || !Number.isSafeInteger(course.maxScore) || course.maxScore < course.minScore
    || !course.percentiles || typeof course.percentiles !== 'object' || Array.isArray(course.percentiles)) return false;
  return Object.entries(course.percentiles).every(([score, values]) =>
    /^[1-9]\d*$/.test(score) && Number(score) <= 10000 && values
    && [values.first, values.repeat].every(value => Number.isFinite(value) && value >= 0 && value <= 100));
}

export function mergeCourseData(league, feed) {
  if (feed?.version !== 1 || !Array.isArray(feed.courses) || !feed.courses.every(validateCourse)) {
    throw new Error('Daily game statistics could not be read.');
  }
  const courses = new Map((league.courses ?? []).map(course => [course.mapNumber, course]));
  for (const course of feed.courses) {
    if (course.courseDate <= league.config.today && dateForMap(course.mapNumber, league.config) === course.courseDate) {
      courses.set(course.mapNumber, course);
    }
  }
  return { ...league, courses: [...courses.values()] };
}

export async function loadCourseData(league) {
  const response = await fetch('./data/courses.json', { cache: 'no-cache', signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw new Error('Daily game statistics are unavailable.');
  return mergeCourseData(league, await response.json());
}
