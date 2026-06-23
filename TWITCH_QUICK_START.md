# Twitch Integration - Quick Start Guide
## Step-by-step implementation from zero to first feature

---

## PREP: Twitch Developer Setup (30 min)

### 1. Create Twitch Application
```
https://dev.twitch.tv/console/apps
→ Create Application
  Name: "JotaOverlay"
  Category: "Application"
  OAuth Redirect URL: http://localhost:3000/api/twitch/oauth/callback
→ Copy Client ID and Client Secret (save to .env or settings file)
```

### 2. Generate Webhook Secret
```bash
# In terminal
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Save this output — you'll need it for webhook validation
```

### 3. Install Dependencies
```bash
cd broadcaststudio
npm install axios tmi.js uuid events
```

---

## PHASE 1: Foundation (Week 1 — ~4 hours)

### Step 1.1: Update `server.js` — Add Twitch State

**File:** `server.js`  
**Find:** Line ~40 where `let state = { ... }` is defined

**Add this to the state object:**
```javascript
let state = {
  // ... existing state ...
  
  twitch: {
    connected: false,
    channelId: '',
    userId: '',
    displayName: '',
    apiToken: '',        // Store encrypted in production
    webhookSecret: process.env.TWITCH_WEBHOOK_SECRET || 'dev-secret',
    webhookUrl: process.env.TWITCH_WEBHOOK_URL || 'http://localhost:3000/api/twitch/webhooks',
    
    predictions: {
      enabled: true,
      current: null,
      history: [],
      settings: {
        autoCreate: false,
        template: 'generic',
        cooldown: 300000
      }
    },
    
    wheel: {
      current: null,
      prizes: [
        { id: 'prize-1', name: 'Sub Gift', color: '#FF6B6B', weight: 1 },
        { id: 'prize-2', name: '$25 Amazon', color: '#4ECDC4', weight: 1 },
        { id: 'prize-3', name: 'Game Copy', color: '#FFE66D', weight: 2 }
      ],
      participants: [],
      history: [],
      settings: {
        duration: 8000,
        requireLiveView: false,
        entryMethod: 'follow'
      }
    },
    
    minigame: {
      current: null,
      games: [],
      history: [],
      settings: {
        enabled: true,
        defaultDuration: 30000,
        breakScreenGameType: 'trivia',
        pointReward: 500
      }
    },
    
    chat: {
      recentMessages: [],
      activeParticipants: []
    }
  }
};
```

### Step 1.2: Create `backend/integrations/twitch-client.js`

**File:** `backend/integrations/twitch-client.js` (NEW)

```javascript
const axios = require('axios');

const TWITCH_API_BASE = 'https://api.twitch.tv/helix';

class TwitchClient {
  constructor(clientId, clientSecret, accessToken) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.accessToken = accessToken;
    this.headers = {
      'Client-ID': clientId,
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    };
  }

  async getUser(userId) {
    try {
      const res = await axios.get(`${TWITCH_API_BASE}/users?id=${userId}`, {
        headers: this.headers
      });
      return res.data.data?.[0] || null;
    } catch (err) {
      console.error('[Twitch] getUser error:', err.message);
      return null;
    }
  }

  async getChannelInfo(broadcasterId) {
    try {
      const res = await axios.get(
        `${TWITCH_API_BASE}/channels?broadcaster_id=${broadcasterId}`,
        { headers: this.headers }
      );
      return res.data.data?.[0] || null;
    } catch (err) {
      console.error('[Twitch] getChannelInfo error:', err.message);
      return null;
    }
  }

  async createPrediction(broadcasterId, title, outcomes, duration) {
    try {
      const res = await axios.post(
        `${TWITCH_API_BASE}/predictions`,
        {
          broadcaster_id: broadcasterId,
          title,
          outcomes: outcomes.map(o => ({ title: o.title })),
          prediction_window: duration
        },
        { headers: this.headers }
      );
      return res.data.data?.[0] || null;
    } catch (err) {
      console.error('[Twitch] createPrediction error:', err.message);
      return null;
    }
  }

  async resolvePrediction(broadcasterId, predictionId, outcomeId) {
    try {
      const res = await axios.patch(
        `${TWITCH_API_BASE}/predictions`,
        {
          broadcaster_id: broadcasterId,
          id: predictionId,
          status: 'RESOLVED',
          winning_outcome_id: outcomeId
        },
        { headers: this.headers }
      );
      return res.data.data?.[0] || null;
    } catch (err) {
      console.error('[Twitch] resolvePrediction error:', err.message);
      return null;
    }
  }

  async addChannelPointsCustomReward(broadcasterId, rewardData) {
    // For giveaway/game point awards
    try {
      const res = await axios.post(
        `${TWITCH_API_BASE}/channel_points/custom_rewards`,
        {
          broadcaster_id: broadcasterId,
          title: rewardData.title || 'Auto-reward',
          cost: 1,  // Dummy value
          is_enabled: false  // Don't show to viewers
        },
        { headers: this.headers }
      );
      return res.data.data?.[0] || null;
    } catch (err) {
      console.error('[Twitch] addChannelPointsCustomReward error:', err.message);
      return null;
    }
  }

  async giveChannelPoints(broadcasterId, userId, amount) {
    // Award channel points to user (via EventSub or API)
    try {
      const res = await axios.post(
        `${TWITCH_API_BASE}/channel_points/custom_rewards/redemptions`,
        {
          broadcaster_id: broadcasterId,
          user_id: userId,
          reward_id: 'builtin-points',  // or custom reward ID
          amount
        },
        { headers: this.headers }
      );
      return true;
    } catch (err) {
      console.error('[Twitch] giveChannelPoints error:', err.message);
      return false;
    }
  }
}

module.exports = { TwitchClient };
```

### Step 1.3: Create `backend/integrations/twitch-webhooks.js`

**File:** `backend/integrations/twitch-webhooks.js` (NEW)

```javascript
const crypto = require('crypto');

// Webhook signature validation (Twitch requirement)
function verifyWebhookSignature(req, webhookSecret) {
  const headers = req.headers;
  const messageId = headers['twitch-eventsub-message-id'];
  const timestamp = headers['twitch-eventsub-message-timestamp'];
  const signature = headers['twitch-eventsub-message-signature'];

  if (!messageId || !timestamp || !signature) {
    return false;
  }

  // Reject if timestamp > 10 minutes old
  const messageTime = Math.floor(new Date(timestamp).getTime() / 1000);
  const currentTime = Math.floor(Date.now() / 1000);
  if (currentTime - messageTime > 600) {
    return false;
  }

  const body = JSON.stringify(req.body);
  const hmacMessage = messageId + timestamp + body;
  const computedSignature = 'sha256=' + crypto
    .createHmac('sha256', webhookSecret)
    .update(hmacMessage)
    .digest('hex');

  return crypto.timingSafeEqual(signature, computedSignature);
}

// Register webhook handlers
function registerTwitchWebhooks(app, state, broadcast) {
  // Handle challenge (Twitch verification handshake)
  app.post('/api/twitch/webhooks/*', (req, res) => {
    if (!verifyWebhookSignature(req, state.twitch.webhookSecret)) {
      return res.status(403).send('Forbidden');
    }

    const { subscription, event } = req.body;

    if (subscription.type === 'webhook_callback_verification') {
      return res.status(200).send(event.challenge);
    }

    res.status(204).send();  // Acknowledge immediately

    // Handle the actual event
    handleTwitchEvent(subscription.type, event, state, broadcast);
  });
}

function handleTwitchEvent(eventType, event, state, broadcast) {
  console.log(`[Twitch] Event: ${eventType}`);

  switch (eventType) {
    case 'channel.prediction.begin':
      state.twitch.predictions.current = {
        id: event.id,
        title: event.title,
        outcomes: event.outcomes.map(o => ({
          id: o.id,
          title: o.title,
          votes: 0,
          totalPoints: 0
        })),
        state: 'active',
        createdAt: event.created_at,
        endsAt: event.locks_at
      };
      broadcast('full_state', state);
      break;

    case 'channel.prediction.progress':
      if (state.twitch.predictions.current?.id === event.id) {
        state.twitch.predictions.current.outcomes = event.outcomes.map(o => ({
          id: o.id,
          title: o.title,
          votes: o.users || 0,
          totalPoints: o.channel_points_won || 0
        }));
        broadcast('full_state', state);
      }
      break;

    case 'channel.prediction.end':
      if (state.twitch.predictions.current) {
        state.twitch.predictions.history.unshift(state.twitch.predictions.current);
        if (state.twitch.predictions.history.length > 50) {
          state.twitch.predictions.history.pop();
        }
        state.twitch.predictions.current = null;
        broadcast('full_state', state);
      }
      break;

    case 'channel.follow':
      // Add to wheel participants
      state.twitch.wheel.participants.push({
        userId: event.user_id,
        displayName: event.user_login,
        method: 'follow',
        weight: 1
      });
      broadcast('full_state', state);
      break;

    case 'channel.subscribe':
      // Add to wheel participants (can have higher weight)
      state.twitch.wheel.participants.push({
        userId: event.user_id,
        displayName: event.user_login,
        method: 'sub',
        weight: 2  // Subscribers can have higher chance
      });
      broadcast('full_state', state);
      break;

    default:
      console.log(`[Twitch] Unhandled event type: ${eventType}`);
  }
}

module.exports = { registerTwitchWebhooks, verifyWebhookSignature };
```

### Step 1.4: Update `server.js` — Add Twitch Route Handler

**File:** `server.js`  
**Find:** Line ~1100 where HTTP server setup is

**Add BEFORE `app.listen()`:**
```javascript
// ── Twitch Integration ────────────────────────────────────────────────────
const { registerTwitchWebhooks } = require('./backend/integrations/twitch-webhooks');
registerTwitchWebhooks(app, state, broadcast);

// OAuth callback
app.post('/api/twitch/oauth/callback', (req, res) => {
  const { code } = req.body;
  console.log('[Twitch] OAuth code received:', code?.substring(0, 10) + '...');
  
  // TODO: Exchange code for access token
  // For now, just acknowledge
  res.json({ success: true });
});

// Prediction creation
app.post('/api/twitch/prediction/create', (req, res) => {
  const { title, outcomes, duration } = req.body;
  console.log(`[Twitch] Create prediction: "${title}"`);
  
  // TODO: Call Twitch API via twitch-client.js
  res.json({ predictionId: 'temp-id' });
});

// Wheel spin
app.post('/api/twitch/wheel/spin', (req, res) => {
  const { wheelId } = req.body;
  console.log(`[Twitch] Spin wheel`);
  
  // TODO: Implement wheel spin logic
  res.json({ spinId: 'temp-spin' });
});
```

### Step 1.5: Add Twitch State Persistence

**File:** `server.js`  
**Find:** `saveFacecams()` function

**Add after it:**
```javascript
function saveTwitchData() {
  if (!state.twitch) return;
  
  const twitchDataFile = path.join(dataDir, 'twitch-data.json');
  const data = {
    webhookSecret: state.twitch.webhookSecret,
    predictions: state.twitch.predictions,
    wheel: state.twitch.wheel,
    minigame: state.twitch.minigame
  };
  
  writeAtomically(twitchDataFile, JSON.stringify(data, null, 2));
}

function loadTwitchData() {
  const twitchDataFile = path.join(dataDir, 'twitch-data.json');
  try {
    if (fs.existsSync(twitchDataFile)) {
      const data = JSON.parse(fs.readFileSync(twitchDataFile, 'utf8'));
      Object.assign(state.twitch, data);
      console.log('[Twitch] Data loaded');
    }
  } catch (err) {
    console.error('[Twitch] Failed to load data:', err.message);
  }
}
```

**Find:** `startHttpServer()` → update `saveAppState()` call:
```javascript
function saveAppState() {
  try {
    writeAtomically(stateFile, JSON.stringify(state, null, 2));
    saveFacecams();
    saveTwitchData();  // ADD THIS LINE
  } catch (err) {
    console.error('Error saving app state:', err.message);
  }
}
```

### Step 1.6: Create Minimal Control Panel "Twitch" Tab

**File:** `control-panel/index.html`  
**Find:** End of tab bar (around line 380)

**Add before closing div:**
```html
<!-- TWITCH TAB -->
<div id="tab-twitch" class="tab-button">🔴 TWITCH</div>

<!-- TWITCH TAB CONTENT -->
<div id="tab-twitch-content" class="tab-content">
  <section class="section">
    <h3 class="section-title">Twitch Connection</h3>
    <div style="padding: 20px; text-align: center;">
      <p id="twitch-status" style="color: var(--muted); margin-bottom: 12px;">
        🔴 Not Connected
      </p>
      <button class="btn btn-primary" id="btn-twitch-login">
        Login with Twitch
      </button>
    </div>
  </section>

  <section class="section" id="twitch-predictions-section" style="display: none;">
    <h3 class="section-title">Predictions</h3>
    <p id="prediction-status" style="font-size: 12px; color: var(--muted);">
      No active prediction
    </p>
    <button class="btn btn-primary" id="btn-create-prediction" style="margin-top: 12px;">
      + Create Prediction
    </button>
  </section>

  <section class="section" id="twitch-wheel-section" style="display: none;">
    <h3 class="section-title">Giveaway Wheel</h3>
    <button class="btn btn-primary btn-lg" id="btn-spin-wheel" style="width: 100%; padding: 16px; font-size: 18px; margin-top: 8px;">
      🎡 SPIN NOW
    </button>
  </section>

  <section class="section" id="twitch-minigame-section" style="display: none;">
    <h3 class="section-title">Chat Games</h3>
    <label style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
      <input type="checkbox" id="minigame-enabled" checked>
      <span>Enable on BRB</span>
    </label>
    <button class="btn btn-primary" id="btn-start-minigame" style="width: 100%;">
      + Start Game Now
    </button>
  </section>
</div>
```

### Step 1.7: Add Twitch Tab Event Listener

**File:** `control-panel/app.js`  
**Add at end:**

```javascript
// ── TWITCH TAB ────────────────────────────────────────────────────────────
el('tab-twitch')?.addEventListener('click', () => {
  switchTab('twitch');
  if (currentState.twitch?.connected) {
    el('twitch-predictions-section').style.display = 'block';
    el('twitch-wheel-section').style.display = 'block';
    el('twitch-minigame-section').style.display = 'block';
    el('twitch-status').innerHTML = '🟢 Connected';
  } else {
    el('twitch-status').innerHTML = '🔴 Not Connected';
    el('twitch-predictions-section').style.display = 'none';
    el('twitch-wheel-section').style.display = 'none';
    el('twitch-minigame-section').style.display = 'none';
  }
});

el('btn-twitch-login')?.addEventListener('click', () => {
  alert('Twitch OAuth login implementation coming next phase');
  // TODO: implement OAuth flow
});

el('btn-create-prediction')?.addEventListener('click', () => {
  const title = prompt('Prediction title:');
  if (!title) return;
  
  send('twitch-prediction-create', {
    title,
    outcomes: [
      { title: 'Outcome 1', color: '#FF6B6B' },
      { title: 'Outcome 2', color: '#4ECDC4' }
    ],
    duration: 300
  });
});

el('btn-spin-wheel')?.addEventListener('click', () => {
  send('twitch-wheel-spin', {});
  alert('Spinning the wheel...');
});

el('btn-start-minigame')?.addEventListener('click', () => {
  send('twitch-minigame-create', {
    type: 'trivia'
  });
  alert('Starting trivia game...');
});
```

### Step 1.8: Handle Twitch Messages in app.js

**File:** `control-panel/app.js`  
**Find:** `ws.on('message', (raw) => { ... })`

**Add case in message handler:**
```javascript
    case 'full_state':
      // ... existing code ...
      
      // Update Twitch status
      if (msg.data.twitch) {
        const tab = el('twitch-status');
        if (tab) {
          tab.innerHTML = msg.data.twitch.connected 
            ? '🟢 Connected' 
            : '🔴 Disconnected';
        }
        
        // Update prediction display
        if (msg.data.twitch.predictions?.current) {
          const pred = msg.data.twitch.predictions.current;
          const predStatus = el('prediction-status');
          if (predStatus) {
            predStatus.innerHTML = `<strong>${pred.title}</strong><br>` +
              pred.outcomes.map(o => `${o.title}: ${o.votes} votes`).join('<br>');
          }
        }
      }
      break;
```

---

## TEST: Foundation Works (15 min)

### Startup Test
```bash
npm start
```

### Checks
- [ ] App launches without errors
- [ ] Control panel loads
- [ ] Twitch tab appears
- [ ] "Not Connected" status shows
- [ ] Click [Create Prediction] → modal appears
- [ ] No console errors

### If Working
→ Continue to Phase 2

---

## PHASE 2: Predictions (Week 2 — ~6 hours)

### Step 2.1: Implement Twitch OAuth

**File:** `backend/integrations/twitch-client.js`  
**Add method:**

```javascript
async getAccessToken(code, clientId, clientSecret, redirectUri) {
  try {
    const res = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: {
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri
      }
    });
    
    return {
      accessToken: res.data.access_token,
      refreshToken: res.data.refresh_token,
      expiresIn: res.data.expires_in
    };
  } catch (err) {
    console.error('[Twitch] getAccessToken error:', err.message);
    return null;
  }
}
```

### Step 2.2: Implement Prediction Manager

**File:** `backend/integrations/twitch-predictions.js` (NEW)

```javascript
const { TwitchClient } = require('./twitch-client');

class PredictionManager {
  constructor(twitchClient, broadcasterId) {
    this.client = twitchClient;
    this.broadcasterId = broadcasterId;
    this.currentPrediction = null;
    this.cooldownUntil = 0;
  }

  async createPrediction(title, outcomes, durationSeconds) {
    // Check cooldown
    if (Date.now() < this.cooldownUntil) {
      throw new Error('Prediction cooldown active');
    }

    const result = await this.client.createPrediction(
      this.broadcasterId,
      title,
      outcomes,
      durationSeconds
    );

    if (result) {
      this.currentPrediction = result;
      this.cooldownUntil = Date.now() + 300000; // 5 min cooldown
      return result;
    }

    throw new Error('Failed to create prediction');
  }

  async resolvePrediction(outcomeId) {
    if (!this.currentPrediction) {
      throw new Error('No active prediction');
    }

    const result = await this.client.resolvePrediction(
      this.broadcasterId,
      this.currentPrediction.id,
      outcomeId
    );

    if (result) {
      this.currentPrediction = null;
      return result;
    }

    throw new Error('Failed to resolve prediction');
  }
}

module.exports = { PredictionManager };
```

### Step 2.3: Update server.js WebSocket Handler

**File:** `server.js`  
**Find:** WebSocket message handler

**Add:**
```javascript
case 'twitch-prediction-create': {
  const { title, outcomes, duration } = msg.data;
  console.log('[Twitch] Creating prediction:', title);
  
  if (!state.twitch.connected) {
    console.warn('[Twitch] Not connected, cannot create prediction');
    return;
  }
  
  // TODO: Call predictionManager.createPrediction()
  // Update state
  // Broadcast update
  break;
}

case 'twitch-prediction-resolve': {
  const { predictionId, outcomeId } = msg.data;
  console.log('[Twitch] Resolving prediction:', outcomeId);
  
  // TODO: Call predictionManager.resolvePrediction()
  // Update state
  // Broadcast update
  break;
}
```

### Step 2.4: Create Prediction Overlay

**File:** `overlay/twitch-alerts.html` (NEW)

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Twitch Alerts</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: transparent;
      font-family: 'Inter', sans-serif;
      color: white;
      overflow: hidden;
      width: 100%;
      height: 100%;
    }
    
    #prediction-container {
      position: absolute;
      bottom: 20px;
      right: 20px;
      width: 400px;
      background: rgba(0, 0, 0, 0.9);
      border: 2px solid #055FDB;
      border-radius: 8px;
      padding: 16px;
      display: none;
      animation: slideIn 0.3s ease-out;
    }
    
    @keyframes slideIn {
      from { transform: translateX(450px); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
    
    .prediction-title {
      font-weight: 700;
      font-size: 14px;
      margin-bottom: 12px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    
    .outcomes {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    
    .outcome {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px;
      background: rgba(255,255,255,0.05);
      border-radius: 4px;
      font-size: 12px;
    }
    
    .outcome-bar {
      flex: 1;
      height: 20px;
      background: rgba(255,255,255,0.1);
      border-radius: 3px;
      overflow: hidden;
    }
    
    .outcome-fill {
      height: 100%;
      background: #4ECDC4;
      transition: width 0.3s;
    }
    
    .outcome-text {
      width: 80px;
      font-weight: 600;
    }
    
    .vote-count {
      min-width: 40px;
      text-align: right;
      color: #FFE66D;
      font-weight: 700;
    }
  </style>
</head>
<body>

<div id="prediction-container">
  <div class="prediction-title" id="pred-title">Prediction</div>
  <div class="outcomes" id="pred-outcomes"></div>
</div>

<script src="scene-base.js"></script>
<script>
  let currentPrediction = null;

  SceneBase.connect(state => {
    if (!state.twitch?.predictions?.current) {
      document.getElementById('prediction-container').style.display = 'none';
      currentPrediction = null;
      return;
    }

    const pred = state.twitch.predictions.current;
    
    if (!currentPrediction || currentPrediction.id !== pred.id) {
      // New prediction
      document.getElementById('prediction-container').style.display = 'block';
      document.getElementById('pred-title').textContent = pred.title;
      currentPrediction = pred;
    }

    // Update outcomes
    const container = document.getElementById('pred-outcomes');
    const totalVotes = pred.outcomes.reduce((sum, o) => sum + o.votes, 0);
    
    container.innerHTML = pred.outcomes.map(outcome => {
      const percentage = totalVotes > 0 ? (outcome.votes / totalVotes * 100).toFixed(0) : 0;
      return `
        <div class="outcome">
          <div class="outcome-text">${outcome.title}</div>
          <div class="outcome-bar">
            <div class="outcome-fill" style="width: ${percentage}%"></div>
          </div>
          <div class="vote-count">${percentage}%</div>
        </div>
      `;
    }).join('');
  });
</script>

</body>
</html>
```

---

## TEST: Predictions Work (15 min)

### Manual Test
1. Open control panel → Twitch tab
2. Click [Create Prediction]
3. Enter title and click create
4. Verify overlay shows prediction
5. Open `http://localhost:3000/twitch-alerts.html` in OBS browser source
6. Should show prediction with live updates

---

## NEXT STEPS

**Continue with:**
- Phase 3: Wheel Spinner (implement spin logic, animation)
- Phase 4: Chat Mini-Games (chat client, game engine)
- Phase 5: Polish (sounds, animations, settings)

---

## QUICK REFERENCE: WebSocket Messages

**Send from Control Panel to Server:**
```javascript
send('twitch-prediction-create', {
  title: string,
  outcomes: [{title, color}, ...],
  duration: number
})

send('twitch-wheel-spin', {})

send('twitch-minigame-create', {type: 'trivia'})

send('twitch-minigame-end-early', {gameId: string})
```

**Listen from Server (automatically):**
```javascript
// In ws.on('message') handler:
case 'full_state':
  // state.twitch.predictions.current
  // state.twitch.wheel.current
  // state.twitch.minigame.current
```

---

## COMMON ERRORS & FIXES

**"Cannot find module 'twitch-client'"**
→ Make sure file is at `backend/integrations/twitch-client.js` and exports correctly

**Webhook not receiving**
→ Check `state.twitch.webhookSecret` matches Twitch console
→ Verify `state.twitch.webhookUrl` is public-accessible (not localhost)

**OAuth redirect not working**
→ Verify redirect URL matches Twitch console exactly
→ Make sure `http://localhost:3000/api/twitch/oauth/callback` is registered

**Overlay not updating**
→ Check `scene-base.js` is loading
→ Open browser console (F12) for errors
→ Verify WebSocket is connected (tab should say "Connected")

---

## Files to Create
- [ ] `backend/integrations/twitch-client.js`
- [ ] `backend/integrations/twitch-webhooks.js`
- [ ] `backend/integrations/twitch-predictions.js`
- [ ] `backend/integrations/twitch-wheel.js` (Phase 3)
- [ ] `backend/integrations/twitch-chat-games.js` (Phase 4)
- [ ] `overlay/twitch-alerts.html`
- [ ] `overlay/twitch-wheel.html` (Phase 3)
- [ ] `overlay/twitch-minigame.html` (Phase 4)

---

You now have a complete roadmap! Start with Phase 1, and once the foundation is solid, scale up to predictions, wheel, and games.

**Questions?** I can provide:
- Exact code for each phase
- Debugging tips
- Testing harnesses
- Production deployment guide
