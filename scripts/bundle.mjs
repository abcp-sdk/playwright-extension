import { build } from 'esbuild'

// Bundle the extension + its TS-source dependencies (`@abc-protocol/sdk` is a
// git dependency that ships raw `.ts`) into a single ESM file so the runtime
// image needs no transpiler. `playwright-core` is precompiled JS and stays
// external (it is a real, resolvable package), as do Node builtins.
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node26',
  outfile: 'dist/main.js',
  external: ['playwright-core'],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
})
