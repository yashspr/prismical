/**
 * TranscriberLive — pure dispatch over the engine lanes. The engine arrives per
 * call (frozen by the producer), so the seam holds no per-recording state of
 * its own; whatever state a lane needs (resampler, prompt context, worker
 * handle) lives inside that lane.
 *
 * `engine.engine` picks the lane, with ONE refinement: 'local' means "on this
 * device", and there are two on-device engines. A local chunk whose frozen
 * `modelId` names a Parakeet bundle goes to ParakeetTranscriberLane; anything
 * else (every whisper catalogue id) goes to LocalTranscriberLane. Keeping this
 * inside the dispatch rather than in the contract is deliberate: the user's
 * stored preference stays `{ engine: 'local', modelId }`, so choosing Parakeet
 * is a model choice and needs no settings migration.
 */
import { Effect, Layer } from 'effect';
import { bundleFor } from '../models/bundles';
import {
  ByokTranscriberLane,
  CloudTranscriberLane,
  LocalTranscriberLane,
  ParakeetTranscriberLane,
  Transcriber,
  type TranscriberApi,
} from './service';

export const TranscriberLive: Layer.Layer<
  Transcriber,
  never,
  CloudTranscriberLane | LocalTranscriberLane | ByokTranscriberLane | ParakeetTranscriberLane
> = Layer.effect(
  Transcriber,
  Effect.gen(function* () {
    const lanes = {
      cloud: yield* CloudTranscriberLane,
      local: yield* LocalTranscriberLane,
      byok: yield* ByokTranscriberLane,
    } as const;
    const parakeet = yield* ParakeetTranscriberLane;
    const api: TranscriberApi = {
      transcribeChunk: (recordingId, params, audio, engine) => {
        const lane =
          engine.engine === 'local' && bundleFor(engine.modelId)?.kind === 'parakeet'
            ? parakeet
            : lanes[engine.engine];
        return lane.transcribeChunk(recordingId, params, audio, engine);
      },
    };
    return api;
  })
);
