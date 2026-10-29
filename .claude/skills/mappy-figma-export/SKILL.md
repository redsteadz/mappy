---
name: mappy-figma-export
description: Push a Mappy crawl into Figma (browser or desktop) through the Figma MCP connector — one frame per screen rebuilt as editable layers, clickable prototype links, flow arrows, an inventory page and a page of the original captures. Use when the user runs /mappy-figma-export <projectId> or asks to send a Mappy map to Figma.
argument-hint: <projectId> [figma file URL]
---

# Export a Mappy crawl to Figma

Mappy can't run a Figma plugin in browser Figma on Linux, so this skill builds the file through the
Figma MCP connector instead. Mappy generates the Plugin-API scripts; you run them and move IDs between steps.

`$ARGUMENTS` = `<projectId> [figma file URL]`. List projects with `node packages/server/src/cli.ts projects` if no id was given.

## 0. Prepare

1. Load the Figma connector's guidance before any `use_figma` call: read `skill://figma/figma-use/SKILL.md` and
   `skill://figma/figma-generate-design/SKILL.md` (with `get_figma_skill`). Pass `skillNames: "resource:figma-use,resource:figma-generate-design"` on every `use_figma` call.
2. Target file: use the URL the user gave, otherwise create one with `create_new_file` (editorType `design`, name `Mappy — <app>`;
   get `planKey` from `whoami`, and ask which team if there are several). Then call `create_session` with the file key and pass its
   `sessionId` to every Figma call.
3. Generate the scripts (from the repo root):
   ```
   node packages/server/src/cli.ts figma-plan <projectId>
   ```
   This writes `.mappy-figma/<projectId>/`: `plan.json`, `screens-NN.js`, `captures-NN.js`, maybe `inventory.js`.
   Every script starts with the same bundled runtime, so after reading the first one in full you only need each later file's
   data lines (from `const fonts` on). If your shell output gets truncated, add `--max-chars 22000` for smaller scripts.
   The screen frames contain only editable layers. The original screenshots go on a separate "captures (reference)" page,
   following the connector's rule that deliverable frames must not contain full-UI screenshots.

## 1. Build screens

For each step in `plan.json` → `steps` (in order): read the script file and call `use_figma` with `code` = the file's **exact,
unmodified** contents. Save the JSON it returns to `.mappy-figma/<projectId>/results/<script name>.json` (e.g. `results/screens-01.json`).

- Run `screens-01.js` first and alone (it creates the flow page). Then send the remaining `screens-NN.js`, `inventory.js` and
  `captures-01.js` in one message in parallel. If there's more than one captures script, run the others after `captures-01.js`,
  which creates that page.
- If a call fails with `safeToRetryWithoutCanvasRead: true`, retry the same script. Otherwise inspect the page before retrying
  so frames aren't duplicated (delete the partial frames of that script first).

## 2. Upload images

```
node packages/server/src/cli.ts figma-plan <projectId> --finish
```
This writes `uploads.json`, `upload-batch-N.json` (each `{count, nodeIds}`) and `wire.js`. For each batch N:

1. Call `upload_assets` with `fileKey`, `count` and `nodeIds` exactly as in `upload-batch-N.json` (scaleMode `FILL`).
2. Save the full JSON response to `.mappy-figma/<projectId>/urls-N.json` as-is. `figma-upload` reads its
   `uploads[].submitUrl` / `targetNodeId` entries. The URLs expire after about 10 minutes.
3. Run `node packages/server/src/cli.ts figma-upload <projectId> --batch N --urls .mappy-figma/<projectId>/urls-N.json`,
   which POSTs each PNG to its upload URL. Every URL is single-use, so finish a batch before requesting the next.

## 3. Wire the flow

Run `wire.js` with `use_figma` (exact contents). It copies uploaded images to duplicate placeholders, adds an ON_CLICK →
NAVIGATE reaction to every hotspot, draws the flow arrows with labels, adds the title, and sets the prototype starting point.

## 4. Check and report

Take one `get_screenshot` of the start screen frame (or the page) to confirm images and text rendered. Then give the user:
- the Figma file link,
- what was built: screens, prototype links, arrows, and inventory items (from the scripts' return values),
- tips: the original captures are on the "captures (reference)" page for side-by-side comparison. Press Present to click
  through the prototype. Repeated elements (nav bars, list rows) are separate frames per screen, so turning them into
  components is a good first design pass.

Screens listed under `simplified` in `plan.json` were too complex for one script and were imported as flat screenshots. Say so.

## Notes
- Scripts are self-contained (the builder runtime is bundled in) and safe to re-run on a fresh page.
- Big crawls produce many scripts and use a lot of context. For very large apps, suggest hiding unimportant screens in the
  Mappy map first (Hide from exports), or the SVG / plugin export paths in the dashboard's Export tab.
