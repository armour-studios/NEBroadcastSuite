/* ─────────────────────────────────────────────────────────────────────────────
   replay-fx.js — the SHARED goal-replay transition engine.

   One engine, three looks, every RL overlay. Before this, each overlay carried its own copy of a
   wipe with its own timing, which is why they drifted (the Worlds HUD peeled early and fired stray
   wipes). Now the timing lives here once, ported from the React HUD's proven cycle:

     goal_scored          → INTRO armed, fires GOAL_TO_REPLAY_MS after the ball hits the net
     view_change 'goal'   → the game actually cut to the replay: fire the intro if it hasn't yet,
                            and RESUME a held cover so the reveal lands exactly ON the camera cut
     replay_will_end      → OUTRO after REPLAY_WILLEND_DELAY_MS (the celebration beat)
     view_change 'hud'    → replay ended: outro if the cue never came, then the cycle closes
     scoreboard/reset     → cycle dropped, nothing pending can fire later

   The intro COVERS and then HOLDS SOLID until that cut arrives (RL takes 2.5–4s and it varies), so
   the transition always masks the game's own jump instead of peeling into it.

   STYLES ('slam' | 'cinema' | 'sweep') are interchangeable across overlays:
     - the producer's pick (state.replay.style, Match ▸ Teams) applies everywhere by default
     - an overlay can set its own default:  ReplayFX.init({ defaultStyle: 'sweep' })
     - any source can be pinned per browser-source with ?fx=slam|cinema|sweep, which wins
   'slam' and 'cinema' are the React HUD's animations (their CSS is generated from it verbatim);
   'sweep' is the Worlds HUD's panel sweep. Adding a fourth = add its CSS + a STYLES entry.

   Usage:
     <script src="/replay-fx.js"></script>
     ReplayFX.init({ defaultStyle: 'sweep' });
     ReplayFX.setState(currentState);         // on every state merge
     ReplayFX.goal(goalData);                 // 'goal_scored'
     ReplayFX.replayStart();                  // view_change 'goal'
     ReplayFX.replayWillEnd();                // 'replay_will_end'
     ReplayFX.replayEnd();                    // view_change 'hud'
     ReplayFX.reset();                        // game_reset / board / kickoff
     ReplayFX.cover({ color, logo, onMid });  // one-off full-screen cover (e.g. the post-game board)

   The slam/cinema CSS below was lifted verbatim out of rl-hud.html and the sweep out of
   rl-worlds.html when this engine was split out; THIS file is the source of truth for all three now.
   rl-hud.html still carries its own copy of slam/cinema for its inline wipe — change one, check the
   other, or move that HUD onto this engine too.
   ───────────────────────────────────────────────────────────────────────────── */
(function (global) {
  'use strict';

  var STYLES = ['slam', 'cinema', 'sweep'];
  // Timing — identical to the React HUD's cycle (see the header).
  var GOAL_TO_REPLAY_MS = 1200;      // intro fires this long after the ball hits the net
  var INTRO_MAX_HOLD_MS = 4000;      // give up holding if the replay-cut event never arrives
  var REPLAY_WILLEND_DELAY_MS = 1800;// celebration beat after RL's "replay ending" cue
  var REPLAY_MAX_MS = 15000;         // last-resort outro if every real signal goes missing
  var CYCLE_MAX_MS = 15000;          // hard backstop on the whole cycle — measured from the REPLAY START (see replayStart)
  var NO_REPLAY_MS = 10000;          // a goal whose replay never starts: close the cycle so the NEXT goal isn't swallowed
  var RE_GOAL_LOCKOUT_MS = 4000;     // a second goal this soon after a cover is the SAME goal echoing

  var CSS = `
/* ───── REPLAY TRANSITION — dark panel swipes IN (sponsor visible), holds, swipes OUT ──── */
/* The frame is now STATIC — the moving wall is the shutter bars below. */
.replay-wipe{position:absolute;top:0;bottom:0;left:-16%;right:-16%;z-index:80;pointer-events:none;overflow:hidden;
  --rp-dur:2.6s;display:flex;align-items:center;justify-content:center;}
.replay-wipe.logo-only{--rp-dur:1.9s;}   /* the after-replay outro — a touch longer than the intro sweep */
/* HOLD: freeze the whole intro cover SOLID (pause every wipe animation) until the game actually cuts to
   the replay. RL's goal→replay cut timing varies (~2.5–4s), so a fixed-length intro peeled BEFORE the
   cut on the slow ones — exposing the janky in-game transition the wipe exists to hide. Resumed (peeled)
   on the real cut (view_change 'goal' → resumeIntroReveal), so the reveal is always ON the camera change. */
.replay-wipe.rp-hold, .replay-wipe.rp-hold *{ animation-play-state: paused !important; }

/* ── SHUTTER SLAM ─────────────────────────────────────────────────────────────
   Five angled bars sweep in staggered from ALTERNATING sides, snap together into one solid wall (the
   lockup punches in on the slam), hold, then peel out in sequence. Because the frame no longer slides
   off-screen, the scrim + brand skin are veiled separately (rwVeil) instead of riding a moving panel. */
.rw-bars{position:absolute;inset:0;z-index:0;pointer-events:none;}
.rw-bars i{position:absolute;left:-30%;right:-30%;height:21%;display:block;   /* 21% = 1% overlap, no seams */
  background:linear-gradient(100deg,rgb(8,11,18) 0%,rgb(14,20,32) 55%,rgb(8,11,18) 100%);
  transform:translateX(var(--from)) skewX(-8deg);will-change:transform;backface-visibility:hidden;}
.rw-bars i:nth-child(1){top:0;   --from:-140%; --to:140%;}
.rw-bars i:nth-child(2){top:20%; --from:140%;  --to:-140%;}
.rw-bars i:nth-child(3){top:40%; --from:-140%; --to:140%;}
.rw-bars i:nth-child(4){top:60%; --from:140%;  --to:-140%;}
.rw-bars i:nth-child(5){top:80%; --from:-140%; --to:140%;}
/* bright leading-edge accent in the team colour — the signature of the slam */
.rw-bars i::after{content:'';position:absolute;top:0;bottom:0;width:4px;
  background:var(--replay-color,#fff);box-shadow:0 0 20px var(--replay-color,#fff);opacity:.92;}
.rw-bars i:nth-child(odd)::after{right:0;}    /* travelling right → leading edge is the right side */
.rw-bars i:nth-child(even)::after{left:0;}
.replay-wipe.play .rw-bars i{animation:rwBar var(--rp-dur) cubic-bezier(.5,.04,.28,1) both;}
.replay-wipe.play .rw-bars i:nth-child(2){animation-delay:45ms;}
.replay-wipe.play .rw-bars i:nth-child(3){animation-delay:90ms;}
.replay-wipe.play .rw-bars i:nth-child(4){animation-delay:135ms;}
.replay-wipe.play .rw-bars i:nth-child(5){animation-delay:180ms;}
@keyframes rwBar{0%{transform:translateX(var(--from)) skewX(-8deg);}
  20%{transform:translateX(0) skewX(-8deg);}
  80%{transform:translateX(0) skewX(-8deg);}
  100%{transform:translateX(var(--to)) skewX(-8deg);}}
/* scrim + brand skin ride the cover window (the frame no longer moves off-screen) */
@keyframes rwVeil{0%,14%{opacity:0;}26%{opacity:1;}76%{opacity:1;}90%,100%{opacity:0;}}
.replay-wipe.play .replay-scrim,.replay-wipe.play .replay-skin{animation:rwVeil var(--rp-dur) linear both;}
/* energetic light-streak that sweeps across once the wall is solid */
.replay-wipe::before{content:'';position:absolute;top:-10%;bottom:-10%;left:-30%;width:24%;z-index:3;pointer-events:none;
  background:linear-gradient(100deg,transparent 0%,rgba(255,255,255,.20) 46%,rgba(255,255,255,.32) 54%,transparent 100%);opacity:0;}
.replay-wipe.play::before{animation:rpStreak var(--rp-dur) ease;}
@keyframes rpStreak{0%,28%{opacity:0;left:-30%;}34%{opacity:.9;}56%{opacity:.9;left:120%;}62%,100%{opacity:0;left:120%;}}

/* optional brand skin: full-frame image layered ABOVE everything else so a border/frame image sits
   over the whole transition (edges frame it; text/logo show through its transparent centre).
   Counter-skewed + sized to the 1920×1080 stage so it stays upright and fills the frame. */
.replay-skin{position:absolute;top:50%;left:50%;width:1920px;height:1080px;
  transform:translate(-50%,-50%);object-fit:cover;z-index:6;pointer-events:none;opacity:0;}
.replay-skin.hidden{display:none;}
/* scrim: darkens the centre over the skin so the outline REPLAY text reads on ANY background
   (incl. a light/white skin) while the skin's edges still show. */
.replay-scrim{position:absolute;inset:0;z-index:1;pointer-events:none;opacity:0;
  background:radial-gradient(58% 86% at 50% 50%,rgba(4,6,10,.66) 0%,rgba(4,6,10,.3) 48%,transparent 74%);}
/* content (counter-skewed so it stays upright): sponsor logo ABOVE the word + chevrons */
/* upright: the frame is no longer skewed (the BARS carry the angle), so no counter-skew here */
.replay-stack{position:relative;z-index:4;display:flex;flex-direction:column;align-items:center;gap:24px;}
.replay-logo{max-height:128px;max-width:600px;object-fit:contain;opacity:0;filter:drop-shadow(0 6px 18px rgba(0,0,0,.6));}
.replay-chevrons{display:flex;gap:9px;opacity:0;}
.replay-chevrons i{width:0;height:0;border-style:solid;border-width:11px 0 11px 18px;
  border-color:transparent transparent transparent var(--replay-color,#fff);}
/* OUTLINE type: hollow italic letters with an accent glow + a dark edge for contrast on any bg */
.replay-text{position:relative;font-size:212px;font-weight:900;font-style:italic;letter-spacing:.05em;
  white-space:nowrap;text-transform:uppercase;line-height:1;padding:0 .16em;overflow:visible;
  color:transparent;-webkit-text-stroke:2.5px #f2f6ff;
  filter:drop-shadow(0 0 3px rgba(0,0,0,.8)) drop-shadow(0 0 30px color-mix(in srgb,var(--replay-color,#fff) 60%,transparent)) drop-shadow(0 8px 20px rgba(0,0,0,.5));
  opacity:0;}
.replay-text::after{content:'';position:absolute;left:6%;right:6%;bottom:-16px;height:5px;border-radius:3px;
  background:var(--replay-color,#fff);box-shadow:0 0 18px var(--replay-color,#fff);transform:scaleX(0);transform-origin:left;}
/* content fades in once the panel covers, holds longer, fades before it swipes away */
.replay-wipe.play .replay-text{animation:rpTextPunch var(--rp-dur) cubic-bezier(.2,.9,.25,1);}   /* SNAP in with a scale punch */
.replay-wipe.play .replay-stack{animation:rpStackShake .5s cubic-bezier(.36,.07,.19,.97) calc(var(--rp-dur) * .28);}   /* impact shake ON the slam */
.replay-wipe.play .replay-logo{animation:rpContent var(--rp-dur) ease .06s backwards;}
.replay-wipe.play .replay-chevrons{animation:rpContent var(--rp-dur) ease backwards;}
.replay-wipe.play .replay-text::after{animation:replayUnderline var(--rp-dur) cubic-bezier(.3,.6,.15,1);}
/* content timing tracks the SHUTTER cover window: last bar lands ~30%, first bar leaves ~80% */
@keyframes rpContent{0%,20%{opacity:0;}32%{opacity:1;}74%{opacity:1;}84%,100%{opacity:0;}}
@keyframes rpTextPunch{0%,18%{opacity:0;transform:scale(1.4);}26%{opacity:1;transform:scale(.98);}30%{transform:scale(1.03);}35%{transform:scale(1);}76%{opacity:1;transform:scale(1);}86%,100%{opacity:0;transform:scale(1.08);}}
@keyframes rpStackShake{0%,100%{transform:translate(0,0);}15%{transform:translate(-4px,3px);}35%{transform:translate(4px,-2px);}55%{transform:translate(-3px,2px);}75%{transform:translate(2px,-1px);}}
@keyframes replayUnderline{0%,28%{transform:scaleX(0);}42%{transform:scaleX(1);}76%{transform:scaleX(1);}100%{transform:scaleX(1);}}
/* small SCORING-TEAM logo beneath the REPLAY word (full swipe only; brand logo as fallback) */
.replay-team-logo{max-height:90px;max-width:230px;object-fit:contain;opacity:0;margin-top:8px;filter:drop-shadow(0 5px 14px rgba(0,0,0,.55));}
/* A TEAM crest is boxed square, so a wide club banner and a square badge carry the same weight
   under the REPLAY word. Only when it IS a crest — this element falls back to the brand logo,
   which is a wordmark and has to stay wide. */
.replay-team-logo.is-team{max-width:90px;}
.replay-team-logo.hidden{display:none;}
.replay-wipe.play .replay-team-logo{animation:rpContent var(--rp-dur) ease .1s backwards;}
/* after-replay outro: brand/custom logo ONLY (no REPLAY text, chevrons, or team logo) */
.replay-wipe.logo-only .replay-text,.replay-wipe.logo-only .replay-chevrons,.replay-wipe.logo-only .replay-team-logo{display:none;}
.replay-wipe.logo-only .replay-logo{max-height:340px;max-width:1000px;}   /* bigger logo on the outro */
/* the outro's sponsor "replay background" skin (e.g. Trolli) reads better DARKER — a heavier, more
   even scrim across the whole frame (vs the goal swipe's centre-only darkening) so the background
   isn't washed out and the logo pops. (Producer feedback: "replay background… opacity darker".) */
.replay-wipe.logo-only .replay-scrim{
  background:radial-gradient(85% 105% at 50% 50%,rgba(2,4,8,.86) 0%,rgba(2,4,8,.74) 52%,rgba(2,4,8,.52) 100%);}

/* ═══ REPLAY TRANSITION — STYLE: CINEMA ══════════════════════════════════════════
   The clean, cinematic alternative to the shutter slam. Two letterbox bars close the frame to a
   2.39:1 window, three bands of the replay word scroll through that window (the outer two hollow
   and slow, the centre one solid), and the sponsor mark sits DEAD STILL on a hairline underneath —
   motion is the type's job, never the partner's. Same --rp-dur and the same .play lifecycle as the
   slam, so showReplay()'s timers are untouched; only the furniture differs.
   Everything is keyed off \`.style-cinema\` so the slam is byte-for-byte what it was. */
.replay-wipe.style-cinema .rw-bars{display:none;}          /* no shutter in this style */
.replay-wipe.style-cinema::before{display:none;}           /* ...and no light streak */
.replay-wipe.style-cinema{--rp-dur:2.6s;}
.replay-wipe.style-cinema.logo-only{--rp-dur:1.9s;}
/* FULLY OPAQUE cover — this transition doubles as a STINGER: RL's own cut into/out of the goal replay
   looks janky, so the overlay must completely blanket the game while the animation is up (the producer
   uses the replay wipe to hide the in-game UI transition). Solid, no alpha. */
.replay-wipe.style-cinema .replay-scrim{
  background:linear-gradient(180deg,#05070c 0%,#080c15 44%,#05070c 100%);}
.replay-wipe.style-cinema.play .replay-scrim,
.replay-wipe.style-cinema.play .replay-skin{animation:rwcVeil var(--rp-dur) cubic-bezier(.4,0,.2,1) both;}
/* Snap SOLID fast (opaque by ~7% ≈ 0.18s) so it hides the cut instantly; hold through the middle;
   reveal late (96%) so the game is already back to a stable frame before it uncovers. */
@keyframes rwcVeil{0%{opacity:0;}7%{opacity:1;}84%{opacity:1;}96%,100%{opacity:0;}}

/* Letterbox — the cinematic tell. Closes fast, opens fast, holds through the middle. */
.rw-cine{position:absolute;inset:0;z-index:2;pointer-events:none;overflow:hidden;display:none;}
.replay-wipe.style-cinema .rw-cine{display:block;}
.rwc-lb{position:absolute;left:0;right:0;height:15%;background:#000;transform:scaleY(0);}
.rwc-lb.top{top:0;transform-origin:top;}
.rwc-lb.bot{bottom:0;transform-origin:bottom;}
.replay-wipe.style-cinema.play .rwc-lb{animation:rwcBar var(--rp-dur) cubic-bezier(.5,.04,.28,1) both;}
@keyframes rwcBar{0%{transform:scaleY(0);}14%{transform:scaleY(1);}82%{transform:scaleY(1);}100%{transform:scaleY(0);}}
/* accent hairline riding the inside edge of each bar */
.rwc-lb::after{content:'';position:absolute;left:0;right:0;height:2px;
  background:linear-gradient(90deg,transparent,var(--replay-color,#fff) 22%,var(--replay-color,#fff) 78%,transparent);
  opacity:.85;box-shadow:0 0 14px var(--replay-color,#fff);}
.rwc-lb.top::after{bottom:0;}
.rwc-lb.bot::after{top:0;}

/* Scrolling type. Each row holds the label twice so translateX(-50%) loops seamlessly. */
.rwc-marquee{position:absolute;left:0;right:0;overflow:hidden;opacity:0;white-space:nowrap;}
.rwc-marquee > span{display:inline-block;font-weight:900;font-style:italic;text-transform:uppercase;
  line-height:1;white-space:nowrap;will-change:transform;}
.rwc-marquee.r1{top:19%;font-size:120px;}
.rwc-marquee.r3{bottom:19%;font-size:120px;}
.rwc-marquee.r1 > span,.rwc-marquee.r3 > span{
  color:transparent;-webkit-text-stroke:2px rgba(236,242,255,.30);letter-spacing:.06em;}
.replay-wipe.style-cinema.play .rwc-marquee{animation:rwcFade var(--rp-dur) ease both;}
@keyframes rwcFade{0%,10%{opacity:0;}24%{opacity:1;}76%{opacity:1;}92%,100%{opacity:0;}}
/* Opposed directions read as parallax; the slow, even speed is what keeps it calm. */
.replay-wipe.style-cinema.play .rwc-marquee.r1 > span{animation:rwcScrollL 9s linear infinite;}
.replay-wipe.style-cinema.play .rwc-marquee.r3 > span{animation:rwcScrollR 11s linear infinite;}
@keyframes rwcScrollL{from{transform:translateX(0);}to{transform:translateX(-50%);}}
@keyframes rwcScrollR{from{transform:translateX(-50%);}to{transform:translateX(0);}}

/* Centre lockup: hero word + a hairline + the STILL sponsor mark. */
.replay-wipe.style-cinema .replay-stack{gap:26px;z-index:5;}
.replay-wipe.style-cinema .replay-chevrons{display:none;}
.replay-wipe.style-cinema .replay-team-logo{max-height:64px;max-width:180px;opacity:.9;}
.replay-wipe.style-cinema .replay-team-logo.is-team{max-width:64px;}
.replay-wipe.style-cinema .replay-text{
  font-size:168px;-webkit-text-stroke:0;color:#fff;letter-spacing:.14em;
  filter:drop-shadow(0 6px 26px rgba(0,0,0,.75));}
.replay-wipe.style-cinema .replay-text::after{
  left:0;right:0;bottom:-22px;height:2px;border-radius:0;}
/* No punch, no shake — it rises and settles. That restraint IS the style. */
.replay-wipe.style-cinema.play .replay-text{animation:rwcRise var(--rp-dur) cubic-bezier(.16,.84,.24,1) both;}
.replay-wipe.style-cinema.play .replay-stack{animation:none;}
@keyframes rwcRise{0%,12%{opacity:0;transform:translateY(26px);}28%{opacity:1;transform:translateY(0);}
  78%{opacity:1;transform:translateY(0);}92%,100%{opacity:0;transform:translateY(-14px);}}
/* The partner logo does not move. It fades, holds, fades — nothing else. */
.replay-wipe.style-cinema.play .replay-logo{animation:rwcStill var(--rp-dur) ease both;}
.replay-wipe.style-cinema.play .replay-team-logo{animation:rwcStill var(--rp-dur) ease both;}
@keyframes rwcStill{0%,16%{opacity:0;}30%{opacity:1;}78%{opacity:1;}92%,100%{opacity:0;}}
/* Outro (logo only): no type at all, so the marquee has nothing to say. */
.replay-wipe.style-cinema.logo-only .rwc-marquee{display:none;}

/* ── Film texture: vignette + a soft team-colour bloom + light grain, so the now-fully-opaque cover
   still reads as a cinematic frame instead of flat black. Sits BEHIND the letterbox bars + type. ── */
.rwc-tex{position:absolute;inset:0;pointer-events:none;opacity:0;z-index:0;
  background:
    radial-gradient(62% 76% at 50% 45%, color-mix(in srgb,var(--replay-color,#fff) 18%,transparent) 0%, transparent 62%),
    radial-gradient(125% 125% at 50% 50%, transparent 50%, rgba(0,0,0,.62) 100%);}   /* team bloom + vignette */
.rwc-grain{position:absolute;inset:-40px;pointer-events:none;opacity:0;z-index:1;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  background-size:150px 150px;}
.replay-wipe.style-cinema.play .rwc-tex{animation:rwcTex var(--rp-dur) ease both;}
.replay-wipe.style-cinema.play .rwc-grain{animation:rwcGrainFade var(--rp-dur) ease both, rwcGrain .7s steps(4) infinite;}
@keyframes rwcTex{0%,8%{opacity:0;}22%{opacity:1;}80%{opacity:1;}94%,100%{opacity:0;}}
@keyframes rwcGrainFade{0%,8%{opacity:0;}22%{opacity:.10;}80%{opacity:.10;}94%,100%{opacity:0;}}
@keyframes rwcGrain{0%{background-position:0 0;}25%{background-position:-38px 26px;}50%{background-position:28px -22px;}75%{background-position:-18px -36px;}100%{background-position:0 0;}}
/* Slow cinematic push-in on the whole framed window — a gentle settle, not a zoom. */
.replay-wipe.style-cinema.play .rw-cine{animation:rwcPush var(--rp-dur) cubic-bezier(.2,.7,.3,1) both;}
@keyframes rwcPush{0%{transform:scale(1.045);}100%{transform:scale(1);}}

/* ══ PANEL SWEEP (replay in/out + scoreboard in/out) ═══════════════════════════ */
.replay-wipe.style-sweep{position:absolute;inset:0;z-index:90;pointer-events:none;overflow:hidden;display:none;}
.replay-wipe.style-sweep.play{display:block;}
.replay-wipe.style-sweep i{position:absolute;top:-10%;bottom:-10%;left:-20%;right:-20%;transform:translateX(130%) skewX(-14deg);}
.replay-wipe.style-sweep .s1{background:radial-gradient(70% 90% at 50% 50%,rgba(255,255,255,.12),rgba(0,0,0,.35)),var(--sw-col,var(--accent));}
.replay-wipe.style-sweep .s2{background:var(--ink);}
.replay-wipe.style-sweep .s3{background:var(--sw-col,var(--accent));opacity:.55;}
.replay-wipe.style-sweep.play .s3{animation:sw var(--sw-dur,1.5s) cubic-bezier(.65,0,.35,1) both;}
.replay-wipe.style-sweep.play .s2{animation:sw var(--sw-dur,1.5s) cubic-bezier(.65,0,.35,1) 60ms both;}
.replay-wipe.style-sweep.play .s1{animation:sw var(--sw-dur,1.5s) cubic-bezier(.65,0,.35,1) 120ms both;}
@keyframes sw{0%{transform:translateX(130%) skewX(-14deg);}36%,64%{transform:translateX(0) skewX(-14deg);}100%{transform:translateX(-130%) skewX(-14deg);}}
.replay-wipe.style-sweep .sw-skin{position:absolute;inset:0;background-size:cover;background-position:center;opacity:0;}
.replay-wipe.style-sweep.play .sw-skin{animation:swC var(--sw-dur,1.5s) linear both;}
.replay-wipe.style-sweep .sw-lock{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;opacity:0;z-index:3;}
.replay-wipe.style-sweep.play .sw-lock{animation:swC var(--sw-dur,1.5s) linear both;}
@keyframes swC{0%,30%{opacity:0;}40%,60%{opacity:1;}70%,100%{opacity:0;}}
.replay-wipe.style-sweep .sw-lock img{max-height:150px;max-width:620px;object-fit:contain;filter:drop-shadow(0 8px 24px rgba(0,0,0,.4));}
.replay-wipe.style-sweep .sw-lock span:empty{display:none;}
.replay-wipe.style-sweep.play .sw-lock img{animation:swPush var(--sw-dur,1.5s) var(--ease) both;}
@keyframes swPush{0%,32%{transform:scale(.92);}60%{transform:scale(1);}100%{transform:scale(1.04);}}

/* ── Scrolling REPLAY marquee — a moving text texture across the covered frame (RLCS style) ── */
.replay-wipe.style-sweep .sw-marquee{position:absolute;left:-6%;right:-6%;top:50%;transform:translateY(-50%);height:170px;z-index:2;
  overflow:hidden;display:flex;align-items:center;opacity:0;pointer-events:none;}
.replay-wipe.style-sweep.play .sw-marquee{animation:swC var(--sw-dur,1.5s) linear both;}
.replay-wipe.style-sweep .sw-track{display:flex;flex:none;will-change:transform;}
.replay-wipe.style-sweep.play .sw-track{animation:swMarq 4.5s linear infinite;}
.replay-wipe.style-sweep .sw-track span{font-weight:800;font-size:132px;line-height:1;letter-spacing:.05em;text-transform:uppercase;
  white-space:nowrap;color:transparent;-webkit-text-stroke:2px rgba(255,255,255,.18);padding:0 .18em;}
@keyframes swMarq{from{transform:translateX(0);}to{transform:translateX(-50%);}}

/* ── Glitch on the centre REPLAY word — chromatic split + slice jitter ── */
.replay-wipe.style-sweep .sw-glitch{position:relative;font-weight:800;font-size:74px;letter-spacing:.28em;text-transform:uppercase;
  padding-left:.28em;color:#fff;text-shadow:0 0 26px rgba(0,0,0,.55);}
.replay-wipe.style-sweep .sw-glitch::before,.replay-wipe.style-sweep .sw-glitch::after{content:attr(data-t);position:absolute;left:0;top:0;width:100%;height:100%;
  padding-left:.28em;overflow:hidden;opacity:.9;}
.replay-wipe.style-sweep .sw-glitch::before{color:#ff2d5e;}
.replay-wipe.style-sweep .sw-glitch::after{color:#2cd8ff;}
.replay-wipe.style-sweep.play .sw-glitch{animation:swJit .3s steps(2,end) 6;}
.replay-wipe.style-sweep.play .sw-glitch::before{animation:swSliceA .42s steps(3,end) 5;}
.replay-wipe.style-sweep.play .sw-glitch::after{animation:swSliceB .42s steps(3,end) 5;}
@keyframes swJit{0%{transform:translate(0,0);}50%{transform:translate(-2px,0);}100%{transform:translate(2px,0);}}
@keyframes swSliceA{0%{clip-path:inset(0 0 72% 0);transform:translate(-4px,0);}33%{clip-path:inset(28% 0 42% 0);transform:translate(3px,0);}66%{clip-path:inset(58% 0 12% 0);transform:translate(-3px,0);}100%{clip-path:inset(0 0 72% 0);transform:translate(-4px,0);}}
@keyframes swSliceB{0%{clip-path:inset(72% 0 0 0);transform:translate(4px,0);}33%{clip-path:inset(42% 0 28% 0);transform:translate(-3px,0);}66%{clip-path:inset(12% 0 58% 0);transform:translate(3px,0);}100%{clip-path:inset(72% 0 0 0);transform:translate(4px,0);}}

/* faint scanline sheen sweeping down for the digital feel */
.replay-wipe.style-sweep .sw-scan{position:absolute;inset:0;z-index:2;pointer-events:none;opacity:0;
  background:repeating-linear-gradient(0deg,rgba(255,255,255,.05) 0 1px,transparent 1px 4px);}
.replay-wipe.style-sweep.play .sw-scan{animation:swC var(--sw-dur,1.5s) linear both;}

/* The wipe element carries BOTH vocabularies (slam/cinema furniture + sweep furniture) on one DOM,
   so every sweep rule above is scoped to .style-sweep. These re-assert the opposite direction: in
   the sweep, opacity is animated on the LOCK, so its children must not stay at the slam's hidden
   default (that blanked the replay logo in every style while the .sw-* rules were unscoped). */
.replay-wipe.style-sweep .replay-logo,
.replay-wipe.style-sweep .replay-text,
.replay-wipe.style-sweep .replay-team-logo{opacity:1;animation:none;}
.replay-wipe.style-sweep.play .replay-logo{animation:swPush var(--sw-dur,1.5s) var(--ease) both;}
`;
  var MARKUP = `
  <div class="rw-bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
  <div class="rw-cine" aria-hidden="true">
    <div class="rwc-tex"></div>
    <div class="rwc-grain"></div>
    <i class="rwc-lb top"></i>
    <div class="rwc-marquee r1"><span id="rfx-row1"></span></div>
    <div class="rwc-marquee r3"><span id="rfx-row3"></span></div>
    <i class="rwc-lb bot"></i>
  </div>
  <i class="s3"></i><i class="s2"></i><i class="s1"></i>
  <div id="rfx-sw-skin" class="sw-skin"></div>
  <div class="sw-marquee" aria-hidden="true"><div id="rfx-sw-track" class="sw-track"></div></div>
  <div class="sw-scan"></div>
  <img id="rfx-skin" class="replay-skin hidden" alt="">
  <div class="replay-scrim"></div>
  <div class="replay-stack sw-lock">
    <img id="rfx-logo" class="replay-logo hidden" alt="">
    <div class="replay-chevrons"><i></i><i></i><i></i></div>
    <span id="rfx-text" class="replay-text sw-glitch">REPLAY</span>
    <img id="rfx-team-logo" class="replay-team-logo hidden" alt="">
  </div>
`;

  var opts = { defaultStyle: 'slam' }, state = {}, root = null, lastCoverAt = 0;
  var cycle = { active: false, introDone: false, outroDone: false, started: false, side: 0 };
  var tIntro = null, tHide = null, tHold = null, tHoldSafety = null, tOutro = null, tCycle = null, tMid = null;

  function el(id) { return document.getElementById(id); }
  function qp(name) {
    var m = new RegExp('[?&]' + name + '=([^&]+)').exec(global.location.search);
    return m ? decodeURIComponent(m[1]) : '';
  }
  function teamOf(p) { return (p && Number(p.team) === 1) ? 1 : 0; }

  function mount() {
    if (root) return root;
    var st = document.createElement('style'); st.id = 'rfx-css'; st.textContent = CSS;
    document.head.appendChild(st);
    root = document.createElement('div');
    root.id = 'rfx-wipe'; root.className = 'replay-wipe hidden';
    root.innerHTML = MARKUP;
    (opts.host || document.body).appendChild(root);
    return root;
  }

  // ?fx= wins (per browser source), then the producer's pick, then this overlay's own default.
  function styleId() {
    var pinned = (qp('fx') || '').toLowerCase();
    if (STYLES.indexOf(pinned) >= 0) return pinned;
    var picked = ((state.replay || {}).style || '').toLowerCase();
    if (STYLES.indexOf(picked) >= 0) return picked;
    return STYLES.indexOf(opts.defaultStyle) >= 0 ? opts.defaultStyle : 'slam';
  }

  function colors() {
    var t = state.teams || {};
    return { blue: (t.blue && t.blue.color) || '#2f7bff', orange: (t.orange && t.orange.color) || '#e9a24a' };
  }
  // Transition accent: the scoring team's colour, the brand colour, or mono — the producer's choice.
  function accent(side, forPanel) {
    var rp = state.replay || {}, br = state.brand || {}, c = colors();
    var mode = rp.colorMode || 'team';
    // 'mono' = black & white: white accents suit the bar styles, but the SWEEP fills whole PANELS
    // with this colour — there it has to be the ink, or mono turns the screen white.
    if (mode === 'mono') return forPanel ? '#0c0f16' : '#ffffff';
    if (mode === 'brand') return br.color || br.accent || c.blue;
    return side === 1 ? c.orange : c.blue;
  }
  function label() { return String((state.replay || {}).label || 'REPLAY').toUpperCase(); }

  function fillCinemaRows() {
    var run = new Array(9).fill(label() + '  ·  ').join('');
    ['rfx-row1', 'rfx-row3'].forEach(function (id) { var n = el(id); if (n) n.textContent = run + run; });
  }
  function fillSweepMarquee(on) {
    var track = el('rfx-sw-track'); if (!track) return;
    if (!on) { track.innerHTML = ''; return; }
    var chunk = (label() + '   ·   ').repeat(6);
    track.innerHTML = '<span>' + chunk + '</span><span>' + chunk + '</span>';
  }

  /* Paint + play one cover. mode 'full' = the intro (label + sponsor + scoring team), 'logo' = the
     outro (outro logo only), 'cover' = a one-off (the post-game board). */
  function play(mode, o) {
    o = o || {};
    var w = mount();
    var logoOnly = mode === 'logo', style = styleId();
    var rp = state.replay || {}, brandLogo = (state.brand || {}).logo || null, hasSkin = !!rp.skin;
    var side = o.side != null ? o.side : cycle.side;

    w.className = 'replay-wipe style-' + style + (logoOnly ? ' logo-only' : '');
    w.style.setProperty('--replay-color', o.color || accent(side));
    w.style.setProperty('--sw-col', o.color || accent(side, style === 'sweep'));
    w.style.setProperty('--sw-dur', (o.dur || (logoOnly ? 1300 : 1700)) + 'ms');

    // logo: intro → replay sponsor, outro → the dedicated outro logo (a full-frame skin already
    // carries a mark, so don't fall back onto the sponsor there and print it twice)
    var logo = o.logo !== undefined ? o.logo
      : logoOnly ? (rp.outroLogo || (hasSkin ? null : (rp.logo || brandLogo)))
                 : (rp.logo || brandLogo);
    var im = el('rfx-logo');
    if (im) { if (logo) { im.src = logo; im.classList.remove('hidden'); } else im.classList.add('hidden'); }

    var sk = el('rfx-skin'), swSk = el('rfx-sw-skin');
    if (sk) { if (rp.skin) { sk.src = rp.skin; sk.classList.remove('hidden'); } else { sk.removeAttribute('src'); sk.classList.add('hidden'); } }
    if (swSk) swSk.style.backgroundImage = rp.skin ? 'url("' + rp.skin + '")' : '';

    var txt = el('rfx-text');
    if (txt) {
      var word = o.text !== undefined ? o.text : (logoOnly ? '' : label());
      txt.textContent = word; txt.setAttribute('data-t', word);
    }
    // scoring team's crest under the word (intro only)
    var tl = el('rfx-team-logo');
    if (tl) {
      var teams = state.teams || {};
      var tLogo = (!logoOnly && mode !== 'cover') ? ((side === 1 ? (teams.orange || {}) : (teams.blue || {})).logo || null) : null;
      tl.classList.toggle('is-team', !!tLogo);
      if (tLogo) { tl.src = tLogo; tl.classList.remove('hidden'); } else { tl.removeAttribute('src'); tl.classList.add('hidden'); }
    }
    if (style === 'cinema' && !logoOnly) fillCinemaRows();
    fillSweepMarquee(style === 'sweep' && !logoOnly && mode !== 'cover');

    if (logoOnly && !logo && !hasSkin) return false;   // nothing to show on the outro → skip it

    w.classList.remove('hidden', 'play', 'rp-hold'); void w.offsetWidth; w.classList.add('play');
    lastCoverAt = Date.now();
    clearTimeout(tHide); clearTimeout(tHold); clearTimeout(tHoldSafety); clearTimeout(tMid);
    var dur = o.dur || (logoOnly ? 2150 : 2850);
    if (o.onMid) tMid = setTimeout(o.onMid, Math.round(dur * 0.5));

    if (mode === 'full') {
      // HOLD the cover solid until the game cuts to the replay, then peel (see the header).
      tHold = setTimeout(function () {
        if (cycle.active && !cycle.started) {
          w.classList.add('rp-hold');
          tHoldSafety = setTimeout(resumeReveal, INTRO_MAX_HOLD_MS);
        }
      }, Math.round(2600 * 0.72));
      tHide = setTimeout(function () {
        if (!w.classList.contains('rp-hold')) { w.classList.add('hidden'); w.classList.remove('play'); }
      }, 2850);
    } else {
      // slam/cinema keyframes run for the CSS --rp-dur (2.6s, 1.9s outro) whatever o.dur says: hiding at dur+150 cut the
      // cover off mid-animation. Only the sweep style is paced by o.dur.
      var hideAt = dur + 150;
      if (style !== 'sweep') hideAt = Math.max(hideAt, logoOnly ? 2050 : 2750);
      tHide = setTimeout(function () { w.classList.add('hidden'); w.classList.remove('play'); }, hideAt);
    }
    return true;
  }

  // The cut happened (or the safety fired) → unfreeze so the cover peels off ON the camera change.
  function resumeReveal() {
    if (!root) return;
    clearTimeout(tHold); clearTimeout(tHoldSafety);
    if (!root.classList.contains('play') || !root.classList.contains('rp-hold')) return;
    root.classList.remove('rp-hold');
    clearTimeout(tHide);
    tHide = setTimeout(function () { root.classList.add('hidden'); root.classList.remove('play', 'rp-hold'); }, 1000);
  }

  function transitionsOn() { return state.rlReplayTransitions !== false; }

  function fireIntro() {
    if (!cycle.active || cycle.introDone) return;
    cycle.introDone = true; clearTimeout(tIntro);
    if (transitionsOn()) play('full', {});
    // The outro safety net is armed from the REPLAY start (replayStart), not here: anchoring it at the goal
    // fired the logo outro over the middle of any replay longer than ~12s.
  }
  function fireOutro() {
    if (!cycle.active || cycle.outroDone) return;
    cycle.outroDone = true; clearTimeout(tOutro);
    if (transitionsOn()) play('logo', {});
  }

  var API = {
    init: function (o) {
      opts = Object.assign({ defaultStyle: 'slam' }, o || {});
      mount();
      return API;
    },
    setState: function (s) { if (s) state = s; return API; },
    style: styleId,
    styles: function () { return STYLES.slice(); },
    /* the ball hit the net */
    goal: function (goal) {
      // rl-hud's guard: a goal arriving within RE_GOAL_LOCKOUT_MS of the last cover is the same goal
      // coming through a second route (goal_scored + view_change), not a new one.
      if (cycle.active || Date.now() - lastCoverAt < RE_GOAL_LOCKOUT_MS) return;
      cycle = { active: true, introDone: false, outroDone: false, started: false, willEnd: false, side: teamOf(goal) };
      clearTimeout(tIntro); tIntro = setTimeout(fireIntro, GOAL_TO_REPLAY_MS);
      // No replay ever started (replays skipped/disabled, event missed): end the cycle quietly — no outro for a
      // replay that never played — so the next goal isn't swallowed by a cycle that is still "active".
      clearTimeout(tCycle); tCycle = setTimeout(function () { if (!cycle.started) { cycle.active = false; clearTimeout(tOutro); } }, NO_REPLAY_MS);
    },
    /* the game cut to the goal replay */
    replayStart: function (goal) {
      if (goal && !cycle.active) API.goal(goal);
      if (goal) cycle.side = teamOf(goal);
      cycle.started = true;
      if (!cycle.introDone) fireIntro(); else resumeReveal();
      // Backstops measured from HERE (the replay actually starting), beyond the longest plausible replay.
      clearTimeout(tCycle); tCycle = setTimeout(function () { fireOutro(); cycle.active = false; }, CYCLE_MAX_MS + 3000);
      if (!cycle.willEnd && !cycle.outroDone) { clearTimeout(tOutro); tOutro = setTimeout(fireOutro, REPLAY_MAX_MS); }
    },
    replayWillEnd: function () {
      if (!cycle.active || cycle.outroDone) return;
      cycle.willEnd = true;
      clearTimeout(tOutro); tOutro = setTimeout(fireOutro, REPLAY_WILLEND_DELAY_MS);
    },
    /* the replay ended (back to play). toScoreboard = the game ended, so no outro. */
    replayEnd: function (o) {
      if (o && o.toScoreboard) { API.reset(); return API; }
      fireOutro();
      cycle.active = false; clearTimeout(tCycle);
      return API;
    },
    /* drop the cycle: nothing armed may fire later (post-game board, kickoff, new game) */
    reset: function () {
      clearTimeout(tIntro); clearTimeout(tOutro); clearTimeout(tCycle); clearTimeout(tHold); clearTimeout(tHoldSafety);
      cycle.active = false; cycle.introDone = cycle.outroDone = true; cycle.started = false;
      if (root && root.classList.contains('rp-hold')) API.clear();   // a held cover can no longer be peeled — don't leave it frozen on air
      return API;
    },
    /* one-off full-screen cover in the SAME style — used for the post-game board in/out */
    cover: function (o) { play('cover', o || {}); return API; },
    busy: function () { return !!(root && root.classList.contains('play')); },
    /* hide immediately (kickoff safety: a cover may never bleed onto live play) */
    clear: function () {
      clearTimeout(tHide); clearTimeout(tMid);
      if (root) { root.classList.add('hidden'); root.classList.remove('play', 'rp-hold'); }
      return API;
    }
  };

  global.ReplayFX = API;
})(window);
