# Twitch Integration System for JotaOverlay
## Predictions, Giveaway Wheel, and Chat Mini-Games

---

## EXECUTIVE SUMMARY

This document outlines a modular Twitch integration system that adds three viewer engagement features while maintaining architectural consistency with your existing adapter/event/scene patterns.

**Three Features:**
1. **Predictions** - Stream activities to Twitch channel points predictions + overlay alerts
2. **Giveaway Wheel** - Interactive spinning wheel scene (control panel + viewer display)
3. **Chat Mini-Game** - BRB/break screen interactive game (trivia, guessing, speed game)

**Architecture**: Follows your existing patterns — WebSocket hub, event adapters, scene architecture, state broadcasting.

**Timeline**: 4-6 weeks for full implementation with polish.

---

## 1. TWITCH INTEGRATION ARCHITECTURE

### 1.1 New Files & Directory Structure

```
backend/integrations/
├── twitch-client.js          # EventSub webhook client + chat connector
├── twitch-predictions.js     # Prediction manager (state machine)
├── twitch-wheel.js           # Wheel state manager + animation sync
├── twitch-chat-games.js      # Mini-game engine (trivia, guessing, etc.)
└── twitch-webhooks.js        # Express routes for EventSub callbacks

overlay/
├── twitch-wheel.html         # Spinning wheel scene
├── twitch-alerts.html        # Prediction & activity feed
└── twitch-minigame.html      # Chat game scene (BRB screen)

control-panel/
└── (new Twitch tab section in existing app.js)
```

### 1.2 State Extension

Add to `state` object in `server.js`:

```javascript
twitch: {
  // Connection & Auth
  connected: false,
  channelId: '',
  userId: '',
  displayName: '',
  apiToken: '',          // OAuth token (encrypted in storage)
  webhookSecret: '',     // EventSub webhook secret
  webhookUrl: '',        // Public URL for callbacks
  
  // Predictions
  predictions: {
    enabled: true,
    current: null,       // { id, title, outcomes, createdAt, endsAt }
    history: [],         // Last 50 predictions
    settings: {
      autoCreate: false,
      template: 'generic',
      cooldown: 300000   // 5min between predictions
    }
  },
  
  // Giveaway Wheel
  wheel: {
    current: null,       // { id, prizes[], winner, state: 'idle'|'spinning'|'ended' }
    prizes: [
      { id: 'prize-1', name: 'Sub Gift', color: '#FF6B6B', weight: 1 },
      { id: 'prize-2', name: '$25 Amazon', color: '#4ECDC4', weight: 1 },
      { id: 'prize-3', name: 'Game Copy', color: '#FFE66D', weight: 2 }
      // ... more prizes
    ],
    history: [],         // Last 20 spins
    settings: {
      duration: 8000,    // Spin animation length (ms)
      requireLiveView: false,
      entryMethod: 'follow'  // 'follow', 'sub', 'points', 'chat'
    }
  },
  
  // Chat Mini-Games
  minigame: {
    current: null,       // { id, type, state, participants, winner }
    games: [
      // Game templates
    ],
    history: [],         // Last 20 games
    settings: {
      enabled: true,
      defaultDuration: 30000,
      breakScreenGameType: 'trivia',  // What game shows on BRB
      pointReward: 500    // Channel points per correct answer
    }
  },
  
  // Events & Activity
  chat: {
    recentMessages: [],  // Last 100 chat messages (for context)
    activeParticipants: [] // Viewers in channel
  }
}
```

---

## 2. FEATURE 1: TWITCH PREDICTIONS

### 2.1 Overview

**What it does:**
- Track active/recent Twitch channel point predictions
- Display current prediction on stream overlay
- Auto-create predictions based on game events (optional)
- Show prediction results and feed

**Control Panel UI:**
- Prediction dashboard (current prediction, outcomes, live vote %)
- Create prediction modal (title, outcomes 1-4, duration)
- Auto-create triggers (e.g., "Game Starting", "Best of 5")
- Prediction history

### 2.2 Prediction State Machine

```
IDLE
  ↓ (create) → CREATED (awaiting stream events)
  ↓ (start)  → ACTIVE (viewers voting, accepting predictions)
  ↓ (lock)   → LOCKED (no more votes accepted)
  ↓ (resolve) → RESOLVED (winner determined, points awarded)
  ↓ (end)    → ENDED (archived)
```

### 2.3 WebSocket Messages

**Control Panel → Server:**
```javascript
send('prediction-create', {
  title: 'Who will score first?',
  outcomes: [
    { title: 'Blue Team', color: '#055FDB' },
    { title: 'Orange Team', color: '#FF7F50' }
  ],
  duration: 300  // seconds
})

send('prediction-resolve', {
  predictionId: 'xxx',
  winningOutcomeId: 'outcome-1'
})

send('prediction-settings-update', {
  autoCreate: true,
  triggers: ['match-start', 'game-start']
})
```

**Server → Overlay:**
```javascript
broadcast('prediction-update', {
  type: 'new'|'state-change'|'vote-update'|'resolved',
  prediction: {
    id, title, outcomes, state,
    createdAt, endsAt, lockedAt, resolvedAt
  },
  outcomes: [
    { id, title, votes, userVotes, totalPoints },
    ...
  ]
})
```

### 2.4 Twitch EventSub Subscriptions

Listen for:
- `channel.prediction.begin` - New prediction started
- `channel.prediction.progress` - Vote updates
- `channel.prediction.lock` - Prediction locked
- `channel.prediction.end` - Prediction resolved

**Webhook Handler:**
```javascript
// backend/integrations/twitch-webhooks.js
app.post('/api/twitch/webhooks/predictions', (req, res) => {
  const { subscription, event } = req.body;
  
  if (subscription.type === 'channel.prediction.begin') {
    // Store prediction in state.twitch.predictions.current
    // Broadcast to overlay
  }
  // ... handle other events
  
  res.status(204).send();
});
```

### 2.5 Overlay Scene: `twitch-alerts.html`

Shows:
- Current prediction (title, live vote %, vote counts)
- Recent activity feed (followers, subscribers, raids)
- Alerts for major events (predictions locked/resolved)

**Styling:**
- Sits in corner or banner area (configurable position via control panel)
- Color-coded by alert type
- Fade in/out animations
- Click to dismiss

---

## 3. FEATURE 2: GIVEAWAY SPINNING WHEEL

### 3.1 Overview

**What it does:**
- Display spinning wheel on stream with 6-12 prize slots
- Producer controls spin via control panel (1-click)
- Configurable prizes with weights (some prizes more likely)
- Automatic/manual winner selection
- Integration with chat (viewers can enter via follow, sub, points spend)

**Control Panel UI:**
- Wheel designer (add/remove/reorder prizes, set weights/colors)
- Spin button (large, obvious)
- Winner announcement + overlay animation
- Entry method selector (who can participate?)
- Prize history & analytics

### 3.2 Wheel State Machine

```
IDLE (wheel stationary, ready)
  ↓ (producer clicks spin) → SPINNING (animation running)
  ↓ (animation ends)     → STOPPED (result locked)
  ↓ (confirm winner)     → CLAIMED (prize awarded to participant)
  ↓ (reset)              → IDLE
```

### 3.3 Wheel Mechanics

**Spin Logic:**
- Client-side animation (smoother UX): 20+ full rotations over 8 seconds
- Server deterministically picks winner before animation starts
- Wheel slows to reveal pre-picked result (eliminates perceived bias)

**Prize Weighting:**
```javascript
// Example
prizes: [
  { id: '1', name: 'Sub Gift', weight: 1, color: '...' },
  { id: '2', name: '$25 Amazon', weight: 0.5, color: '...' }, // Rarer
  { id: '3', name: 'Game Copy', weight: 2, color: '...' },   // Common
]
// Normalize weights → probability per prize
// Spin uses weighted random selection
```

### 3.4 WebSocket Messages

**Control Panel → Server:**
```javascript
send('wheel-spin', {
  wheelId: 'giveaway-1',
  forceWinnerId: null  // Optional: predetermined winner
})

send('wheel-prize-update', {
  prizes: [
    { id, name, color, weight },
    ...
  ]
})

send('wheel-settings-update', {
  duration: 8000,
  entryMethod: 'follow|sub|points',
  pointsRequired: 500
})
```

**Server → Overlay:**
```javascript
broadcast('wheel-spin-start', {
  wheelId, spinId, targetPrizeId, duration
})

broadcast('wheel-spin-end', {
  spinId, winnerPrizeId, winner: { userId, displayName }
})
```

### 3.5 Entry System (Chat Integration)

**Participants:**
- Followers: automatically entered (optional)
- Subscribers: always entered (higher entry weighting optional)
- Channel Points spenders: can "purchase" entries (50-500 points)
- Chat command: `!enter` (if enabled)

**Webhook Hook:**
```javascript
// Listen for channel follow, subscription, points redemptions
// Add viewers to participant pool
state.twitch.wheel.participants.push({
  userId, displayName, method: 'follow'|'sub'|'points', weight: 1
})
```

### 3.6 Overlay Scene: `twitch-wheel.html`

**Layout:**
- Large centered spinning wheel (animated SVG or canvas)
- Prize names radiate from center
- Pointer at top (indicates selected prize)
- Winner name + prize announcement (post-spin)

**Animation:**
- Spin: smooth rotation with easing
- Deceleration: slows from 20x/sec → 0 over 8s
- Land: momentary bounce/wobble at result
- Announce: text overlay, sound effect, participant celebration animation

**Responsive:**
- Scales to fill screen or sidebar (via control panel position setting)
- Works in 16:9, 21:9, ultra-wide

---

## 4. FEATURE 3: CHAT MINI-GAMES (BRB Screen)

### 4.1 Overview

**What it does:**
- Interactive games displayed during breaks/BRB screens
- Chat participates by voting, answering, or clicking
- Rewards channel points for correct answers
- Multiple game types for variety

**Game Types Included:**

#### A. **Trivia**
- Question displayed on screen
- 4 multiple choice answers
- Viewers type answer in chat (`!a`, `!b`, `!c`, `!d`)
- 30-second timer
- Show results + award points to correct answerers
- Database of game-specific trivia questions

#### B. **Prediction Guessing**
- "Guess the outcome" (e.g., "How many kills in next round?")
- Viewers submit guess via chat (`!guess 15`)
- Closest guess wins
- Rewards scaling (perfect guess = 1000 pts, within 5 = 500 pts, etc.)

#### C. **Spin to Win Mini-Wheel**
- Smaller version of giveaway wheel (6 outcomes, not prizes)
- Outcomes are point values: 100, 500, 1000, 250, etc.
- Everyone who participates gets the points their "vote" lands on
- Quick (8 second round)

#### D. **Viewer Vote**
- Poll-style: "Who will clutch?" with 2-4 options
- Chat votes: `!1`, `!2`, etc.
- Majority wins
- Example: "Will team reach 50 points?" → all who voted correctly get 250 points

### 4.2 Mini-Game State

```javascript
minigame: {
  current: {
    id: 'game-123',
    type: 'trivia'|'prediction'|'spin'|'vote',
    state: 'waiting'|'active'|'calculating'|'results'|'ended',
    startedAt: timestamp,
    endsAt: timestamp,
    question: string,
    answers: [{ id, text, correct?: bool }],
    participants: [{ userId, displayName, answer, correct }],
    winner: { userId, displayName, pointsAwarded },
    nextGameAt: timestamp + (5 min default)
  }
}
```

### 4.3 Auto-Start on BRB

**Trigger:**
```javascript
// When scene switches to countdown (BRB screen)
if (scene === 'countdown' && state.twitch.minigame.settings.enabled) {
  auto_start_minigame(state.twitch.minigame.settings.breakScreenGameType)
}
```

**Sequence:**
1. BRB countdown appears
2. Chat mini-game starts automatically (30-60 sec duration)
3. Question + answers displayed on overlay
4. 3-second results fade-in
5. Next BRB countdown OR game again if time permits
6. Loop until stream returns to live

### 4.4 Chat Integration

**Listen for chat messages:**
```javascript
client.on('message', (channel, userstate, message, self) => {
  if (!state.twitch.minigame.current) return;
  
  const game = state.twitch.minigame.current;
  const answer = parseGameCommand(message);
  
  if (isValidAnswer(answer, game)) {
    game.participants.push({
      userId: userstate['user-id'],
      displayName: userstate.display_name,
      answer,
      correct: null  // Determined at game end
    });
  }
});
```

### 4.5 Rewards & Leaderboard

**Per-Game Points:**
- Correct answer: 500 points (configurable)
- Partial credit (for prediction games): 250 points
- Wrong answer: 0 points

**Leaderboard (Session):**
- Track top 10 players for the stream
- Display on overlay (optional)
- Persists per-broadcast-session

### 4.6 WebSocket Messages

**Control Panel → Server:**
```javascript
send('minigame-settings-update', {
  enabled: true,
  defaultDuration: 30000,
  breakScreenGameType: 'trivia',
  pointReward: 500
})

send('minigame-create', {
  type: 'trivia',
  questionId: 'rocket-league-1'  // or auto-select
})

send('minigame-end-early', {
  gameId: 'game-123'
})
```

**Server → Overlay:**
```javascript
broadcast('minigame-start', {
  gameId, type, question, answers, duration
})

broadcast('minigame-results', {
  gameId, correctAnswer, participants: [
    { displayName, answer, correct, pointsAwarded },
    ...
  ],
  leaderboard: [ /* top 10 */ ]
})
```

### 4.7 Overlay Scene: `twitch-minigame.html`

**Layout (adapts per game type):**

**Trivia:**
- Large question at top
- 4 answer buttons (A/B/C/D)
- Chat command hint (`Type !a to answer`)
- Live vote count per answer
- Timer countdown
- Results overlay (show correct, highlight correct voters)

**Prediction:**
- Prompt: "Guess the number of ___ (1-100)"
- Input visualization (number scale)
- Chat: `!guess 42`
- Results: show distribution of guesses, highlight winners

**Spin Mini-Wheel:**
- Smaller wheel (6 outcomes instead of 12)
- Point values displayed
- Same spin animation
- Everyone's outcome revealed post-spin

**Voter:**
- Poll-style grid (2-4 options)
- Vote count + percentage per option
- Timer
- Results: highlight winning option, show voter names

---

## 5. CONTROL PANEL UI/UX

### 5.1 New "Twitch" Tab (right-side panel)

**Section 1: Connection Status**
```
🔴 Disconnected
[Twitch OAuth Login Button]
Status: Not connected
Channel: —
Followers: — Subscribers: —
```

**Section 2: Predictions** (collapsible)
```
Current Prediction:
├─ Title: Who will score first?
├─ Outcome 1: Blue (45%) [Outcome 2: Orange (55%)]
├─ [Resolve: Blue Team] [Cancel]
└─ Settings: [Auto-create toggle] [Triggers: Game Start, Match Start]
```

**Section 3: Giveaway Wheel** (collapsible)
```
Wheel Setup:
├─ [Designer] [Prizes: 6 items]
├─ [SPIN] (large button)
├─ Last Winner: @PlayerName (Prize: Sub Gift)
└─ Settings: Duration, Entry Method, Point Cost
```

**Section 4: Chat Games** (collapsible)
```
Mini-Game Settings:
├─ Enabled: [Toggle]
├─ Break Screen Game: [Dropdown: Trivia|Prediction|Spin|Vote]
├─ Point Reward: 500 [Slider]
├─ Duration: 30s [Slider]
└─ [Create Game Now] [Leaderboard]
```

**Section 5: Chat Activity** (collapsible)
```
Recent Messages (last 10):
├─ @PlayerName: awesome stream!
├─ @Another: when does match start?
└─ @Follower: followed!

Participants: 127 online
```

### 5.2 Modals & Designer Panels

**Prediction Creator Modal:**
- Title input
- Add/remove outcomes (up to 4)
- Duration slider (30s-600s)
- Create button

**Wheel Designer Panel:**
- Drag-to-reorder prizes
- Name, color, weight per prize
- Add/delete prize buttons
- Preview wheel visualization

**Game Question Creator:**
- Load from template database or create custom
- Question text
- Answer options (A/B/C/D)
- Mark correct answer
- Save to library

---

## 6. IMPLEMENTATION SEQUENCE

### Phase 1: Foundation (Week 1)
- ✅ Add `state.twitch.*` to state object
- ✅ Create `backend/integrations/twitch-client.js` (OAuth, API calls)
- ✅ Create `backend/integrations/twitch-webhooks.js` (EventSub routes)
- ✅ Implement Twitch OAuth login flow
- ✅ Add "Twitch" control panel tab
- ✅ Test WebSocket state broadcasting

### Phase 2: Predictions (Week 2)
- ✅ Implement prediction manager (`twitch-predictions.js`)
- ✅ Handle EventSub subscription webhooks
- ✅ Create `overlay/twitch-alerts.html`
- ✅ Add prediction UI to control panel
- ✅ Test end-to-end: create prediction in Twitch → overlay updates

### Phase 3: Wheel (Week 2-3)
- ✅ Implement wheel state machine (`twitch-wheel.js`)
- ✅ Create `overlay/twitch-wheel.html` with canvas/SVG animation
- ✅ Wheel designer panel (control panel)
- ✅ Participant entry system (follow/sub/points webhooks)
- ✅ Test: spin animation, weighted random, winner display

### Phase 4: Chat Games (Week 3-4)
- ✅ Implement game engine (`twitch-chat-games.js`)
- ✅ Chat client integration (tmi.js or Twitch ChatBot API)
- ✅ Create 4 game type engines (Trivia, Prediction, Spin, Vote)
- ✅ Create `overlay/twitch-minigame.html`
- ✅ Auto-start on BRB scene detection
- ✅ Leaderboard tracking + display

### Phase 5: Polish & Features (Week 4-6)
- ✅ Add game question database + importer
- ✅ Prediction auto-create triggers + template system
- ✅ Wheel analytics & prize history
- ✅ Settings persistence
- ✅ Animations & sound effects
- ✅ Mobile-friendly control panel
- ✅ Comprehensive error handling & reconnect logic

---

## 7. DATA PERSISTENCE

**New file:**
```
%APPDATA%/ne-broadcast-suite/data/twitch-data.json
```

**Contents:**
```javascript
{
  apiToken: "encrypted-token",
  webhookSecret: "webhook-secret",
  predictions: {
    templates: [ /* prediction templates */ ],
    history: [ /* resolved predictions */ ]
  },
  wheel: {
    presets: [ /* saved wheel configs */ ],
    history: [ /* past spins */ ]
  },
  games: {
    questions: [ /* game question library */ ],
    history: [ /* past games */ ]
  }
}
```

---

## 8. SECURITY CONSIDERATIONS

### OAuth Token Storage
- **Never log or send unencrypted tokens**
- Store as: `crypto.encrypt(token, masterKey)`
- Load from disk: decrypt on server startup
- Regenerate if compromised

### Webhook Validation
- Verify `X-Twitch-Eventsub-Message-Signature` on every webhook
- Check message timestamp (reject if > 10 minutes old) — prevents replay attacks
- Only accept from Twitch IPs (optional, but recommended)

### Chat Safety
- Ignore messages with `@` mentions (bot spam prevention)
- Rate-limit answers per user per game (1 per game max)
- Ignore flagged/banned users from leaderboard

---

## 9. CODE EXAMPLES

### 9.1 Creating a Prediction (Control Panel)

```javascript
// control-panel/app.js
el('btn-create-prediction').addEventListener('click', () => {
  const prediction = {
    title: el('prediction-title').value,
    outcomes: [
      { title: el('outcome-1-text').value, color: el('outcome-1-color').value },
      { title: el('outcome-2-text').value, color: el('outcome-2-color').value }
    ],
    duration: parseInt(el('prediction-duration').value)
  };
  send('prediction-create', prediction);
});

// Handle response
ws.on('message', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.type === 'prediction-update') {
    updatePredictionDisplay(msg.prediction);
  }
});
```

### 9.2 Wheel Spin Handler (Server)

```javascript
// backend/integrations/twitch-wheel.js
function spinWheel(wheelConfig) {
  // Weighted random selection
  const winner = selectWeightedPrize(wheelConfig.prizes);
  
  const spinId = generateId();
  state.twitch.wheel.current = {
    id: spinId,
    state: 'spinning',
    targetPrizeId: winner.id,
    startedAt: Date.now(),
    duration: wheelConfig.duration
  };
  
  // Broadcast spin START (animation begins on client)
  broadcast('wheel-spin-start', {
    spinId,
    duration: wheelConfig.duration,
    targetPrizeId: winner.id
  });
  
  // After animation duration, reveal winner
  setTimeout(() => {
    const selectedParticipant = selectRandomParticipant(
      state.twitch.wheel.participants
    );
    
    broadcast('wheel-spin-end', {
      spinId,
      winnerPrizeId: winner.id,
      winnerParticipant: selectedParticipant
    });
    
    // Award prize/points if applicable
    if (selectedParticipant) {
      awardChannelPoints(selectedParticipant.userId, winner.pointValue);
    }
  }, wheelConfig.duration);
}
```

### 9.3 Chat Game Start (Server)

```javascript
// backend/integrations/twitch-chat-games.js
function startGame(gameType) {
  const gameId = generateId();
  const question = selectGameQuestion(gameType);
  
  state.twitch.minigame.current = {
    id: gameId,
    type: gameType,
    state: 'active',
    startedAt: Date.now(),
    endsAt: Date.now() + 30000,
    question: question.text,
    answers: question.answers,
    participants: []
  };
  
  // Broadcast to overlay
  broadcast('minigame-start', {
    gameId,
    type: gameType,
    question: question.text,
    answers: question.answers,
    duration: 30000
  });
  
  // Auto-end after duration
  setTimeout(() => endGame(gameId), 30000);
}

function endGame(gameId) {
  const game = state.twitch.minigame.current;
  if (game.id !== gameId) return;
  
  // Calculate winners
  const correctAnswers = game.answers.filter(a => a.correct);
  const winners = game.participants.filter(p =>
    correctAnswers.some(a => a.id === p.answer)
  );
  
  // Award points
  winners.forEach(winner => {
    awardChannelPoints(winner.userId, state.twitch.minigame.settings.pointReward);
  });
  
  broadcast('minigame-results', {
    gameId,
    correctAnswers: correctAnswers.map(a => a.id),
    winners: winners.map(w => ({ userId: w.userId, displayName: w.displayName }))
  });
}
```

---

## 10. TESTING CHECKLIST

### Predictions
- [ ] OAuth login with Twitch
- [ ] Create prediction from control panel
- [ ] Overlay shows prediction details + live voting
- [ ] Resolve prediction correctly
- [ ] Auto-create trigger fires at game start
- [ ] Multiple predictions in sequence

### Wheel
- [ ] Add/edit/delete prizes
- [ ] Spin animation smooth (60 FPS)
- [ ] Winner selected with correct probability
- [ ] Participants entering (follow, sub, points)
- [ ] Winner announced correctly
- [ ] Spin history persists

### Chat Games
- [ ] Auto-start on BRB scene detection
- [ ] Trivia: answer parsing, correct answer highlighted
- [ ] Prediction guessing: distribution shown, closest wins
- [ ] Spin mini-wheel: all participants get points
- [ ] Vote game: majority wins
- [ ] Leaderboard updates correctly
- [ ] Points awarded to channel points properly
- [ ] Multiple games in sequence

### Integration
- [ ] Predictions + wheel visible simultaneously
- [ ] Chat games don't interfere with predictions
- [ ] All scenes respond to state updates within 100ms
- [ ] Reconnect handling (Twitch API down)
- [ ] Mobile control panel responsive

---

## 11. FUTURE ENHANCEMENTS

- **Prediction Analytics**: Win rate per question type, optimal timing
- **Wheel Variants**: Prize variations, seasonal themes
- **Advanced Games**: Custom game builder, community game templates
- **Bot Moderation**: Auto-suspend users with excessive wrong answers
- **Community Challenges**: Cumulative challenges (e.g., "Win 100 trivia games for reward")
- **Clip Integration**: Auto-clip predictions (lock moment + resolve moment)
- **Sentiment Analysis**: AI reads chat tone during events
- **Extended Analytics**: Dashboard showing viewer engagement metrics

---

## 12. DEPENDENCIES

Add to `package.json`:
```json
{
  "dependencies": {
    "axios": "^1.4.0",           // HTTP for Twitch API
    "tmi.js": "^1.8.5",          // Chat client
    "crypto": "^1.0.0",          // Token encryption
    "uuid": "^9.0.0",            // ID generation
    "canvas": "^2.11.2",         // Wheel animation (optional, can use SVG)
    "events": "^3.3.0"           // Event emitter
  }
}
```

---

## 13. ARCHITECTURE CONSISTENCY

**How this integrates with existing patterns:**

| Aspect | Existing | Twitch | Consistency |
|--------|----------|--------|------------|
| **State** | `state.teams`, `state.game`, `state.banner` | `state.twitch.predictions`, `state.twitch.wheel`, `state.twitch.minigame` | ✅ Same broadcast model |
| **WebSocket** | Existing WS hub broadcasts to all clients | Twitch events → state updates → broadcast | ✅ Uses existing hub |
| **Overlays** | Scene HTML files at `/overlay/*.html` | `twitch-wheel.html`, `twitch-minigame.html`, `twitch-alerts.html` | ✅ Same architecture |
| **Control Panel** | Tab-based UI (`teams`, `settings`, `production`) | New `twitch` tab | ✅ Same pattern |
| **Events** | `rl-stats-update`, `csgo-update`, director events | `twitch-prediction-update`, `wheel-spin-start`, `minigame-start` | ✅ Event naming consistent |
| **Integrations** | `/backend/integrations/rl-stats-api.js`, `obs-client.js` | `/backend/integrations/twitch-client.js` | ✅ Same directory structure |

**Why this design is maintainable:**
- No changes to core state/broadcast system
- New features isolated to `/backend/integrations/twitch-*`
- Overlays follow existing `scene-base.js` bootstrap pattern
- Control panel tab follows existing tab structure
- Easy to enable/disable Twitch features (settings toggle)
- Easy to add more games (game type engine pattern)

---

## 14. QUICK START CHECKLIST

1. **Register Twitch Developer Application** (if not done)
   - https://dev.twitch.tv/console/apps
   - OAuth redirect URL: `http://localhost:3000/api/twitch/oauth/callback`

2. **Prepare Credentials**
   - Client ID
   - Client Secret
   - Webhook Secret (generate yourself)

3. **Enable Features in Control Panel**
   - Twitch > Connect > Login with Twitch
   - Enable Predictions, Wheel, Games (toggles)

4. **Test with Sample Data**
   - Create test prediction
   - Spin test wheel
   - Trigger test game

5. **Publish Overlays to OBS**
   - `http://localhost:3000/twitch-wheel.html`
   - `http://localhost:3000/twitch-minigame.html`
   - `http://localhost:3000/twitch-alerts.html`

---

**This architecture scales**: You can easily add more Twitch features (channel raids, subscriber alerts, chat commands, overlay redemptions) by following the same patterns.

**Questions?** I can provide:
- Detailed API implementation guides
- Sample code for each component
- OBS scene setup instructions
- Testing harness for local development
- Production deployment guide

