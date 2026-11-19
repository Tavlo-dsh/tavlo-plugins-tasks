import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { bundleCalendar } from './bundle-calendar.mjs'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
let bundled = source
const calendar = await bundleCalendar()
for (const name of ['@dnd-kit/core', './calendar/task-date-picker.jsx']) {
  const marker = `require('${name}')`
  if (source.split(marker).length !== 2) throw new Error(`Expected one ${name} import in the DSH module factory`)
  const result = name.startsWith('./') ? calendar : await build({ stdin: { contents: `module.exports = ${marker}`, resolveDir: process.cwd() },
  bundle: true, format: 'cjs', platform: 'browser', minify: true, write: false, target: 'es2020',
  external: ['react', 'react-dom'], define: { 'process.env.NODE_ENV': '"production"' } })
  bundled = bundled.replace(marker, () => `(() => { const module = { exports: {} }; ${result.outputFiles[0].text}\nreturn module.exports })()`)
}
const out = new URL('../lib/', import.meta.url)
await mkdir(out, { recursive: true })
await writeFile(new URL('client.js', out), bundled)
const calendarPackages = Object.keys(calendar.metafile.inputs).flatMap(file => file.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1] || [])
const licenses = await Promise.all([...new Set(['@dnd-kit/core', '@dnd-kit/accessibility', '@dnd-kit/utilities', 'tslib', ...calendarPackages])].map(async name => {
  const base = new URL(`../node_modules/${name}/`, import.meta.url)
  if (name === 'react-remove-scroll-bar') return name + '\n' + await readFile(new URL('../licenses/react-remove-scroll-bar-MIT.txt', import.meta.url), 'utf8')
  for (const file of ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'LICENSE-MIT', 'license']) {
    try { return name + '\n' + await readFile(new URL(file, base), 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  throw new Error('Missing license for ' + name)
}))
licenses.push(await readFile(new URL('../calendar/vendor/looseleaf/LICENSE', import.meta.url), 'utf8'))
await writeFile(new URL('client.js.LEGAL.txt', out), licenses.join('\n\n'))
