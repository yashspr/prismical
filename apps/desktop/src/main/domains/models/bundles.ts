/**
 * A model the user picks that is more than one file on disk.
 *
 * Whisper is one ggml blob, so `transcription.modelId` could name a catalogue
 * entry directly. Parakeet is four files — encoder, decoder, joiner and a
 * tokens table — and sherpa-onnx takes all four paths individually. They must
 * download, resume and verify SEPARATELY (a 652 MB encoder and a 9 KB token
 * table have nothing in common but their model), yet be chosen, installed and
 * deleted as ONE thing.
 *
 * So the catalogue entry stays the unit of TRANSFER — every byte of the
 * resumable `.part` / range-request / streaming-SHA-1 machinery in live.ts is
 * untouched — and a bundle is the unit of CHOICE laid over it. A bundle id is
 * a valid `transcription.modelId`; it is installed when every part is, and its
 * progress is the sum of its parts'.
 *
 * A single-file model needs no bundle: `bundleFor` returns null and every
 * caller falls back to the plain catalogue entry, so whisper's path does not
 * change shape.
 */
import type { ModelKind } from '@prismical/desktop-contracts';
import {
  findCatalogueEntry,
  PARAKEET_V2_MODEL_ID,
  PARAKEET_V3_MODEL_ID,
  type ModelCatalogueEntry,
} from './catalogue';

/** The named files a Parakeet recognizer needs, in the order sherpa-onnx wants them. */
export type ParakeetPart = 'encoder' | 'decoder' | 'joiner' | 'tokens';

export interface ModelBundle {
  /** What `transcription.modelId` stores and the settings screen shows. */
  readonly id: string;
  readonly name: string;
  readonly kind: ModelKind;
  /** Catalogue entry ids, by role. Every one must install before the bundle is usable. */
  readonly parts: Readonly<Record<ParakeetPart, string>>;
  readonly recommended?: boolean;
}

export const MODEL_BUNDLES: ReadonlyArray<ModelBundle> = [
  // v3 first, and `recommended`: multilingual costs ~9 MB more than v2 and is
  // the safer default for a meeting recorder, where one speaker switching
  // language would otherwise come out as English-shaped nonsense. v2 stays for
  // English-only work, where it is a shade more accurate.
  {
    id: PARAKEET_V3_MODEL_ID,
    name: 'Parakeet TDT 0.6b v3 (multilingual)',
    kind: 'parakeet',
    parts: {
      encoder: 'parakeet-tdt-0.6b-v3-encoder',
      decoder: 'parakeet-tdt-0.6b-v3-decoder',
      joiner: 'parakeet-tdt-0.6b-v3-joiner',
      tokens: 'parakeet-tdt-0.6b-v3-tokens',
    },
    recommended: true,
  },
  {
    id: PARAKEET_V2_MODEL_ID,
    name: 'Parakeet TDT 0.6b v2 (English)',
    kind: 'parakeet',
    parts: {
      encoder: 'parakeet-tdt-0.6b-v2-encoder',
      decoder: 'parakeet-tdt-0.6b-v2-decoder',
      joiner: 'parakeet-tdt-0.6b-v2-joiner',
      tokens: 'parakeet-tdt-0.6b-v2-tokens',
    },
  },
];

export const bundleFor = (modelId: string): ModelBundle | null =>
  MODEL_BUNDLES.find(bundle => bundle.id === modelId) ?? null;

/** The catalogue ids a bundle owns — the download fan-out and the delete set. */
export const bundlePartIds = (bundle: ModelBundle): ReadonlyArray<string> =>
  Object.values(bundle.parts);

/** Every catalogue id that belongs to SOME bundle: these never appear as their own row. */
export const BUNDLED_PART_IDS: ReadonlySet<string> = new Set(
  MODEL_BUNDLES.flatMap(bundle => bundlePartIds(bundle))
);

export const bundleOwning = (partId: string): ModelBundle | null =>
  MODEL_BUNDLES.find(bundle => bundlePartIds(bundle).includes(partId)) ?? null;

export const bundleEntries = (bundle: ModelBundle): ReadonlyArray<ModelCatalogueEntry> =>
  bundlePartIds(bundle)
    .map(id => findCatalogueEntry(id))
    .filter((entry): entry is ModelCatalogueEntry => entry !== undefined);

/** A bundle's total download size — the sum of its parts' pinned sizes. */
export const bundleSizeBytes = (bundle: ModelBundle): number =>
  bundleEntries(bundle).reduce((total, entry) => total + entry.sizeBytes, 0);

/**
 * The four absolute paths a Parakeet recognizer is built from, or null when any
 * part is missing. `installedPath` is the ModelManager's per-entry resolver, so
 * a half-installed bundle (an interrupted download, a part deleted by hand)
 * reads as "not installed" rather than as a recognizer that fails to load.
 */
export interface ParakeetModelPaths {
  readonly encoder: string;
  readonly decoder: string;
  readonly joiner: string;
  readonly tokens: string;
}

export const resolveBundlePaths = (
  bundle: ModelBundle,
  installedPath: (modelId: string) => string | null
): ParakeetModelPaths | null => {
  const encoder = installedPath(bundle.parts.encoder);
  const decoder = installedPath(bundle.parts.decoder);
  const joiner = installedPath(bundle.parts.joiner);
  const tokens = installedPath(bundle.parts.tokens);
  if (encoder === null || decoder === null || joiner === null || tokens === null) return null;
  return { encoder, decoder, joiner, tokens };
};

/**
 * Every catalogue id that must be installed before `modelId` can transcribe:
 * a bundle's parts, or a single-file model's own entry.
 *
 * The PRE-FLIGHT gates need this. `installedPath` — and the `local_model` rows
 * behind it — are per-ENTRY by design, so asking either about a bundle id
 * answers "missing" however complete the install is: a bundle owns rows, it
 * never has one. A gate that asks directly refuses to record with all four
 * Parakeet files on disk, and the recovery drain parks such a recording
 * forever. Both call sites expand through here instead.
 */
export const requiredPartIds = (modelId: string): ReadonlyArray<string> => {
  const bundle = bundleFor(modelId);
  return bundle === null ? [modelId] : bundlePartIds(bundle);
};
