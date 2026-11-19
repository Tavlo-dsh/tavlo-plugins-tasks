import { copyFile, mkdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, relative, resolve, sep } from 'node:path'
import { bundleCalendar, vendor } from './bundle-calendar.mjs'

const checkout = process.argv[2]
if (!checkout || execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== '4bdb647940e2fefb3cebb394f3bad25c766a27d2') throw new Error('Expected the pinned Looseleaf checkout')
const root = resolve(checkout, 'src'), result = await bundleCalendar(root)
for (const file of Object.keys(result.metafile.inputs).map(file => resolve(file)).filter(file => file.startsWith(root + sep))) {
  const destination = resolve(vendor, relative(root, file))
  await mkdir(dirname(destination), { recursive: true }); await copyFile(file, destination)
}
await copyFile(resolve(checkout, 'LICENSE'), resolve(vendor, 'LICENSE'))
