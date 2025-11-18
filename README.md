# Dashboard

Dashboard is a personal decision-making and entertainment hub that brings movie discovery, live music scouting, and dining ideas into a single web app. The front end is a vanilla JavaScript single-page experience backed by Firebase for auth/persistence and a lightweight Express server for API proxying, caching, and scheduled scripts.

## Table of Contents
- [Feature Tour](#feature-tour)
  - [Movies](#movies)
  - [Live-Music](#live-music)
  - [Restaurants](#restaurants)
  - [Backups, Restore, and Settings Utilities](#backups-restore-and-settings-utilities)
- [Ticketmaster integration](#ticketmaster-integration)
- [Architecture Overview](#architecture-overview)
- [Configuration & Required Secrets](#configuration--required-secrets)
- [Local Development](#local-development)
- [Testing](#testing)
- [Troubleshooting Checklist](#troubleshooting-checklist)

## Feature Tour

### Movies
The Movies tab is a curated discovery feed for film night:
- **Three collections** – a live "Movie Stream" feed, a "Saved" list you can curate, and a "Watched" archive with ratings.
- **Quality filters** – filter the stream by minimum TMDB rating, vote count, release year window, and genre before requesting more titles.
- **Genre controls** – toggle a single focus genre or exclude any number of genres with pill chips; selections persist between visits and flow into TMDB `without_genres` requests.
- **Progressive discovery** – the client keeps paging through TMDB Discover results until it finds enough titles that meet the quality threshold (`vote_average ≥ 7` and `vote_count ≥ 50` by default).
- **Personal ratings** – mark any movie as Interested, Watched, or Not Interested. Ratings are clamped to 0–10 with half-point granularity.
- **Saved list persistence** – lists and ratings are stored both locally and in Firestore so they follow the authenticated user.
- **TMDB integration** – the UI accepts either a direct TMDB API key or uses the deployed Cloud Function proxy (`/tmdbProxy`) to keep the client keyless.
- **Critic score lookup** – pull Rotten Tomatoes, Metacritic, and IMDb ratings from the OMDb-backed proxy for both movie and TV titles when you need more context.

### Live Music
The Live Music tab now uses Ticketmaster’s Discovery API to surface nearby concerts and comedy shows:
- **Automatic location search** – share your location and the app queries Ticketmaster for music and comedy events within a 100-mile radius over the next two weeks.
- **Rich event cards** – each result includes the event name, start time, venue details, distance (when provided), and a direct Ticketmaster link.
- **Inline status and debug info** – helpful messages explain location or network issues, and a debug drawer summarizes each Ticketmaster request.

### Restaurants
Answer the eternal "Where should we eat?" question:
- **City or coordinate search** with optional cuisine filters.
- **Foursquare Places integration** via the Express proxy that accepts a key from request headers, query parameters, or the `FOURSQUARE_API_KEY` environment variable.
- **Result cards** include ratings, categories, price tier, distance, and external links when Foursquare supplies them.
- **Caching layer** – identical Foursquare lookups are cached for 30 minutes to conserve API quota.
- **Map-friendly data** – coordinates are included whenever Foursquare returns them, so you can plot results in custom map overlays.

### Backups, Restore, and Settings Utilities
Separate helper pages (`backup.json`, `restore.html`, `settings.html`) provide advanced utilities:
- **Export/import** routines for Firestore collections and locally cached preferences.
- **Environment-specific tweaks** – scripts in `scripts/` automate geolocation imports, travel KML updates, and alert workflows.
- **Monitoring aides** – Node scripts (e.g., `scripts/tempAlert.js`) integrate with Twilio or email to surface anomalies.

### Ticketmaster integration
The server exposes a `/api/shows` proxy so the client never has to ship a Ticketmaster key:
1. The proxy receives your latitude, longitude, optional radius, and day window. It issues two Ticketmaster Discovery requests—one for live music and one for comedy—and caches the combined response for 15 minutes per coordinate bucket.
2. Responses are normalized into a lightweight shape (name, venue, start time, ticket URL, distance, segment) and sorted chronologically before being returned to the browser.
3. Segment summaries (status, counts, request URLs) are included so the UI can display helpful debugging context when Ticketmaster throttles or a segment fails.

Ticketmaster keys are free for development—create one in the [Ticketmaster Developer Portal](https://developer.ticketmaster.com/products-and-docs/apis/getting-started/) and store it as `TICKETMASTER_API_KEY` in your environment. No manual input is required in the UI.

### Alternative live music APIs
If you want a broader "what's happening near me" search without providing artist keywords, consider wiring an additional proxy
to one of these location-first providers:

- **SeatGeek Discovery API** – `https://api.seatgeek.com/2/events` accepts `lat`, `lon`, and `range` (miles) parameters so you can request all concerts within a radius. Scope results by `type=concert` and cache responses per rounded coordinate bucket to avoid burning through rate limits.
- **Bandsintown Events API** – `https://rest.bandsintown.com/v4/events` lets you search by `location=LAT,LON` and `radius`. It requires a public app ID and the responses already include venue coordinates, which simplifies distance sorting client-side.

Each provider has distinct authentication and rate limits, so follow the same approach: keep keys on the server, normalize the response shape (name, venue, start time, ticket URL, distance), and bail gracefully when credentials are missing.

## Architecture Overview
- **Front end** – A hand-rolled SPA in vanilla JS, HTML, and CSS. Each tab has a dedicated module under `js/` that owns its DOM bindings, local storage, and network calls.
- **Auth & persistence** – Firebase Auth (Google provider) and Firestore handle user login state plus long-term storage for movies, tab descriptions, and other preferences. Firestore is initialized with persistent caching so the UI stays responsive offline.
- **Server** – `backend/server.js` is an Express app that serves the static bundle, proxies external APIs (Ticketmaster Discovery, Foursquare Places, Spoonacular), and exposes helper routes for descriptions, saved movies, Plaid item creation, etc. It also normalizes responses and caches expensive calls to protect third-party rate limits.
- **Cloud Functions** – The `functions/` directory mirrors much of the server logic for deployments that rely on Firebase Functions instead of the local Express instance.
- **Shared utilities** – Reusable helpers live under `shared/` (e.g., caching primitives) so both the server and Cloud Functions share a single implementation.
- **Node scripts** – `scripts/` contains operational tooling for geodata imports, monitoring, and static asset generation. They rely on environment variables documented below.

## Configuration & Required Secrets
Create a `.env` in the project root (and optionally `backend/.env`) with the credentials you intend to use. Common settings include:

| Variable | Used By | Purpose |
| --- | --- | --- |
| `PORT` | Express server | Override the default `3003` port. |
| `HOST` | Express server | Bind address; defaults to `0.0.0.0`. |
| `SPOTIFY_CLIENT_ID` | `/api/spotify-client-id` | PKCE client ID for Spotify login. |
| `TICKETMASTER_API_KEY` | Shows proxy | Ticketmaster Discovery API key for the Live Music panel. |
| `SPOONACULAR_KEY` | Spoonacular proxy | API key for recipe search. |
| `OMDB_API_KEY` (or `OMDB_KEY`/`OMDB_TOKEN`) | Movie ratings proxy | OMDb key for Rotten Tomatoes and Metacritic lookups. |
| `FOURSQUARE_API_KEY` | Restaurants proxy | Foursquare Places API key if you do not pass one per request. |
| `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` | Plaid endpoints | Enable financial account linking workflows. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | `/contact` endpoint | Enable contact form email delivery. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `ALERT_PHONE` | `scripts/tempAlert.js` | SMS alerts for monitoring. |

Remember to also configure Firebase (see `firebase.json` and `.firebaserc`) if you deploy hosting or Cloud Functions.

## Local Development
1. **Install dependencies**
   ```bash
   npm install
   ```
2. **Start the backend**
   ```bash
   npm start
   ```
   `npm start` now runs `scripts/start-server.sh`, which hydrates `YOUTUBE_API_KEY` plus the required `FIREBASE_*` config entries from Google Cloud Secret Manager (if they're not already set in your shell) and then launches the Express server on `http://localhost:3004`. The script keeps the rest of the proxies and static assets available as before.
3. **Set up API keys** – Supply environment variables for any services you plan to use (e.g., TMDB, Ticketmaster, Foursquare).
4. **Optional Firebase emulators** – If you prefer not to use the production Firestore project during development, configure the Firebase emulator suite and point the app to it.

## Firebase Hosting

- The repo is already wired to Firebase project `decision-maker-4e1d3` via `.firebaserc`. Once you have authenticated with `firebase login`, run `firebase deploy --only hosting` (add `,functions` when you want to push the Node APIs as well) to publish the front end from this repo.
- After deployment the site is accessible at `https://decision-maker-4e1d3.web.app` (and `https://decision-maker-4e1d3.firebaseapp.com`). I cannot deploy from this sandbox without project credentials, but those commands will publish the app and give you the URL you requested.

## Testing
- **Unit/integration tests** – run `npm test` to execute the Vitest suite (covers movie discovery, Ticketmaster lookups, etc.).
- **End-to-end tests** – run `npm run e2e` to launch Playwright scenarios when the supporting services are available.

## Troubleshooting Checklist
- **Location sharing disabled** – allow the site to access your location so it can request nearby Ticketmaster events. The Live Music panel will continue to show an error until geolocation succeeds.
- **Empty Discover results** – expand the radius or confirm that your `TICKETMASTER_API_KEY` is valid. The debug drawer shows the last response from Ticketmaster, including status codes for each segment.
- **`Cannot GET /api/shows`** – point `API_BASE_URL` at the deployed API (`https://narrow-down.web.app/api`) or start the Express server with `npm start` so the Live Music tab can reach the Ticketmaster proxy.
- **Spoonacular quota errors** – the proxy caches responses for six hours; if you keep seeing rate-limit messages clear the cache collection in Firestore or wait for the TTL to expire.
- **Firestore permission denials** – authenticate with Google using the Sign In button; most persistence features require a logged-in user.
- **Foursquare proxy failures** – ensure the `x-api-key` header or `FOURSQUARE_API_KEY` env var is set. The API returns `missing foursquare api key` if not.
