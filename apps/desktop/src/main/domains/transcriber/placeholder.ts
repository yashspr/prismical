/**
 * Placeholder lanes — inert stand-ins for the local Whisper and BYOK lanes.
 * Production uses LocalWhisperLive / ByokTranscriberLive (workspace-layer.ts);
 * the placeholders remain
 * as the DEFAULT lanes of the recording/drain test harnesses
 * (tests/helpers/fake-workspace-env.ts makeTranscriberStack), where a test
 * that does not inject a lane must still see the seam's one hard rule: EVERY
 * chunk resolves `ok` (an empty transcript), so a recording under an engine
 * the harness cannot run still completes, persists its row, and never parks
 * for the drain. One warn per recording (not per chunk).
 */
import { Effect, HashSet, Layer, Ref } from 'effect';
import type { TranscriptionEngine } from '@prismical/desktop-contracts';
import { MainLogger } from '../../infra/logging/service';
import type { RecordingLaneResult, RecordingSegment } from '../transport/service';
import {
  ByokTranscriberLane,
  LocalTranscriberLane,
  ParakeetTranscriberLane,
  type TranscriberLaneApi,
} from './service';

const EMPTY_OK: RecordingLaneResult<readonly RecordingSegment[]> = { ok: true, value: [] };

export const makePlaceholderLane = (
  engine: Exclude<TranscriptionEngine, 'cloud'>
): Effect.Effect<TranscriberLaneApi, never, MainLogger> =>
  Effect.gen(function* () {
    const log = (yield* MainLogger).scoped('transcriber');
    const warned = yield* Ref.make(HashSet.empty<string>());
    const api: TranscriberLaneApi = {
      transcribeChunk: recordingId =>
        Ref.modify(warned, seen => [
          HashSet.has(seen, recordingId),
          HashSet.add(seen, recordingId),
        ]).pipe(
          Effect.flatMap(seen =>
            seen
              ? Effect.void
              : log.warn('transcription engine not available in this build — chunks ack empty', {
                  recordingId,
                  engine,
                })
          ),
          Effect.as(EMPTY_OK)
        ),
    };
    return api;
  });

export const LocalTranscriberPlaceholderLive: Layer.Layer<LocalTranscriberLane, never, MainLogger> =
  Layer.effect(LocalTranscriberLane, makePlaceholderLane('local'));

export const ByokTranscriberPlaceholderLive: Layer.Layer<ByokTranscriberLane, never, MainLogger> =
  Layer.effect(ByokTranscriberLane, makePlaceholderLane('byok'));

/**
 * Parakeet's placeholder. It reports `engine: 'local'` because that IS the
 * engine the user chose — Parakeet is a model choice inside the local engine,
 * not an engine of its own (see ParakeetTranscriberLane).
 */
export const ParakeetTranscriberPlaceholderLive: Layer.Layer<
  ParakeetTranscriberLane,
  never,
  MainLogger
> = Layer.effect(ParakeetTranscriberLane, makePlaceholderLane('local'));
