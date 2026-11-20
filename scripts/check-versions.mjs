import { readFileSync } from 'node:fs'

// One v<version> tag releases every package together, so every place that
// names the version has to agree.
const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

const versions = {
  'js/package.json': JSON.parse(read('js/package.json')).version,
  'js/src/core/version.ts': read('js/src/core/version.ts').match(
    /SDK_VERSION = '([^']+)'/
  )?.[1],
  'swift/Sources/Instatus/Version.swift': read(
    'swift/Sources/Instatus/Version.swift'
  ).match(/version = "([^"]+)"/)?.[1],
  'python/src/instatus_otel/version.py': read(
    'python/src/instatus_otel/version.py'
  ).match(/__version__ = "([^"]+)"/)?.[1],
  'go/version.go': read('go/version.go').match(
    /const Version = "([^"]+)"/
  )?.[1],
  'java/pom.xml': read('java/pom.xml').match(
    /<artifactId>instatus-otel<\/artifactId>\s*<version>([^<]+)<\/version>/
  )?.[1],
  'java/src/main/java/com/instatus/otel/Version.java': read(
    'java/src/main/java/com/instatus/otel/Version.java'
  ).match(/VERSION = "([^"]+)"/)?.[1],
  'ruby/lib/instatus/otel/version.rb': read(
    'ruby/lib/instatus/otel/version.rb'
  ).match(/VERSION = "([^"]+)"/)?.[1],
  'dotnet/src/Instatus.Otel/Version.cs': read(
    'dotnet/src/Instatus.Otel/Version.cs'
  ).match(/Version = "([^"]+)"/)?.[1],
  'dotnet/src/Instatus.Otel/Instatus.Otel.csproj': read(
    'dotnet/src/Instatus.Otel/Instatus.Otel.csproj'
  ).match(/<Version>([^<]+)<\/Version>/)?.[1],
  'php/src/Version.php': read('php/src/Version.php').match(
    /VERSION = '([^']+)'/
  )?.[1]
}

const distinct = new Set(Object.values(versions))
if (distinct.size !== 1 || distinct.has(undefined)) {
  for (const [file, version] of Object.entries(versions))
    console.error(`${file}: ${version}`)
  console.error('Versions must match.')
  process.exit(1)
}
console.log([...distinct][0])
