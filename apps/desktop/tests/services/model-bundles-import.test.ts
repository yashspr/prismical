/**
 * The two things that make a four-file model usable: it is ONE row with one
 * download and one delete (bundles.ts + the fan-out in ModelManagerLive), and
 * it can be installed from a copy that already exists on this device instead of
 * downloaded again (`import`).
 *
 * Electron-free, like model-manager.test.ts: real fs in a temp dir, the fake
 * OperationalDb, a local http fixture standing in for Hugging Face. The import
 * tests pin the behaviour that actually protects the user — matching on the
 * PINNED SHA-1 rather than on a filename, LINKING rather than copying, and
 * deleting the link rather than someone else's bytes.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { Context, Effect, Exit, Layer, Option, Scope, Stream } from 'effect';
import type { ModelsStateView } from '@prismical/desktop-contracts';
import { makeFakeOperationalDb } from '../helpers/fake-operational-db';
import { makeTestLogger, testConfigLayer } from '../helpers/test-layers';
import type { ModelBundle } from '../../src/main/domains/models/bundles';
import type { ModelCatalogueEntry } from '../../src/main/domains/models/catalogue';
import { makeModelManagerLive } from '../../src/main/domains/models/live';
import { ModelManager, type ModelManagerApi } from '../../src/main/domains/models/service';
import { PendingReset } from '../../src/main/infra/pending-reset/service';

const tempRoot = mkdtempSync(path.join(tmpdir(), 'prismical-bundle-test-'));
let counter = 0;
const freshDir = (what: string) => path.join(tempRoot, `${what}-${counter++}`);

const sha1 = (bytes: Buffer): string => createHash('sha1').update(bytes).digest('hex');

/** Deterministic bytes, distinct per part. */
const bodyFor = (name: string, length: number): Buffer => {
  const out = Buffer.alloc(length);
  let x = [...name].reduce((acc, ch) => (acc * 33 + ch.charCodeAt(0)) >>> 0, 7);
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
};

const PART_NAMES = ['encoder', 'decoder', 'joiner', 'tokens'] as const;
/** Deliberately different sizes: the size prefilter must not be the decider. */
const PART_SIZES: Record<(typeof PART_NAMES)[number], number> = {
  encoder: 4096,
  decoder: 2048,
  joiner: 1024,
  tokens: 512,
};

const BODIES = Object.fromEntries(
  PART_NAMES.map(name => [name, bodyFor(name, PART_SIZES[name])])
) as Record<(typeof PART_NAMES)[number], Buffer>;

/** A four-part fixture bundle over a fixture catalogue, served by `url`. */
const fixtureCatalogue = (url: string): ReadonlyArray<ModelCatalogueEntry> =>
  PART_NAMES.map(name => ({
    id: `fixture-${name}`,
    name: `Fixture — ${name}`,
    filename: `fixture-${name}.bin`,
    downloadUrl: `${url}/${name}`,
    sha1: sha1(BODIES[name]),
    sizeBytes: BODIES[name].length,
    kind: 'parakeet' as const,
  }));

const FIXTURE_BUNDLE: ModelBundle = {
  id: 'fixture-bundle',
  name: 'Fixture bundle',
  kind: 'parakeet',
  parts: {
    encoder: 'fixture-encoder',
    decoder: 'fixture-decoder',
    joiner: 'fixture-joiner',
    tokens: 'fixture-tokens',
  },
  recommended: true,
};

const TOTAL_BYTES = PART_NAMES.reduce((sum, name) => sum + BODIES[name].length, 0);

/** A trivial origin serving each part by name, counting the requests it saw. */
const makeFixture = () =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ url: string; requests: string[]; server: Server }>(resolve => {
          const requests: string[] = [];
          const server = createServer((req, res) => {
            const name = (req.url ?? '').replace('/', '') as (typeof PART_NAMES)[number];
            requests.push(name);
            const body = BODIES[name];
            if (body === undefined) {
              res.writeHead(404).end();
              return;
            }
            res.writeHead(200, {
              'content-length': String(body.length),
              'content-type': 'application/octet-stream',
            });
            res.end(body);
          });
          server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = typeof address === 'object' && address !== null ? address.port : 0;
            resolve({ url: `http://127.0.0.1:${port}`, requests, server });
          });
        })
    ),
    fixture => Effect.promise(() => new Promise<void>(done => fixture.server.close(() => done())))
  );

const build = (options: {
  readonly catalogue: ReadonlyArray<ModelCatalogueEntry>;
  readonly modelsDir: string;
  readonly externalRoots?: ReadonlyArray<string>;
}) => {
  const logger = makeTestLogger();
  const db = makeFakeOperationalDb({}, { localModels: [] });
  const layer = makeModelManagerLive({
    catalogue: options.catalogue,
    bundles: [FIXTURE_BUNDLE],
    externalRoots: options.externalRoots ?? [],
    probe: { freeBytes: async () => Number.MAX_SAFE_INTEGER },
  }).pipe(
    Layer.provide(testConfigLayer({ modelsDir: options.modelsDir })),
    Layer.provide(db.layer),
    Layer.provide(Layer.succeed(PendingReset, { applied: null })),
    Layer.provide(logger.layer)
  );
  return { logger, db, layer };
};

const modelOf = (state: ModelsStateView, id: string) => {
  const model = state.models.find(m => m.id === id);
  assert.isDefined(model, `model ${id} in state`);
  return model as NonNullable<typeof model>;
};

const waitFor = (manager: ModelManagerApi, predicate: (state: ModelsStateView) => boolean) =>
  manager.state.changes.pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow)
  );

/** Write the whole bundle into `dir` under names that are NOT the catalogue's. */
const stageExternalCopy = (dir: string, parts: ReadonlyArray<(typeof PART_NAMES)[number]>) => {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of parts) {
    fs.writeFileSync(path.join(dir, `${name}-model.int8.onnx`), BODIES[name]);
  }
  return dir;
};

describe('ModelManager bundles', () => {
  it.effect('shows one row for the bundle and none for its parts', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fixture = yield* makeFixture().pipe(Scope.extend(scope));
      const { layer } = build({
        catalogue: fixtureCatalogue(fixture.url),
        modelsDir: freshDir('models'),
      });
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const manager = Context.get(ctx, ModelManager);

      const state = yield* manager.list;
      assert.deepStrictEqual(
        state.models.map(model => model.id),
        ['fixture-bundle']
      );
      const row = modelOf(state, 'fixture-bundle');
      // The row is the WHOLE model: every part's bytes, the bundle's name, and
      // a recommendation that belongs to the bundle rather than to a file.
      assert.strictEqual(row.sizeBytes, TOTAL_BYTES);
      assert.strictEqual(row.name, 'Fixture bundle');
      assert.isTrue(row.recommended);
      assert.isFalse(row.installed);
      assert.isFalse(row.linked);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('one download installs every part, and one delete removes them all', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fixture = yield* makeFixture().pipe(Scope.extend(scope));
      const modelsDir = freshDir('models');
      const catalogue = fixtureCatalogue(fixture.url);
      const { layer, db } = build({ catalogue, modelsDir });
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const manager = Context.get(ctx, ModelManager);

      yield* manager.download('fixture-bundle');
      yield* waitFor(manager, s => modelOf(s, 'fixture-bundle').installed);

      // Every part is on disk with its pinned bytes and has a row of its own —
      // the fold is a VIEW, not a change to what "installed" means.
      for (const entry of catalogue) {
        const file = path.join(modelsDir, entry.filename);
        assert.strictEqual(sha1(fs.readFileSync(file)), entry.sha1, entry.id);
        assert.strictEqual(db.localModels.get(entry.id)?.path, file);
        assert.deepStrictEqual(yield* manager.installedPath(entry.id), Option.some(file));
      }
      assert.deepStrictEqual([...fixture.requests].sort(), [...PART_NAMES].sort());
      const installed = modelOf(yield* manager.list, 'fixture-bundle');
      assert.isNull(installed.download);
      assert.isNotNull(installed.installedAt);

      yield* manager.delete('fixture-bundle');
      const after = modelOf(yield* manager.list, 'fixture-bundle');
      assert.isFalse(after.installed);
      for (const entry of catalogue) {
        assert.isFalse(fs.existsSync(path.join(modelsDir, entry.filename)), entry.id);
        assert.isUndefined(db.localModels.get(entry.id));
      }
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('refuses a second download of a bundle that is already installed', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fixture = yield* makeFixture().pipe(Scope.extend(scope));
      const modelsDir = freshDir('models');
      const { layer } = build({ catalogue: fixtureCatalogue(fixture.url), modelsDir });
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const manager = Context.get(ctx, ModelManager);

      yield* manager.download('fixture-bundle');
      yield* waitFor(manager, s => modelOf(s, 'fixture-bundle').installed);
      const refusal = yield* Effect.either(manager.download('fixture-bundle'));
      assert.isTrue(refusal._tag === 'Left');
      if (refusal._tag === 'Left') {
        assert.strictEqual(refusal.left.reason, 'already-installed');
        assert.strictEqual(refusal.left.modelId, 'fixture-bundle');
      }
      yield* Scope.close(scope, Exit.void);
    })
  );
});

describe('ModelManager import', () => {
  it.effect('links an existing copy instead of downloading it', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fixture = yield* makeFixture().pipe(Scope.extend(scope));
      const modelsDir = freshDir('models');
      const external = stageExternalCopy(freshDir('elsewhere'), PART_NAMES);
      const catalogue = fixtureCatalogue(fixture.url);
      const { layer } = build({ catalogue, modelsDir });
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const manager = Context.get(ctx, ModelManager);

      const result = yield* manager.import('fixture-bundle', external);
      assert.strictEqual(result.outcome, 'imported');
      assert.strictEqual(result.imported, 4);
      assert.strictEqual(result.total, 4);
      assert.strictEqual(result.sourceDir, external);

      // Installed, marked as linked, and NOT a byte fetched.
      const row = modelOf(yield* manager.list, 'fixture-bundle');
      assert.isTrue(row.installed);
      assert.isTrue(row.linked);
      assert.deepStrictEqual(fixture.requests, []);

      // The names differed on disk — only the SHA-1 matched them up — and the
      // installed file is the SAME inode, so the copy cost no extra space.
      for (const name of PART_NAMES) {
        const source = path.join(external, `${name}-model.int8.onnx`);
        const target = path.join(modelsDir, `fixture-${name}.bin`);
        assert.isTrue(fs.existsSync(target), name);
        assert.strictEqual(fs.statSync(target).ino, fs.statSync(source).ino, name);
      }
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('deleting an imported model removes the link, never the original', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fixture = yield* makeFixture().pipe(Scope.extend(scope));
      const modelsDir = freshDir('models');
      const external = stageExternalCopy(freshDir('elsewhere'), PART_NAMES);
      const { layer } = build({ catalogue: fixtureCatalogue(fixture.url), modelsDir });
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const manager = Context.get(ctx, ModelManager);

      yield* manager.import('fixture-bundle', external);
      yield* manager.delete('fixture-bundle');

      assert.isFalse(modelOf(yield* manager.list, 'fixture-bundle').installed);
      for (const name of PART_NAMES) {
        assert.isFalse(fs.existsSync(path.join(modelsDir, `fixture-${name}.bin`)), name);
        const source = path.join(external, `${name}-model.int8.onnx`);
        assert.isTrue(fs.existsSync(source), `original ${name} survives`);
        assert.strictEqual(sha1(fs.readFileSync(source)), sha1(BODIES[name]), name);
      }
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('reports partial when only some parts are there, and the rest still download', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fixture = yield* makeFixture().pipe(Scope.extend(scope));
      const modelsDir = freshDir('models');
      const external = stageExternalCopy(freshDir('elsewhere'), ['encoder', 'tokens']);
      const { layer } = build({ catalogue: fixtureCatalogue(fixture.url), modelsDir });
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const manager = Context.get(ctx, ModelManager);

      const result = yield* manager.import('fixture-bundle', external);
      assert.strictEqual(result.outcome, 'partial');
      assert.strictEqual(result.imported, 2);
      assert.strictEqual(result.total, 4);
      assert.isFalse(modelOf(yield* manager.list, 'fixture-bundle').installed);

      // The fan-out fetches ONLY what the import could not supply.
      yield* manager.download('fixture-bundle');
      yield* waitFor(manager, s => modelOf(s, 'fixture-bundle').installed);
      assert.deepStrictEqual([...fixture.requests].sort(), ['decoder', 'joiner']);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('will not adopt a file that is the right size but the wrong bytes', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fixture = yield* makeFixture().pipe(Scope.extend(scope));
      const modelsDir = freshDir('models');
      const external = freshDir('elsewhere');
      fs.mkdirSync(external, { recursive: true });
      // Same length as the real encoder, and even the catalogue's own filename
      // — everything but the bytes.
      const impostor = Buffer.alloc(BODIES.encoder.length, 0x5a);
      fs.writeFileSync(path.join(external, 'fixture-encoder.bin'), impostor);
      const { layer, logger } = build({ catalogue: fixtureCatalogue(fixture.url), modelsDir });
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const manager = Context.get(ctx, ModelManager);

      const result = yield* manager.import('fixture-bundle', external);
      assert.strictEqual(result.outcome, 'not-found');
      assert.strictEqual(result.imported, 0);
      assert.isFalse(modelOf(yield* manager.list, 'fixture-bundle').installed);
      assert.isFalse(fs.existsSync(path.join(modelsDir, 'fixture-encoder.bin')));
      assert.isUndefined(logger.find(entry => entry.message.includes('adopted')));
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('scans the known model directories when no folder is given', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fixture = yield* makeFixture().pipe(Scope.extend(scope));
      const modelsDir = freshDir('models');
      const root = freshDir('app-support');
      // Nested the way another app would keep it, not at the root of the scan.
      const external = stageExternalCopy(
        path.join(root, 'SomeOtherApp', 'Models', 'parakeet'),
        PART_NAMES
      );
      const { layer } = build({
        catalogue: fixtureCatalogue(fixture.url),
        modelsDir,
        externalRoots: [root],
      });
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const manager = Context.get(ctx, ModelManager);

      const result = yield* manager.import('fixture-bundle', null);
      assert.strictEqual(result.outcome, 'imported');
      assert.strictEqual(result.sourceDir, external);
      assert.isTrue(modelOf(yield* manager.list, 'fixture-bundle').linked);
      assert.deepStrictEqual(fixture.requests, []);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('finds nothing when the roots hold no matching bytes', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fixture = yield* makeFixture().pipe(Scope.extend(scope));
      const root = freshDir('app-support');
      fs.mkdirSync(path.join(root, 'Unrelated'), { recursive: true });
      fs.writeFileSync(path.join(root, 'Unrelated', 'notes.txt'), 'nothing to see');
      const { layer } = build({
        catalogue: fixtureCatalogue(fixture.url),
        modelsDir: freshDir('models'),
        externalRoots: [root],
      });
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const manager = Context.get(ctx, ModelManager);

      const result = yield* manager.import('fixture-bundle', null);
      assert.deepStrictEqual(result, {
        outcome: 'not-found',
        imported: 0,
        total: 4,
        sourceDir: null,
      });
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('answers already-installed rather than rescanning', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fixture = yield* makeFixture().pipe(Scope.extend(scope));
      const modelsDir = freshDir('models');
      const external = stageExternalCopy(freshDir('elsewhere'), PART_NAMES);
      const { layer } = build({ catalogue: fixtureCatalogue(fixture.url), modelsDir });
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const manager = Context.get(ctx, ModelManager);

      yield* manager.import('fixture-bundle', external);
      const again = yield* manager.import('fixture-bundle', external);
      assert.strictEqual(again.outcome, 'already-installed');
      assert.strictEqual(again.imported, 0);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('answers unknown-model for an id in neither the catalogue nor the bundles', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const fixture = yield* makeFixture().pipe(Scope.extend(scope));
      const { layer } = build({
        catalogue: fixtureCatalogue(fixture.url),
        modelsDir: freshDir('models'),
      });
      const ctx = yield* Layer.build(layer).pipe(Scope.extend(scope));
      const manager = Context.get(ctx, ModelManager);

      const result = yield* manager.import('not-a-model', null);
      assert.strictEqual(result.outcome, 'unknown-model');
      yield* Scope.close(scope, Exit.void);
    })
  );
});
