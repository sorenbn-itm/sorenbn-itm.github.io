import { dateInTimeZone } from '../domain.js';

const timeZone = 'Europe/Copenhagen';
const demoNow = '2026-10-15T12:00:00Z';

export const leagueConfig = Object.freeze({
  name: 'Kinda Hard Golf scores',
  timeZone,
  weekdays: [1, 2, 3, 4, 5],
  // The mock league has a fixed clock so its sample results remain consistent.
  today: dateInTimeZone(demoNow, timeZone),
  mapAnchor: { date: '2026-10-15', number: 561 },
  archiveWeeks: 3,
});

export const exampleScore = `Kinda Hard Golf #561
📝 25

8.⛳ 5
7.⛳ 2
6.⛳ 1
5.⛳ 1
4.⛳ 1
3.⛳ 2
2.⛳ -
1.⛳ 10
0.🏌️ 3

https://kindahard.golf/`;
