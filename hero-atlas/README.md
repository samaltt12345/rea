# Hero × Atlas

Hero × Atlas is a map-based history quiz and study atlas built as a static site with Firebase and EdgeOne serverless functions.

## Start here

- Read [`CONFIG.md`](CONFIG.md) for the configuration map, deployment variables, and project layout.
- Edit [`js/00-site-config.js`](js/00-site-config.js) for the site name, version, data namespace, tagline, intro, and feature flags.
- Press **F5** in VS Code to run the local Hero Site Config Editor, then click the **Hero** icon in the left Activity Bar to edit site settings in the sidebar.
- Edit [`js/02-firebase-config.js`](js/02-firebase-config.js) for the public Firebase web app configuration.
- Paste [`firestore.rules`](firestore.rules) into the matching Firebase project's Firestore Rules page and publish it.
- Read [`content/BOUNDARIES.md`](content/BOUNDARIES.md) to export the quiz catalog and build the bundled 10m map boundaries.

## Project structure

| Path | Contents |
| --- | --- |
| `index.html` | Site markup and script loading order |
| `js/` | Browser code, split by feature |
| `css/` | Site styles and generated Tailwind CSS |
| `edge-functions/api/` | EdgeOne server endpoints; private keys are read from environment variables |
| `scripts/` | Versioning and maintenance scripts |
| `firestore.rules` | Firestore access rules |

## Deploy and secrets

Deploy through EdgeOne Pages. Put admin passwords, Firebase service-account private keys, GitHub tokens, and webhook URLs in EdgeOne environment variables. Do not commit them or include them in browser JavaScript. The Firebase web config is public by design; Firestore rules and Firebase project settings enforce access.

See [`CONFIG.md`](CONFIG.md) for the full environment variable list, including the GitHub token required by the Steward redeploy feature.

## Version and CSS

- `npm run release:patch`, `npm run release:minor`, or `npm run release:major` updates the site and package version.
- Run `npm run setup:git-hooks` once per clone. VS Code commits then get a `v<version>:` prefix from `SITE.version` in `js/00-site-config.js`; any message you type is kept after the prefix.
- `npm run build:css` rebuilds `css/tailwind.css` from `tailwind.input.css` and `tailwind.config.js`.

## Guest access
Hero has no student accounts, usernames, passwords, or email sign-in. Firebase Anonymous Authentication creates a random guest session in each browser so Firestore can save that browser's scores, streak, settings, and push preferences. It is not a recoverable identity: clearing browser site data or switching devices starts a new guest session.

Enable **Anonymous** under Firebase Console > Authentication > Sign-in method, keep student credential providers disabled, and publish `firestore.rules`. Steward access remains separate and password protected.

## Study Atlas (Hero × Atlas)
Hero × Atlas folds the Atlas study app into Hero. It replaces the old Clio AI guide, and **no AI service is called anywhere**.

- **Where it lives:** `js/29-study-atlas.js` (UI and logic), `css/study-atlas.css` (styles) and `js/28-atlas-geo.js` (the Atlas gazetteer, shapes and grading). `js/28` is bundled from `vendor/atlas/*.ts` with `npm run build:atlas`.
- **Modes:** Explore, Learn (four levels per place), Flashcards, Test (timed, three difficulties), Blank map and Records. They work for both tours, for My Map (Personal Practice), and for any list a visitor pastes in.
- **Storage:** study progress and personal sets stay in the browser (`localStorage` keys `heroAtlas_*`). Sets can be exported and imported as `.atlas.json`, which the Atlas app also reads.
- **Maps:** Satellite (Esri World Imagery), Terrain (Esri World Physical) or Solid (one colour with Natural Earth borders, no tiles). The same toggle drives the quiz map.
- **Outlines:** Hero's `content/location-boundaries.geojson` comes first, then `content/countries.geojson` (Natural Earth Admin 0, public domain), then Atlas's bundled river/route paths and region boxes.
- **Locations:** the 1 Year tour seed (`server/seed.json` → `defaultQuiz`) holds Atlas's 57-place European Geography set.

## Site maintenance
The construction-page message can be customized in the admin panel's **Dev Mode** card. Leave the field blank to restore its default.
