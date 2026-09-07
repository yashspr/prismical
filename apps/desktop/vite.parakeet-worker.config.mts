/**
 * The Parakeet worker bundle — a SEPARATE single-entry vite build of
 * src/main/infra/parakeet/parakeet-worker-fork.ts into
 * .vite/build/parakeet-worker-fork.js.
 *
 * Separate for exactly the reason vite.worker.config.mts is: as another rollup
 * input of the MAIN build, rollup would hoist the modules this entry shares
 * with main (infra/whisper/protocol.ts, which parakeet's protocol re-exports)
 * into a hash-named chunk, and the emitted worker would start with
 * `require('./protocol-<hash>.js')`. The forge asar.unpack glob unpacks only
 * the worker file, so that chunk would stay INSIDE app.asar — which the plain
 * Node SIDECAR the worker runs under cannot read. A single-entry build has
 * nothing to share, so the protocol inlines and the worker is self-contained.
 *
 * `sherpa-onnx-node` stays EXTERNAL: it loads a prebuilt .node binary from its
 * platform package at require time, so it must remain a runtime require the
 * worker resolves with a real node_modules walk (shipped unpacked, like the
 * whisper wrapper).
 */
import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const builtins = [
  'electron',
  'electron/common',
  'electron/main',
  ...builtinModules.flatMap(m => [m, `node:${m}`]),
];

export default defineConfig({
  build: {
    outDir: '.vite/build',
    emptyOutDir: false,
    copyPublicDir: false,
    minify: true,
    lib: {
      entry: resolve(__dirname, 'src/main/infra/parakeet/parakeet-worker-fork.ts'),
      formats: ['cjs'],
      fileName: () => 'parakeet-worker-fork.js',
    },
    rollupOptions: {
      external: ['better-sqlite3', 'sherpa-onnx-node', ...builtins],
    },
  },
  resolve: {
    conditions: ['node'],
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
});
