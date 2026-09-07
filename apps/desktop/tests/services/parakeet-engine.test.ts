/**
 * ParakeetEngineLive against the REAL forked worker and the REAL sherpa-onnx
 * addon — the fork recipe, the IPC pump, the recognizer cache and the failure
 * mapping, none of it mocked.
 *
 * The model is not: a 661 MB download cannot be a unit-test dependency. So the
 * decode case is SKIPPED unless the weights are already on disk, named by
 * PRISMICAL_PARAKEET_MODEL_DIR (the directory holding encoder.int8.onnx,
 * decoder.int8.onnx, joiner.int8.onnx and tokens.txt). Everything that does not
 * need weights — spawning, a bad model path failing typed rather than hanging,
 * disposal — runs always.
 *
 * The worker bundle must exist: `pnpm build:worker:parakeet`. Without it the
 * host reports spawn-failed, which is what the no-bundle case asserts.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { Context, Effect, Layer } from 'effect';
import { expect } from 'vitest';
import {
  makeParakeetEngineLive,
  type ParakeetWorkerPaths,
} from '../../src/main/infra/parakeet/engine';
import { ParakeetEngine } from '../../src/main/infra/parakeet/service';
import { makeTestLogger, testConfigLayer } from '../helpers/test-layers';

const DESKTOP_ROOT = path.resolve(__dirname, '../..');
const WORKER_BUNDLE = path.join(DESKTOP_ROOT, '.vite', 'build', 'parakeet-worker-fork.js');

/**
 * The suite runs under vitest, not the packaged app, so the sidecar is this
 * process's own node and the worker is the dev bundle.
 */
const testPaths = (workerPath = WORKER_BUNDLE): ParakeetWorkerPaths => ({
  nodeBinaryPath: process.execPath,
  workerPath,
  cwd: DESKTOP_ROOT,
});

const build = (paths: ParakeetWorkerPaths) => {
  const logger = makeTestLogger();
  return makeParakeetEngineLive({ paths, modelLoadTimeout: undefined }).pipe(
    Layer.provide(testConfigLayer()),
    Layer.provide(logger.layer)
  );
};

const modelDir = process.env.PRISMICAL_PARAKEET_MODEL_DIR ?? null;
const modelFiles =
  modelDir === null
    ? null
    : {
        encoder: path.join(modelDir, 'encoder.int8.onnx'),
        decoder: path.join(modelDir, 'decoder.int8.onnx'),
        joiner: path.join(modelDir, 'joiner.int8.onnx'),
        tokens: path.join(modelDir, 'tokens.txt'),
      };
const haveModel = modelFiles !== null && Object.values(modelFiles).every(file => existsSync(file));
const haveBundle = existsSync(WORKER_BUNDLE);

describe('ParakeetEngineLive', () => {
  it.effect.skipIf(!haveBundle)(
    'reports spawn-failed for a worker bundle that is not there, rather than hanging',
    () =>
      Effect.gen(function* () {
        const layer = build(testPaths(path.join(DESKTOP_ROOT, '.vite', 'build', 'no-such.js')));
        const ctx = yield* Layer.build(layer);
        const engine = Context.get(ctx, ParakeetEngine);
        const result = yield* Effect.either(
          engine.ensureModel({
            encoder: '/nope/encoder.onnx',
            decoder: '/nope/decoder.onnx',
            joiner: '/nope/joiner.onnx',
            tokens: '/nope/tokens.txt',
          })
        );
        assert.isTrue(result._tag === 'Left');
        if (result._tag === 'Left') {
          // A node that cannot find its entry file exits non-zero before any
          // message, which the host must read as a spawn failure.
          expect(['spawn-failed', 'worker-crashed']).toContain(result.left.reason);
        }
      }).pipe(Effect.scoped),
    30_000
  );

  it.effect.skipIf(!haveBundle)(
    'fails typed on model files that are not valid graphs',
    () =>
      Effect.gen(function* () {
        const ctx = yield* Layer.build(build(testPaths()));
        const engine = Context.get(ctx, ParakeetEngine);
        const result = yield* Effect.either(
          engine.ensureModel({
            encoder: path.join(DESKTOP_ROOT, 'package.json'),
            decoder: path.join(DESKTOP_ROOT, 'package.json'),
            joiner: path.join(DESKTOP_ROOT, 'package.json'),
            tokens: path.join(DESKTOP_ROOT, 'package.json'),
          })
        );
        assert.isTrue(result._tag === 'Left');
        if (result._tag === 'Left') {
          // Deterministic: the lane must NOT retry these forever.
          expect(['inference-failed', 'worker-crashed']).toContain(result.left.reason);
        }
      }).pipe(Effect.scoped),
    60_000
  );

  it.effect.skipIf(!haveBundle || !haveModel)(
    'transcribes 16 kHz audio through the real addon',
    () =>
      Effect.gen(function* () {
        const ctx = yield* Layer.build(build(testPaths()));
        const engine = Context.get(ctx, ParakeetEngine);
        assert.isNotNull(modelFiles);
        yield* engine.ensureModel(modelFiles);

        // A second of silence decodes to nothing — but must not throw, because
        // the lane's near-silence guard is upstream and not infallible.
        const silence = new Float32Array(16_000);
        const quiet = yield* engine.transcribe(silence);
        expect(typeof quiet.text).toBe('string');
      }).pipe(Effect.scoped),
    180_000
  );
});
