import { build } from 'esbuild'
import { rm } from 'node:fs/promises'

const ENTRIES = {
  browser: 'src/browser/index.ts',
  'browser-tracing': 'src/tracing/index.ts',
  react: 'src/react/index.tsx',
  node: 'src/node/index.ts',
  'react-native': 'src/react-native/index.ts'
}

const shared = {
  bundle: true,
  packages: 'external',
  platform: 'neutral',
  target: 'es2020',
  jsx: 'automatic',
  sourcemap: true,
  legalComments: 'inline'
}

await rm('dist', { recursive: true, force: true })

// ESM entries share chunks, so the client exists once and each subpath
// carries only what it uses; CommonJS can't split, so each entry stands alone.
await Promise.all([
  build({
    ...shared,
    entryPoints: ENTRIES,
    outdir: 'dist',
    format: 'esm',
    splitting: true,
    chunkNames: 'chunks/[name]-[hash]'
  }),
  ...Object.entries(ENTRIES).map(([name, file]) =>
    build({
      ...shared,
      entryPoints: [file],
      outfile: `dist/${name}.cjs`,
      format: 'cjs'
    })
  )
])
