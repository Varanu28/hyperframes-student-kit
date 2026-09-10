# GPT -> Codex -> HyperFrames: `editor` workspace

This repository can be used as the shared execution workspace for a GPT that delegates implementation and video-editing tasks to Codex.

## Target architecture

```text
GPT / ChatGPT skill
        |
        | HTTPS action/tool call
        v
HyperFrames Editor Codex Gateway
        |
        | codex exec --sandbox workspace-write
        v
Codex execution layer: editor
        |
        | reads AGENTS.md + .agents/skills
        v
Varanu28/hyperframes-student-kit
        |
        +-- edit-video
        +-- short-form-edit
        +-- cut-silences
        +-- cut-mistakes
        +-- style-library
        +-- video-storytelling
        +-- hyperframes-cli
        +-- FFmpeg / GSAP / HyperFrames
```

## Important distinction

A Codex UI/cloud environment display name such as `editor` is not a public API address that an external GPT can call by name. The repository therefore provides two compatible pieces:

1. A Codex environment configuration for the human-visible `editor` environment.
2. A server-side Codex gateway that GPT can call programmatically. The gateway runs Codex from this same repository and identifies the execution workspace as `editor`.

Both layers use the repository as the source of truth, so Codex receives the same `AGENTS.md`, skills, code, styles, scripts, and video projects.

## 1. Configure the Codex cloud environment named `editor`

In Codex settings, create or edit the cloud environment with these values:

- **Environment name:** `editor`
- **Repository:** `Varanu28/hyperframes-student-kit`
- **Branch while this integration is under review:** `feat/gpt-hyperframes-bridge`
- **Branch after PR #1 is merged:** `main`
- **Setup script:** `bash .codex/editor-setup.sh`
- **Maintenance script:** `bash .codex/editor-maintenance.sh`

The setup script installs the locked npm dependencies, validates the skill mirror, checks Node 22+, FFmpeg/ffprobe, and runs `hyperframes doctor`.

If the environment reports a browser problem, install or expose Chrome/Chromium in that Codex environment and reset its cache.

## 2. Run the GPT-to-Codex gateway

The gateway file is:

```text
gpt-bridge/editor-codex-server.mjs
```

It requires a bearer key for the GPT-facing HTTP endpoint and a working Codex authentication method on the server.

Example environment variables:

```bash
export HYPERFRAMES_BRIDGE_API_KEY="replace-with-a-long-random-secret"
export EDITOR_CODEX_PORT=8790
```

For Codex authentication, use one supported method on the host:

- an existing Codex login on that machine, or
- `OPENAI_API_KEY` / Codex API-key authentication for server-side usage.

Do not commit authentication credentials to this repository.

Start the gateway from the repository root:

```bash
node gpt-bridge/editor-codex-server.mjs
```

Health check:

```bash
curl http://localhost:8790/health
```

## 3. Connect the GPT

Deploy the gateway behind HTTPS. Then edit:

```text
gpt-bridge/editor-openapi.yaml
```

Replace:

```text
https://YOUR-EDITOR-GATEWAY.example.com
```

with the public HTTPS URL of the gateway.

Add that OpenAPI schema to the GPT action/tool configuration and configure bearer authentication with the same value used for `HYPERFRAMES_BRIDGE_API_KEY`.

The GPT receives two operations:

- `runEditorCodex` — delegate a task to Codex.
- `getEditorCodexJob` — retrieve status and Codex JSONL output/logs.

## 4. How GPT should delegate

For a repository-wide task:

```json
{
  "prompt": "Inspect the HyperFrames workspace, choose the correct skill, implement the requested change, run the relevant tests and report the result.",
  "readOnly": false
}
```

For an existing video project:

```json
{
  "project": "my-video",
  "prompt": "Use short-form-edit to produce a reviewed 9:16 draft. Preserve meaning, tighten silence, propose mistake cuts before applying ambiguous cuts, use the style library, then lint and preflight.",
  "readOnly": false
}
```

For analysis only:

```json
{
  "prompt": "Audit the current editing pipeline and identify the three highest-risk runtime failures. Do not modify files.",
  "readOnly": true
}
```

## 5. Permissions and safety

The gateway deliberately uses Codex with either `read-only` or `workspace-write` sandboxing. It does not expose a full-access/yolo option.

The HTTP caller cannot inject arbitrary Codex CLI flags or choose an arbitrary filesystem working directory. The only optional subdirectory is a validated `video-projects/<slug>` folder.

The repository's existing review rule remains in force for mistake removal: ambiguous spoken cuts must be surfaced for review before they are applied.

## 6. Relationship with the direct HyperFrames bridge

`gpt-bridge/server.mjs` exposes deterministic HyperFrames functions directly, such as preflight, lint, style search, silence cutting, transcription, and rendering.

`gpt-bridge/editor-codex-server.mjs` is the reasoning/execution layer. It is useful when GPT should delegate an open-ended task to Codex and let Codex choose the relevant repository skills and edit files.

A production deployment can expose both services behind one HTTPS hostname, for example:

```text
/api/hyperframes/*   -> server.mjs:8787
/v1/codex/editor/*   -> editor-codex-server.mjs:8790
```

This gives GPT both deterministic tools and a Codex engineering agent while preserving the repository as the shared state layer.
