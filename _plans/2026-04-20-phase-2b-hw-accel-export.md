# Phase 2b: Hardware-accelerated edited export — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the styled PixiJS → WebCodecs export pipeline visually identical while eliminating the two CPU readbacks per frame that are stalling the GPU. Target: 5–10× wall-clock speedup on M-series Macs for long recordings.

**Why this matters:** the styled render path is what users actually ship (see SPEC Phase 2a abandonment note — the unstyled fast path had the wrong output). The encoder already runs on VideoToolbox (`hardwareAcceleration: "prefer-hardware"` is already passed and already preferred first on macOS — `videoExporter.ts:444`, `:530`). The bottleneck is not the encoder; it's two sequential `readPixels`/`getImageData` calls that drain the GPU to CPU on every frame.

**Scope correction vs. SPEC bullets:** the SPEC says "Request `hardwareAcceleration: prefer-hardware`" as the first fix, but that is already wired. The real fix is removing the two readbacks. Update the SPEC's Phase 2b section in Task 5 to match what we actually shipped.

**Tech stack:** Electron 39 (Chromium ~130+, VideoToolbox H.264/HEVC), PixiJS 8 (WebGL), WebCodecs `VideoFrame` + `VideoEncoder`, mediabunny muxer.

**Project constraint:** macOS-only (SPEC header). The existing `readPixels` / `getImageData` paths were defensive workarounds for Linux (`EGL/Ozone` shared-image failures, noted in comments at `videoExporter.ts:241-243` and `frameRenderer.ts:690-693`). On Chromium/macOS the GPU shared-image path is reliable, so both readbacks can be dropped.

---

## The two readbacks we are eliminating

**Readback A — `FrameRenderer.readbackVideoCanvas()` (`src/lib/exporter/frameRenderer.ts:694-724`).** Every frame: `gl.readPixels()` from Pixi's WebGL canvas into a `Uint8Array`, manual vertical-flip loop, then `putImageData` into an auxiliary 2D `rasterCanvas`. The `rasterCanvas` is the source that `compositeWithShadows` then `drawImage`s onto `compositeCanvas`. Purpose: guarantee a 2D-safe copy of the Pixi output for Linux. Cost on macOS: full frame-buffer CPU copy + vertical-flip + putImageData per frame — entirely wasted.

**Readback B — `canvasCtx.getImageData` in `VideoExporter` (`src/lib/exporter/videoExporter.ts:244-258`).** After compositing, `getImageData(0, 0, w, h)` drains `compositeCanvas` to an `ImageData` buffer, and a `VideoFrame` is built from the raw RGBA ArrayBuffer. Purpose: same Linux defense. Cost on macOS: second full frame-buffer CPU copy per frame.

**Post-change data flow:** Pixi WebGL canvas → `drawImage(pixi.canvas, ...)` onto `compositeCanvas` (GPU-resident shared image on macOS) → `new VideoFrame(compositeCanvas, { timestamp, duration })` (canvas source — WebCodecs keeps it GPU-resident where possible) → encoder.

---

## File Structure

**Modify:**
- `src/lib/exporter/videoExporter.ts` — replace the `getImageData` + RGBA-buffer `VideoFrame` construction (lines 240–258) with `new VideoFrame(canvas, { timestamp, duration })`.
- `src/lib/exporter/frameRenderer.ts` — delete `readbackVideoCanvas` and the `rasterCanvas`/`rasterCtx` fields. Update `compositeWithShadows` to read directly from `this.app.canvas`. Update `destroy` to drop the removed fields.
- `SPEC.md` — update Phase 2b section to reflect what shipped (drop the stale "request prefer-hardware" bullet, note the readback elimination + benchmark).

**No new files.** No test files — the existing browser test (`src/lib/exporter/videoExporter.browser.test.ts`) already exercises the full pipeline end-to-end and serves as the regression harness.

---

## Task 1: Eliminate Readback B (encode direct from composite canvas)

**Files:**
- Modify: `src/lib/exporter/videoExporter.ts`

**Why first:** isolating this change lets us confirm the encoder accepts canvas-sourced `VideoFrame`s before we also touch `FrameRenderer`. If this step alone fails (unexpected — but possible if the codec path rejects the canvas's pixel format), we can diagnose without the compositing change confusing the picture.

- [ ] **Step 1: Replace the `getImageData` block with direct canvas construction**

In `src/lib/exporter/videoExporter.ts`, locate the block inside the `decodeAll` callback (currently lines 238–258):

```typescript
						const canvas = renderer.getCanvas();

						// Read raw pixels from the canvas instead of passing
						// the canvas directly to VideoFrame. On some Linux
						// systems the GPU shared-image path (EGL/Ozone) fails
						// silently, producing empty frames.
						const canvasCtx = canvas.getContext("2d")!;
						const imageData = canvasCtx.getImageData(0, 0, canvas.width, canvas.height);
						const exportFrame = new VideoFrame(imageData.data.buffer, {
							format: "RGBA",
							codedWidth: canvas.width,
							codedHeight: canvas.height,
							timestamp,
							duration: frameDuration,
							colorSpace: {
								primaries: "bt709",
								transfer: "iec61966-2-1",
								matrix: "rgb",
								fullRange: true,
							},
						});
```

Replace it with:

```typescript
						const canvas = renderer.getCanvas();

						// Construct VideoFrame directly from the composite canvas so the
						// encoder can use the GPU shared-image path. macOS-only — on Linux
						// (EGL/Ozone) this is unreliable, but the project ships macOS-only
						// per SPEC. Color space is inferred from the canvas; we no longer
						// need to pass it explicitly.
						const exportFrame = new VideoFrame(canvas, {
							timestamp,
							duration: frameDuration,
						});
```

- [ ] **Step 2: Typecheck + lint**

Run: `npx tsc --noEmit && npx biome check src/lib/exporter/videoExporter.ts`
Expected: no errors.

- [ ] **Step 3: Run the browser regression test**

Run: `npm run test:browser`
Expected: PASS — the existing end-to-end test (`videoExporter.browser.test.ts`) produces a valid MP4 blob with a `ftyp` box. If it fails with a codec/format complaint, the canvas-source VideoFrame path is not accepted by Chromium's WebCodecs for the current configuration; stop and diagnose (likely need `new VideoFrame(canvas, { alpha: "discard", ... })` or keep compositeCanvas as an `OffscreenCanvas` — see Deferred below).

- [ ] **Step 4: Commit**

```bash
git add src/lib/exporter/videoExporter.ts
git commit -m "perf(export): construct VideoFrame directly from composite canvas"
```

---

## Task 2: Eliminate Readback A (remove Pixi→raster readback)

**Files:**
- Modify: `src/lib/exporter/frameRenderer.ts`

On macOS, `compositeCtx.drawImage(pixiCanvas, ...)` uses Chromium's GPU shared-image path — no CPU copy. The `readbackVideoCanvas` method and `rasterCanvas`/`rasterCtx` plumbing exist only to force a CPU copy for Linux.

- [ ] **Step 1: Simplify `compositeWithShadows` to draw from Pixi's canvas directly**

In `src/lib/exporter/frameRenderer.ts`, in `compositeWithShadows` (currently line 726), find:

```typescript
		if (!this.compositeCanvas || !this.compositeCtx || !this.app) return;

		const videoCanvas = this.readbackVideoCanvas();
		const ctx = this.compositeCtx;
```

Replace with:

```typescript
		if (!this.compositeCanvas || !this.compositeCtx || !this.app) return;

		// Draw Pixi's WebGL canvas directly. On macOS Chromium this stays on the
		// GPU via the shared-image path — no readPixels copy. See SPEC header
		// (macOS-only) for why we don't keep the Linux fallback.
		const videoCanvas = this.app.canvas as HTMLCanvasElement;
		const ctx = this.compositeCtx;
```

- [ ] **Step 2: Delete `readbackVideoCanvas` and its raster-canvas fields**

In the same file:

a) Remove these two field declarations from the class (currently lines 117–118):

```typescript
	private rasterCanvas: HTMLCanvasElement | null = null;
	private rasterCtx: CanvasRenderingContext2D | null = null;
```

b) Remove the `rasterCanvas`/`rasterCtx` setup block in `initialize()` (currently lines 198–204):

```typescript
		this.rasterCanvas = document.createElement("canvas");
		this.rasterCanvas.width = this.config.width;
		this.rasterCanvas.height = this.config.height;
		this.rasterCtx = this.rasterCanvas.getContext("2d");
		if (!this.rasterCtx) {
			throw new Error("Failed to get 2D context for raster canvas");
		}
```

c) Remove the entire `readbackVideoCanvas` method and the Linux-explanation comment above it (currently lines 690–724, from `// On Linux/Wayland...` through the closing `}` of the method).

d) In `destroy()`, remove these two lines (currently lines 866–867):

```typescript
		this.rasterCanvas = null;
		this.rasterCtx = null;
```

- [ ] **Step 3: Typecheck + lint**

Run: `npx tsc --noEmit && npx biome check src/lib/exporter/frameRenderer.ts`
Expected: no errors. If the linter flags unused `WebGL2RenderingContext` / `WebGLRenderingContext` — confirm no other references remain and delete any stale imports.

- [ ] **Step 4: Run unit tests + browser test**

```bash
npx vitest run
npm run test:browser
```

Expected: PASS. The browser test validates the full styled export end-to-end.

- [ ] **Step 5: Commit**

```bash
git add src/lib/exporter/frameRenderer.ts
git commit -m "perf(export): drop Linux-era readPixels path from FrameRenderer"
```

---

## Task 3: Benchmark + visual QA

**Files:** none (manual).

This phase lives or dies on the benchmark, so capture numbers before declaring shipped. Also verify visual parity — the whole point of Phase 2b (vs. abandoned 2a) is that the output is *identical*, only faster.

- [ ] **Step 1: Pick a benchmark recording**

Choose a recording that exercises the common styled-export path: zoom regions, shadow on, wallpaper background, padding, and (if available) webcam overlay. Roughly 60–120 seconds at 60fps. Note the file path.

- [ ] **Step 2: Baseline against `main`**

```bash
git stash              # hide the current branch changes
git switch main
npm run build-vite     # ensure dist is current
npm run dev            # start Electron dev
```

Open the benchmark recording in the editor. Export at quality = `source`. Note wall-clock from "Exporting..." start to success. Repeat 3×, take the median. Kill dev server.

- [ ] **Step 3: Measure on the Phase 2b branch**

```bash
git switch phase-2b-hw-accel-export   # or whatever the branch is named
git stash pop                          # restore in-flight edits if needed
npm run build-vite
npm run dev
```

Same recording, same quality setting. Export 3×, take the median wall-clock. Target: ≥2× speedup to declare success (SPEC says 5–10× but that assumes the readbacks were the dominant cost; encoder-bound work caps the ceiling).

- [ ] **Step 4: Visual parity check**

Open both exported MP4s side-by-side in QuickTime. Spot-check at 5s, 30s, and the end of each clip. Confirm: identical padding, shadow intensity, wallpaper colors, zoom framing, webcam overlay position, border radius, annotations. Any visible drift is a bug — stop and investigate the compositing change in Task 2.

- [ ] **Step 5: Record the numbers**

Hold these for Task 4 (SPEC update) and the PR body. Format:

```
Benchmark: <recording name>, <duration>s, <width>x<height> export, quality=source
  main:         <Ns> median
  phase-2b:     <Ns> median  (<Nx> speedup)
  Visual parity: yes / notes
```

No commit here.

---

## Task 4: Update SPEC

**Files:**
- Modify: `SPEC.md`

- [ ] **Step 1: Rewrite Phase 2b section + flip Execution order**

In `SPEC.md`, replace the entire `## Phase 2b — Hardware-accelerated edited export` section (currently lines 36–55) with:

```markdown
## Phase 2b — Hardware-accelerated edited export — SHIPPED 2026-04-20

Eliminated two CPU readbacks that were stalling the GPU on every exported frame:

- **Readback A (removed):** `FrameRenderer.readbackVideoCanvas` — `gl.readPixels` + manual vertical flip + `putImageData` into an auxiliary raster canvas. Existed as a Linux/EGL workaround; dropped because this project is macOS-only.
- **Readback B (removed):** `canvasCtx.getImageData` in `VideoExporter` to build a `VideoFrame` from an RGBA buffer. Replaced with `new VideoFrame(canvas, { timestamp, duration })` so the encoder consumes the canvas directly via Chromium's GPU shared-image path.

The encoder was already configured with `hardwareAcceleration: "prefer-hardware"` (VideoToolbox H.264/HEVC on macOS) — that bullet in the original scope was stale.

Benchmark (fill in after running Task 3):
- Recording: `<name>`, `<duration>s`, `<width>x<height>` at 60fps, quality=source
- Before: `<N>s` median (3 runs)
- After: `<N>s` median (3 runs) — `<N>×` speedup
- Visual parity: confirmed identical (spot-checked at 5s / 30s / end)

Plan: `_plans/2026-04-20-phase-2b-hw-accel-export.md`
```

Also update the Execution order (currently line 89):

```
3. Phase 2b (HW-accel edited export) — primary path to faster exports; next slice up
```

to:

```
3. Phase 2b (HW-accel edited export) — shipped 2026-04-20 (`_plans/2026-04-20-phase-2b-hw-accel-export.md`)
```

- [ ] **Step 2: Commit**

```bash
git add SPEC.md
git commit -m "docs(spec): mark Phase 2b hw-accel export shipped"
```

---

## Task 5: Full verification before handoff

- [ ] **Step 1: Run full verification suite**

```bash
npx tsc --noEmit                 # types green
npx biome check .                # lint green
npx vitest run                   # unit tests green
npm run test:browser             # end-to-end export test green
npm run build-vite               # production renderer bundle builds
```

All must pass.

- [ ] **Step 2: Manual smoke test**

1. `npm run dev`
2. Open a real recording in the editor
3. Export at quality = `source` — confirm success, output plays in QuickTime
4. Export at quality = `good` (1080p) — confirm success
5. Export with shadow OFF, no webcam — confirm still works
6. Export with zoom regions + annotations — confirm visual parity with baseline

If any step fails, stop and diagnose — do not flag the phase shipped.

---

## Deferred / Out of scope

- **OffscreenCanvas migration.** SPEC mentions "Render PixiJS to OffscreenCanvas". HTMLCanvasElement works identically for `new VideoFrame(canvas)`, and moving Pixi to OffscreenCanvas only matters if we move rendering to a Worker — a much bigger refactor. Skip until/unless the main-thread is measurably blocked after Tasks 1–2.
- **Codec/bitrate tuning.** `VideoEditor.tsx:1407-1478` already tunes bitrate per resolution (10/20/30/50/80 Mbps) and codec is `avc1.640033` (H.264 High@5.1), which VideoToolbox supports natively. No change needed.
- **HEVC path.** VideoToolbox supports HEVC and could yield smaller files at the same quality, but changes codec string, muxer metadata, and Premiere compatibility assumptions. Separate phase.
- **PixiJS filter audit.** `BlurFilter` and `MotionBlurFilter` are standard Pixi shader filters — GPU-native, no forced readback. If post-Task-2 exports show visible blur artifacts, revisit.

---

## Checkpoint

**Shipped state:**
- `videoExporter.ts` constructs `VideoFrame` directly from the composite canvas — no more `getImageData` per frame
- `frameRenderer.ts` draws Pixi's WebGL canvas straight into the composite 2D canvas — no more `readPixels` / raster-canvas intermediate
- SPEC.md Phase 2b section rewritten with actual changes + benchmark numbers
- Visual parity confirmed vs. `main`

**Verification commands:**
```bash
npx tsc --noEmit                 # types green
npx biome check .                # lint green
npx vitest run                   # all unit tests pass
npm run test:browser             # end-to-end export regression green
npm run build-vite               # production bundle builds
```

**Manual verification:** see Task 5 Step 2 — must export a real recording with shadow + zoom + webcam and confirm the output plays in QuickTime with identical framing to `main`.
