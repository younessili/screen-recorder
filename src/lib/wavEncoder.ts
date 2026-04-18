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

export function encodeMonoWav16BitPCM(samples: Float32Array, sampleRate: number): ArrayBuffer {
	const dataSize = samples.length * BYTES_PER_SAMPLE;
	const buffer = new ArrayBuffer(HEADER_SIZE_BYTES + dataSize);
	const view = new DataView(buffer);

	writeAscii(view, 0, "RIFF");
	view.setUint32(4, buffer.byteLength - 8, true);
	writeAscii(view, 8, "WAVE");

	writeAscii(view, 12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, PCM_FORMAT_TAG, true);
	view.setUint16(22, MONO_CHANNELS, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * MONO_CHANNELS * BYTES_PER_SAMPLE, true);
	view.setUint16(32, MONO_CHANNELS * BYTES_PER_SAMPLE, true);
	view.setUint16(34, BITS_PER_SAMPLE, true);

	writeAscii(view, 36, "data");
	view.setUint32(40, dataSize, true);

	for (let i = 0; i < samples.length; i++) {
		const clamped = Math.max(-1, Math.min(1, samples[i]));
		view.setInt16(HEADER_SIZE_BYTES + i * BYTES_PER_SAMPLE, clamped * INT16_PEAK, true);
	}

	return buffer;
}
