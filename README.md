# Mappy

Mappy crawls an Android app on your phone. It taps every button and interactive element, screenshots each screen it reaches, and builds a map of the app's UI/UX. You can explore that map in a local dashboard and export it to design tools as **editable screens with a working prototype**:

- **Figma**: one frame per screen with rebuilt editable layers (frames, live Roboto text, image crops), clickable prototype links, flow arrows, an inventory page of interactive elements, and the original captures for reference.
- **Penpot**: the same, through a Penpot plugin.
- **Anywhere else**: per-screen editable SVGs, a whole-flow SVG, a PNG/PDF poster, a Mermaid flowchart, and JSON.

It also reports **UX and accessibility findings**: unlabeled icon buttons, tap targets under 48dp, low-contrast text, crashes, dead ends, and deep screens.

## Quick start

```bash
npm install
npm run build        # dashboard + Penpot/Figma plugins
npm run mappy        # http://127.0.0.1:4317 opens in your browser
```

No phone yet? On **New crawl**, pick **Demo phone**. It's a simulated notes app that exercises every feature (lists, dialogs, a risky "Delete", a permission prompt, an external link, a crash).

Requires Node 24+ (TypeScript runs natively, so there's no build step for the server).

## Connecting a phone

1. Install adb: `sudo pacman -S android-tools android-udev`, then re-plug the phone.
2. On the phone: tap **Build number** 7 times to enable Developer options, then turn on **USB debugging**. Connect and tap **Allow**.
3. Keep the phone unlocked. The dashboard's **Device setup** page checks everything.

During a crawl, Mappy turns system animations off and keeps the screen awake. It writes the original values to `~/.local/share/mappy/device-restore/` first and restores them afterwards, even after a crash (on the next start).

**Use a test account.** Mappy asks before tapping anything that looks destructive (delete, pay, log out, send…), and you can edit that word list. Pause and **Take over** let you log in or get past a hard screen by hand. Mappy re-reads the screen when you resume.

## How it works

```
phone ──adb──▶ AndroidDriver ─▶ Crawler ─▶ observations + transitions (event log on disk)
                                   │
                         screen clustering (pure, re-runnable, + your merges/splits/renames)
                                   │
              map ─▶ dashboard (React Flow) · insights · reconstruction ─▶ Design IR ─▶ exporters
```

- **Crawler** (`packages/engine/src/crawler`): explores depth-first. It samples list items (rows share a template), fills text fields with test data, scrolls to find more, and handles permission prompts, crashes, other apps, and the launcher. When a screen is done it goes back, follows a known path, or restarts the app and replays the shortest path. Crawls can be resumed.
- **Screen identity** (`abstraction.ts`): a weighted structural signature (classes, flags, coarse position, toolbar title, selected tab) that still works for Compose and Flutter apps without resource IDs. Scrolling never creates a new screen, and pages opened from the same list share a template.
- **Reconstruction** (`packages/engine/src/reconstruct`): samples the screenshot under each view to get fills (trimmed to drawn insets), corner radii, strokes, and text colour, size, weight, and alignment. Images, icons, and controls stay as pixel crops. A fidelity score compares the re-rendered layers with the screenshot.
- **Design IR** (`packages/shared/src/schema.ts`): a tool-neutral design model in dp (screens, layer trees, hotspots, ELK-laid-out flow edges, assets). Every exporter reads it.

## Exporting to Figma

Figma only runs development plugins in its desktop app, which isn't available for Linux. Pick one:

1. **Claude Code + Figma connector (works with browser Figma).** In Claude Code, in this folder, run `/mappy-figma-export <projectId>`. The project skill (`.claude/skills/mappy-figma-export`) generates Plugin-API scripts with `mappy figma-plan` and runs them through the connector's `use_figma`. It uploads screenshots and crops with `upload_assets` (POSTed by `mappy figma-upload`), then wires the prototype.
2. **SVG drag-in.** Export → *SVG pack*, then drag a screen SVG into Figma. You get editable layers, but no prototype links.
3. **Desktop plugin.** On macOS/Windows (or figma-linux): Plugins → Development → Import plugin from manifest → `packages/figma-plugin/manifest.json`, then pick a `.mappy.zip`.

## Exporting to Penpot

In Penpot, press Ctrl + Alt + P and install `http://127.0.0.1:4317/plugins/penpot/manifest.json`. Open the plugin, then pick a crawl, or a `.mappy.zip` file. Brave and recent Chrome block public sites from loading `localhost`. Allow it for `design.penpot.app` under `brave://settings/content/localhostAccess`, or self-host Penpot.

## CLI

```
mappy [serve] [--port 4317] [--no-open]
mappy crawl --device <serial|demo> --package <pkg> [--config cfg.json] [--max-actions N]
mappy projects
mappy export <projectId> --format json|mermaid|svg|flow.svg|poster.png|poster.pdf|bundle [--out file]
mappy figma-plan <projectId> [--finish]
mappy figma-upload <projectId> --batch N --urls urls-N.json
```

`npm run mappy -- <args>` works too. Data lives in `~/.local/share/mappy` (override it with `MAPPY_HOME`).

## Development

```bash
npm test            # vitest: parsing, clustering, crawler (mock app), exports, Figma/Penpot builders, server API
npm run typecheck
npm run dev:web     # Vite dev server on :5173, proxied to the API on :4317 (run `npm run mappy -- --no-open` alongside)
```

| Package | What's in it |
|---|---|
| `packages/shared` | zod schemas: crawl data, map, Design IR, live events |
| `packages/engine` | adb + mock drivers, hierarchy parsing, crawler, clustering, reconstruction, ELK layout, exporters, Figma builder |
| `packages/server` | Fastify API + WebSocket, project store, crawl jobs, insights, CLI |
| `packages/web` | React dashboard |
| `packages/penpot-plugin` / `packages/figma-plugin` | design-tool importers for `.mappy.zip` bundles |

Known limits: `uiautomator dump` takes about 1–2 s per screen. Screens with `FLAG_SECURE` (banking apps) capture as black and are marked opaque. Canvas-rendered UIs (games) can only be mapped as screenshots.

Fonts: `assets/fonts/Roboto.ttf` is licensed under the SIL Open Font License (`assets/fonts/OFL.txt`).
