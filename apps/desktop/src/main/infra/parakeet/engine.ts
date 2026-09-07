/**
 * ParakeetEngineLive — the sherpa-onnx worker host. See service.ts for the
 * contract; this file is the fork recipe + the IPC pump, and it is deliberately
 * the same recipe as infra/whisper/engine.ts:
 *
 *   execPath   packaged  <Resources>/node[.exe]   (the bundled Node SIDECAR — the
 *                        RunAsNode fuse is burned, electron can never be the worker)
 *              dev       apps/desktop/node-binaries/<platform>-<arch>/node
 *   worker     packaged  <Resources>/app.asar.unpacked/.vite/build/parakeet-worker-fork.js
 *              dev       apps/desktop/.vite/build/parakeet-worker-fork.js
 *   env        ELECTRON_RUN_AS_NODE=1, NODE_OPTIONS REPLACED (never inherited — a
 *              tsx/vitest loader in the parent must not leak into the worker),
 *              execArgv: [] for the same reason, silent: true with stdout/stderr
 *              drained into the log (onnxruntime prints to stderr; an undrained
 *              pipe would eventually block the worker).
 *
 * Lifecycle: forked lazily on the first call, re-forked transparently after a
 * crash (the requested model is rebuilt on the next transcribe), killed on
 * timeout (a synchronous decode cannot be cancelled — the stuck worker is
 * replaced) and when the boot scope closes.
 *
 * The one substantive difference from whisper: the "model" is FOUR paths rather
 * than one, so the cache key is their tuple plus the thread count (a recognizer
 * is built with its thread count baked in).
 */
import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { Duration, Effect, Layer } from 'effect';
import { AppConfig } from '../config/service';
import { MainLogger, type UnsafeScopedLog } from '../logging/service';
import {
  isWorkerLogFrame,
  serializeArg,
  type ParakeetModelConfig,
  type ParakeetTranscription,
  type WorkerLogLevel,
  type WorkerRequest,
  type WorkerResponse,
} from './protocol';
import { ParakeetEngine, ParakeetEngineError, type ParakeetEngineApi } from './service';

/**
 * Budget for ONE decode of a ≤5 s chunk. Far tighter than whisper's 300 s:
 * Parakeet does not pad to a 30 s encoder window, and measured cold it decodes
 * ~7 s of audio in ~200 ms on an M-series CPU. 60 s is a very wide margin for a
 * slow machine while still unwedging a genuinely stuck call in reasonable time.
 */
export const TRANSCRIBE_TIMEOUT = Duration.seconds(60);
/** Building the recognizer reads a 652 MB encoder graph from a possibly cold disk. */
export const MODEL_LOAD_TIMEOUT = Duration.minutes(2);
/**
 * Threads for the encoder. Capped rather than `os.cpus().length`: the lane runs
 * while audio capture and the editor share the machine, and past ~4 the encoder
 * stops scaling on the core counts these laptops have.
 */
export const DEFAULT_THREADS = 4;

export interface ParakeetWorkerPaths {
  readonly nodeBinaryPath: string;
  readonly workerPath: string;
  readonly cwd: string;
  /** Packaged only — exported to the worker as APP_ASAR_PATH. */
  readonly asarPath?: string;
}

/** The runtime path resolution above, from AppConfig (testable without electron). */
export const resolveParakeetWorkerPaths = (config: {
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
}): ParakeetWorkerPaths => {
  const binary = config.platform === 'win32' ? 'node.exe' : 'node';
  if (config.isPackaged) {
    const resources = process.resourcesPath;
    return {
      nodeBinaryPath: path.join(resources, binary),
      workerPath: path
        .join(__dirname, 'parakeet-worker-fork.js')
        .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`),
      cwd: resources,
      asarPath: path.join(resources, 'app.asar'),
    };
  }
  return {
    nodeBinaryPath: path.join(
      process.cwd(),
      'node-binaries',
      `${config.platform}-${process.arch}`,
      binary
    ),
    workerPath: path.join(process.cwd(), '.vite', 'build', 'parakeet-worker-fork.js'),
    cwd: process.cwd(),
  };
};

/** Injectable `fork` so the host is unit-testable with a fake child. */
export type ForkLike = (
  modulePath: string,
  args: readonly string[],
  options: ForkOptions
) => ChildProcess;

export interface ParakeetEngineLiveOptions {
  readonly paths?: ParakeetWorkerPaths;
  readonly forkFn?: ForkLike;
  readonly transcribeTimeout?: Duration.Duration;
  readonly modelLoadTimeout?: Duration.Duration;
  readonly numThreads?: number;
}

type Resume = (result: Effect.Effect<unknown, ParakeetEngineError>) => void;

interface WorkerHandle {
  readonly child: ChildProcess;
  readonly pending: Map<number, Resume>;
  nextId: number;
  /** True once the worker sent ANY message: a death before that is a spawn failure. */
  ready: boolean;
  /** The recognizer config this worker holds; null after fork and after a failed build. */
  loadedKey: string | null;
  dead: boolean;
}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const modelKey = (model: ParakeetModelConfig, threads: number): string =>
  JSON.stringify([model.encoder, model.decoder, model.joiner, model.tokens, threads]);

/** Line-buffer a piped stream into the log (never let the worker block on a full pipe). */
const drainLines = (stream: Readable | null, emit: (line: string) => void): void => {
  if (stream === null) return;
  let pending = '';
  stream.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8');
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() !== '') emit(line);
    }
  });
};

const WORKER_LOG_LEVELS: ReadonlySet<string> = new Set<WorkerLogLevel>([
  'debug',
  'info',
  'warn',
  'error',
]);

export const makeParakeetEngineLive = (
  options: ParakeetEngineLiveOptions = {}
): Layer.Layer<ParakeetEngine, never, AppConfig | MainLogger> =>
  Layer.scoped(
    ParakeetEngine,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const logger = yield* MainLogger;
      const log = logger.scoped('parakeet-engine');
      const unsafeLog = logger.scopedUnsafe('parakeet-engine');
      const workerLog: UnsafeScopedLog = logger.scopedUnsafe('parakeet-worker');
      const paths = options.paths ?? resolveParakeetWorkerPaths(config);
      const forkFn: ForkLike = options.forkFn ?? fork;
      const transcribeTimeout = options.transcribeTimeout ?? TRANSCRIBE_TIMEOUT;
      const modelLoadTimeout = options.modelLoadTimeout ?? MODEL_LOAD_TIMEOUT;
      const numThreads = options.numThreads ?? DEFAULT_THREADS;
      const semaphore = yield* Effect.makeSemaphore(1);

      // Callback-edge state (single-threaded event loop): mutated only under the
      // semaphore or inside the child's event handlers.
      let worker: WorkerHandle | null = null;
      let requestedModel: ParakeetModelConfig | null = null;

      const settleAll = (handle: WorkerHandle, error: ParakeetEngineError): void => {
        const waiters = [...handle.pending.values()];
        handle.pending.clear();
        for (const resume of waiters) resume(Effect.fail(error));
      };

      /** Idempotent: the `error` and `exit` edges (and a deliberate kill) all land here. */
      const markDead = (handle: WorkerHandle, detail: string): void => {
        if (handle.dead) return;
        handle.dead = true;
        handle.loadedKey = null;
        if (worker === handle) worker = null;
        settleAll(
          handle,
          new ParakeetEngineError({
            reason: handle.ready ? 'worker-crashed' : 'spawn-failed',
            detail,
          })
        );
      };

      const onMessage = (handle: WorkerHandle, msg: unknown): void => {
        handle.ready = true;
        if (isWorkerLogFrame(msg)) {
          const level: WorkerLogLevel = WORKER_LOG_LEVELS.has(msg.level) ? msg.level : 'info';
          workerLog[level](
            msg.message,
            msg.args !== undefined && msg.args.length > 0 ? { args: msg.args } : undefined
          );
          return;
        }
        const response = msg as WorkerResponse;
        if (typeof response.id !== 'number') return;
        const resume = handle.pending.get(response.id);
        if (resume === undefined) return; // timed out / interrupted — already settled
        handle.pending.delete(response.id);
        resume(
          response.error !== undefined
            ? Effect.fail(
                new ParakeetEngineError({ reason: 'inference-failed', detail: response.error })
              )
            : Effect.succeed(response.result)
        );
      };

      const spawnWorker: Effect.Effect<WorkerHandle, ParakeetEngineError> = Effect.gen(
        function* () {
          const child = yield* Effect.try({
            try: () =>
              forkFn(paths.workerPath, [], {
                execPath: paths.nodeBinaryPath,
                execArgv: [],
                cwd: paths.cwd,
                silent: true,
                env: {
                  ...process.env,
                  ELECTRON_RUN_AS_NODE: '1',
                  NODE_OPTIONS: '--max-old-space-size=8192',
                  ...(paths.asarPath === undefined ? {} : { APP_ASAR_PATH: paths.asarPath }),
                },
              }),
            catch: cause =>
              new ParakeetEngineError({ reason: 'spawn-failed', detail: errorMessage(cause) }),
          });
          const handle: WorkerHandle = {
            child,
            pending: new Map(),
            nextId: 0,
            ready: false,
            loadedKey: null,
            dead: false,
          };
          child.on('message', msg => onMessage(handle, msg));
          child.on('error', error => {
            unsafeLog.warn('parakeet worker error', { reason: error.message });
            markDead(handle, error.message);
          });
          child.on('exit', (code, signal) => {
            unsafeLog.info('parakeet worker exited', { code, signal });
            markDead(handle, `exit code=${code} signal=${signal}`);
          });
          drainLines(child.stdout, line => workerLog.debug(line));
          drainLines(child.stderr, line => workerLog.debug(line));
          worker = handle;
          yield* log.info('parakeet worker forked');
          return handle;
        }
      );

      const ensureWorker: Effect.Effect<WorkerHandle, ParakeetEngineError> = Effect.suspend(() =>
        worker === null ? spawnWorker : Effect.succeed(worker)
      );

      const killWorker = (why: string): Effect.Effect<void> =>
        Effect.sync(() => {
          const handle = worker;
          if (handle === null) return;
          handle.child.kill();
          markDead(handle, why);
        });

      /** One request/response exchange; interruption (timeout) forgets the call. */
      const exec = <T>(
        handle: WorkerHandle,
        method: string,
        args: readonly unknown[]
      ): Effect.Effect<T, ParakeetEngineError> =>
        Effect.async<T, ParakeetEngineError>(resume => {
          if (handle.dead) {
            resume(
              Effect.fail(
                new ParakeetEngineError({ reason: 'worker-crashed', detail: 'worker is gone' })
              )
            );
            return;
          }
          const id = handle.nextId++;
          handle.pending.set(id, result => resume(result as Effect.Effect<T, ParakeetEngineError>));
          const request: WorkerRequest = { id, method, args: args.map(serializeArg) };
          try {
            handle.child.send(request);
          } catch (cause) {
            handle.pending.delete(id);
            resume(
              Effect.fail(
                new ParakeetEngineError({ reason: 'worker-crashed', detail: errorMessage(cause) })
              )
            );
          }
          return Effect.sync(() => {
            handle.pending.delete(id);
          });
        });

      /** Budget a call; a timeout kills the (presumed stuck) worker so the next call re-forks. */
      const budgeted = <T>(
        effect: Effect.Effect<T, ParakeetEngineError>,
        budget: Duration.Duration,
        what: string
      ): Effect.Effect<T, ParakeetEngineError> =>
        effect.pipe(
          Effect.timeoutFail({
            duration: budget,
            onTimeout: () => new ParakeetEngineError({ reason: 'timeout', detail: what }),
          }),
          Effect.tapError(error =>
            error.reason === 'timeout'
              ? log
                  .warn('parakeet worker call timed out — replacing the worker', { what })
                  .pipe(Effect.zipRight(killWorker(`timeout: ${what}`)))
              : Effect.void
          )
        );

      const ensureLoaded = (
        model: ParakeetModelConfig
      ): Effect.Effect<WorkerHandle, ParakeetEngineError> =>
        Effect.gen(function* () {
          const handle = yield* ensureWorker;
          const key = modelKey(model, numThreads);
          if (handle.loadedKey === key) return handle;
          // Forget the cached key BEFORE the attempt and record the new one only
          // on success: a failed build must never leave the host believing a
          // recognizer is live and decoding against nothing.
          handle.loadedKey = null;
          yield* budgeted(
            exec<void>(handle, 'ensureModel', [model, { numThreads }]),
            modelLoadTimeout,
            'ensureModel'
          );
          handle.loadedKey = key;
          yield* log.info('parakeet model loaded', { encoder: path.basename(model.encoder) });
          return handle;
        });

      const api: ParakeetEngineApi = {
        ensureModel: model =>
          semaphore.withPermits(1)(
            Effect.suspend(() => {
              requestedModel = model;
              return ensureLoaded(model).pipe(Effect.asVoid);
            })
          ),
        transcribe: (audio16k, decodeOptions) =>
          semaphore.withPermits(1)(
            Effect.suspend(() => {
              const model = requestedModel;
              if (model === null) {
                return Effect.fail(
                  new ParakeetEngineError({
                    reason: 'inference-failed',
                    detail: 'no model requested — call ensureModel first',
                  })
                );
              }
              return ensureLoaded(model).pipe(
                Effect.flatMap(handle =>
                  budgeted(
                    exec<ParakeetTranscription>(handle, 'transcribe', [
                      audio16k,
                      model,
                      { numThreads, ...decodeOptions },
                    ]),
                    transcribeTimeout,
                    'transcribe'
                  )
                )
              );
            })
          ),
        // Deliberately NOT under the semaphore: a stuck decode must not delay a kill.
        dispose: killWorker('dispose'),
      };

      yield* Effect.addFinalizer(() => killWorker('scope closed'));
      return api;
    })
  );

/** The boot-scoped host with the runtime path resolution (BootLayer). */
export const ParakeetEngineLive: Layer.Layer<ParakeetEngine, never, AppConfig | MainLogger> =
  makeParakeetEngineLive();
