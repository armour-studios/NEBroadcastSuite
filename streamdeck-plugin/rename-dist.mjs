// Post-pack step: the Elgato CLI names the package after the UUID; we ship it as
// nebroadcaststudio.streamDeckPlugin (friendlier download name, same contents —
// the installer reads the manifest inside the archive, not the filename).
import { renameSync, existsSync } from "node:fs";

const from = "dist/com.armour-studios.ne-broadcast.streamDeckPlugin";
const to = "dist/nebroadcaststudio.streamDeckPlugin";
if (existsSync(from)) {
  renameSync(from, to);
  console.log(`renamed -> ${to}`);
} else if (!existsSync(to)) {
  console.error("no packed plugin found to rename");
  process.exit(1);
}
