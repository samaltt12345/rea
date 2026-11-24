// ===== EDIT SITE SETTINGS HERE =====
// When you duplicate this repo, give it a new unique id and update the name.
// The id namespaces this site's Firestore data when projects share one Firebase database.
const SITE = {
  id: 'hero-atlas-2026',
  name: 'Hero × Atlas',
  version: '1.5.0.0',
  tagline: 'STUDYING, REDEFINED.',

  // Public opening time. Hero × Atlas is open now; set a future ISO time to show the launch gate again.
  launchAt: '2026-11-23T00:00:00Z',

  // Increase intro to replay the opening film for everyone. Optional: set a custom MP4 path.
  intro: 4, 
  introVideo: 'media/hero-trailer.mp4', // Example: 'media/hero-intro.mp4'

  // Turn features off here rather than removing their source files.
  features: {
    studyAtlas: true,
    music: true,
    tutorial: true,
    cookies: true,
    secrets: true,
    flappyBird: true,
    randomLocations: true,
  },
}

// Site id is used by the Firestore paths throughout the app.
window.__app_id = SITE.id;
