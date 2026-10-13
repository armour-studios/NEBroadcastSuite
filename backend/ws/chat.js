'use strict';
// Chat, Q&A, multichat, match titles and VODs — panel messages (moved out of server.js's message dispatcher).
// Registered by server.js through registerWsHandlers once every declaration there has run, so the
// dependencies below are bound once and can be used directly; values server.js reassigns are
// read and written through ctx (_mtPendingSince, _mtPreviewKey, discordChat, kickChat).
let
  _chatLog, broadcastFullState, electronApi, fetchDiscordMessages, finalizeVod, matchTitle,
  questionStore, questionsChanged, resetTwitchAutoTitle, saveAppState, saveMultichatData,
  showChatHighlight, state;
let ctx;

const handlers = {
  // Built-in chat commands config — the master toggle + the Discord invite (!discord).
  set_chat_commands(msg, ws) {
    if (msg.data) {
      if ('enabled' in msg.data) state.chatCommands.enabled = !!msg.data.enabled;
      if (typeof msg.data.discord === 'string') state.chatCommands.discord = msg.data.discord.trim().slice(0, 300);
      saveAppState();
      broadcastFullState();
    }
  },

  // Pulse / Grid multiview: publish THIS producer's live game to the org so it appears as a tile on
  // the main broadcast's grid scenes. channel = Twitch handle shown on the tile bar.
  set_match_titles(msg, ws) {
    const d = msg.data || {};
    const mt = state.matchTitles;
    const tpl = (v, dflt) => (typeof v === 'string' ? (v.trim() ? v.slice(0, 300) : dflt) : null);
    if (d.twitch && typeof d.twitch === 'object') {
      if ('auto' in d.twitch) mt.twitch.auto = !!d.twitch.auto;
      const t = tpl(d.twitch.template, matchTitle.DEFAULT_TWITCH_TEMPLATE); if (t !== null) mt.twitch.template = t;
      if (!mt.twitch.auto) mt.status.twitchError = '';
    }
    if (d.vod && typeof d.vod === 'object') {
      ['rename', 'eventFolder', 'datePrefix', 'csv'].forEach((k) => { if (k in d.vod) mt.vod[k] = !!d.vod[k]; });
      const t = tpl(d.vod.template, matchTitle.DEFAULT_VOD_TEMPLATE); if (t !== null) mt.vod.template = t;
    }
    if ('stripSponsors' in d) mt.stripSponsors = !!d.stripSponsors;
    resetTwitchAutoTitle();
    ctx._mtPreviewKey = '';
    saveAppState();
    broadcastFullState();
  },

  match_titles_push_twitch(msg, ws) {
    resetTwitchAutoTitle();
    ctx._mtPendingSince = 0;
  },

  vod_retry(msg, ws) {
    const e = state.matchTitles.vodLog.find((x) => x && x.id === (msg.data && msg.data.id));
    if (e && e.status !== 'pending') { if (e.status === 'saved' && e.path) e.from = e.path; finalizeVod(e); }
  },

  vod_reveal(msg, ws) {
    const e = state.matchTitles.vodLog.find((x) => x && x.id === (msg.data && msg.data.id));
    const target = e && (e.path || e.from);
    if (target) try { electronApi.shell.showItemInFolder(target); } catch (err) { console.warn('[match-titles] reveal:', err.message); }
  },

  vod_clear_log(msg, ws) {
    state.matchTitles.vodLog = state.matchTitles.vodLog.filter((x) => x && x.status === 'pending');
    saveAppState();
    broadcastFullState();
  },

  // ── Multichat: feature a chat message on stream (overlay/chat-highlight.html) ──
  set_chat_highlight(msg, ws) {
    showChatHighlight(msg.data || {});
    broadcastFullState();
  },

  // One-shot backfill of the multichat feed for a freshly opened panel.
  request_chat_log(msg, ws) {
    try { ws.send(JSON.stringify({ type: 'chat_log', data: { messages: _chatLog.slice(-100) } })); } catch (e) {}
  },

  // Configure the Kick + Discord multichat sources. Bot token only overwrites when a
  // non-empty value is sent (so re-saving other fields never wipes it); '' clears it.
  set_multichat_settings(msg, ws) {
    const d = msg.data || {};
    let kickChanged = false, discordChanged = false;
    if (typeof d.kickChannel === 'string') {
      const v = d.kickChannel.trim().toLowerCase().replace(/^@/, '').slice(0, 60);
      if (v !== state.multichat.kickChannel) { state.multichat.kickChannel = v; kickChanged = true; }
    }
    if (typeof d.discordChannelId === 'string') {
      const v = d.discordChannelId.trim().replace(/[^0-9]/g, '').slice(0, 40);
      if (v !== state.multichat.discordChannelId) { state.multichat.discordChannelId = v; discordChanged = true; }
    }
    if (typeof d.discordBotToken === 'string') {
      // Empty = explicit clear; the panel sends the real token only when the user typed one.
      if (d.discordBotToken !== '•••') { state.multichat.discordBotToken = d.discordBotToken.trim().slice(0, 120); discordChanged = true; }
    }
    saveMultichatData();
    if (kickChanged && ctx.kickChat) ctx.kickChat.kick();
    if (discordChanged && ctx.discordChat) ctx.discordChat.kick();
    broadcastFullState();
  },

  // ── Q&A mailbag (backend/questions.js) ───────────────────────────────
  // Add one question: typed by hand (source = whichever social it came off), or grabbed
  // off a row in the multichat feed.
  add_question(msg, ws) {
    const q = questionStore.addQuestion(state.questions.list, msg.data || {});
    if (q) questionsChanged();
  },

  // Edit / re-tag / mark. Only the fields present are touched, so the panel can send a
  // single-field patch (star, status) without round-tripping the whole question.
  update_question(msg, ws) {
    const d = msg.data || {};
    const q = state.questions.list.find(x => x.id === d.id);
    if (!q) return;
    if (typeof d.text === 'string') q.text = d.text.trim().slice(0, 400);
    if (typeof d.user === 'string') q.user = d.user.trim().slice(0, 60);
    if (typeof d.source === 'string') q.source = questionStore.normalizeSource(d.source);
    if (typeof d.sourceLabel === 'string') q.sourceLabel = d.sourceLabel.trim().slice(0, 24);
    if (typeof d.status === 'string' && ['new', 'asked', 'skipped'].includes(d.status)) q.status = d.status;
    if (typeof d.star === 'boolean') q.star = d.star;
    questionsChanged();
  },

  remove_question(msg, ws) {
    const i = state.questions.list.findIndex(x => x.id === (msg.data || {}).id);
    if (i === -1) return;
    state.questions.list.splice(i, 1);
    questionsChanged();
  },

  // scope 'asked' clears the answered/skipped ones (the usual between-segments tidy);
  // 'all' empties the queue — the panel confirms before sending that.
  clear_questions(msg, ws) {
    const scope = ((msg.data || {}).scope === 'all') ? 'all' : 'asked';
    const before = state.questions.list.length;
    state.questions.list = scope === 'all' ? [] : state.questions.list.filter(q => q.status === 'new');
    if (state.questions.list.length !== before) questionsChanged();
  },

  // Put a queued question on the chat lower third and mark it asked in one step.
  ask_question(msg, ws) {
    const d = msg.data || {};
    const q = state.questions.list.find(x => x.id === d.id);
    if (!q) return;
    const dur = (d.duration === undefined) ? state.questions.settings.duration : d.duration;
    showChatHighlight({
      visible: true, platform: q.source, user: q.user, text: q.text,
      kicker: questionStore.kickerFor(q), duration: dur
    });
    q.status = 'asked';
    questionsChanged();   // also broadcasts the highlight
  },

  set_question_settings(msg, ws) {
    const d = msg.data || {};
    const s = state.questions.settings;
    let discordChanged = false;
    if (typeof d.discordChannelId === 'string') {
      const v = d.discordChannelId.trim().replace(/[^0-9]/g, '').slice(0, 40);
      if (v !== s.discordChannelId) { s.discordChannelId = v; discordChanged = true; }
    }
    if (typeof d.keyword === 'string') s.keyword = d.keyword.trim().slice(0, 20);
    if (typeof d.keywordEnabled === 'boolean') s.keywordEnabled = d.keywordEnabled;
    if (d.duration !== undefined) s.duration = Math.max(0, Math.min(300, Number(d.duration) || 0));
    // The questions channel rides the same bot connection as the chat channel.
    if (discordChanged && ctx.discordChat) ctx.discordChat.kick();
    questionsChanged();
  },

  // Backlog pull: the gateway only delivers what arrives after we connect, so read the
  // channel's recent history over REST on demand. Reply goes to the asking panel only.
  pull_discord_questions(msg, ws) {
    const reply = (ok, text, added) => {
      try { ws.send(JSON.stringify({ type: 'questions_pull_result', data: { ok, text, added: added || 0 } })); } catch (e) {}
    };
    const chan = state.questions.settings.discordChannelId || state.multichat.discordChannelId;
    fetchDiscordMessages({ botToken: state.multichat.discordBotToken, channelId: chan, limit: (msg.data || {}).limit || 50 })
      .then((rows) => {
        let added = 0;
        for (const r of rows) {
          if (questionStore.addQuestion(state.questions.list, { ...r, source: 'discord', origin: 'discord' })) added++;
        }
        if (added) questionsChanged();
        reply(true, added ? `Pulled ${added} question${added === 1 ? '' : 's'} from Discord.`
                          : 'Nothing new — everything in that channel is already queued.', added);
      })
      .catch((err) => reply(false, err.message || 'Discord pull failed.'));
  },
};

module.exports = function createChatHandlers(c) {
  ctx = c;
  ({
    _chatLog, broadcastFullState, electronApi, fetchDiscordMessages, finalizeVod, matchTitle,
    questionStore, questionsChanged, resetTwitchAutoTitle, saveAppState, saveMultichatData,
    showChatHighlight, state
  } = c);
  return handlers;
};
