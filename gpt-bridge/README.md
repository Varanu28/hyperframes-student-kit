# HyperFrames GPT Bridge

This folder turns the local HyperFrames Student Kit into a small, allow-listed HTTP API that can be connected to a GPT action/skill through `openapi.yaml`.

## What the bridge exposes

- Read the repository's existing agent skills.
- Search the style-card registry and retrieve card HTML.
- Create HyperFrames video projects from the included starter.
- Read/write allowed text files inside `video-projects/<slug>/`.
- Import media from explicitly allow-listed HTTPS hosts.
- Run project preflight, HyperFrames lint, and beat-sync validation.
- Run the transcript-driven silence cutter.
- Find mistake candidates, then apply only reviewed/approved cuts.
- Start HyperFrames transcription.
- Start bounded draft/standard/high renders and poll job status.
- Run `hyperframes doctor`.

The server never accepts an arbitrary shell command. Project paths are normalized and constrained to `video-projects/<slug>/`. Media downloads are disabled unless their hostname is explicitly allow-listed.

## Requirements

Use the same runtime as the student kit:

- Node.js 22+
- FFmpeg and ffprobe
- Chrome or Chromium
- `npm ci` completed in the repository root

## Local start

From the repository root:

```bash
npm ci
export HYPERFRAMES_BRIDGE_API_KEY='replace-with-a-long-random-secret'
export HYPERFRAMES_ALLOWED_MEDIA_HOSTS='storage.googleapis.com,cdn.example.com'
node gpt-bridge/server.mjs
```

PowerShell:

```powershell
$env:HYPERFRAMES_BRIDGE_API_KEY='replace-with-a-long-random-secret'
$env:HYPERFRAMES_ALLOWED_MEDIA_HOSTS='storage.googleapis.com,cdn.example.com'
node gpt-bridge/server.mjs
```

The default port is `8787`. Override it with `PORT` or `HYPERFRAMES_BRIDGE_PORT`.

For localhost-only development you may set `HYPERFRAMES_ALLOW_UNAUTHENTICATED=1`, but do not expose that mode to the internet.

## Test locally

```bash
curl http://localhost:8787/health
curl -H "Authorization: Bearer $HYPERFRAMES_BRIDGE_API_KEY" \
  http://localhost:8787/v1/capabilities
```

Create a project:

```bash
curl -X POST \
  -H "Authorization: Bearer $HYPERFRAMES_BRIDGE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"project":"gpt-demo"}' \
  http://localhost:8787/v1/projects
```

Start a draft render:

```bash
curl -X POST \
  -H "Authorization: Bearer $HYPERFRAMES_BRIDGE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"quality":"draft","fps":30,"format":"mp4"}' \
  http://localhost:8787/v1/projects/gpt-demo/render
```

The response contains a `jobId`. Poll `/v1/jobs/<jobId>` until the status becomes `completed` or `failed`.

## Connect it to a GPT skill/action

1. Deploy this repository or this server to an HTTPS host that has enough CPU/RAM to run Chrome + FFmpeg renders.
2. Set `HYPERFRAMES_BRIDGE_API_KEY` on the host.
3. Set `HYPERFRAMES_ALLOWED_MEDIA_HOSTS` only to hosts you trust for media ingestion.
4. Replace `https://YOUR-HOST.example.com` in `openapi.yaml` with the deployed HTTPS origin.
5. Add/import `gpt-bridge/openapi.yaml` as the GPT action/tool schema.
6. Configure bearer authentication using the same bridge API key.
7. Add the behavior in `GPT_SKILL_INSTRUCTIONS.md` to your GPT's instructions or skill definition.

## Suggested workflow for the GPT

1. Call `getCapabilities` and `listHyperframesSkills` when first learning the bridge.
2. Load only the skill contract relevant to the user's request, for example `short-form-edit`, `edit-video`, `cut-silences`, or `make-a-video`.
3. Create or select a project.
4. Import or reference media only after it is available to the bridge host.
5. Build/edit composition files using the relevant skill guidance and style cards.
6. Run `preflightProject`, `lintProject`, and `validateBeatSync` as applicable.
7. Render a draft first. Review before high-quality rendering or publishing.
8. For mistake cuts, always run candidate detection first and obtain review/approval before `applyApprovedMistakeCuts`.

## Production notes

The included job store is intentionally simple and lives in server memory. A production deployment should replace it with durable storage/queueing if you need jobs to survive restarts or run across multiple instances. The bridge currently returns render paths on the host; add object-storage upload/download endpoints if you want GPT to receive final media files directly.
