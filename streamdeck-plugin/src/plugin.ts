import streamDeck from "@elgato/streamdeck";
import { suite } from "./suite-connection";
import { AdjustScore } from "./actions/adjust-score";
import { SetScore } from "./actions/set-score";
import { SeriesControl } from "./actions/series-control";
import { SelectTeam } from "./actions/select-team";
import { GfxOnAir } from "./actions/gfx-onair";
import { ClearGfx } from "./actions/clear-gfx";
import { SwitchScene } from "./actions/switch-scene";
import { FireFlow } from "./actions/fire-flow";
import { BreakCountdown } from "./actions/break-countdown";
import { CountdownClock } from "./actions/countdown-clock";
import { DeskTopic } from "./actions/desk-topic";
import { CountdownControls } from "./actions/countdown-controls";
import { RunOfShow } from "./actions/run-of-show";
import { AudioMute } from "./actions/audio-mute";
import { SourceToggle } from "./actions/source-toggle";
import { ViewForce } from "./actions/view-force";
import { SaveReplay } from "./actions/save-replay";
import { ReplayBuffer } from "./actions/replay-buffer";
import { AdBreak } from "./actions/ad-break";
import { OverlayToggle } from "./actions/overlay-toggle";
import { TwitchClip } from "./actions/twitch-clip";
import { TwitchMarker } from "./actions/twitch-marker";

streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new AdjustScore());
streamDeck.actions.registerAction(new SetScore());
streamDeck.actions.registerAction(new SeriesControl());
streamDeck.actions.registerAction(new SelectTeam());
streamDeck.actions.registerAction(new GfxOnAir());
streamDeck.actions.registerAction(new ClearGfx());
streamDeck.actions.registerAction(new SwitchScene());
streamDeck.actions.registerAction(new FireFlow());
streamDeck.actions.registerAction(new BreakCountdown());
streamDeck.actions.registerAction(new CountdownClock());
streamDeck.actions.registerAction(new DeskTopic());
streamDeck.actions.registerAction(new CountdownControls());
streamDeck.actions.registerAction(new RunOfShow());
streamDeck.actions.registerAction(new AudioMute());
streamDeck.actions.registerAction(new SourceToggle());
streamDeck.actions.registerAction(new ViewForce());
streamDeck.actions.registerAction(new SaveReplay());
streamDeck.actions.registerAction(new ReplayBuffer());
streamDeck.actions.registerAction(new AdBreak());
streamDeck.actions.registerAction(new OverlayToggle());
streamDeck.actions.registerAction(new TwitchClip());
streamDeck.actions.registerAction(new TwitchMarker());

// Retry the bridge immediately when the suite launches or the machine wakes —
// the backoff loop covers everything else.
streamDeck.system.onApplicationDidLaunch(() => suite.kick());
streamDeck.system.onSystemDidWakeUp(() => suite.kick());

await streamDeck.connect();
suite.start();
