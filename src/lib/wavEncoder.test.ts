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
		expect(readUint32LE(view, 24)).toBe(44100);
		expect(readUint32LE(view, 28)).toBe(44100 * 2);
		expect(readUint16LE(view, 32)).toBe(2);
		expect(readUint16LE(view, 34)).toBe(16);
		expect(readUint16LE(view, 22)).toBe(1);
		expect(readUint16LE(view, 20)).toBe(1);
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
