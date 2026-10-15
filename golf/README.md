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

The sample season contains the week of 12–16 October 2026 and the three preceding weeks. The mock instant in `config.js` is fixed at 15 October; `dateInTimeZone()` converts it to a Copenhagen calendar date. Map #561 is assigned to that date for demonstration; the live game's map-date relationship and daily reset time must be verified before launch. Sample checkpoint counts vary by map.

Players, browser identity, and submitted scores are stored under `office-open.mock.v1` in localStorage. Name registration is case-insensitive and the name cannot be changed through the app. Reset demo removes the identity and submissions and restores the sample league. Export scores downloads the stored dataset as JSON.

After today's score is submitted, the form is replaced by the saved result. This also applies after reloading or when another tab submits the score. The form is available when the active league date has no result for the current player.

This data is local to each browser and origin. It is editable through browser developer tools and provides no identity verification. The mock does not provide a shared leaderboard or protection against impersonation. Storage errors are reported instead of claiming a successful save. Tabs on the same origin refresh when storage changes.

## League rules

- Weeks run Monday through Friday in Europe/Copenhagen, including daylight-saving changes. Lowest total wins. Players must complete all due rounds to appear in the rankings. During the week, rankings are provisional.
- Incomplete players are ordered by rounds submitted, then total. Missing rounds do not count as zero.
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

## Connecting Supabase

Replace the adapter imported by `app.js`. Keep this interface:

| Method | Result |
| --- | --- |
| `getLeague()` | `{ config, players, scores, identity }` |
| `registerPlayer(name)` | A player record |
| `submitScore({ rawText })` | The saved score, including `courseDate`; rejects existing player/map pairs |
| `exportData()` | A JSON string |
| `resetDemo()` | Restores browser-local sample data; remove this action for the live league |

Player records contain `id`, `name`, `color`, and `ink`. Scores contain `playerId`, `mapNumber`, `courseDate`, `total`, `checkpoints: [{ index, shots }]`, `rawText`, and optionally `submittedAt`. `shots: null` represents a skipped checkpoint. Identity is the current player record or `null`.

Use anonymous sessions for identity, and enforce name immutability, ownership, unique player/map pairs, insert-only scores, date eligibility, and score validation in the backend. Reject updates, including upserts, with database permissions and a unique constraint on `(player_id, map_number)`. Browser validation is only for feedback. Never place a Supabase secret/service-role key in this repository or frontend. Replace the mock clock and anchor with a verified course calendar. Use `dateInTimeZone()` for live dates in Europe/Copenhagen and refresh the active week when that date changes. Refresh shared standings after writes and when the page regains focus, or subscribe to database changes. Define the archived-week cutoff policy before launch.

When switching adapters, remove the mock storage listener, demo banner, sample-data controls, and fixed-clock explanations. The UI currently imports `STORAGE_KEY` for cross-tab mock refresh; that listener is separate from the adapter interface.
