# Phase 1: Mic Stem Auto-Export — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every recording with mic enabled writes a separate mono WAV file (`<recording-name>.mic.wav`) alongside the screen video, so it can be imported standalone into Premiere.

**Why a separate stem (not just extract from the webm):** when system audio is also enabled, `useScreenRecorder.ts:478-488` mixes the mic into a single audio track via `createMediaStreamDestination()` and applies a 1.4× mic gain boost (`MIC_GAIN_BOOST`). The `.webm` therefore contains a single mixed track, not a separable mic stem. Post-hoc ffmpeg extraction would produce mic-plus-system-audio-with-gain, not a clean voice track. This feature taps the mic *before* the mix.

**Architecture:** When a recording starts, in addition to the existing `MediaRecorder` on the mixed/screen stream, tap the raw mic `MediaStream` with a Web Audio `ScriptProcessorNode` to capture Float32 PCM samples (mono, channel 0). On stop, encode the PCM samples to a 16-bit PCM WAV in-renderer, ship the ArrayBuffer over IPC alongside the screen video, write to disk in the main process, and persist the path in the session manifest.

**Tech Stack:** Electron (main + preload + renderer), React + TypeScript, Web Audio API (`AudioContext`, `ScriptProcessorNode`), Vitest (jsdom), Biome (lint).

**Spec reference:** `SPEC.md` Phase 1 — Mic stem auto-export.

**Why ScriptProcessorNode (deprecated) over AudioWorklet:** Simpler — single file, no Vite worklet build path to verify, no worklet module load. Our processor only pushes Float32 chunks into an array (no synchronous compute), so the deprecation's main concern (main-thread blocking) doesn't apply. Swap to AudioWorklet later only if we observe drops.

**Out of scope:** System audio stem, mic-on-by-default UI change, transcoding to other formats. Mic stem is auto-saved only when the user has already enabled the microphone (current behavior).

---

## File Structure

**Create:**
- `src/lib/wavEncoder.ts` — pure function: `encodeMonoWav16BitPCM(samples: Float32Array, sampleRate: number): ArrayBuffer`
- `src/lib/wavEncoder.test.ts` — unit tests for header layout + sample encoding
- `src/lib/micStemRecorder.ts` — class wrapping `AudioContext` + `ScriptProcessorNode`; exposes `start(stream)` + `stop(): { samples, sampleRate }`
- `src/lib/recordingSession.test.ts` — unit tests for `normalizeRecordingSession` (covers existing fields + new `micAudioPath`)

**Modify:**
- `src/lib/recordingSession.ts` — add `micAudioPath?: string` to `ProjectMedia` + `RecordingSession`; add `RecordedAudioAssetInput` + `micAudio?: RecordedAudioAssetInput` field on `StoreRecordedSessionInput`; preserve `micAudioPath` in `normalizeProjectMedia` + `normalizeRecordingSession`.
- `src/hooks/useScreenRecorder.ts` — instantiate `MicStemRecorder` when mic enabled; finalize on stop; encode WAV; include in `storeRecordedSession` payload.
- `electron/ipc/handlers.ts` — write `payload.micAudio.audioData` to disk; include `micAudioPath` in saved session + manifest.
- `SPEC.md` — flip Phase 1 status note when complete (no tracker in this repo, just edit the Execution order line).

---

## Task 1: WAV encoder (pure logic, TDD)

**Files:**
- Create: `src/lib/wavEncoder.ts`
- Test: `src/lib/wavEncoder.test.ts`

WAV format primer (16-bit PCM mono):
- 44-byte header: `"RIFF" | size32 | "WAVE" | "fmt " | 16 (subchunk size) | 1 (PCM format) | 1 (mono) | sampleRate | byteRate | 2 (block align) | 16 (bits per sample) | "data" | dataSize`
- Then PCM: each Float32 sample (range −1..1) clamped and converted to Int16 little-endian: `Math.max(-1, Math.min(1, s)) * 0x7FFF`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/wavEncoder.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { encodeMonoWav16BitPCM } from "./wavEncoder";

function readUint32LE(view: DataView, offset: number): number {
	return view.getUint32(offset, true);
}

function readUint16LE(view: DataView, offset: number): number {
	return view.getUint16(offset, true);
}

function readAscii(buffer: ArrayBuffer, offset: number, length: number): string {
	return String.fromCharCode(...new Uint8Array(buffer, offset, length));
}

describe("encodeMonoWav16BitPCM", () => {
	it("produces a 44-byte header followed by PCM data", () => {
		const samples = new Float32Array([0, 0, 0, 0]);
		const buffer = encodeMonoWav16BitPCM(samples, 48000);
		expect(buffer.byteLength).toBe(44 + samples.length * 2);
	});

	it("writes the RIFF/WAVE/fmt /data chunk identifiers", () => {
		const buffer = encodeMonoWav16BitPCM(new Float32Array(0), 48000);
		expect(readAscii(buffer, 0, 4)).toBe("RIFF");
		expect(readAscii(buffer, 8, 4)).toBe("WAVE");
		expect(readAscii(buffer, 12, 4)).toBe("fmt ");
		expect(readAscii(buffer, 36, 4)).toBe("data");
	});

	it("encodes the requested sample rate and derived byte rate", () => {
		const buffer = encodeMonoWav16BitPCM(new Float32Array(0), 44100);
		const view = new DataView(buffer);
		expect(readUint32LE(view, 24)).toBe(44100); // sample rate
		expect(readUint32LE(view, 28)).toBe(44100 * 2); // byte rate (mono * 2 bytes)
		expect(readUint16LE(view, 32)).toBe(2); // block align (mono * 2)
		expect(readUint16LE(view, 34)).toBe(16); // bits per sample
		expect(readUint16LE(view, 22)).toBe(1); // mono channel count
		expect(readUint16LE(view, 20)).toBe(1); // PCM format tag
	});

	it("converts a peak +1.0 sample to int16 0x7FFF", () => {
		const buffer = encodeMonoWav16BitPCM(new Float32Array([1]), 48000);
		const view = new DataView(buffer);
		expect(view.getInt16(44, true)).toBe(0x7fff);
	});

	it("clamps samples above 1.0 to 0x7FFF", () => {
		const buffer = encodeMonoWav16BitPCM(new Float32Array([2]), 48000);
		const view = new DataView(buffer);
		expect(view.getInt16(44, true)).toBe(0x7fff);
	});

	it("clamps samples below -1.0 to -0x7FFF", () => {
		const buffer = encodeMonoWav16BitPCM(new Float32Array([-2]), 48000);
		const view = new DataView(buffer);
		expect(view.getInt16(44, true)).toBe(-0x7fff);
	});

	it("writes the data chunk size in bytes", () => {
		const samples = new Float32Array([0.5, -0.5, 0.25]);
		const buffer = encodeMonoWav16BitPCM(samples, 48000);
		const view = new DataView(buffer);
		expect(readUint32LE(view, 40)).toBe(samples.length * 2);
	});

	it("writes the RIFF chunk size as totalLength - 8", () => {
		const samples = new Float32Array([0, 0, 0]);
		const buffer = encodeMonoWav16BitPCM(samples, 48000);
		const view = new DataView(buffer);
		expect(readUint32LE(view, 4)).toBe(buffer.byteLength - 8);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/wavEncoder.test.ts`
Expected: FAIL with module-not-found / `encodeMonoWav16BitPCM is not a function`.

- [ ] **Step 3: Implement the encoder**

Create `src/lib/wavEncoder.ts`:

```typescript
const HEADER_SIZE_BYTES = 44;
const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;
const MONO_CHANNELS = 1;
const PCM_FORMAT_TAG = 1;
const INT16_PEAK = 0x7fff;

function writeAscii(view: DataView, offset: number, value: string): void {
	for (let i = 0; i < value.length; i++) {
		view.setUint8(offset + i, value.charCodeAt(i));
	}
}

export function encodeMonoWav16BitPCM(
	samples: Float32Array,
	sampleRate: number,
): ArrayBuffer {
	const dataSize = samples.length * BYTES_PER_SAMPLE;
	const buffer = new ArrayBuffer(HEADER_SIZE_BYTES + dataSize);
	const view = new DataView(buffer);

	writeAscii(view, 0, "RIFF");
	view.setUint32(4, buffer.byteLength - 8, true);
	writeAscii(view, 8, "WAVE");

	writeAscii(view, 12, "fmt ");
	view.setUint32(16, 16, true); // fmt chunk size
	view.setUint16(20, PCM_FORMAT_TAG, true);
	view.setUint16(22, MONO_CHANNELS, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * MONO_CHANNELS * BYTES_PER_SAMPLE, true); // byte rate
	view.setUint16(32, MONO_CHANNELS * BYTES_PER_SAMPLE, true); // block align
	view.setUint16(34, BITS_PER_SAMPLE, true);

	writeAscii(view, 36, "data");
	view.setUint32(40, dataSize, true);

	for (let i = 0; i < samples.length; i++) {
		const clamped = Math.max(-1, Math.min(1, samples[i]));
		view.setInt16(HEADER_SIZE_BYTES + i * BYTES_PER_SAMPLE, clamped * INT16_PEAK, true);
	}

	return buffer;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/wavEncoder.test.ts`
Expected: PASS — 8/8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/wavEncoder.ts src/lib/wavEncoder.test.ts
git commit -m "feat(audio): add 16-bit PCM mono WAV encoder"
```

---

## Task 2: Update `RecordingSession` types + normalizers (TDD)

**Files:**
- Modify: `src/lib/recordingSession.ts`
- Test: `src/lib/recordingSession.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/recordingSession.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
	normalizeProjectMedia,
	normalizeRecordingSession,
} from "./recordingSession";

describe("normalizeProjectMedia", () => {
	it("returns null for non-object input", () => {
		expect(normalizeProjectMedia(null)).toBeNull();
		expect(normalizeProjectMedia("path/to/video.webm")).toBeNull();
	});

	it("requires a screenVideoPath", () => {
		expect(normalizeProjectMedia({})).toBeNull();
		expect(normalizeProjectMedia({ screenVideoPath: "  " })).toBeNull();
	});

	it("preserves screenVideoPath only when other fields absent", () => {
		const result = normalizeProjectMedia({ screenVideoPath: "/tmp/a.webm" });
		expect(result).toEqual({ screenVideoPath: "/tmp/a.webm" });
	});

	it("preserves webcamVideoPath when present", () => {
		const result = normalizeProjectMedia({
			screenVideoPath: "/tmp/a.webm",
			webcamVideoPath: "/tmp/a-webcam.webm",
		});
		expect(result).toEqual({
			screenVideoPath: "/tmp/a.webm",
			webcamVideoPath: "/tmp/a-webcam.webm",
		});
	});

	it("preserves micAudioPath when present", () => {
		const result = normalizeProjectMedia({
			screenVideoPath: "/tmp/a.webm",
			micAudioPath: "/tmp/a.mic.wav",
		});
		expect(result).toEqual({
			screenVideoPath: "/tmp/a.webm",
			micAudioPath: "/tmp/a.mic.wav",
		});
	});

	it("preserves all three media paths together", () => {
		const result = normalizeProjectMedia({
			screenVideoPath: "/tmp/a.webm",
			webcamVideoPath: "/tmp/a-webcam.webm",
			micAudioPath: "/tmp/a.mic.wav",
		});
		expect(result).toEqual({
			screenVideoPath: "/tmp/a.webm",
			webcamVideoPath: "/tmp/a-webcam.webm",
			micAudioPath: "/tmp/a.mic.wav",
		});
	});

	it("trims whitespace and discards empty optional paths", () => {
		const result = normalizeProjectMedia({
			screenVideoPath: "  /tmp/a.webm  ",
			webcamVideoPath: "   ",
			micAudioPath: "",
		});
		expect(result).toEqual({ screenVideoPath: "/tmp/a.webm" });
	});
});

describe("normalizeRecordingSession", () => {
	it("returns null when media is missing", () => {
		expect(normalizeRecordingSession({})).toBeNull();
	});

	it("preserves createdAt when finite number", () => {
		const result = normalizeRecordingSession({
			screenVideoPath: "/tmp/a.webm",
			createdAt: 1700000000000,
		});
		expect(result?.createdAt).toBe(1700000000000);
	});

	it("falls back to Date.now() for invalid createdAt", () => {
		const before = Date.now();
		const result = normalizeRecordingSession({
			screenVideoPath: "/tmp/a.webm",
			createdAt: Number.NaN,
		});
		const after = Date.now();
		expect(result?.createdAt).toBeGreaterThanOrEqual(before);
		expect(result?.createdAt).toBeLessThanOrEqual(after);
	});

	it("preserves micAudioPath end-to-end", () => {
		const result = normalizeRecordingSession({
			screenVideoPath: "/tmp/a.webm",
			micAudioPath: "/tmp/a.mic.wav",
			createdAt: 1700000000000,
		});
		expect(result).toEqual({
			screenVideoPath: "/tmp/a.webm",
			micAudioPath: "/tmp/a.mic.wav",
			createdAt: 1700000000000,
		});
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/recordingSession.test.ts`
Expected: FAIL — the `micAudioPath` cases will fail (and the other `normalizeProjectMedia` tests pass since the existing code already covers them).

- [ ] **Step 3: Update the types and normalizers**

Replace `src/lib/recordingSession.ts` with:

```typescript
export interface ProjectMedia {
	screenVideoPath: string;
	webcamVideoPath?: string;
	micAudioPath?: string;
}

export interface RecordingSession extends ProjectMedia {
	createdAt: number;
}

export interface RecordedVideoAssetInput {
	fileName: string;
	videoData: ArrayBuffer;
}

export interface RecordedAudioAssetInput {
	fileName: string;
	audioData: ArrayBuffer;
}

export interface StoreRecordedSessionInput {
	screen: RecordedVideoAssetInput;
	webcam?: RecordedVideoAssetInput;
	micAudio?: RecordedAudioAssetInput;
	createdAt?: number;
}

function normalizePath(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

export function normalizeProjectMedia(candidate: unknown): ProjectMedia | null {
	if (!candidate || typeof candidate !== "object") {
		return null;
	}

	const raw = candidate as Partial<ProjectMedia>;
	const screenVideoPath = normalizePath(raw.screenVideoPath);

	if (!screenVideoPath) {
		return null;
	}

	const webcamVideoPath = normalizePath(raw.webcamVideoPath);
	const micAudioPath = normalizePath(raw.micAudioPath);

	const result: ProjectMedia = { screenVideoPath };
	if (webcamVideoPath) result.webcamVideoPath = webcamVideoPath;
	if (micAudioPath) result.micAudioPath = micAudioPath;
	return result;
}

export function normalizeRecordingSession(candidate: unknown): RecordingSession | null {
	if (!candidate || typeof candidate !== "object") {
		return null;
	}

	const raw = candidate as Partial<RecordingSession>;
	const media = normalizeProjectMedia(raw);
	if (!media) {
		return null;
	}

	return {
		...media,
		createdAt:
			typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt)
				? raw.createdAt
				: Date.now(),
	};
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/recordingSession.test.ts`
Expected: PASS — all tests green.

- [ ] **Step 5: Run full test suite to catch regressions**

Run: `npx vitest run`
Expected: PASS for everything (other tests don't touch these symbols' shape beyond what's covered).

- [ ] **Step 6: Commit**

```bash
git add src/lib/recordingSession.ts src/lib/recordingSession.test.ts
git commit -m "feat(session): add micAudioPath to RecordingSession + StoreRecordedSessionInput"
```

---

## Task 3: Mic stem recorder

**Files:**
- Create: `src/lib/micStemRecorder.ts`

This class is light glue around Web Audio APIs. It is exercised through manual recording smoke-tests rather than unit tests (jsdom does not implement `AudioContext`/`ScriptProcessorNode`).

- [ ] **Step 1: Implement the recorder**

Create `src/lib/micStemRecorder.ts`:

```typescript
const SCRIPT_PROCESSOR_BUFFER_SIZE = 4096;
const MONO_CHANNEL_COUNT = 1;
const CAPTURED_CHANNEL_INDEX = 0;
// Hard cap to protect renderer memory. At 48kHz mono Float32 the raw chunks
// grow ~11.5 MB/min; the WAV merge + Int16 encode roughly triples peak usage
// during finalize. 90 minutes ~= 1 GB raw + 500 MB WAV = manageable. Past
// that the renderer risks OOM and taking the screen recording down with it.
const MAX_CAPTURE_MINUTES = 90;

export interface MicStemCapture {
	samples: Float32Array;
	sampleRate: number;
}

/**
 * Captures raw Float32 PCM samples from a microphone MediaStream into an
 * in-memory buffer. Mono only (channel 0). Used to produce a separate WAV
 * stem for editing in Premiere alongside the screen recording.
 *
 * Memory ceiling: stops capturing (gracefully — does not throw) after
 * MAX_CAPTURE_MINUTES of audio. The screen recording is unaffected; the
 * resulting .mic.wav is simply truncated. A warning is logged so the user
 * knows to use ffmpeg-extract from the webm for the remainder if needed.
 */
export class MicStemRecorder {
	private context: AudioContext | null = null;
	private source: MediaStreamAudioSourceNode | null = null;
	private processor: ScriptProcessorNode | null = null;
	private chunks: Float32Array[] = [];
	private totalSampleCount = 0;
	private sampleRate = 0;
	private maxSampleCount = 0;
	private capHit = false;

	pause(): void {
		// Suspend the AudioContext so onaudioprocess stops firing while the
		// MediaRecorder is paused. Without this the WAV duration drifts past
		// the screen video duration and Premiere sync breaks.
		this.context?.suspend().catch(() => undefined);
	}

	resume(): void {
		this.context?.resume().catch(() => undefined);
	}

	start(stream: MediaStream): void {
		if (this.context) {
			throw new Error("MicStemRecorder already started");
		}

		const context = new AudioContext();
		const source = context.createMediaStreamSource(stream);
		const processor = context.createScriptProcessor(
			SCRIPT_PROCESSOR_BUFFER_SIZE,
			MONO_CHANNEL_COUNT,
			MONO_CHANNEL_COUNT,
		);

		processor.onaudioprocess = (event: AudioProcessingEvent) => {
			if (this.capHit) {
				return;
			}
			const channel = event.inputBuffer.getChannelData(CAPTURED_CHANNEL_INDEX);
			if (this.totalSampleCount + channel.length > this.maxSampleCount) {
				this.capHit = true;
				console.warn(
					`MicStemRecorder: hit ${MAX_CAPTURE_MINUTES}-minute cap; mic stem will be truncated. Screen recording continues.`,
				);
				return;
			}
			// getChannelData returns a view into the audio thread's buffer that
			// gets reused; copy before storing.
			this.chunks.push(new Float32Array(channel));
			this.totalSampleCount += channel.length;
		};

		source.connect(processor);
		// ScriptProcessorNode only fires onaudioprocess when connected to a
		// destination. We connect to the context destination (silence — gain 0
		// is unnecessary because we feed the processor input from the mic, not
		// the destination, and the processor's output buffer is left untouched).
		processor.connect(context.destination);

		this.context = context;
		this.source = source;
		this.processor = processor;
		this.sampleRate = context.sampleRate;
		this.maxSampleCount = MAX_CAPTURE_MINUTES * 60 * context.sampleRate;
		this.capHit = false;
	}

	async stop(): Promise<MicStemCapture> {
		if (!this.context || !this.processor || !this.source) {
			throw new Error("MicStemRecorder not started");
		}

		this.processor.onaudioprocess = null;
		try {
			this.source.disconnect();
		} catch {
			// already disconnected
		}
		try {
			this.processor.disconnect();
		} catch {
			// already disconnected
		}

		try {
			await this.context.close();
		} catch {
			// ignore close failures during teardown
		}

		const merged = new Float32Array(this.totalSampleCount);
		let offset = 0;
		for (const chunk of this.chunks) {
			merged.set(chunk, offset);
			offset += chunk.length;
		}

		const sampleRate = this.sampleRate;
		this.context = null;
		this.source = null;
		this.processor = null;
		this.chunks = [];
		this.totalSampleCount = 0;
		this.sampleRate = 0;
		this.maxSampleCount = 0;
		this.capHit = false;

		return { samples: merged, sampleRate };
	}
}
```

> **Note on the silent-output concern:** ScriptProcessorNode's output buffer defaults to silence when `onaudioprocess` doesn't write to it. Connecting `processor → context.destination` lets the node receive ticks, and the user hears nothing because we never set output samples. This is the standard idiom for capture-only ScriptProcessor use.

- [ ] **Step 2: Verify it typechecks**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/micStemRecorder.ts
git commit -m "feat(audio): add MicStemRecorder for raw PCM mic capture"
```

---

## Task 4: Wire mic stem into recording flow

**Files:**
- Modify: `src/hooks/useScreenRecorder.ts`

The mic stream is already captured separately at lines 416–438 into `microphoneStream.current`. We tap it with a `MicStemRecorder` ref, parallel to `screenRecorder`/`webcamRecorder`.

- [ ] **Step 1: Add imports + constant + ref**

In `src/hooks/useScreenRecorder.ts`, near the top imports:

```typescript
import { MicStemRecorder } from "@/lib/micStemRecorder";
import { encodeMonoWav16BitPCM } from "@/lib/wavEncoder";
```

Below the existing `WEBCAM_FILE_SUFFIX` constant (around line 32), add:

```typescript
const MIC_STEM_FILE_SUFFIX = ".mic";
const MIC_STEM_FILE_EXTENSION = ".wav";
```

Inside `useScreenRecorder()`, alongside `screenRecorder` / `webcamRecorder` refs (around line 99–100), add:

```typescript
const micStemRecorder = useRef<MicStemRecorder | null>(null);
```

- [ ] **Step 2: Start the mic stem recorder when mic stream is available**

In `startRecording`, after the `microphoneStream.current = await navigator.mediaDevices.getUserMedia(...)` block (around line 438), and before the webcam block, append:

```typescript
				if (microphoneStream.current) {
					try {
						const micRecorder = new MicStemRecorder();
						micRecorder.start(microphoneStream.current);
						micStemRecorder.current = micRecorder;
					} catch (micStemError) {
						console.warn("Failed to start mic stem capture:", micStemError);
						micStemRecorder.current = null;
					}
				}
```

- [ ] **Step 3a: Snapshot + null-out the mic recorder ref BEFORE the async IIFE**

In `finalizeRecording` (around lines 209–214), find the existing block:

```typescript
		if (screenRecorder.current === activeScreenRecorder) {
			screenRecorder.current = null;
		}
		if (activeWebcamRecorder && webcamRecorder.current === activeWebcamRecorder) {
			webcamRecorder.current = null;
		}
```

Add a third sibling block immediately after it (still synchronous, still inside `finalizeRecording`, **before** the `teardownMedia()` call and **before** the `void (async () => { ... })()` IIFE):

```typescript
		const activeMicStemRecorder = micStemRecorder.current;
		if (activeMicStemRecorder && micStemRecorder.current === activeMicStemRecorder) {
			micStemRecorder.current = null;
		}
```

The `activeMicStemRecorder` const is captured here (sync) so the async IIFE that follows can close over it without racing a `restartRecording` that swaps in a new mic recorder.

- [ ] **Step 3b: Replace the async IIFE body to ship the mic stem**

Now replace the existing `void (async () => { ... })()` block (the async IIFE, originally lines ~224–281) in its entirety with the version below. Do not touch the synchronous code above it (Step 3a already handled that).

```typescript
		void (async () => {
			try {
				const screenBlob = await activeScreenRecorder.recordedBlobPromise;
				if (discardRecordingId.current === activeRecordingId) {
					if (activeMicStemRecorder) {
						await activeMicStemRecorder.stop().catch(() => undefined);
					}
					return;
				}
				if (screenBlob.size === 0) {
					if (activeMicStemRecorder) {
						await activeMicStemRecorder.stop().catch(() => undefined);
					}
					return;
				}

				const fixedScreenBlob = await fixWebmDuration(screenBlob, duration);
				let fixedWebcamBlob: Blob | null = null;
				if (activeWebcamRecorder) {
					const webcamBlob = await activeWebcamRecorder.recordedBlobPromise.catch(() => null);
					if (webcamBlob && webcamBlob.size > 0) {
						fixedWebcamBlob = await fixWebmDuration(webcamBlob, duration);
					}
				}

				let micAudioBuffer: ArrayBuffer | null = null;
				if (activeMicStemRecorder) {
					try {
						const capture = await activeMicStemRecorder.stop();
						if (capture.samples.length > 0) {
							micAudioBuffer = encodeMonoWav16BitPCM(capture.samples, capture.sampleRate);
						}
					} catch (micStemError) {
						console.warn("Failed to finalize mic stem capture:", micStemError);
					}
				}

				const screenFileName = `${RECORDING_FILE_PREFIX}${activeRecordingId}${VIDEO_FILE_EXTENSION}`;
				const webcamFileName = `${RECORDING_FILE_PREFIX}${activeRecordingId}${WEBCAM_FILE_SUFFIX}${VIDEO_FILE_EXTENSION}`;
				const micFileName = `${RECORDING_FILE_PREFIX}${activeRecordingId}${MIC_STEM_FILE_SUFFIX}${MIC_STEM_FILE_EXTENSION}`;

				const result = await window.electronAPI.storeRecordedSession({
					screen: {
						videoData: await fixedScreenBlob.arrayBuffer(),
						fileName: screenFileName,
					},
					webcam: fixedWebcamBlob
						? {
								videoData: await fixedWebcamBlob.arrayBuffer(),
								fileName: webcamFileName,
							}
						: undefined,
					micAudio: micAudioBuffer
						? {
								audioData: micAudioBuffer,
								fileName: micFileName,
							}
						: undefined,
					createdAt: activeRecordingId,
				});

				if (!result.success) {
					console.error("Failed to store recording session:", result.message);
					return;
				}

				if (result.session) {
					await window.electronAPI.setCurrentRecordingSession(result.session);
				} else if (result.path) {
					await window.electronAPI.setCurrentVideoPath(result.path);
				}

				await window.electronAPI.switchToEditor();
			} catch (error) {
				console.error("Error saving recording:", error);
			} finally {
				if (finalizingRecordingId.current === activeRecordingId) {
					finalizingRecordingId.current = null;
				}
				if (discardRecordingId.current === activeRecordingId) {
					discardRecordingId.current = null;
				}
			}
		})();
```

- [ ] **Step 4: Wire pause/resume into the mic stem**

In `togglePaused` (around lines 597–635 of `useScreenRecorder.ts`), the existing code pauses the screen MediaRecorder. The mic stem must follow the same pause/resume so the WAV duration matches the screen video duration (otherwise Premiere sync breaks after the first pause).

In the resume branch (the `if (activeScreenRecorder.state === "paused") { ... }` block), after `activeScreenRecorder.resume();` and the optional `activeWebcamRecorder?.resume();`, add:

```typescript
				micStemRecorder.current?.resume();
```

In the pause branch (the block that calls `activeScreenRecorder.pause();`), after `activeScreenRecorder.pause();` and the optional `activeWebcamRecorder?.pause();`, add:

```typescript
				micStemRecorder.current?.pause();
```

- [ ] **Step 5: Stop mic stem on cleanup paths (via shared helper)**

Below the `teardownMedia` `useCallback` (around line 171), define a shared helper so the cleanup logic doesn't drift across the two call sites:

```typescript
	const teardownMicStem = useCallback(() => {
		if (micStemRecorder.current) {
			micStemRecorder.current.stop().catch(() => undefined);
			micStemRecorder.current = null;
		}
	}, []);
```

In the `useEffect` cleanup (around lines 336–365), after the `webcamRecorder.current = null;` line, add:

```typescript
				teardownMicStem();
```

In the `startRecording` `catch` block (around lines 578–594), before `teardownMedia()`, add:

```typescript
				teardownMicStem();
```

(Note: the dependency array of the `useEffect` cleanup will need `teardownMicStem` added next to `teardownMedia`.)

- [ ] **Step 6: Typecheck + lint**

Run: `npx tsc --noEmit && npx biome check src/hooks/useScreenRecorder.ts`
Expected: no errors.

- [ ] **Step 7: Run full test suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/hooks/useScreenRecorder.ts
git commit -m "feat(recording): capture mic stem alongside screen recording"
```

---

## Task 5: Persist mic file in main process

**Files:**
- Modify: `electron/ipc/handlers.ts`

- [ ] **Step 1: Write the mic file in `storeRecordedSessionFiles`**

In `electron/ipc/handlers.ts`, locate `storeRecordedSessionFiles` (around line 257). Replace the section that currently builds `webcamVideoPath` and the `session` literal with:

```typescript
async function storeRecordedSessionFiles(payload: StoreRecordedSessionInput) {
	const createdAt =
		typeof payload.createdAt === "number" && Number.isFinite(payload.createdAt)
			? payload.createdAt
			: Date.now();
	const screenVideoPath = resolveRecordingOutputPath(payload.screen.fileName);
	await fs.writeFile(screenVideoPath, Buffer.from(payload.screen.videoData));

	let webcamVideoPath: string | undefined;
	if (payload.webcam) {
		webcamVideoPath = resolveRecordingOutputPath(payload.webcam.fileName);
		await fs.writeFile(webcamVideoPath, Buffer.from(payload.webcam.videoData));
	}

	let micAudioPath: string | undefined;
	if (payload.micAudio) {
		micAudioPath = resolveRecordingOutputPath(payload.micAudio.fileName);
		await fs.writeFile(micAudioPath, Buffer.from(payload.micAudio.audioData));
	}

	const session: RecordingSession = {
		screenVideoPath,
		createdAt,
		...(webcamVideoPath ? { webcamVideoPath } : {}),
		...(micAudioPath ? { micAudioPath } : {}),
	};
	setCurrentRecordingSessionState(session);
	currentProjectPath = null;

	const telemetryPath = `${screenVideoPath}.cursor.json`;
	if (pendingCursorSamples.length > 0) {
		await fs.writeFile(
			telemetryPath,
			JSON.stringify({ version: CURSOR_TELEMETRY_VERSION, samples: pendingCursorSamples }, null, 2),
			"utf-8",
		);
	}
	pendingCursorSamples = [];

	const sessionManifestPath = path.join(
		RECORDINGS_DIR,
		`${path.parse(payload.screen.fileName).name}${RECORDING_SESSION_SUFFIX}`,
	);
	await fs.writeFile(sessionManifestPath, JSON.stringify(session, null, 2), "utf-8");

	return {
		success: true,
		path: screenVideoPath,
		session,
		message: "Recording session stored successfully",
	};
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `npx tsc --noEmit && npx biome check electron/ipc/handlers.ts`
Expected: no errors.

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 4: Build to verify Electron bundle compiles**

Run: `npm run build-vite`
Expected: success — Vite produces the renderer bundle and Electron TS compiles.

- [ ] **Step 5: Commit**

```bash
git add electron/ipc/handlers.ts
git commit -m "feat(main): persist mic stem WAV alongside recording"
```

---

## Task 6: Update SPEC + manual smoke test

**Files:**
- Modify: `SPEC.md`

- [ ] **Step 1: Mark Phase 1 shipped in SPEC**

In `SPEC.md`, locate the `## Execution order` section. Change the Phase 1 line from:

```
1. Phase 1 (mic stem) — smallest, isolated
```

to:

```
1. Phase 1 (mic stem) — shipped 2026-04-18 (`_plans/2026-04-18-phase-1-mic-stem.md`)
```

- [ ] **Step 2: Commit the spec update**

```bash
git add SPEC.md
git commit -m "docs(spec): mark Phase 1 mic stem shipped"
```

- [ ] **Step 3: Manual smoke test instructions (run before opening PR)**

These steps require the user — listed here so the implementer can hand off.

1. Build the app: `npm run build-vite`
2. Launch dev: `npm run dev`
3. Enable microphone in the recording HUD
4. Record a ~30-second clip while speaking
5. Stop the recording (the editor should open as before)
6. In Finder, open `~/Library/Application Support/Openscreen/recordings/`
7. Confirm three files for the session:
   - `recording-<timestamp>.webm` (existing)
   - `recording-<timestamp>.session.json` (existing — should now contain `"micAudioPath"`)
   - `recording-<timestamp>.mic.wav` (**new**)
8. Open the `.mic.wav` in QuickTime or Audacity — confirm voice plays back cleanly, no dropouts, correct duration
9. **Pause/resume sync check (load-bearing for the feature):** record ~10 seconds, hit pause, wait ~5 seconds, resume, record another ~10 seconds, stop. Open the `.mic.wav` in Audacity — duration must be ≈20 seconds (matching the screen video), NOT ≈25 seconds. If it's ≈25, the pause/resume wiring is broken.
10. Drag the `.mic.wav` into a Premiere project — confirm import succeeds and audio is usable

Disable mic and re-record to confirm: only the existing files are produced (no `.mic.wav`, no `micAudioPath` in the manifest).

---

## Checkpoint

**Shipped state:**
- New WAV encoder (`src/lib/wavEncoder.ts`) with 8 unit tests
- New mic stem capture class (`src/lib/micStemRecorder.ts`)
- `RecordingSession` types + normalizers extended with `micAudioPath` (with unit tests)
- `useScreenRecorder` taps the mic stream with a parallel PCM capturer when mic is enabled
- `storeRecordedSessionFiles` writes `<recording>.mic.wav` next to the video and persists the path in the session manifest
- SPEC.md notes Phase 1 as shipped

**Verification commands:**
```bash
npx tsc --noEmit                 # types green
npx biome check .                # lint green
npx vitest run                   # all tests pass
npm run build-vite               # production renderer bundle builds
```

**Manual verification:** see Task 6 Step 3 — must record with mic on and confirm `.mic.wav` lands in `~/Library/Application Support/Openscreen/recordings/` and imports cleanly into Premiere.
