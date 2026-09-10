#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

echo "[editor] workspace: $ROOT"
echo "[editor] node: $(node --version)"
echo "[editor] npm: $(npm --version)"

node -e 'const m=Number(process.versions.node.split(".")[0]); if (m < 22) { console.error("Node.js 22+ is required"); process.exit(1); }'

npm ci
npm run setup
npm run check:skills

echo "[editor] checking runtime tools"
command -v ffmpeg >/dev/null || { echo "ffmpeg is required" >&2; exit 1; }
command -v ffprobe >/dev/null || { echo "ffprobe is required" >&2; exit 1; }

# HyperFrames doctor is intentionally last so the environment reports any
# browser/runtime issue after dependencies and skills have been installed.
npx hyperframes doctor

echo "[editor] Codex environment ready"
