/** Verify the reviewed immutable snapshot. No compilation or runtime dependency.
 * node scripts/looseleaf-audit.mjs [downloaded-upstream-directory]
 * Without a directory, files are fetched only from the commit in the lock file.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

const lock = JSON.parse(await readFile(new URL('../docs/looseleaf-source-lock.json', import.meta.url)))
assert.match(lock.commit, /^[a-f0-9]{40}$/)
const digest = (kind, bytes) => createHash(kind).update(bytes).digest('hex')
const pending = [...lock.files]
let verified = 0
async function worker() {
  while (pending.length) {
    const file = pending.shift()
    assert(!file.path.startsWith('/') && !file.path.split('/').includes('..'))
    let bytes
    if (process.argv[2]) bytes = await readFile(resolve(process.argv[2], file.path))
    else {
      let failure
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetch(`https://raw.githubusercontent.com/kevintngo/looseleaf/${lock.commit}/${file.path}`, { signal: AbortSignal.timeout(30000) })
          assert(response.ok, `${file.path}: HTTP ${response.status}`)
          bytes = Buffer.from(await response.arrayBuffer()); break
        } catch (error) { failure = error }
      }
      if (!bytes) throw new Error(`Cannot fetch ${file.path}`, { cause: failure })
    }
    assert.equal(bytes.length, file.bytes, file.path + ' length')
    assert.equal(digest('sha256', bytes), file.sha256, file.path + ' SHA-256')
    assert.equal(digest('sha1', Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])), file.gitBlob, file.path + ' Git blob')
    for (const notice of lock.copiedNotices.filter(row => row.upstream === file.path)) {
      assert(bytes.equals(await readFile(new URL('../' + notice.local, import.meta.url))), 'Exact license copy')
    }
    verified++
  }
}
await Promise.all(Array.from({ length: 4 }, worker))
for (const file of lock.copiedRuntimeFiles) {
  const text = await readFile(new URL('../' + file.local, import.meta.url), 'utf8')
  for (const asset of file.assets ?? []) {
    const uri = text.match(new RegExp(`const ${asset.symbol} = '([^']+)'`))?.[1]
    assert(uri?.startsWith('data:image/png;base64,'), asset.symbol)
    const bytes = Buffer.from(uri.split(',')[1], 'base64')
    assert.equal(bytes.length, asset.bytes, asset.symbol + ' PNG bytes')
    assert.equal(digest('sha256', bytes), asset.sha256, asset.symbol + ' PNG SHA-256')
  }
}
console.log(JSON.stringify({ commit: lock.commit, verifiedFiles: verified, copiedRuntimeFiles: lock.copiedRuntimeFiles, licenseMatches: true }, null, 2))
