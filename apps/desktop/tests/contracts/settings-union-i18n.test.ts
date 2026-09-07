/**
 * Catalogue coverage for the enumerated unions the settings screens render.
 *
 * `catalogs.test.ts` in app-i18n proves every locale has the SAME keys as
 * English; it cannot prove English has the keys the interface asks for. Both
 * cards here build their keys from a union —
 * `t(\`desktop.aiProvider.providers.${provider}.label\`)` and the engine card's
 * equivalent — so a member added to the contract without catalogue entries
 * renders i18next's missing-key fallback ("Something went wrong. Please try
 * again.") as a RADIO OPTION, in every language at once, while the structural
 * test and the renderer tests (which mock react-i18next) stay green. That
 * shipped once, for the `cli` provider; this closes it for both unions.
 */
import { describe, expect, it } from 'vitest';
import { catalogs, supportedLocales } from '@prismical/app-i18n';
import { aiProviderKindSchema, transcriptionEngineSchema } from '@prismical/desktop-contracts';

type Node = string | { readonly [key: string]: Node };

const lookup = (root: Node, path: string): Node | undefined =>
  path.split('.').reduce<Node | undefined>((node, key) => {
    if (node === undefined || typeof node === 'string') return undefined;
    return node[key];
  }, root);

/** Keys with no non-empty string in some locale, as "<locale>: <key>". */
const missingKeys = (keys: ReadonlyArray<string>): string[] =>
  supportedLocales.flatMap(locale =>
    keys
      .filter(key => {
        const value = lookup(catalogs[locale] as Node, key);
        return typeof value !== 'string' || value.trim().length === 0;
      })
      .map(key => `${locale}: ${key}`)
  );

describe('settings union catalogue coverage', () => {
  it('gives every ai provider kind a label and a description', () => {
    expect(
      missingKeys(
        aiProviderKindSchema.options.flatMap(provider =>
          ['label', 'description'].map(f => `desktop.aiProvider.providers.${provider}.${f}`)
        )
      )
    ).toEqual([]);
  });

  it('gives every transcription engine a label and a description', () => {
    expect(
      missingKeys(
        transcriptionEngineSchema.options.flatMap(engine =>
          ['label', 'description'].map(f => `desktop.transcriptionEngine.engines.${engine}.${f}`)
        )
      )
    ).toEqual([]);
  });

  it('carries the custom-command copy the cli provider needs', () => {
    // Rendered only for `cli` (HAS_CLI_COMMAND), so the provider-kind sweep
    // above cannot reach these three.
    expect(
      missingKeys([
        'desktop.aiProvider.cliCommandHelp',
        'desktop.aiProvider.cliCommandLabel',
        'desktop.aiProvider.cliCommandPlaceholder',
      ])
    ).toEqual([]);
  });
});
