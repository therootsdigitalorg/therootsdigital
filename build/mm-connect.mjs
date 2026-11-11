// Bundles the official MetaMask Connect SDK (@metamask/connect-evm) for self-hosting at /vendor/mm-connect/.
// Usage: npm run build:mm   (output is committed, so deployments need no build step)
//
// Why self-host: jsDelivr's automatic "+esm" bundling breaks the SDK's Stencil UI (install / QR modal) and its
// mobile relay, and self-hosting removes the third-party CDN from the Content-Security-Policy.
// Fixes applied here: (1) single file, no code splitting — esbuild's split chunks lose the named exports of CommonJS
// dependencies that the SDK loads with import() (eciesjs → 'PrivateKey is not a constructor'); (2) a Buffer polyfill;
// (3) @metamask/mobile-wallet-protocol-core ships an ES-module build (dist/index.mjs) but does not
// declare it in package.json, so bundlers pick the CommonJS file and the SDK's dynamic import() gets no named
// exports ("Cannot read properties of undefined (reading 'create')"). We resolve it to the .mjs build.
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public/vendor/mm-connect');
rmSync(out, { recursive: true, force: true });

const esmOnly = {
  name: 'prefer-esm-builds',
  setup(b) {
    b.onResolve({ filter: /^@metamask\/mobile-wallet-protocol-core$/ }, () => ({ path: path.join(root, 'node_modules/@metamask/mobile-wallet-protocol-core/dist/index.mjs') }));
  },
};

await build({
  entryPoints: { 'connect-evm': path.join(root, 'build/mm-connect-entry.js') },
  outdir: out, bundle: true, format: 'esm', splitting: false, // splitting drops named exports of CommonJS deps loaded via import() (eciesjs)
  inject: [path.join(root, 'build/buffer-shim.js')], platform: 'browser', target: 'es2020', minify: true,
  chunkNames: 'chunk-[hash]', legalComments: 'external', mainFields: ['browser', 'module', 'main'], conditions: ['browser', 'import', 'module'],
  define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' }, plugins: [esmOnly], logLevel: 'info',
});
