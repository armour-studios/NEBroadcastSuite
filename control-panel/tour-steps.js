/* NE Broadcast Suite — walkthrough content. The engine is tour.js; this file is only data.
 *
 * Kept separate so test/tour-targets.test.js can load it in Node and check every selector
 * against the markup. Stale selectors are how the old tour broke: a page is redesigned, a step
 * points at nothing, and the card floats in the middle explaining something that isn't there.
 *
 * Chapter:  { id, title, summary, page (sidebar data-tab this chapter is about, or null), steps }
 * Step:
 *   target     CSS selector to spotlight. A comma list means "the first one that's visible".
 *              Omit it for a centred card.
 *   nav        where to go first. Uses the app's own navigation functions (see tour.js go()):
 *              { tab, prod, talent, teams, ev, assets, stats, integ, card, rail, settings }
 *   title/body the card text. Plain text only.
 *   placement  preferred side of the target: 'right' | 'left' | 'bottom' | 'top' (default: auto)
 *   action     'click' makes it a "try it" step: the highlighted control is live, and clicking it
 *              moves the tour on. Only use this for controls that are safe to click at any time
 *              (sub-tabs, never anything that goes to air).
 *   hint       the "try it" instruction line (defaults to "Click the highlighted control").
 *   optional   when the target isn't on screen (feature off, not connected), skip the step
 *              quietly. Without it, a missing target still skips, but logs a warning.
 *   stay       on the chapter's last step: finishing leaves the user on this page.
 */
(function (root) {
  'use strict';

  var CHAPTERS = [
    // ── Quick start: the first-run path ─────────────────────────────────────────
    { id: 'quick', title: 'Quick start', page: null,
      summary: 'From a fresh install to a graphic on air: game, event, match, graphics and OBS.',
      steps: [
        { title: 'Welcome to NE Broadcast Suite',
          body: 'This quick start covers the minimum you need for a first show: pick your game, name the event, set the match, put a graphic on air and connect OBS. Nine stops, about two minutes. Use the arrow keys or the buttons to move, and Esc to leave at any time. Each page also has its own walkthrough, which you can open from the ? button in the top bar.' },
        { target: '.sidebar-nav', placement: 'right', nav: { tab: 'principal' },
          title: 'Your pages',
          body: 'The Live group at the top is where you run a show: Dashboard, Production, Talent, Events and Replays. The System group below is for setup: Assets, Analytics, Marketplace, Settings and Roles.' },
        { target: '#game-header-dd',
          title: 'Pick your game',
          body: 'The active game decides which scoreboard, HUD, map pool and automation load. When you change it here, every overlay switches to match.' },
        { target: '[data-dash-id="event"]', nav: { tab: 'principal' },
          title: 'Name the event',
          body: 'Give your broadcast a name and link a tournament from start.gg, Challonge or NXGEN, or a league you run in this app. The active event feeds the bracket, standings, stream queue and scores ticker.' },
        { target: '[data-dash-id="teams"]', nav: { tab: 'principal' },
          title: 'Set the match',
          body: 'Set the two teams, their logos and colours, the series score and the rosters. These drive the scoreboard and every graphic that shows teams, including the lineup, matchup and winner screen.' },
        { target: '#qk-put', nav: { tab: 'principal', rail: 'quick' }, placement: 'left',
          title: 'Put a graphic on air',
          body: 'Each chip puts one graphic on air. Click it again to take the graphic off. Chips with a gear ask for options first, such as a team, a player or a countdown length.' },
        { target: '#bottom-bar', placement: 'top',
          title: 'Cut between scenes',
          body: 'Once OBS or vMix is connected, your scenes appear along this bar. Click a scene to cut to it on program. The Clip button saves the replay buffer and creates a Twitch clip in one press.' },
        { target: '#navsearch', placement: 'right',
          title: 'Find anything',
          body: 'Search by feature, team, player, scene or clip and jump straight to it. Ctrl+K focuses this box from any page.' },
        { target: '#btn-obs-download-collection', nav: { card: 'obs' }, stay: true,
          title: 'Next step: install the OBS scenes',
          body: 'Save Scene Collection gives you a ready-made OBS scene collection that is already wired to these overlays. In OBS, go to Scene Collection, then Import. Connect OBS on this page too, and your scenes will appear on the bottom bar.' }
      ] },

    // ── Dashboard ──────────────────────────────────────────────────────────────
    { id: 'dashboard', title: 'Dashboard', page: 'principal',
      summary: 'The live cockpit: event, match, series, deck, on-air graphics and talent.',
      steps: [
        { target: '#tab-principal', nav: { tab: 'principal' }, placement: 'right',
          title: 'Dashboard: the live cockpit',
          body: 'This is a grid of widgets for running the broadcast. The widgets are live, so a change here reaches viewers as soon as you make it, unless the widget says it needs a Push.' },
        { target: '[data-dash-id="event"]', nav: { tab: 'principal' },
          title: 'Event',
          body: 'Search for a tournament or paste its link. You can also pick one of your own leagues. If a tournament has more than one event, you choose which one. The bracket, standings, stream queue and ticker all follow the active event.' },
        { target: '[data-dash-id="teams"]', nav: { tab: 'principal' },
          title: 'Match: teams and score',
          body: 'Set the teams, logos, colours, rosters and score. Swap sides with one click. The gear opens match settings: series format, team records and scene automation.' },
        { target: '[data-dash-id="series"]', nav: { tab: 'principal' }, optional: true,
          title: 'Series',
          body: 'This tracks the games in the current series, including the result and map of each one. It feeds the series score on the scoreboard and the between-games graphics.' },
        { target: '[data-dash-id="deck"]', nav: { tab: 'principal' },
          title: 'Deck',
          body: 'Your scene buttons, with a preview and hotkeys. Connect a switcher first in Marketplace, using either OBS or vMix. After that, the deck cuts live and always shows what is actually on air.' },
        { target: '#dash-section-onair', nav: { tab: 'principal' }, optional: true,
          title: 'On Air',
          body: 'Shows everything viewers can see right now. Take anything off from here, including graphics you put up from other pages.' },
        { target: '#dash-section-graphics', nav: { tab: 'principal' }, optional: true,
          title: 'Graphics',
          body: 'Every overlay is a card here: lower thirds, standings, bracket, matchup, desk topics and sponsor plates. Edit a card, then press Push Live. The bracket card also lets you pick the phase and pool and search for a team.' },
        { target: '[data-dash-id="director"]', nav: { tab: 'principal' }, optional: true,
          title: 'Director Control Center',
          body: 'Shows who is on camera. Put hosts and casters on deck, watch their cameras and change the on-air lineup live. Pop it out to move people between rooms and listen in without putting them on air.' },
        { target: '#dash-customize-btn', nav: { tab: 'principal' }, stay: true,
          title: 'Customize the layout',
          body: 'Rearrange widgets, change the number of columns, or add and remove cards until the dashboard fits the way you produce.' }
      ] },

    // ── Top bar + bottom bar ────────────────────────────────────────────────────
    { id: 'live', title: 'Top bar and program bar', page: null,
      summary: 'Game, timer, ads, notifications, preview, search, scene cuts and clipping.',
      steps: [
        { target: '#game-header-dd',
          title: 'Active game',
          body: 'The active game sets the scoreboard, HUD, map pool and automation. Every page follows it.' },
        { target: '#prod-timer',
          title: 'Segment timer',
          body: 'This timer drives the countdown overlay. The arrow opens the full panel, where you set the time, the headline and what happens at zero. Stream Deck countdown keys control this same timer.' },
        { target: '#tb-ad-area', optional: true,
          title: 'Twitch ads',
          body: 'Allow or block ads, pick a length, run one now or snooze the next one. Ads never run on their own. A commercial only plays when you press the button.' },
        { target: '#btn-notif',
          title: 'Notifications',
          body: 'Connection drops, expired tokens and system warnings appear here and don\'t interrupt what you\'re doing.' },
        { target: '#btn-obs-preview',
          title: 'Program preview',
          body: 'Opens a small preview of what OBS is sending to program. It works on every page.' },
        { target: '#btn-tour-help',
          title: 'Help and walkthroughs',
          body: 'Opens this walkthrough library at any time. If the page you\'re on has its own chapter, it appears first.' },
        { target: '#bottom-bar', placement: 'top',
          title: 'Program cuts',
          body: 'Your OBS or vMix scenes, one click each. The bar also shows the next match from the stream queue. Drag scenes to reorder them. The number keys follow the order on the bar.' },
        { target: '#btn-bb-clip', placement: 'top',
          title: 'Clip',
          body: 'Saves the OBS replay buffer and creates a Twitch clip in one press. A green dot means both the buffer and Twitch are ready. If the buffer is off, the button starts it.' },
        { target: '#navsearch', placement: 'right', stay: true,
          title: 'Search anything',
          body: 'Search for panels, teams, players, crew, scenes, clips and flows. Ctrl+K opens it from anywhere, and each result takes you to the right page and sub-tab.' }
      ] },

    // ── Right rail ──────────────────────────────────────────────────────────────
    { id: 'rail', title: 'The quick-actions rail', page: null,
      summary: 'The panel on the right that stays on screen on every page, and what each tab does.',
      steps: [
        { target: '#qrail', nav: { rail: 'quick' }, placement: 'left',
          title: 'The quick-actions rail',
          body: 'The rail stays on screen whatever page you\'re on, so you can run the show while you set up something else. Drag its inner edge to resize it, and click the open tab to fold it away.' },
        { target: '#qrail', nav: { rail: 'quick' }, placement: 'left',
          title: 'On Air',
          body: 'Shows what viewers see: stream status and title, the put-on-air chips and the program feed.' },
        { target: '#qrail', nav: { rail: 'ros' }, placement: 'left',
          title: 'Up Next',
          body: 'The run of show and the match queue. Step through the rundown segments and see which match is coming next.' },
        { target: '#qrail', nav: { rail: 'talent' }, placement: 'left',
          title: 'Talent',
          body: 'Casters and players: cameras, mics and listen-in for every room, from any page.' },
        { target: '#qrail', nav: { rail: 'replay' }, placement: 'left',
          title: 'Replay',
          body: 'The replay buffer, recent clips and playlists. Capture a clip and send it to air without leaving the page you\'re on.' },
        { target: '#qrail', nav: { rail: 'twitch' }, placement: 'left',
          title: 'Chat',
          body: 'Chat, activity, Q&A, predictions and channel tools. Click a chat message to feature it on stream.' },
        { target: '#qrail', nav: { rail: 'flows' }, placement: 'left',
          title: 'Automation',
          body: 'Fire flows, and turn the AI shield, auto-director and auto-clipping on or off.' },
        { target: '#qrail', nav: { rail: 'notes' }, placement: 'left',
          title: 'Notes',
          body: 'Notes for the producer, kept in the rail so you can check them on any page.' },
        { target: '#qrail-popout-btn', nav: { rail: 'quick' }, placement: 'left', stay: true,
          title: 'Pop it out',
          body: 'Move the rail into its own window, for example on a second monitor. Close that window to bring the rail back here.' }
      ] },

    // ── Production ──────────────────────────────────────────────────────────────
    { id: 'production', title: 'Production', page: 'produccion',
      summary: 'Cameras, run of show, flows, hotkeys and the NEURAL AI director.',
      steps: [
        { target: '#tab-produccion', nav: { tab: 'produccion' }, placement: 'right',
          title: 'Production: build your show',
          body: 'This is where you prepare the show: camera feeds, the run of show, automations, hotkeys and the AI director. Once it\'s built, you run it from the Dashboard and the rail.' },
        { target: '#pd-subnav', nav: { prod: 'cameras' },
          title: 'Five workspaces',
          body: 'Cameras, Rundown, Flows, Hotkeys and NEURAL AI. Each tab is a separate workspace.' },
        { target: '#cf-subnav', nav: { prod: 'cameras' }, optional: true,
          title: 'Cameras',
          body: 'Set up the video side of your talent: assign cameras, set up VDO.Ninja rooms, request screenshares and send feeds into your OBS scenes. If you belong to an organization, feeds that other producers share appear here too.' },
        { target: '#rundown-section', nav: { prod: 'rundown' },
          title: 'Rundown',
          body: 'Your run of show, as ordered segments grouped under section headers. A segment can be a scene cut, a graphic, a countdown, a playlist or a flow, and can advance itself after a hold time. Run it from the rail\'s Up Next tab or from Stream Deck keys.' },
        { target: '#pd-subnav [data-pd="flows"]', nav: { prod: 'rundown' }, action: 'click',
          hint: 'Click Flows to open it.',
          title: 'Try it: open Flows',
          body: 'Flows are the automation side of Production. Open the tab yourself. The tour continues when you click it.' },
        { target: '#flows-section', nav: { prod: 'flows' },
          title: 'Flows',
          body: 'A flow is a chain of actions, such as scene cuts, overlays, timers and Twitch actions. It runs from one click, a hotkey or a game trigger like kickoff or match end. Use flows for the moments you repeat: going live, starting soon, back from break and match transitions.' },
        { target: '#prod-hotkeys-tab', nav: { prod: 'hotkeys' },
          title: 'Hotkeys',
          body: 'Lists every keyboard shortcut bound to a deck button. Set a key combination on any button in the Deck editor and it works from every page.' },
        { target: '#director-section', nav: { prod: 'director' },
          title: 'NEURAL AI',
          body: 'The AI director watches the game feed and suggests scene cuts, such as gameplay at kickoff, a replay after a goal, or the casters during downtime. When you arm it, it makes those cuts itself. It learns from the suggestions you accept and reject.' },
        { target: '#whats-armed', nav: { prod: 'director' }, optional: true, stay: true,
          title: 'What\'s armed',
          body: 'Lists every automation allowed to act on its own, with a log of what each one did. If a scene ever changes by itself, this panel shows why.' }
      ] },

    // ── Talent ──────────────────────────────────────────────────────────────────
    { id: 'talent', title: 'Talent', page: 'equipos',
      summary: 'Teams, the team vault, and your on-air crew with private camera rooms.',
      steps: [
        { target: '#tab-equipos', nav: { tab: 'equipos' }, placement: 'right',
          title: 'Talent: everyone on camera',
          body: 'Teams and players, plus the crew in front of the camera: casters, hosts, guests and observers.' },
        { target: '#talent-page-nav', nav: { talent: 'teams' },
          title: 'Show Deck, Teams and Crew',
          body: 'Show Deck is the on-air lineup. Teams holds rosters and logos. Crew holds your people and their camera rooms.' },
        { target: '#talent-panel-teams', nav: { talent: 'teams' },
          title: 'Teams',
          body: 'Saved teams, the teams in the current event, and the Vault. Import from CSV, or back everything up to JSON with logos included.' },
        { target: '[data-teamstab="vault"]', nav: { talent: 'teams' }, optional: true,
          title: 'The Vault',
          body: 'A permanent team database. Set a team\'s logo and roster once, and they are applied again at every future event the team plays.' },
        { target: '#talent-panel-crew', nav: { talent: 'crew' }, stay: true,
          title: 'Crew',
          body: 'Casters, hosts, guests and observers. Each has a private VDO.Ninja camera room with a join link and a QR code, so you never have to paste URLs around.' }
      ] },

    // ── Events ──────────────────────────────────────────────────────────────────
    { id: 'events', title: 'Events', page: 'events',
      summary: 'Competitions, leagues and your own events, with or without a tournament platform.',
      steps: [
        { target: '#tab-events', nav: { tab: 'events' }, placement: 'right',
          title: 'Events: the competitive side',
          body: 'Run leagues and events from start to finish, including teams, fixtures, results and standings. The live competition feeds the ticker, schedule, standings and break scenes.' },
        { target: '#ev-subnav', nav: { ev: 'competitions' },
          title: 'Events sub-tabs',
          body: 'Competitions, Leagues and My Events. A Tournaments tab also appears once you connect start.gg, Challonge or NXGEN.' },
        { target: '#ev-comp-panel', nav: { ev: 'competitions' }, optional: true,
          title: 'Competitions',
          body: 'Run a competition in this app, with no tournament platform needed. Its results can come from a Google Sheet, your website\'s feed, the API or a CSV.' },
        { target: '#ev-subnav [data-evtab="leagues"]', nav: { ev: 'competitions' }, action: 'click',
          hint: 'Click Leagues to open it.',
          title: 'Try it: open Leagues',
          body: 'Leagues hold whole seasons. Open the tab. The tour continues when you click it.' },
        { target: '#ev-leagues-panel', nav: { ev: 'leagues' },
          title: 'Leagues',
          body: 'Rosters, standings, schedule and bracket for a season. Import from CSV if you already run it somewhere else. Build a custom bracket from the league\'s Bracket tab.' },
        { target: '#ev-myevents-panel', nav: { ev: 'myevents' }, optional: true, stay: true,
          title: 'My Events',
          body: 'Single events you run yourself. Add one, give it teams, and use the Bracket button to build its bracket.' }
      ] },

    // ── Replays ─────────────────────────────────────────────────────────────────
    { id: 'replays', title: 'Replays', page: 'replays',
      summary: 'Capture from the replay buffer, trim, then show it now or add it to a playlist.',
      steps: [
        { target: '#tab-replays', nav: { tab: 'replays' }, placement: 'right',
          title: 'Replays',
          body: 'The workflow has three steps, from left to right: capture, trim, then show the clip now or add it to a playlist.' },
        { target: '#rp-capture-strip', nav: { tab: 'replays' },
          title: 'The replay buffer',
          body: 'The pill shows whether the OBS replay buffer is running. Start and stop the buffer here. It needs to be running before a replay can be captured.' },
        { target: '#rp-capture', nav: { tab: 'replays' },
          title: 'Capture Replay',
          body: 'Saves the last few seconds of the buffer and imports the clip. The new clip opens in Trim straight away. If the buffer is off, this button starts it first.' },
        { target: '.rp-pane-staging', nav: { tab: 'replays' }, optional: true,
          title: '1. Captured',
          body: 'Every clip in your OBS replay folder. Search the list, select several clips for bulk actions, or press Refresh to scan the folder again.' },
        { target: '#clip-preview-card', nav: { tab: 'replays' }, optional: true,
          title: '2. Trim',
          body: 'Set the in and out points, and the playback speed if you want slow motion.' },
        { target: '#rp-to-program', nav: { tab: 'replays' }, stay: true,
          title: '3. Show it',
          body: 'Show Now plays the clip or playlist on OBS program. It switches to your chosen scene, plays with audio, and can return to the previous scene when it ends. Preview puts it on the preview bus first without going live.' }
      ] },

    // ── Assets ──────────────────────────────────────────────────────────────────
    { id: 'assets', title: 'Assets', page: 'media',
      summary: 'Your image library and every overlay browser source.',
      steps: [
        { target: '#tab-media', nav: { tab: 'media' }, placement: 'right',
          title: 'Assets',
          body: 'Your image library and every overlay source, in one place.' },
        { target: '#assets-subnav', nav: { assets: 'media' },
          title: 'Assets and Overlays',
          body: 'Assets is the media library. Overlays lists every overlay source.' },
        { target: '#assets-panel-media', nav: { assets: 'media' }, optional: true,
          title: 'Media library',
          body: 'Upload logos, backgrounds and sponsor art once, then pick them anywhere in the app.' },
        { target: '#assets-panel-overlays', nav: { assets: 'overlays' }, optional: true, stay: true,
          title: 'Overlays',
          body: 'Every overlay with a live preview. Copy its browser-source URL into OBS, or open the scene editor to customize its HTML.' }
      ] },

    // ── Analytics ───────────────────────────────────────────────────────────────
    { id: 'analytics', title: 'Analytics', page: 'stats',
      summary: 'Broadcast data, audience growth, team and player stats, and sponsor reports.',
      steps: [
        { target: '#tab-stats', nav: { tab: 'stats' }, placement: 'right',
          title: 'Analytics',
          body: 'Data from start.gg, Twitch and live games is pulled in automatically. Filter by date, game or tournament. Everything updates in real time.' },
        { target: '#stats-subnav', nav: { stats: 'overview' },
          title: 'What\'s in here',
          body: 'Overview, Tournaments, Teams, Players, Broadcasts, Audience and Sponsors. On the Tournaments tab you can import a start.gg tournament\'s full history.' },
        { target: '#stats-subnav [data-stab="audience"]', nav: { stats: 'audience' }, optional: true,
          title: 'Audience',
          body: 'Live Twitch followers, subscribers and clips, and how they changed over each broadcast.' },
        { target: '#stats-subnav [data-stab="sponsors"]', nav: { stats: 'sponsors' }, optional: true, stay: true,
          title: 'Sponsors',
          body: 'How long each sponsor was on screen, per broadcast. Use it as proof for your partners.' }
      ] },

    // ── Marketplace ─────────────────────────────────────────────────────────────
    { id: 'marketplace', title: 'Marketplace', page: 'integrations',
      summary: 'Connect OBS, vMix, Twitch, tournament platforms and the Stream Deck.',
      steps: [
        { target: '#int-store-grid', nav: { integ: 'store' }, placement: 'right',
          title: 'Integrations',
          body: 'Every platform the suite connects to, each with a live status: green means connected, amber needs attention, grey is not set up yet. Click a card to open that app\'s settings. Each key field has a "How do I get this?" guide.' },
        { target: '#int-store-grid .int-card[data-card="obs"]', nav: { integ: 'store' },
          title: 'Pick one switcher',
          body: 'Use either OBS or vMix, not both. Connecting one lets the deck, the bottom bar and the automations cut scenes for you.' },
        { target: '#int-store-grid .int-card[data-card="startgg"]', nav: { integ: 'store' }, optional: true,
          title: 'Tournament platforms',
          body: 'start.gg, Challonge, FACEIT, NXGEN, Liquipedia and Google Sheets. Add a token once and brackets, standings and the stream queue fill themselves.' },
        { target: '#int-store-grid .int-card[data-card="streamdeck"]', nav: { integ: 'store' }, optional: true,
          title: 'Elgato Stream Deck',
          body: 'The official plugin adds score keys in team colours, graphics keys that light up while on air, a live countdown, run-of-show navigation, mutes and replays. It finds the app on its own.' },
        { target: '#int-store-grid .int-card[data-card="twitch"]', nav: { integ: 'store' }, stay: true,
          title: 'Twitch',
          body: 'Connect your channel to use chat in the rail, predictions, ad controls, clips, and the live numbers on Analytics > Audience.' }
      ] },

    // ── Settings ────────────────────────────────────────────────────────────────
    { id: 'settings', title: 'Settings', page: 'ajustes',
      summary: 'Games, brand kits, Twitch viewer features and your profile.',
      steps: [
        { target: '#set-rail', nav: { settings: 'general' }, placement: 'right',
          title: 'Settings',
          body: 'Settings opens over the page you\'re on. Pick a category on the left. Esc or the X closes it.' },
        { target: '#set-rail [data-stab="games"]', nav: { settings: 'games' }, placement: 'right',
          title: 'Games',
          body: 'One game strip controls every game-specific setting: connection, overlay, automation and scoring. Rocket League automation is set up here.' },
        { target: '#set-rail [data-stab="brandkits"]', nav: { settings: 'brandkits' }, placement: 'right',
          title: 'Brand Kits',
          body: 'A brand kit holds a logo, colours, fonts and sponsor placements, and each kit can have packages for different sponsors or shows. Activating a kit changes the look of the whole broadcast in one click.' },
        { target: '#set-rail [data-stab="features"]', nav: { settings: 'features' }, placement: 'right',
          title: 'Features',
          body: 'Viewer features for Twitch: predictions, the giveaway wheel and chat mini-games.' },
        { target: '#set-rail [data-stab="profile"]', nav: { settings: 'profile' }, placement: 'right',
          title: 'Profile and organization',
          body: 'Sign in to sync your producer profile to the cloud. If your studio is part of an organization, teams, leagues and camera feeds are shared with its other producers.' },
        { target: '#tour-section', nav: { settings: 'general' }, stay: true,
          title: 'Come back any time',
          body: 'Every walkthrough is listed here and under the ? button in the top bar. Your progress is saved, so you can finish a chapter later.' }
      ] }
  ];

  root.NETourChapters = CHAPTERS;
  if (typeof module !== 'undefined' && module.exports) module.exports = CHAPTERS;
})(typeof window !== 'undefined' ? window : globalThis);
