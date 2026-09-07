// Worker process entry point for fork — runs under the bundled Node SIDECAR
// (never inside electron: the RunAsNode fuse is burned). Protocol in
// protocol.ts; the main-process host is engine.ts.
//
// Why a worker at all, when sherpa-onnx ships a prebuilt N-API binary and
// whisper needed one for ABI reasons: `recognizer.decode()` is a SYNCHRONOUS
// C++ call. Run in main it would block the event loop for the length of the
// decode — with capture, IPC and the editor all on that loop. Under the sidecar
// it also gets the plain-Node ABI the npm prebuild was built for, so nothing
// has to be rebuilt for electron.
//
// `sherpa-onnx-node` is required at module load, so a missing or incompatible
// binary kills the worker on spawn and the host reports 'spawn-failed' — the
// same contract the whisper worker keeps.
import {
  isSerializedFloat32Array,
  type ParakeetDecodeOptions,
  type ParakeetModelConfig,
  type ParakeetTranscription,
  type WorkerLogFrame,
  type WorkerLogLevel,
  type WorkerRequest,
  type WorkerResponse,
} from './protocol';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- the sidecar bundle is CJS and this must be a real runtime require (see vite.parakeet-worker.config.mts)
const sherpa = require('sherpa-onnx-node') as SherpaModule;

interface SherpaStream {
  acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void;
}
interface SherpaResult {
  text?: unknown;
  timestamps?: unknown;
}
interface SherpaRecognizer {
  createStream(): SherpaStream;
  decode(stream: SherpaStream): void;
  getResult(stream: SherpaStream): SherpaResult;
}
interface SherpaModule {
  OfflineRecognizer: new (config: unknown) => SherpaRecognizer;
}

function log(level: WorkerLogLevel, message: string, ...args: unknown[]): void {
  const frame: WorkerLogFrame = {
    type: 'log',
    level,
    message,
    args: args.map(a => {
      if (a instanceof Error) return a.message;
      if (typeof a === 'object') {
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      }
      return a;
    }),
  };
  process.send?.(frame);
}

/** The 16 kHz mono rate every ASR lane resamples to before crossing IPC. */
const SAMPLE_RATE = 16_000;
/** Parakeet's own default; the host overrides it. */
const DEFAULT_THREADS = 4;

let recognizer: SherpaRecognizer | null = null;
/** The config the live recognizer was built from — a change rebuilds it. */
let loadedKey: string | null = null;

const configKey = (model: ParakeetModelConfig, options: ParakeetDecodeOptions): string =>
  JSON.stringify([
    model.encoder,
    model.decoder,
    model.joiner,
    model.tokens,
    options.numThreads ?? DEFAULT_THREADS,
    options.provider ?? 'cpu',
  ]);

function ensureModel(model: ParakeetModelConfig, options: ParakeetDecodeOptions): void {
  const key = configKey(model, options);
  if (recognizer !== null && loadedKey === key) return;
  const started = Date.now();
  recognizer = new sherpa.OfflineRecognizer({
    modelConfig: {
      // Parakeet TDT is an offline TRANSDUCER: three graphs plus a token table.
      transducer: { encoder: model.encoder, decoder: model.decoder, joiner: model.joiner },
      tokens: model.tokens,
      // Without this sherpa-onnx guesses the architecture from the graphs and
      // gets a NeMo TDT wrong.
      modelType: 'nemo_transducer',
      numThreads: options.numThreads ?? DEFAULT_THREADS,
      provider: options.provider ?? 'cpu',
      debug: false,
    },
    decodingMethod: 'greedy_search',
  });
  loadedKey = key;
  log('info', 'parakeet model loaded', { ms: Date.now() - started });
}

function transcribe(
  audio16k: Float32Array,
  model: ParakeetModelConfig,
  options: ParakeetDecodeOptions
): ParakeetTranscription {
  ensureModel(model, options);
  if (recognizer === null) throw new Error('recognizer unavailable after load');
  const stream = recognizer.createStream();
  stream.acceptWaveform({ samples: audio16k, sampleRate: SAMPLE_RATE });
  recognizer.decode(stream);
  const result = recognizer.getResult(stream);
  const text = typeof result.text === 'string' ? result.text.trim() : '';
  const timestamps = Array.isArray(result.timestamps)
    ? result.timestamps.filter((t): t is number => typeof t === 'number')
    : [];
  return { text, timestamps };
}

const reply = (response: WorkerResponse): void => {
  process.send?.(response);
};

process.on('message', (message: WorkerRequest) => {
  if (typeof message !== 'object' || message === null) return;
  const { id, method, args } = message;
  try {
    switch (method) {
      case 'ensureModel': {
        const [model, options] = args as [ParakeetModelConfig, ParakeetDecodeOptions | undefined];
        ensureModel(model, options ?? {});
        reply({ id, result: null });
        return;
      }
      case 'transcribe': {
        const [rawAudio, model, options] = args as [
          unknown,
          ParakeetModelConfig,
          ParakeetDecodeOptions | undefined,
        ];
        if (!isSerializedFloat32Array(rawAudio)) {
          reply({ id, error: 'audio argument was not a serialized Float32Array' });
          return;
        }
        const audio = Float32Array.from(rawAudio.data);
        reply({ id, result: transcribe(audio, model, options ?? {}) });
        return;
      }
      default:
        reply({ id, error: `unknown method: ${method}` });
    }
  } catch (error) {
    reply({ id, error: error instanceof Error ? error.message : String(error) });
  }
});

log('info', 'parakeet worker ready');
