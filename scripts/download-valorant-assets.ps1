# Download Valorant overlay assets from hel-valorant-overlay-server GitHub repo
# Run from the broadcaststudio root:  .\scripts\download-valorant-assets.ps1

$CDN   = "https://cdn.jsdelivr.net/gh/Ailyrr/hel-valorant-overlay-server@master/overlays/visual_assets"
$DEST  = "$PSScriptRoot\..\assets\valorant"

$AGENTS = @(
  "astra","breach","brimstone","chamber","clove","cypher",
  "deadlock","fade","gekko","harbor","iso","jett","kayo",
  "killjoy","neon","omen","phoenix","raze","reyna","sage",
  "skye","sova","viper","yoru"
)
$ABILITY_SLOTS = @("c","q","e","x")

$GAME_ICONS = @(
  "spike","credits",
  "classic","shorty","frenzy","ghost","sheriff",
  "stinger","spectre","bucky","judge",
  "bulldog","guardian","phantom","vandal",
  "marshal","operator","outlaw",
  "ares","odin","knife"
)

function Download-File($url, $dest) {
  $dir = Split-Path $dest -Parent
  if (!(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  if (Test-Path $dest) { Write-Host "  skip (exists): $dest"; return }
  try {
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
    Write-Host "  OK: $dest"
  } catch {
    Write-Host "  MISS: $url — $($_.Exception.Message)"
  }
}

Write-Host "== Downloading Valorant overlay assets =="

# Spike images (white + red)
foreach ($s in @("spike_white","spike_red")) {
  Download-File "$CDN/$s.png" "$DEST\$s.png"
}

# UI assets
foreach ($f in @("diamond-solid.svg","ultimage-charged-border.svg")) {
  Download-File "$CDN/$f" "$DEST\$f"
}

# Agent icons and ability icons
Write-Host "`n-- Agent icons & abilities --"
foreach ($agent in $AGENTS) {
  New-Item -ItemType Directory -Path "$DEST\agents\$agent" -Force | Out-Null
  Download-File "$CDN/agent_icons/$agent/${agent}_icon.webp" "$DEST\agents\$agent\${agent}_icon.webp"
  foreach ($slot in $ABILITY_SLOTS) {
    Download-File "$CDN/agent_icons/$agent/ability_$slot.webp" "$DEST\agents\$agent\ability_$slot.webp"
  }
}

# Game icons (weapons + HUD items)
Write-Host "`n-- Game icons --"
New-Item -ItemType Directory -Path "$DEST\game_icons" -Force | Out-Null
foreach ($icon in $GAME_ICONS) {
  Download-File "$CDN/game_icons/$icon.webp" "$DEST\game_icons\$icon.webp"
}

Write-Host "`n== Done. Assets in: $DEST =="
