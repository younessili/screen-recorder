import { describe, expect, it } from "vitest";
import { normalizeProjectMedia, normalizeRecordingSession } from "./recordingSession";

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
