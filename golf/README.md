# Kinda Hard Golf scores

A desktop score tracker for Kinda Hard Golf. Open `/golf/` on GitHub Pages. No build step, external fonts, or dependencies are required. Dark mode is the default; the theme toggle saves a preference under `golf.theme` in localStorage.

## Local preview

From the repository root:

```sh
python -m http.server 8767 --bind 127.0.0.1
```

Visit `http://127.0.0.1:8767/golf/`. JavaScript modules require HTTP; opening the HTML file directly is unsupported.

Run the domain and adapter checks with Node.js 20 or later:

```sh
cd golf
node --test
```

## Demo data and storage

The sample season contains the week of 12–16 October 2026 and the three preceding weeks. The mock instant in `config.js` is fixed at 15 October; `dateInTimeZone()` converts it to a Copenhagen calendar date. Map #561 matches that date in the inspected game calendar. The live game resets at 04:00 UTC, which differs from the league's Copenhagen midnight; a live adapter must account for this when selecting the active course. Sample checkpoint counts vary by map.

Players, browser identity, and submitted scores are stored under `office-open.mock.v1` in localStorage. Name registration is case-insensitive and the name cannot be changed through the app. Reset demo removes the identity and submissions and restores the sample league. Export scores downloads the stored dataset as JSON.

After today's score is submitted, the form is replaced by the saved result. This also applies after reloading or when another tab submits the score. The form is available when the active league date has no result for the current player.

## Handicaps and player statistics

Select a player below the leaderboard to see their handicap, today's expected shots, daily league group, rounds played, average shots, and best score. Open a score for its par comparison, target comparison, league rank, and global groups when collected.

The handicap is the average of `shots − par` across the last 20 earlier played rounds with known par, rounded to one decimal. It requires at least three rounds. Today's target is `par + handicap`, rounded to whole shots with a minimum of one. Negative handicaps are supported. The current round and future rounds never enter their own target. Missing historical submissions and revised par snapshots can recalculate targets. This is a league statistic, not an official golf handicap. Assigned scores count toward weekly rankings and awards; handicap, rounds played, averages, best scores, and percentiles use submitted rounds only.

League groups compare submitted scores on the same map. `Top N%` is the percentage of scores equal to or better than the player's score, rounded up; ties share the same rank and group. A sole player or an all-tied field is top 100%. Global groups are supplied by the game for first daily runs and repeat runs separately. They are not inferred from the league's scores. Scores outside the collected range show no global percentile.

Demo historical courses use visibly marked sample par. A collected snapshot replaces sample par only when both its map number and date match the demo calendar. The fixed demo date does not advance with the collector. Remove sample par when connecting a live league; real handicaps need three earlier rounds with collected par.

## Daily game data

Run the collector from the repository root:

```sh
node golf/scripts/scrape-courses.js
```

The collector reads the public game page and its current JavaScript module, discovers the game's daily reset calculation and stats request, and collects the same data used by the game. It does not require login, run gameplay, or submit scores. The inspected game uses a 04:00 UTC reset with map zero on 2 April 2025. Its displayed par is the rounded global average and changes during the day.

`golf/data/courses.json` retains one latest snapshot per course date, including collection time, par, average, completion percentage, score range, and first/repeat percentiles for integer scores up to the daily maximum, capped at 500. Collection is sequential with a 150 ms pause between score requests, a 15-second request timeout, and up to three attempts for temporary failures. These are snapshots collected over an interval, not a single atomic reading. The game has no documented integration contract; changes to its page or internal requests may require collector updates. Invalid responses and collections crossing the daily reset leave the existing archive intact.

`.github/workflows/golf-stats.yml` collects four times daily at 05:17, 11:17, 17:17, and 23:17 UTC, saves snapshots to the repository, and deploys GitHub Pages. Main-branch pushes run checks and deploy without recollecting. Manual workflow runs collect and deploy. In repository **Settings → Pages**, select **GitHub Actions** as the build source before enabling this workflow. Its explicit Pages deployment publishes collected data even though commits made by `GITHUB_TOKEN` do not trigger another workflow. Scheduled jobs can be delayed by GitHub; timestamps in the UI identify the collection time.

The browser reads only the local JSON feed, avoiding cross-origin game requests. If the feed fails, score entry and league statistics remain available; game data is marked unavailable. Global statistics are never fabricated when a snapshot is missing. The archive begins when collection starts; this collector cannot backfill past game statistics.

This data is local to each browser and origin. It is editable through browser developer tools and provides no identity verification. The mock does not provide a shared leaderboard or protection against impersonation. Storage errors are reported instead of claiming a successful save. Tabs on the same origin refresh when storage changes.

## League rules

- Weeks run Monday through Friday in Europe/Copenhagen, including daylight-saving changes. Lowest total wins. Played and assigned scores count toward all due rounds for ranking. During the week, rankings are provisional.
- Once a day is earlier than the league's current date, every registered player without a submission is assigned the highest submitted score on that map plus one. Today's and future rounds remain pending. If nobody submitted on a day, it stays pending until a submitted score provides a baseline. Weekends are excluded.
- Assigned scores appear in red with `DNF` (did not finish). Their details show the highest submitted score and the added stroke. Weekly totals show played and assigned round counts separately.
- Assignments are calculated from submissions when standings are read, including archived weeks. They are not stored as submissions and have no checkpoints. Multiple absent players receive the same score; assignments never become the baseline for another assignment. Late submissions replace assignments and recalculate any assignments based on the day's highest score.
- Players with pending due rounds appear below the rankings, ordered by rounds counted, then total. Pending rounds do not count as zero.
- Equal totals share a place. The archive shows every tied winner and loser. A sole eligible player is the winner and has no loser.
- One submission per player per map. Scores are final: duplicate writes are rejected by the adapter. There is no update operation.
- Missing historical scores can be submitted during the demo and recalculate archives. Define a submission deadline before making weekly awards permanent.
- Checkpoint counts vary by map. A checkpoint dash means skipped, not zero shots. The reported total must equal the numeric checkpoint shots.

## Source layout

- `index.html`, `styles.css`, `assets/`: page and original SVG artwork.
- `app.js`: rendering, forms, dialogs, and interactions.
- `domain.js`: parsing, date arithmetic, standings, and awards.
- `config.js`: sample clock, map-date anchor, and competition days.
- `mock-db.js`: asynchronous database adapter and sample-data generator.
- `course-data.js`, `data/courses.json`: validated daily game snapshots and feed loading.
- `scripts/scrape-courses.js`: game page inspection and daily statistics collection.

## Connecting Supabase

Replace the adapter imported by `app.js`. Keep this interface:

| Method | Result |
| --- | --- |
| `getLeague()` | `{ config, players, scores, courses, identity }` |
| `registerPlayer(name)` | A player record |
| `submitScore({ rawText })` | The saved score, including `courseDate`; rejects existing player/map pairs |
| `exportData()` | A JSON string |
| `resetDemo()` | Restores browser-local sample data; remove this action for the live league |

Player records contain `id`, `name`, `color`, and `ink`. Scores contain `playerId`, `mapNumber`, `courseDate`, `total`, `checkpoints: [{ index, shots }]`, `rawText`, and optionally `submittedAt`. `shots: null` represents a skipped checkpoint. Identity is the current player record or `null`.

Return submitted scores in `league.scores`. `standingsForWeek()` derives missed-day scores with `assigned: true` and `highestTotal`, keeping them out of personal statistics and submission uniqueness checks. Export contains the submitted records; standings reproduce assignments from those records and the league date. Keep this separation in a live adapter so a late submission can replace an assignment while actual submissions remain immutable.

Courses contain `mapNumber`, `courseDate`, `par`, and `source`. Game snapshots also include `fetchedAt`, `averageScore`, `percentFinished`, `minScore`, `maxScore`, and `percentiles: { [shots]: { first, repeat } }`. A live adapter can return `courses: []` and use the checked-in JSON feed, or return persisted course snapshots from its backend. Ensure the live map calendar matches the game before associating statistics with results.

Use anonymous sessions for identity, and enforce name immutability, ownership, unique player/map pairs, insert-only scores, date eligibility, and score validation in the backend. Reject updates, including upserts, with database permissions and a unique constraint on `(player_id, map_number)`. Browser validation is only for feedback. Never place a Supabase secret/service-role key in this repository or frontend. Replace the mock clock and anchor with a verified course calendar. Use `dateInTimeZone()` for live dates in Europe/Copenhagen and refresh the active week when that date changes. Refresh shared standings after writes and when the page regains focus, or subscribe to database changes. Define the archived-week cutoff policy before launch.

When switching adapters, remove the mock storage listener, demo banner, sample-data controls, and fixed-clock explanations. The UI currently imports `STORAGE_KEY` for cross-tab mock refresh; that listener is separate from the adapter interface.
