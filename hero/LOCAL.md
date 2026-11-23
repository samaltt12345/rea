# Running Hero locally

This copy runs the real Hero front end (`index.html`, `js/`, `css/`, `media/`, `content/`) together with the
original EdgeOne functions (`edge-functions/api/*`, `cloud-functions/api/*`), **unchanged**, on one small Node
server. You don't need a Firebase project, an EdgeOne account, or any npm packages.

```bash
cd hero
npm start            # or: node server/server.mjs
# → http://localhost:3000
```

Node 18 or newer is required (it was tested on Node 22).

## Passwords

| Where | Default |
| --- | --- |
| Launch countdown → "Early access password" | `devaccess123` |
| Under-construction screen → "Developer access" | `devaccess123` |
| Stewards' Gate (admin panel) | `devaccess123` |

You can override them with `DEV_ACCESS=... ADMIN_PASSWORD=... npm start`.

## What the server provides

- **Firestore and Auth.** `server/client/firebase-local.js` replaces the Firebase compat SDK in the browser.
  It supports anonymous guests, the steward custom-token sign-in, documents and queries, transactions,
  batches, `serverTimestamp` and `increment`, and realtime `onSnapshot` over Server-Sent Events.
  Every read and write is checked against a JavaScript port of `firestore.rules` (`server/lib/rules.mjs`),
  so guests get the same permission errors as on the live site. Data is saved to `.data/firestore.json`.
- **API functions.** `/api/auth`, `/api/firebase-token`, `/api/chat`, `/api/push-config`,
  `/api/push-announcement`, `/api/deploy`, `/api/config` and `/api/build-boundaries` run the original handler
  files. Their calls to Google OAuth, the Firestore REST API, FCM, GitHub and the EdgeOne deploy hook are
  answered locally (`server/lib/cloud.mjs`).
- **Push notifications.** These are delivered to open tabs over the same SSE stream, and the service worker
  shows them.
- **Redeploy.** "Create and redeploy" in the steward panel records a local commit and gives the site a new
  `hero-build-id`. Open tabs then show the "An update is here" notice, the same as after a real deploy.

## Optional environment variables

| Variable | Effect |
| --- | --- |
| `PORT`, `HOST` | Listen address (default `0.0.0.0:3000`) |
| `HERO_DATA_DIR` | Where data and keys are stored (default `hero/.data`) |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Turn on real Clio answers. Without a key, Clio shows "Clio isn't set up yet", as the original does |
| `GITHUB_TOKEN` **and** `GITHUB_REPOSITORY` | Make Redeploy and border rebuilds commit to a real GitHub repository instead of locally |
| `DEPLOY_WEBHOOK_URL`, `DEPLOY_BRANCH` | Real EdgeOne deploy hook and branch |
| `FLAPPY_*` | Same meaning as on EdgeOne |

## Resetting data

Stop the server, delete `.data/firestore.json`, and start the server again. It re-seeds from `server/seed.json`:
the Europe tour with 58 locations, the visit counter, site mode and the home card. Keep `.data/secrets.json`
so that existing sessions stay valid.

## Seed differences from the live site

The live site's Firestore data isn't public. The seed rebuilds what the live site shows publicly: the Europe
tour, the dev-mode flag, the visit count and the Agastya Archive home card. Leaderboards, feedback,
announcements and analytics start empty.
