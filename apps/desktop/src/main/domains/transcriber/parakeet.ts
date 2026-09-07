/**
 * ParakeetLive — the second on-device lane behind the Transcriber seam:
 * NVIDIA Parakeet TDT through sherpa-onnx, one chunk at a time, minting one
 * stable row per chunk exactly like the whisper lane.
 *
 * Per chunk, in order:
 *   1. the bundle's four installed files (ModelManager, via resolveBundlePaths)
 *      — any part missing → a retryable model-missing result, retaining audio;
 *   2. the near-silence guard on the 48 kHz samples → `[]` without touching the
 *      engine;
 *   3. 48 kHz → 16 kHz through a per-(recording, source) StreamingLinearResampler
 *      (continuity across chunk boundaries — the carry is 1 sample);
 *   4. ensureModel → transcribe → applyReplacements → mintChunkSegment.
 *
 * WHAT IS DELIBERATELY ABSENT versus the whisper lane, and why:
 *   - no initial prompt. Parakeet is a transducer with no prompt channel, so
 *     `buildWhisperPrompt` has nothing to attach to. Vocabulary still lands,
 *     through the deterministic `applyReplacements` pass that runs after the
 *     decode for every engine.
 *   - no VAD weights. Parakeet does not hallucinate on silence the way whisper
 *     does (that behaviour is why whisper.cpp needs Silero here); the
 *     near-silence guard is enough.
 *   - no `previousText`. It only ever fed whisper's prompt.
 *
 * The circuit breaker IS kept, unchanged in shape: a wedged synchronous decode
 * looks the same whatever addon is behind it, and the drain's recovery
 * semantics depend on the lane parking audio rather than dropping it.
 */
import { Clock, Effect, Either, HashSet, Layer, Option, Ref } from 'effect';
import { applyReplacements } from '@prismical/ai-prompts/transcription';
import type { StreamingLinearResampler } from '../../infra/audio/streaming-linear-resampler';
import { MainLogger, type ScopedLog } from '../../infra/logging/service';
import { ProductDb } from '../../infra/product-db/service';
import { ParakeetEngine, type ParakeetEngineError } from '../../infra/parakeet/service';
import { AppModeService } from '../app-mode/service';
import { bundleFor, resolveBundlePaths } from '../models/bundles';
import { ModelManager } from '../models/service';
import {
  WorkspaceBackend,
  type RecordingLaneResult,
  type RecordingSegment,
  type TranscribeChunkParams,
} from '../transport/service';
import { isNearSilence, makeWhisperResampler } from './audio';
import { mintChunkSegment } from './segment';
import { ParakeetTranscriberLane, type TranscriberLaneApi } from './service';
import { makeVocabularySource } from './vocabulary';
import { ENGINE_BREAKER_THRESHOLD, LANE_IDLE_TTL_MS } from './local';

const EMPTY_OK: RecordingLaneResult<readonly RecordingSegment[]> = { ok: true, value: [] };

/**
 * The same mapping the whisper lane uses, and it must stay the same: the
 * recovery drain branches on retryability, not on which engine ran. A worker
 * that could not spawn / crashed / timed out is RETRYABLE (the cursor holds,
 * the drain re-sends from the retained WAV); an inference failure is NOT — a
 * model file that is not a valid graph will not become one on a retry.
 */
const engineFailureResult = (
  error: ParakeetEngineError
): RecordingLaneResult<readonly RecordingSegment[]> => {
  switch (error.reason) {
    // 'spawn-failed' has no lane reason of its own — a worker that never came
    // up and one that died are the same story for the drain, and the whisper
    // lane already collapses them the same way.
    case 'spawn-failed':
    case 'worker-crashed':
      return { ok: false, retryable: true, failure: { kind: 'engine', reason: 'worker-crashed' } };
    case 'timeout':
      return { ok: false, retryable: true, failure: { kind: 'engine', reason: 'timeout' } };
    case 'inference-failed':
      return {
        ok: false,
        retryable: false,
        failure: { kind: 'engine', reason: 'inference-failed' },
      };
  }
};

interface LaneContext {
  readonly resampler: StreamingLinearResampler;
  lastUsedAt: number;
}

export const ParakeetLive: Layer.Layer<
  ParakeetTranscriberLane,
  never,
  ParakeetEngine | ModelManager | ProductDb | MainLogger | AppModeService | WorkspaceBackend
> = Layer.effect(
  ParakeetTranscriberLane,
  Effect.gen(function* () {
    const parakeet = yield* ParakeetEngine;
    const models = yield* ModelManager;
    const product = yield* ProductDb;
    const appMode = yield* AppModeService;
    const backend = yield* WorkspaceBackend;
    const log: ScopedLog = (yield* MainLogger).scoped('transcriber');
    const source = makeVocabularySource({ mode: appMode.mode, product, backend, log });
    const warnedMissing = yield* Ref.make(HashSet.empty<string>());
    const lanes = new Map<string, LaneContext>();

    interface BreakerContext {
      consecutive: number;
      open: RecordingLaneResult<readonly RecordingSegment[]> | null;
      lastUsedAt: number;
    }
    const breakers = new Map<string, BreakerContext>();
    const breakerFor = (recordingId: string, now: number): BreakerContext => {
      for (const [other, context] of breakers) {
        if (other !== recordingId && now - context.lastUsedAt > LANE_IDLE_TTL_MS) {
          breakers.delete(other);
        }
      }
      let context = breakers.get(recordingId);
      if (context === undefined) {
        context = { consecutive: 0, open: null, lastUsedAt: now };
        breakers.set(recordingId, context);
      }
      context.lastUsedAt = now;
      return context;
    };

    const warnModelMissingOnce = (recordingId: string, modelId: string): Effect.Effect<void> =>
      Ref.modify(warnedMissing, seen => [
        HashSet.has(seen, recordingId),
        HashSet.add(seen, recordingId),
      ]).pipe(
        Effect.flatMap(seen =>
          seen
            ? Effect.void
            : log.warn('parakeet model not installed — audio retained for recovery', {
                recordingId,
                modelId,
              })
        )
      );

    const laneFor = (recordingId: string, chunkSource: string, now: number): LaneContext => {
      const key = `${recordingId}:${chunkSource}`;
      for (const [other, context] of lanes) {
        if (other !== key && now - context.lastUsedAt > LANE_IDLE_TTL_MS) lanes.delete(other);
      }
      let context = lanes.get(key);
      if (context === undefined) {
        context = { resampler: makeWhisperResampler(), lastUsedAt: now };
        lanes.set(key, context);
      }
      context.lastUsedAt = now;
      return context;
    };

    const transcribeChunk: TranscriberLaneApi['transcribeChunk'] = (
      recordingId,
      params: TranscribeChunkParams,
      audio,
      engine
    ) =>
      Effect.gen(function* () {
        const breaker = yield* Clock.currentTimeMillis.pipe(
          Effect.map(now => breakerFor(recordingId, now))
        );
        if (breaker.open !== null) return breaker.open;

        const bundle = bundleFor(engine.modelId);
        if (bundle === null) {
          // The dispatcher only routes bundle ids here, so this is a wiring
          // bug rather than a user state — but it must still park the audio.
          yield* warnModelMissingOnce(recordingId, engine.modelId);
          return {
            ok: false,
            retryable: true,
            failure: { kind: 'engine', reason: 'model-missing' },
          };
        }
        // Every part must be installed AND verified: a bundle missing one file
        // reads as not-installed rather than as a recognizer that fails to build.
        const installedPaths = yield* Effect.forEach(
          [bundle.parts.encoder, bundle.parts.decoder, bundle.parts.joiner, bundle.parts.tokens],
          id => models.installedPath(id).pipe(Effect.map(Option.getOrNull))
        );
        const byId = new Map(
          [
            bundle.parts.encoder,
            bundle.parts.decoder,
            bundle.parts.joiner,
            bundle.parts.tokens,
          ].map((id, index) => [id, installedPaths[index] ?? null])
        );
        const model = resolveBundlePaths(bundle, id => byId.get(id) ?? null);
        if (model === null) {
          yield* warnModelMissingOnce(recordingId, bundle.id);
          return {
            ok: false,
            retryable: true,
            failure: { kind: 'engine', reason: 'model-missing' },
          };
        }

        if (isNearSilence(audio.samples)) return EMPTY_OK;

        const startedAt = yield* Clock.currentTimeMillis;
        const lane = yield* Effect.sync(() => laneFor(recordingId, params.source, startedAt));
        const audio16k = yield* Effect.sync(() => lane.resampler.process(audio.samples));
        const terms = yield* source.termsFor(recordingId);

        const decoded = yield* parakeet
          .ensureModel(model)
          .pipe(Effect.zipRight(parakeet.transcribe(audio16k)), Effect.either);
        if (Either.isLeft(decoded)) {
          yield* log.warn('parakeet chunk failed', {
            recordingId,
            chunkIndex: params.chunkIndex,
            source: params.source,
            reason: decoded.left.reason,
            detail: decoded.left.detail,
          });
          const result = engineFailureResult(decoded.left);
          if (!result.ok && result.retryable) {
            breaker.consecutive += 1;
            if (breaker.consecutive >= ENGINE_BREAKER_THRESHOLD && breaker.open === null) {
              breaker.open = result;
              yield* log.warn(
                'parakeet circuit opened — engine bypassed for the rest of this recording (audio parks for the drain)',
                {
                  recordingId,
                  consecutiveFailures: breaker.consecutive,
                  reason: decoded.left.reason,
                }
              );
            }
          } else {
            breaker.consecutive = 0;
          }
          return result;
        }
        breaker.consecutive = 0;

        const replaced = applyReplacements(decoded.right.text, terms);
        const now = yield* Clock.currentTimeMillis;
        const segment = mintChunkSegment({
          recordingId,
          params,
          samples: audio.samples,
          text: replaced.text,
          now,
        });
        if (segment === null) return EMPTY_OK;
        if (replaced.hits.length > 0) {
          yield* source.bumpUsage(recordingId, replaced.hits);
        }
        return { ok: true, value: [segment] } satisfies RecordingLaneResult<
          readonly RecordingSegment[]
        >;
      });

    const api: TranscriberLaneApi = { transcribeChunk };
    return api;
  })
);
