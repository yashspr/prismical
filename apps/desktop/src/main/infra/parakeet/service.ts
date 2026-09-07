import { Context, Data, type Effect } from 'effect';
import type { ParakeetDecodeOptions, ParakeetModelConfig, ParakeetTranscription } from './protocol';

/**
 * Why a ParakeetEngine call did not succeed — the same four reasons the
 * WhisperEngine reports, because the transcriber lane maps both onto the same
 * `RecordingLaneFailure { kind: 'engine' }` and must not care which engine ran:
 *  - `spawn-failed`      the worker never came up: fork threw, the sidecar is
 *                        missing, or sherpa-onnx-node failed to load at require
 *                        time (a platform package that did not install);
 *  - `worker-crashed`    the worker died with a call in flight;
 *  - `timeout`           a decode exceeded the budget — the worker is presumed
 *                        stuck in the synchronous C++ call and is killed;
 *  - `inference-failed`  the worker answered with an error (a model file that
 *                        is not a valid graph, a token table that does not
 *                        match) — deterministic, so NOT retryable.
 */
export class ParakeetEngineError extends Data.TaggedError('ParakeetEngineError')<{
  readonly reason: 'spawn-failed' | 'worker-crashed' | 'timeout' | 'inference-failed';
  readonly detail?: string;
}> {}

/**
 * The boot-scoped sherpa-onnx worker host: ONE lazily forked worker under the
 * Node sidecar, one call in flight at a time, the recognizer cached by its
 * four-path config and rebuilt on change, killed when the boot scope closes.
 *
 * Boot-scoped for the same reason WhisperEngine is: a loaded model is device
 * state worth keeping across a workspace rebuild (org switch / sign-out), and
 * rebuilding a 652 MB encoder graph per recording would be absurd.
 */
export interface ParakeetEngineApi {
  /**
   * Build the recognizer for `model` (forking the worker first if needed). A
   * no-op when that exact config is already live; a different one frees the old
   * recognizer and builds the new one. Remembered across a worker crash: the
   * next `transcribe` rebuilds it transparently.
   */
  readonly ensureModel: (model: ParakeetModelConfig) => Effect.Effect<void, ParakeetEngineError>;
  /**
   * Decode ONE buffer of 16 kHz mono Float32 audio (resample BEFORE calling —
   * the samples cross IPC as a JSON number array).
   */
  readonly transcribe: (
    audio16k: Float32Array,
    options?: ParakeetDecodeOptions
  ) => Effect.Effect<ParakeetTranscription, ParakeetEngineError>;
  /** Kill the worker now (the scope finalizer does the same); the next call re-forks. */
  readonly dispose: Effect.Effect<void>;
}

export class ParakeetEngine extends Context.Tag('desktop/ParakeetEngine')<
  ParakeetEngine,
  ParakeetEngineApi
>() {}
