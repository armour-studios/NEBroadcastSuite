'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');
const os    = require('os');

// Optional deps — loaded lazily so the app boots even before npm install
let google, TwitterApi, cron;
try { ({ google }     = require('googleapis'));     } catch (e) { console.warn('[Social] googleapis not installed:', e.message); }
try { ({ TwitterApi } = require('twitter-api-v2')); } catch (e) { console.warn('[Social] twitter-api-v2 not installed:', e.message); }
try { cron            = require('node-cron');       } catch (e) { console.warn('[Social] node-cron not installed:', e.message); }

const YT_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly'
];
// Twitter OAuth 2.0 scopes — media.write is needed for video upload
const TW_SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'offline.access', 'media.write'];

class SocialPublisher {
  constructor(userDataPath, env = {}) {
    this.userDataPath = userDataPath;
    this.tokensPath   = path.join(userDataPath, 'social-tokens.json');
    this.schedulePath = path.join(userDataPath, 'social-schedule.json');
    this.env          = env;
    this.tokens       = this._load(this.tokensPath, {});
    this.schedule     = this._load(this.schedulePath, []);
    this._cronJob     = null;
    this._onPublish   = null;
    this._twState     = {};   // Twitter PKCE: { codeVerifier, state }
  }

  _load(p, def) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; } }
  _save(p, d)   { try { fs.writeFileSync(p, JSON.stringify(d, null, 2), 'utf8'); } catch (e) { console.error('[Social] save failed:', e.message); } }

  // ── YouTube ─────────────────────────────────────────────────────────────────
  _ytOAuth() {
    if (!google) throw new Error('Run: npm install googleapis in the app directory');
    if (!this.env.GOOGLE_CLIENT_ID) throw new Error('GOOGLE_CLIENT_ID not configured. Add it to .env.local (dev) or .env.production (build).');
    return new google.auth.OAuth2(
      this.env.GOOGLE_CLIENT_ID,
      this.env.GOOGLE_CLIENT_SECRET || '',   // Desktop apps: secret is not actually secret per Google docs
      'http://localhost:3000/api/social/callback/youtube'
    );
  }

  getYouTubeAuthUrl() {
    const c = this._ytOAuth();
    return c.generateAuthUrl({ access_type: 'offline', scope: YT_SCOPES, prompt: 'consent' });
  }

  async handleYouTubeCallback(code) {
    const c = this._ytOAuth();
    const { tokens } = await c.getToken(code);
    this.tokens.youtube = tokens;
    this._save(this.tokensPath, this.tokens);
    return true;
  }

  async _ytClient() {
    if (!this.tokens.youtube) return null;
    const c = this._ytOAuth();
    c.setCredentials(this.tokens.youtube);
    c.on('tokens', t => {
      this.tokens.youtube = { ...this.tokens.youtube, ...t };
      this._save(this.tokensPath, this.tokens);
    });
    return c;
  }

  // Upload video to YouTube.
  // If post.scheduledAt is set, YouTube natively schedules the publish time —
  // the video uploads NOW but goes live at the scheduled time (no cron needed).
  // If post.isShort is true, #Shorts is appended to description.
  async uploadToYouTube(post) {
    const auth = await this._ytClient();
    if (!auth) throw new Error('YouTube not connected');
    if (!google) throw new Error('googleapis not installed');
    const yt   = google.youtube({ version: 'v3', auth });
    const mp4  = post._localVideoPath;
    if (!mp4 || !fs.existsSync(mp4)) throw new Error('Video file not found for YouTube upload');

    const isShort  = !!post.isShort;
    const schedAt  = post.scheduledAt && post.scheduledAt > Date.now() ? post.scheduledAt : null;

    let description = (post.captions?.youtube || '').trim();
    if (isShort && !description.includes('#Shorts')) {
      description = description ? description + '\n\n#Shorts' : '#Shorts';
    }

    let title = (post.title || 'Clip').substring(0, 100);
    if (isShort && !title.includes('#Shorts') && title.length < 95) {
      title = title + ' #Shorts';
    }

    const privacyStatus = schedAt ? 'private' : (post.ytVisibility || 'public');

    const res = await yt.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title,
          description,
          tags:       (post.tags || []).concat(isShort ? ['Shorts'] : []),
          categoryId: '20',  // Gaming
          defaultLanguage: 'en'
        },
        status: {
          privacyStatus,
          selfDeclaredMadeForKids: false,
          ...(schedAt ? { publishAt: new Date(schedAt).toISOString() } : {})
        }
      },
      media: { mimeType: 'video/mp4', body: fs.createReadStream(mp4) }
    });

    const videoId  = res.data.id;
    const videoUrl = `https://youtu.be/${videoId}`;
    return {
      id:          videoId,
      url:         videoUrl,
      isShort,
      scheduled:   !!schedAt,
      publishAt:   schedAt ? new Date(schedAt).toISOString() : null
    };
  }

  // ── Twitter / X ─────────────────────────────────────────────────────────────
  getTwitterAuthUrl() {
    if (!TwitterApi) throw new Error('Run: npm install twitter-api-v2 in the app directory');
    if (!this.env.TWITTER_CLIENT_ID) throw new Error('TWITTER_CLIENT_ID not configured. Add it to .env.local (dev) or .env.production (build).');
    // Use PKCE — clientSecret is optional for public native app clients
    const { url, codeVerifier, state } = TwitterApi.generateOAuth2AuthLink(
      'http://localhost:3000/api/social/callback/twitter',
      { scope: TW_SCOPES }
    );
    this._twState = { codeVerifier, state };
    return { url, state };
  }

  async handleTwitterCallback(code, state) {
    if (!TwitterApi) throw new Error('twitter-api-v2 not installed');
    const clientOpts = { clientId: this.env.TWITTER_CLIENT_ID };
    if (this.env.TWITTER_CLIENT_SECRET) clientOpts.clientSecret = this.env.TWITTER_CLIENT_SECRET;
    const client = new TwitterApi(clientOpts);
    const { accessToken, refreshToken, expiresIn } = await client.loginWithOAuth2({
      code,
      codeVerifier: this._twState.codeVerifier,
      redirectUri:  'http://localhost:3000/api/social/callback/twitter'
    });
    this.tokens.twitter = {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + (expiresIn || 7200) * 1000
    };
    this._save(this.tokensPath, this.tokens);
    return true;
  }

  async _twClient() {
    if (!this.tokens.twitter) return null;
    let { accessToken, refreshToken, expiresAt } = this.tokens.twitter;
    if (expiresAt && Date.now() > expiresAt - 60000 && refreshToken) {
      try {
        const clientOpts = { clientId: this.env.TWITTER_CLIENT_ID };
        if (this.env.TWITTER_CLIENT_SECRET) clientOpts.clientSecret = this.env.TWITTER_CLIENT_SECRET;
        const c = new TwitterApi(clientOpts);
        const r = await c.refreshOAuth2Token(refreshToken);
        accessToken = r.accessToken;
        this.tokens.twitter = {
          accessToken:  r.accessToken,
          refreshToken: r.refreshToken || refreshToken,
          expiresAt:    Date.now() + (r.expiresIn || 7200) * 1000
        };
        this._save(this.tokensPath, this.tokens);
      } catch (e) {
        console.error('[Social] Twitter token refresh failed:', e.message);
      }
    }
    return new TwitterApi(accessToken);
  }

  async postToTwitter(post) {
    const client = await this._twClient();
    if (!client) throw new Error('Twitter not connected');
    const caption = ((post.captions?.twitter) || post.title || '').substring(0, 280);
    // Use pre-uploaded mediaId if available (set by prepareTwitterMedia during scheduling)
    let mediaId = post.twitterMediaId || null;
    if (!mediaId && post._localVideoPath && fs.existsSync(post._localVideoPath)) {
      mediaId = await client.v1.uploadMedia(post._localVideoPath, { mimeType: 'video/mp4', target: 'tweet' });
    }
    const tweet = await client.v2.tweet({
      text: caption,
      ...(mediaId ? { media: { media_ids: [mediaId] } } : {})
    });
    return { id: tweet.data.id, url: `https://twitter.com/i/status/${tweet.data.id}` };
  }

  // Pre-upload Twitter media when a post is scheduled, so at post-time we only need to
  // send the tweet (fast, and avoids re-downloading the clip later).
  // Twitter media IDs are valid for 24h without being attached to a tweet.
  async prepareTwitterMedia(post) {
    let tmpFile = null;
    const ownTmp = post.clipType === 'twitch' && (post.thumbnailUrl || post.clipVideoUrl);
    try {
      if (ownTmp) {
        console.log('[Social] Pre-uploading Twitter media…');
        tmpFile = await this.downloadTwitchClip(post.thumbnailUrl || post.clipVideoUrl, post.clipUrl, post._twitchToken, post._twitchClientId);
      } else if (post.clipType === 'local' && post.clipPath && fs.existsSync(post.clipPath)) {
        tmpFile = post.clipPath;
      }
      if (!tmpFile) return null;
      const client = await this._twClient();
      if (!client) return null;
      const mediaId = await client.v1.uploadMedia(tmpFile, { mimeType: 'video/mp4', target: 'tweet' });
      console.log('[Social] Twitter media pre-uploaded:', mediaId);
      return mediaId;
    } catch (e) {
      console.error('[Social] Twitter media pre-upload failed (will retry at post time):', e.message);
      return null;
    } finally {
      if (ownTmp && tmpFile) { try { fs.unlinkSync(tmpFile); } catch {} }
    }
  }

  // ── YouTube channel stats (analytics) ───────────────────────────────────────
  // Returns channel KPIs, recent videos, and live-stream viewer count if active.
  // Cached for 90 seconds so rapid tab switches don't hammer the quota.
  async getYouTubeStats() {
    if (!google) throw new Error('googleapis not installed');
    const auth = await this._ytClient();
    if (!auth) return null;
    const now = Date.now();
    if (this._ytStatsCache && now - this._ytStatsCache.at < 90000) return this._ytStatsCache.data;
    const yt = google.youtube({ version: 'v3', auth });

    // Channel KPIs
    const chRes = await yt.channels.list({ part: ['statistics', 'snippet'], mine: true });
    const ch    = (chRes.data.items || [])[0] || {};
    const stats = ch.statistics || {};
    const channel = {
      name:        ch.snippet?.title        || '',
      subscribers: parseInt(stats.subscriberCount || 0, 10),
      totalViews:  parseInt(stats.viewCount        || 0, 10),
      videoCount:  parseInt(stats.videoCount       || 0, 10),
    };

    // Recent uploads (last 10)
    let videos = [];
    try {
      const srch = await yt.search.list({ part: ['snippet'], forMine: true, type: ['video'], maxResults: 10, order: 'date' });
      const ids  = (srch.data.items || []).map((i) => i.id && i.id.videoId).filter(Boolean);
      if (ids.length) {
        const vRes = await yt.videos.list({ part: ['snippet', 'statistics', 'contentDetails'], id: ids.join(',') });
        videos = (vRes.data.items || []).map((v) => ({
          id:          v.id,
          title:       v.snippet?.title       || '',
          views:       parseInt(v.statistics?.viewCount   || 0, 10),
          likes:       parseInt(v.statistics?.likeCount   || 0, 10),
          comments:    parseInt(v.statistics?.commentCount || 0, 10),
          publishedAt: v.snippet?.publishedAt || null,
          duration:    v.contentDetails?.duration || '',
          url:         `https://www.youtube.com/watch?v=${v.id}`,
          thumbnail:   v.snippet?.thumbnails?.default?.url || '',
        }));
      }
    } catch (_) {}

    // Live stream concurrent viewers
    let live = { isLive: false, viewers: 0, title: '' };
    try {
      const bRes = await yt.liveBroadcasts.list({ part: ['status', 'snippet', 'statistics'], broadcastStatus: 'active', maxResults: 1 });
      const b    = (bRes.data.items || [])[0];
      if (b) live = { isLive: true, viewers: parseInt(b.statistics?.concurrentViewers || 0, 10), title: b.snippet?.title || '' };
    } catch (_) {}

    const data = { channel, videos, live };
    this._ytStatsCache = { data, at: now };
    return data;
  }

  // ── Connections ─────────────────────────────────────────────────────────────
  // Always returns configured: true — credentials are bundled in the production build
  // via gen-prod-env.js. On a fresh dev env without .env.local the Connect button
  // will show an informative error message instead.
  getConnections() {
    return {
      youtube: { connected: !!this.tokens.youtube, configured: true },
      twitter: { connected: !!this.tokens.twitter, configured: true }
    };
  }

  disconnect(platform) {
    delete this.tokens[platform];
    this._save(this.tokensPath, this.tokens);
  }

  // ── Schedule management ──────────────────────────────────────────────────────
  addPost(post) {
    const id = 'sp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const entry = { ...post, id, status: 'scheduled', createdAt: Date.now() };
    this.schedule.push(entry);
    this._save(this.schedulePath, this.schedule);
    return entry;
  }

  cancelPost(id) {
    const p = this.schedule.find(x => x.id === id);
    if (!p) return false;
    p.status = 'cancelled';
    this._save(this.schedulePath, this.schedule);
    return true;
  }

  getSchedule() { return this.schedule; }

  // ── Video helpers ────────────────────────────────────────────────────────────

  // Returns true if the file at `p` starts with a valid MP4/MOV box header.
  _isValidMp4(p) {
    try {
      const buf = Buffer.alloc(12);
      const fd  = fs.openSync(p, 'r');
      const n   = fs.readSync(fd, buf, 0, 12, 0);
      fs.closeSync(fd);
      if (n < 8) return false;
      const box = buf.toString('ascii', 4, 8);
      return ['ftyp', 'mdat', 'moov', 'wide', 'free', 'skip'].includes(box);
    } catch { return false; }
  }

  // Use Twitch GQL to get signed CDN download URLs for a clip.
  // Must use Twitch's own public web client ID — the GQL endpoint rejects
  // third-party client IDs even when paired with a valid OAuth token.
  async _getTwitchClipUrls(slug) {
    const query = `query GetClip($slug:ID!){clip(slug:$slug){videoQualities{frameRate quality sourceURL}playbackAccessToken(params:{platform:"web",playerType:"site",playerBackend:"mediaplayer"}){signature value}}}`;
    const body  = JSON.stringify([{ query, variables: { slug } }]);
    const headers = {
      'Content-Type':  'application/json',
      'Content-Length': Buffer.byteLength(body),
      'User-Agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Client-ID':     'kimne78kx3ncx6brgo4mv6wki5h1ko',
      'Origin':        'https://www.twitch.tv',
      'Referer':       'https://www.twitch.tv/',
    };

    const data = await new Promise((resolve, reject) => {
      const req = https.request('https://gql.twitch.tv/gql', { method: 'POST', headers }, res => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); }
          catch (e) { reject(new Error('GQL parse error: ' + e.message + ' body=' + raw.slice(0, 300))); }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    const clip = Array.isArray(data) ? data[0]?.data?.clip : data?.data?.clip;
    if (!clip) {
      const errMsg = Array.isArray(data) ? JSON.stringify(data[0]?.errors) : JSON.stringify(data?.errors);
      throw new Error('Clip not found in GQL response — errors: ' + (errMsg || JSON.stringify(data).slice(0, 200)));
    }
    const token     = clip.playbackAccessToken;
    const qualities = (clip.videoQualities || [])
      .sort((a, b) => parseInt(b.quality || 0) - parseInt(a.quality || 0));
    if (!qualities.length) throw new Error('No videoQualities returned from GQL (clip may be restricted)');
    return qualities.map(q => {
      let url = q.sourceURL || '';
      if (url && token?.signature && token?.value) {
        const sep = url.includes('?') ? '&' : '?';
        url += sep + 'sig=' + encodeURIComponent(token.signature) + '&token=' + encodeURIComponent(token.value);
      }
      return url;
    }).filter(Boolean);
  }

  // Extract clip slug from a clips.twitch.tv URL or bare slug string.
  _twitchSlug(clipUrl) {
    if (!clipUrl) return null;
    const m = clipUrl.match(/(?:clips\.twitch\.tv\/|clip\/)([A-Za-z0-9_-]+)/);
    return m ? m[1] : (clipUrl.includes('/') ? null : clipUrl);
  }

  // Try yt-dlp (or youtube-dl) if installed.
  async _downloadWithYtDlp(clipUrl, dest) {
    const { spawn } = require('child_process');
    const bins = ['yt-dlp', 'yt-dlp.exe', 'youtube-dl', 'youtube-dl.exe'];
    for (const bin of bins) {
      const found = await new Promise(res => {
        const p = spawn(bin, ['--version'], { windowsHide: true });
        p.on('error', () => res(false));
        p.on('close', code => res(code === 0));
      });
      if (!found) continue;
      console.log('[Social] Using', bin, 'to download Twitch clip');
      return new Promise((resolve, reject) => {
        const args = ['-f', 'best[ext=mp4]/best', '-o', dest, '--no-playlist', '--quiet', clipUrl];
        const p = spawn(bin, args, { windowsHide: true });
        p.on('error', e => reject(new Error(bin + ' spawn failed: ' + e.message)));
        p.on('close', code => {
          if (code === 0 && this._isValidMp4(dest)) resolve(dest);
          else reject(new Error(bin + ' exited with code ' + code));
        });
      });
    }
    return null;
  }

  // Download a Twitch clip.
  // Strategy: (1) GQL signed URL  (2) yt-dlp if installed  (3) error
  async downloadTwitchClip(thumbnailUrl, clipUrl, twitchToken, twitchClientId) {
    const tmp = path.join(os.tmpdir(), `ne_social_${Date.now()}.mp4`);

    // 1. Twitch GQL — get actual signed CDN URLs (works without yt-dlp)
    const slug = this._twitchSlug(clipUrl);
    if (slug) {
      try {
        const urls = await this._getTwitchClipUrls(slug);
        for (const url of urls) {
          try {
            await this._downloadFile(url, tmp);
            if (this._isValidMp4(tmp)) {
              console.log('[Social] Twitch clip downloaded via GQL');
              return tmp;
            }
            try { fs.unlinkSync(tmp); } catch {}
          } catch (e) {
            console.warn('[Social] GQL CDN download failed:', e.message);
            try { fs.unlinkSync(tmp); } catch {}
          }
        }
      } catch (e) {
        console.warn('[Social] GQL lookup failed:', e.message);
      }
    }

    // 2. Thumbnail URL → video URL pattern fallback (quality suffixes)
    if (thumbnailUrl) {
      // Derive the base CDN URL from the thumbnail and try known quality suffixes
      const base = thumbnailUrl.replace(/-preview(-\d+x\d+)?\.jpg$/i, '');
      const candidates = ['-1080.mp4', '-720.mp4', '-480.mp4', '-360.mp4', '.mp4'];
      for (const suffix of candidates) {
        try {
          await this._downloadFile(base + suffix, tmp);
          if (this._isValidMp4(tmp)) {
            console.log('[Social] Twitch clip downloaded via thumbnail CDN pattern');
            return tmp;
          }
          try { fs.unlinkSync(tmp); } catch {}
        } catch (e) {
          console.warn('[Social] CDN suffix fallback failed (' + suffix + '):', e.message);
          try { fs.unlinkSync(tmp); } catch {}
        }
      }
    }

    // 3. yt-dlp fallback
    if (clipUrl) {
      try {
        const result = await this._downloadWithYtDlp(clipUrl, tmp);
        if (result) return result;
      } catch (e) {
        console.warn('[Social] yt-dlp failed:', e.message);
        try { fs.unlinkSync(tmp); } catch {}
      }
    }

    throw new Error(
      'Could not download this Twitch clip automatically.\n' +
      'Download the clip manually from Twitch and add it to your Local Clips library.'
    );
  }

  _downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
      const file  = fs.createWriteStream(dest);
      const proto = url.startsWith('https') ? https : http;
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'video/mp4,video/*,*/*',
        'Referer': 'https://www.twitch.tv/',
      };
      const req = proto.get(url, { headers }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          return this._downloadFile(res.headers.location, dest).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) {
          file.close();
          return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      });
      req.on('error', reject);
    });
  }

  // ── ffmpeg helpers ───────────────────────────────────────────────────────────

  _ffmpegBin() {
    const candidates = [
      path.join(process.env.ProgramFiles || 'C:/Program Files', 'ffmpeg/bin/ffmpeg.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'ffmpeg/bin/ffmpeg.exe'),
      'ffmpeg'
    ];
    for (const c of candidates) {
      if (c === 'ffmpeg' || fs.existsSync(c)) return c;
    }
    return 'ffmpeg';
  }

  // Render a branding card (intro/outro slate) using ffmpeg lavfi.
  // Uses Arial Bold on Windows. Falls back to no fontfile (default ffmpeg font).
  async _generateBrandingCard(outputPath, opts, vertical) {
    const { spawn } = require('child_process');
    const { template = 'clean', text = '', color = '#7c3aed', duration: dur = 2, isOutro = false } = opts;
    const w  = vertical ? 1080 : 1920;
    const h  = vertical ? 1920 : 1080;
    const fs_size = vertical ? 80 : 110;
    const bgHex = color.replace('#', '0x');

    const fontFile = ['C:/Windows/Fonts/arialbd.ttf', 'C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/segoeui.ttf']
      .find(f => fs.existsSync(f)) || '';
    const fontArg = fontFile ? `:fontfile='${fontFile}'` : '';
    const safeText = (text || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:');
    const drawBase = `text='${safeText}':fontsize=${fs_size}:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2${fontArg}`;

    let vfParts;
    if (template === 'fade') {
      const fadeOutSt = (dur - 0.4).toFixed(2);
      vfParts = isOutro
        ? [`drawtext=${drawBase}`, 'fade=t=in:st=0:d=0.4']
        : [`drawtext=${drawBase}`, 'fade=t=in:st=0:d=0.4', `fade=t=out:st=${fadeOutSt}:d=0.4`];
    } else if (template === 'slide') {
      // Text slides up from bottom on intro, slides down on outro
      const yIn  = `if(lt(t,0.5),h+(h/2-text_h/2-h)*(t/0.5),(h-text_h)/2)`;
      const ejectSt = (dur - 0.5).toFixed(2);
      const yOut = `if(lt(t,${ejectSt}),(h-text_h)/2,(h-text_h)/2+(h/2+text_h/2)*(t-${ejectSt})/0.5)`;
      const slideDraw = `text='${safeText}':fontsize=${fs_size}:fontcolor=white:x=(w-text_w)/2:y=${isOutro ? yOut : yIn}${fontArg}`;
      vfParts = [`drawtext=${slideDraw}`];
    } else { // clean
      vfParts = [`drawtext=${drawBase}`, 'fade=t=in:st=0:d=0.2'];
    }

    const vf   = vfParts.join(',');
    const ff   = this._ffmpegBin();
    const args = [
      '-y',
      '-f', 'lavfi', '-i', `color=c=${bgHex}:size=${w}x${h}:rate=30`,
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-filter_complex', `[0:v]${vf}[vout]`,
      '-map', '[vout]', '-map', '1:a',
      '-t', String(dur),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22',
      '-c:a', 'aac', '-b:a', '128k',
      outputPath
    ];
    await new Promise((resolve, reject) => {
      const p = spawn(ff, args, { windowsHide: true });
      let errOut = '';
      p.stderr.on('data', d => errOut += d);
      p.on('close', code => code === 0 ? resolve() : reject(new Error(`Branding card encode failed: ${errOut.slice(-400)}`)));
      p.on('error', e => reject(new Error(`ffmpeg not found (${ff}): ${e.message}`)));
    });
  }

  // Trim + vertical crop + concat intro/outro. Returns { path, owned, workDir }.
  // owned=false means the original localPath is returned unchanged (no encode needed).
  async encodeCompose(localPath, opts = {}) {
    const { trimIn = 0, trimOut = null, intro = null } = opts;
    const vertical  = intro?.vertical || false;
    const needsIntro = intro && intro.template && intro.template !== 'none';

    // Quick exit: no trim, no intro, no vertical crop
    if (!needsIntro && !vertical && (trimIn || 0) < 0.5 && trimOut === null) {
      return { path: localPath, owned: false };
    }

    const { spawn } = require('child_process');
    const ff = this._ffmpegBin();

    // Probe source duration
    let duration = null;
    try {
      const ffprobe = ff.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
      duration = await new Promise(res => {
        let out = '';
        const p = spawn(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', localPath], { windowsHide: true });
        p.stdout.on('data', d => out += d);
        p.on('close', () => res(parseFloat(out) || null));
        p.on('error', () => res(null));
      });
    } catch {}

    const actualIn  = Math.max(0, trimIn || 0);
    const hasTrimOut = trimOut !== null && trimOut < (duration || Infinity) - 0.5;
    const hasTrimIn  = actualIn > 0.5;
    if (!needsIntro && !vertical && !hasTrimIn && !hasTrimOut) {
      return { path: localPath, owned: false };
    }

    const workDir = path.join(os.tmpdir(), `ne_social_compose_${Date.now()}`);
    fs.mkdirSync(workDir, { recursive: true });

    try {
      const parts = [];

      // 1. Generate intro card
      if (needsIntro) {
        const introPath = path.join(workDir, 'intro.mp4');
        await this._generateBrandingCard(introPath, intro, vertical);
        parts.push(introPath);
        console.log('[Social] Intro card generated');
      }

      // 2. Process main clip (trim + scale)
      const clipPath  = path.join(workDir, 'clip.mp4');
      const vf        = vertical ? 'scale=-1:1920,crop=1080:1920,setsar=1' : 'scale=-2:1080,setsar=1';
      const clipArgs  = [
        '-y',
        '-ss', String(actualIn), '-i', localPath,
        ...(hasTrimOut ? ['-t', String(trimOut - actualIn)] : []),
        '-vf', vf,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22',
        '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '44100',
        clipPath
      ];
      await new Promise((resolve, reject) => {
        const p = spawn(ff, clipArgs, { windowsHide: true });
        let errOut = '';
        p.stderr.on('data', d => errOut += d);
        p.on('close', code => code === 0 ? resolve() : reject(new Error(`Clip encode failed: ${errOut.slice(-400)}`)));
        p.on('error', e => reject(new Error(`ffmpeg not found: ${e.message}`)));
      });
      parts.push(clipPath);
      console.log('[Social] Clip encoded');

      // 3. Generate outro card
      if (needsIntro && intro.outro !== false) {
        const outroPath = path.join(workDir, 'outro.mp4');
        await this._generateBrandingCard(outroPath, { ...intro, isOutro: true }, vertical);
        parts.push(outroPath);
        console.log('[Social] Outro card generated');
      }

      if (parts.length === 1) {
        return { path: parts[0], owned: true, workDir };
      }

      // 4. Concat all parts
      const concatList = path.join(workDir, 'concat.txt');
      fs.writeFileSync(concatList, parts.map(p => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
      const finalPath  = path.join(workDir, 'final.mp4');
      await new Promise((resolve, reject) => {
        const p = spawn(ff, ['-y', '-f', 'concat', '-safe', '0', '-i', concatList, '-c', 'copy', finalPath], { windowsHide: true });
        let errOut = '';
        p.stderr.on('data', d => errOut += d);
        p.on('close', code => code === 0 ? resolve() : reject(new Error(`Concat failed: ${errOut.slice(-400)}`)));
        p.on('error', e => reject(new Error(`ffmpeg not found: ${e.message}`)));
      });
      console.log('[Social] Compose done:', finalPath);
      return { path: finalPath, owned: true, workDir };
    } catch (e) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
      throw e;
    }
  }

  // ── Publish ──────────────────────────────────────────────────────────────────
  async publish(post) {
    let tmpFile       = null;
    let composeWorkDir = null;
    const results   = { platforms: {} };
    const ownsTmp   = post.clipType === 'twitch' && post.clipVideoUrl;

    try {
      if (ownsTmp) {
        console.log('[Social] Downloading Twitch clip for publish…');
        tmpFile = await this.downloadTwitchClip(post.thumbnailUrl || post.clipVideoUrl, post.clipUrl, post._twitchToken, post._twitchClientId);
        post._localVideoPath = tmpFile;
      } else if (post.clipType === 'local' && post.clipPath && fs.existsSync(post.clipPath)) {
        post._localVideoPath = post.clipPath;
      }

      // Run compose step (trim + intro/outro + vertical crop) when needed
      if (post._localVideoPath) {
        const needsCompose = (post.trimIn > 0.5) || (post.trimOut !== null && post.trimOut !== undefined) ||
          (post.intro && post.intro.template && post.intro.template !== 'none') ||
          (post.intro?.vertical);
        if (needsCompose) {
          console.log('[Social] Composing clip…');
          const compose = await this.encodeCompose(post._localVideoPath, {
            trimIn:  post.trimIn  || 0,
            trimOut: post.trimOut || null,
            intro:   post.intro   || null,
          });
          post._localVideoPath = compose.path;
          if (compose.workDir) composeWorkDir = compose.workDir;
        }
      }

      for (const platform of (post.platforms || [])) {
        try {
          if (platform === 'youtube') results.platforms.youtube = await this.uploadToYouTube(post);
          if (platform === 'twitter') results.platforms.twitter = await this.postToTwitter(post);
          console.log(`[Social] ${platform} OK`);
        } catch (e) {
          results.platforms[platform] = { error: e.message };
          console.error(`[Social] ${platform} error:`, e.message);
        }
      }
    } finally {
      if (ownsTmp && tmpFile) { try { fs.unlinkSync(tmpFile); } catch {} }
      if (composeWorkDir)     { try { fs.rmSync(composeWorkDir, { recursive: true, force: true }); } catch {} }
    }
    return results;
  }

  // ── Cron scheduler (Twitter + fallback for YouTube) ───────────────────────────
  // YouTube scheduled posts are handled natively by YouTube — no cron action needed.
  // Twitter has no native scheduling, so we post at the right time from here.
  startScheduler(onPublished) {
    if (!cron) { console.warn('[Social] node-cron missing — Twitter scheduler disabled'); return; }
    this._onPublish = onPublished;
    this._cronJob = cron.schedule('* * * * *', () => this._tick());
    console.log('[Social] Scheduler started');
  }

  stopScheduler() {
    if (this._cronJob) { this._cronJob.stop(); this._cronJob = null; }
  }

  async _tick() {
    const now = Date.now();
    // Only handle posts that are due AND have Twitter (YouTube handles its own schedule)
    const due = this.schedule.filter(p =>
      p.status === 'scheduled' &&
      p.scheduledAt &&
      p.scheduledAt <= now &&
      (p.platforms || []).some(pl => pl !== 'youtube')
    );
    for (const post of due) {
      // If this post is YouTube-only and was already uploaded (YouTube handles timing) — mark done
      if ((post.platforms || []).every(pl => pl === 'youtube') && post.youtubeUploaded) {
        post.status = 'published';
        post.publishedAt = Date.now();
        this._save(this.schedulePath, this.schedule);
        continue;
      }

      post.status = 'publishing';
      this._save(this.schedulePath, this.schedule);
      try {
        // For scheduled posts, only run non-YouTube platforms (YouTube already uploaded)
        const platformsToRun = (post.platforms || []).filter(pl => {
          if (pl === 'youtube' && post.youtubeUploaded) return false;
          return true;
        });
        const results = await this.publish({ ...post, platforms: platformsToRun });
        // Merge any pre-existing YouTube result
        if (post.youtubeUploaded && post.publishResults?.platforms?.youtube) {
          results.platforms.youtube = post.publishResults.platforms.youtube;
        }
        post.status         = 'published';
        post.publishedAt    = Date.now();
        post.publishResults = results;
        if (this._onPublish) this._onPublish(post);
      } catch (e) {
        post.status = 'failed';
        post.error  = e.message;
        console.error('[Social] Scheduled publish failed:', e.message);
      }
      this._save(this.schedulePath, this.schedule);
    }
  }
}

module.exports = { SocialPublisher };
