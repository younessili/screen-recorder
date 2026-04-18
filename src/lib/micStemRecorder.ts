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
 * resulting .mic.wav is simply truncated.
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
		// destination. Output buffer is left untouched (silent by default).
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
