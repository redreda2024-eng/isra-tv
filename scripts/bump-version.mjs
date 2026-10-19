import { readFileSync, writeFileSync } from 'node:fs'

const pkgPath = new URL('../package.json', import.meta.url)
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const parts = pkg.version.split('.').map(Number)
parts[2] = (parts[2] ?? 0) + 1
pkg.version = parts.join('.')
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
console.log(`Version bumped to ${pkg.version}`)
