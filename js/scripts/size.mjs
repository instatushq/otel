import { build } from 'esbuild'
import { gzipSync } from 'node:zlib'

const LIMITS = [
  {
    name: 'errors (init + captureException)',
    contents: "export { init, captureException } from './src/browser/index.ts'",
    limitKb: 15
  },
  {
    name: 'errors (whole entry)',
    contents: "export * from './src/browser/index.ts'",
    limitKb: 15
  },
  {
    name: 'tracing (whole entry)',
    contents: "export * from './src/tracing/index.ts'"
  }
]

let failed = false

for (const { name, contents, limitKb } of LIMITS) {
  const result = await build({
    stdin: { contents, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true,
    minify: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    target: 'es2020',
    legalComments: 'none'
  })
  const bytes = result.outputFiles[0].contents
  const gzippedKb = gzipSync(bytes).length / 1024
  const summary = `${name}: ${(bytes.length / 1024).toFixed(1)} KB minified, ${gzippedKb.toFixed(1)} KB gzipped`
  if (limitKb !== undefined && gzippedKb > limitKb) {
    failed = true
    console.error(`${summary}, over the ${limitKb} KB limit`)
  } else {
    console.log(
      limitKb === undefined ? summary : `${summary} (limit ${limitKb} KB)`
    )
  }
}

if (failed) process.exit(1)
