# OpenScreen Personal Fork — Spec v1

Owner: Ali Younessi
Platform: macOS only
Upstream: https://github.com/siddharthvaddem/openscreen

## Goals
OpenScreen captures cleanly and hands raw assets to Premiere fast. The built-in editor stays for occasional on-brand exports, not the main path.

---

## Phase 1 — Mic stem auto-export

Every recording writes a separate mic-only audio file alongside the video.

- Format: WAV, original sample rate, mono
- Filename: `<recording-name>.mic.wav` next to the video
- Mic only (not system audio, not mixed)
- Always on, no toggle
- Touches: `src/hooks/useScreenRecorder.ts`, `electron/ipc/handlers.ts`, `src/lib/recordingSession.ts`

The mic MediaStream is already separate from screen capture — tee it to a second MediaRecorder writing audio-only.

---

## Phase 2a — Skip re-render when no edits applied

Recording already produces a usable file the editor opens directly without transcoding (verified: `handlers.ts:263`, `VideoEditor.tsx:350-370`, `handlers.ts:27`). Current export re-renders every frame even when the user made zero edits — that's the ~3× real-time slowdown for the no-edit case.

Caveat: recording is **AV1 + Opus in WebM**, which Premiere does not import natively. So the "no edits" path can't just copy the WebM — it needs to **remux/transcode to MP4 (H.264 + AAC)** for Premiere compatibility. Done with VideoToolbox, this is still 5-10× faster than the current frame-by-frame pipeline.

Fix:
- On export, detect "no edits applied" (project snapshot == baseline)
- If no edits: pipe source WebM through a fast VideoToolbox H.264 transcode + AAC audio → MP4 destination. Skip PixiJS pipeline entirely.
- If edits: existing render path runs as today (until 2b lands)
- Touches: `src/lib/exporter/videoExporter.ts`, `src/components/video-editor/ExportDialog.tsx`

Interim manual escape hatch (no code change): ffmpeg one-liner from CLI — see Appendix A.

---

## Phase 2b — Hardware-accelerated edited export

Important, non-trivial, gets its own plan before execution.

Current pipeline is software-encoded with a per-frame GPU→CPU readback (`videoExporter.ts:175-176`, `:245`). Even when the encoder *could* use hardware, the `getImageData()` readback stalls the GPU on every frame.

Fixes (rough scope, to be turned into a proper plan):
- Request `hardwareAcceleration: "prefer-hardware"` on `VideoEncoder` (Chromium → VideoToolbox H.264/HEVC on macOS)
- Render PixiJS to `OffscreenCanvas`, wrap with `new VideoFrame(canvas)` — keep frames on GPU through encode, skip the readback
- Validate the existing mediabunny muxer accepts the new frame format
- Tune codec/bitrate defaults for screen-recording content (high-detail static text, fast motion during scroll)
- Audit zoom/blur PixiJS filters — confirm they stay GPU-resident
- Benchmark vs. current path; target 5-10× speedup on M-series Macs

Risks:
- Some PixiJS filter chains may force CPU readback regardless
- WebCodecs hardware path varies by Chromium version (Electron 39 currently)
- Edge cases: HDR, color space handling, audio drift across long recordings

Owner: TBD. Do not start until 2a ships and a proper plan exists.

---

## Phase 3 — OperateU brand defaults

OpenScreen already supports custom backgrounds, padding, and corner radius. We change the defaults; no new UI.

| Setting | Value | Token |
|---|---|---|
| Background | Dark solid | `#131313` (`surface`) |
| Optional bg | Subtle gradient | `#FFE9BD → #FFC72C` |
| Padding | Generous | 6rem-equivalent inset |
| Corner radius | Sharp | `rounded-md` (0.375rem) max |
| Webcam frame | Sharp, no heavy shadow | `outline-variant` at 15% |

Save as a re-applicable "OperateU" preset. Source of truth: `01_OperateU/_context/design-system.md`.

---

## Out of scope

- "Record now" PIM skill — separate skill, not codebase
- Windows/Linux paths
- Editor feature work beyond the brand preset
- System audio stem
- Baking padding/background into the raw recording

---

## Execution order

1. Phase 1 (mic stem) — shipped 2026-04-18 (`_plans/2026-04-18-phase-1-mic-stem.md`)
2. Phase 2a (skip re-render via fast remux) — biggest daily-workflow impact, modest scope
3. Phase 3 (brand defaults) — polish, low risk
4. Phase 2b (HW-accel edited export) — important, separate plan, do last

---

## Appendix A — Interim ffmpeg escape hatch

Until Phase 2a ships, when an OpenScreen export is taking too long, kill it and transcode the raw recording directly:

```bash
ffmpeg -i "<recording>.webm" \
  -c:v h264_videotoolbox -b:v 20M \
  -c:a aac -b:a 192k \
  output.mp4
```

Recordings live at: `~/Library/Application Support/Openscreen/recordings/`
Format: AV1 video + Opus audio in WebM container.
Premiere does not import AV1/Opus/WebM natively — transcode is required.
