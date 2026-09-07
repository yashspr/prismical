/**
 * The Parakeet worker's IPC protocol — shared by the worker entry
 * (parakeet-worker-fork.ts, bundled for the Node sidecar) and the main-process
 * host (engine.ts).
 *
 * The request/response/log FRAMES are whisper's: identical shapes, and
 * `serializeArg` is load-bearing (JSON has no typed arrays, so 16 kHz Float32
 * audio crosses as a number array). Re-exported from there rather than copied
 * so the two ASR workers cannot drift into subtly different serialization —
 * that module is types + two pure functions with no runtime dependencies, which
 * is exactly what a worker bundle can afford to inline.
 *
 * Only the model config and the result are Parakeet's own. Both are plain data:
 * the worker bundle must load nothing but `sherpa-onnx-node`.
 */
export {
  isSerializedFloat32Array,
  isWorkerLogFrame,
  serializeArg,
  type SerializedFloat32Array,
  type WorkerLogFrame,
  type WorkerLogLevel,
  type WorkerRequest,
  type WorkerResponse,
} from '../whisper/protocol';

/**
 * The four files a sherpa-onnx offline transducer is built from. Absolute
 * paths, resolved by the ModelManager from an installed bundle — the worker
 * never looks anything up, so a half-installed model fails in main with a
 * typed error instead of inside the addon.
 */
export interface ParakeetModelConfig {
  readonly encoder: string;
  readonly decoder: string;
  readonly joiner: string;
  readonly tokens: string;
}

/**
 * Decode knobs the host sets. `numThreads` is the one that matters on a laptop:
 * the encoder is the whole cost and it parallelizes, but a recording lane also
 * shares the machine with capture and the editor, so the host caps it rather
 * than taking every core.
 */
export interface ParakeetDecodeOptions {
  readonly numThreads?: number;
  /** sherpa-onnx execution provider. 'cpu' everywhere; 'coreml' is opt-in and unproven here. */
  readonly provider?: 'cpu' | 'coreml';
  readonly [key: string]: unknown;
}

/**
 * A decode's answer. Parakeet TDT emits punctuated, cased text and no
 * per-segment confidence, so unlike whisper there is nothing to filter for
 * hallucinations and no `noSpeechProb` to threshold on — the lane's near-silence
 * guard upstream is what keeps empty audio out.
 */
export interface ParakeetTranscription {
  readonly text: string;
  /** Word/token timestamps in seconds when the model emits them; empty otherwise. */
  readonly timestamps: readonly number[];
}
