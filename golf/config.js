import { dateInTimeZone, mapForDate, mondayOf } from './domain.js';

const timeZone = 'Europe/Copenhagen';
const today = dateInTimeZone(new Date(), timeZone);

export const leagueConfig = Object.freeze({
  name: 'Kinda Hard Golf scores',
  timeZone,
  weekdays: [1, 2, 3, 4, 5],
  // Supabase replaces these initial calendar values with its server clock.
  today,
  seasonStart: mondayOf(today),
  mapAnchor: { date: '2025-04-02', number: 0 },
  archiveWeeks: 3,
});

export function activeMap(config) {
  return config.activeMapNumber ?? mapForDate(config.today, config);
}
