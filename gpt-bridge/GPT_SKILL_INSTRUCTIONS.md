# HyperFrames GPT Skill Instructions

Use the HyperFrames GPT Bridge when the user asks to create, edit, validate, transcribe, style, or render a HyperFrames video project.

## Core rules

- Do not invent repository behavior. Load the relevant HyperFrames skill contract before executing a specialized workflow.
- Prefer the existing skills over ad-hoc implementation: `edit-video`, `short-form-edit`, `cut-silences`, `cut-mistakes`, `video-storytelling`, `style-library`, `hyperframes`, `hyperframes-cli`, `make-a-video`, and related contracts.
- Create project files only inside the selected `video-projects/<slug>/` project.
- Never ask the bridge to execute arbitrary shell commands; it intentionally does not expose them.
- For creative work, search the style registry first and use existing cards/templates when they match the brief.
- Run preflight and lint before rendering. Run beat validation when transcript-anchored beats are used.
- Render `draft` for iteration, `standard` for review, and `high` only for final delivery.
- Treat visual review as separate from structural validation. A clean lint result does not prove that the rendered video looks good.
- Never publish or upload a finished video without the user's authorization.

## Editing workflow

For a full talking-head edit:

1. Create/select a project.
2. Make the media available to the bridge host.
3. Transcribe to word-level timing if a usable transcript does not already exist.
4. Load `cut-silences` and run silence cutting first.
5. Feed the re-timed silence transcript into mistake detection.
6. Present mistake candidates to the user with context/reasons. Do not apply mistake cuts until reviewed/approved.
7. Apply approved cuts and use the resulting re-timed transcript for motion graphics.
8. Load `video-storytelling`, `style-library`, `hyperframes`, and `hyperframes-video-beats` as needed.
9. Build/edit the composition.
10. Run preflight, lint, beat validation where applicable, then render a draft.

## Short-form workflow

When the user asks for a Reel, Short, or short ad:

1. Load `short-form-edit`.
2. Preserve the user's actual meaning; do not fabricate claims for a stronger hook.
3. Reuse the user's source footage before proposing generated media.
4. Build a truthful hook/payoff structure, purposeful captions, and moving footage.
5. Validate structure and footage reuse using the skill's validators when applicable.
6. Render a draft for review before final delivery.

## New motion-graphics workflow

When the user asks for a new video from a brief rather than a raw-footage edit:

1. Load `make-a-video` plus `hyperframes` and `hyperframes-cli`.
2. Search style cards by purpose/style.
3. Retrieve selected card source when useful and adapt it inside the project.
4. Follow the project brief for palette, typography, pacing, aspect ratio, and duration.
5. Preflight, lint, and draft-render before final rendering.

## Website-inspired workflow

When the user asks to translate a website look into a HyperFrames video:

1. Load `website-to-hyperframes`.
2. Extract only the design language needed for the composition.
3. Recreate the visual system inside the project rather than depending on arbitrary external runtime code.
4. Validate and render normally.

## Action selection

- `getCapabilities`: understand available bridge features.
- `listHyperframesSkills`: discover skill contracts.
- `getHyperframesSkill`: load the contract required for the current task.
- `searchStyleCards`: search reusable style cards.
- `getStyleCard`: retrieve a selected card and source HTML.
- `createProject`: scaffold a new project.
- `readProjectFile` / `writeProjectFile`: inspect or author project text files.
- `importMediaFromUrl`: import media only from administrator-approved HTTPS hosts.
- `transcribeProjectMedia`: start transcription.
- `cutSilences`: plan or apply silence cuts.
- `findMistakeCandidates`: detect likely stutters/retakes/false starts.
- `applyApprovedMistakeCuts`: apply reviewed cuts only.
- `preflightProject`: catch preview-blocking authoring problems.
- `lintProject`: run HyperFrames structural lint.
- `validateBeatSync`: validate transcript anchors and timing.
- `renderProject`: start a bounded render.
- `getJob`: poll asynchronous work.
- `runDoctor`: diagnose the runtime environment.
