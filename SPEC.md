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

## Phase 2a — Skip re-render when no edits applied — ABANDONED 2026-04-19

**Status: not shipping.** The implementation (auto-fast-path via ffmpeg-static + `h264_videotoolbox` when no edits were applied) was built on branch `phase-2a-skip-rerender` and verified end-to-end, but abandoned during manual testing because the fast path produces a **raw passthrough** of the source WebM — no PixiJS compositing, so padding / wallpaper / shadow / border-radius / webcam overlay / cursor effects all disappear from the output. That is what the SPEC literally asked for ("raw assets to Premiere fast"), but in practice the user's common workflow is the styled export visible in the editor preview. The quality gap made the auto-trigger feel like a regression, not a speedup.

**Lessons for 2b:** the bottleneck worth fixing is the *styled* render path — not a separate "unstyled but fast" path. Phase 2b covers that directly: hardware-accelerate the existing PixiJS → WebCodecs pipeline so the same visual output ships 5–10× faster. No divergent output modes, no ffmpeg dependency.

**If the raw-to-Premiere workflow ever matters again,** the original implementation is recoverable from git history (branch was deleted after WIP commit `1f09a30`), and the manual escape hatch in Appendix A still works from the CLI without any code changes.

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

Owner: TBD. Next phase up — 2a was abandoned, so 2b is the primary path to faster exports. Gets its own branch + plan in a new session.

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
2. ~~Phase 2a (skip re-render via fast remux)~~ — abandoned 2026-04-19, see Phase 2a section for reasoning
3. Phase 2b (HW-accel edited export) — primary path to faster exports; next slice up
4. Phase 3 (brand defaults) — polish, low risk

---

## Appendix A — Manual ffmpeg escape hatch (Premiere handoff)

When you want the raw recording in Premiere format without the styled export, skip the app entirely and transcode the source WebM directly. This is the intentional replacement for abandoned Phase 2a — no code path, no UI, just a shell one-liner you run when you need it:

```bash
ffmpeg -i "<recording>.webm" \
  -c:v h264_videotoolbox -b:v 20M \
  -c:a aac -b:a 192k \
  output.mp4
```

Recordings live at: `~/Library/Application Support/Screen Recorder/recordings/`
Format: AV1 video + Opus audio in WebM container.
Premiere does not import AV1/Opus/WebM natively — transcode is required.
