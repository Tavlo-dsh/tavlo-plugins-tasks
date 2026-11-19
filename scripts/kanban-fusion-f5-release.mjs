import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const required = key => { assert(process.env[key], `Set ${key}`); return resolve(process.env[key]) }
const cli = required('DSH_CLI'), old = required('FUSION_V5_PACKAGE'), candidate = required('FUSION_TAVLO_PACKAGE')
const output = required('FUSION_PROBE_OUTPUT'), executablePath = required('BROWSER_EXE')
const { chromium } = await import(pathToFileURL(required('PLAYWRIGHT_MODULE')).href)
const root = await mkdtemp(join(await realpath(tmpdir()), 'tavlo-f5-')), live = join(root, 'live'), restored = join(root, 'restored')
const run = promisify(execFile), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const digest = async path => hash(await readFile(path))
const env = { ...process.env, DSH_TELEMETRY_DISABLED: '1', npm_config_offline: 'true' }
for (const key of Object.keys(env)) if (/API_?KEY|TOKEN|SECRET|PASSWORD|^NODE_(PATH|OPTIONS)$/i.test(key)) delete env[key]
const command = (home, args) => run(process.execPath, [cli, ...args], { cwd: root, env: { ...env, DSH_HOME: home }, windowsHide: true, timeout: 180000 })
const install = (home, archive) => command(home, ['plugin', '--profile', 'web', 'add', '--prod', archive, '--offline', '--reporter=append-only'])
const checks = [], pass = name => { checks.push(name); console.log('PASS:', name) }
let child, exited, control, browser, context, client, completed = false

async function start(home, name, seed = false) {
  control = join(root, name); await mkdir(control)
  if (seed) for (const title of ['F5 Alpha', 'F5 Beta']) await mkdir(join(control, title))
  const patch = join(control, 'offline.yml')
  await writeFile(patch, `- id: agent-default-model\n  config:\n    provider: tasks-f5-offline\n    model: offline\n- id: workspace-controller\n  config:\n    documentsDirectory: ${JSON.stringify(join(root, 'documents'))}\n- id: ui-settings-general\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n- id: ui-settings-account\n  disabled: true\n- id: ui-settings-models\n  disabled: true\n- insert:\n    - id: f5-fixture\n      name: ${JSON.stringify(new URL('./kanban-fusion-f5-control.mjs', import.meta.url).href)}\n      config:\n        control: ${JSON.stringify(control)}\n        seed: ${seed}\n`)
  const logPath = join(control, 'private.log'), log = await open(logPath, 'wx')
  try {
    child = spawn(process.execPath, [cli, '--profile', 'web', '--patch', patch, '--no-open', '--host', '127.0.0.1', '--port', '0'], { cwd: root, env: { ...env, DSH_HOME: home }, windowsHide: true, stdio: ['ignore', log.fd, log.fd] })
    exited = new Promise((resolveExit, reject) => { child.once('exit', resolveExit); child.once('error', reject) })
  } finally { await log.close() }
  for (let attempt = 0; attempt < 480; attempt++) {
    assert.equal(child.exitCode, null, `${name} exited before ready`)
    const login = (await readFile(logPath, 'utf8')).match(/http:\/\/127\.0\.0\.1:\d+\/[^\s\x1b]*/)?.[0]
    if (login) return login
    await delay(250)
  }
  throw Error(`${name}: Host not ready`)
}

async function stop() {
  await client?.close(); client = undefined
  await context?.close(); context = undefined
  await writeFile(join(control, 'stop'), 'stop')
  let timer
  try { assert.equal(await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Host did not stop')), 25000) })]), 0) }
  finally { clearTimeout(timer) }
  assert.equal(await readFile(join(control, 'disposed'), 'utf8'), 'ok'); child = undefined
}

async function board(login) {
  const origin = new URL(login).origin
  context = await browser.newContext({ viewport: { width: 1480, height: 900 }, locale: 'zh-CN', serviceWorkers: 'block' })
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  const page = await context.newPage(); page.setDefaultTimeout(18000)
  await page.addLocatorHandler(page.getByText(/^(开始使用|Get started)$/), () => page.getByRole('button', { name: /^(关闭|Close)$/ }).last().click())
  await page.goto(login, { waitUntil: 'domcontentloaded' }); await page.getByText(/^(任务|Tasks)$/).first().click()
  await page.locator('[data-task-sync="live"]').waitFor()
  const cookie = (await context.cookies(origin)).map(item => `${item.name}=${item.value}`).join('; ')
  client = new Client({ name: 'f5-acceptance', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL('/api/dsh-plugin-tasks/mcp', origin), { requestInit: { headers: { cookie }, redirect: 'error' } }))
  return page
}

async function tool(name, input = {}) {
  const result = await client.callTool({ name: `tasks_${name}`, arguments: input })
  assert(!result.isError, JSON.stringify(result.structuredContent)); return result.structuredContent.value
}

async function reconnect(page, title) {
  const editor = await context.newPage()
  try {
    await editor.addInitScript(() => {
      const fetch = window.fetch.bind(window)
      window.fetch = (input, options) => {
        if (!String(input).endsWith('/dsh-plugin-tasks/events')) return fetch(input, options)
        if (window.f5Offline) return Promise.reject(new TypeError('F5 stream disconnected'))
        const controller = new AbortController()
        window.f5Disconnect = () => { window.f5Offline = true; controller.abort() }
        return fetch(input, { ...options, signal: AbortSignal.any([controller.signal, options.signal]) })
      }
    })
    await editor.goto(page.url(), { waitUntil: 'domcontentloaded' }); await editor.getByText(/^(任务|Tasks)$/).first().click()
    await editor.locator('[data-task-sync="live"]').waitFor(); await editor.getByRole('button', { name: title, exact: true }).click()
    const drawer = editor.locator('.dsh-tasks-drawer'), brief = drawer.locator('[name=brief]')
    await drawer.getByRole('button', { name: /^(编辑描述|Edit description)$/ }).click()
    await brief.fill('F5 unsaved local draft'); await editor.evaluate(() => window.f5Disconnect())
    await editor.locator('[data-task-sync="offline"]').waitFor()
    const card = page.locator('.dsh-tasks-card').filter({ has: page.getByRole('button', { name: title, exact: true }) })
    await card.locator('summary').click(); await card.getByRole('button', { name: /^(移入|Move to) F5 Review$/ }).click()
    await page.locator('.dsh-tasks-col[aria-label="F5 Review"]').getByRole('button', { name: title, exact: true }).waitFor()
    await editor.evaluate(() => { window.f5Offline = false; window.dispatchEvent(new Event('online')) })
    await editor.locator('[data-task-sync="live"]').waitFor(); await drawer.locator('[role=alert]').waitFor()
    assert.equal(await brief.inputValue(), 'F5 unsaved local draft'); assert(await drawer.getByRole('button', { name: /^(保存修改|Save changes)$/ }).isDisabled())
    await drawer.locator('[role=alert] button').click()
    await editor.getByRole('alertdialog').getByRole('button', { name: /放弃.*载入|discard.*load/i }).click()
    await drawer.locator('.dsh-tasks-description-empty').waitFor()
    assert.equal(await brief.count(), 0)
    await editor.reload({ waitUntil: 'domcontentloaded' }); await editor.getByText(/^(任务|Tasks)$/).first().click()
    await editor.locator('.dsh-tasks-col[aria-label="F5 Review"]').getByRole('button', { name: title, exact: true }).waitFor()
  } finally { await editor.close() }
  pass('Two tabs: severed SSE misses a move, reconnect preserves dirty text and blocks stale save; reload restores placement')
}

async function files(home) {
  const dbs = (await readdir(join(home, 'storages'))).filter(name => /^tasks\.sqlite(?:-wal|-shm|-journal)?$/.test(name))
  assert(dbs.includes('tasks.sqlite'))
  const paths = dbs.map(name => `storages/${name}`)
  async function walk(dir) {
    for (const entry of await readdir(join(home, dir), { withFileTypes: true })) {
      const path = dir + '/' + entry.name
      if (entry.isDirectory()) await walk(path)
      else { assert(entry.isFile()); paths.push(path) }
    }
  }
  try { await walk('attachments/v1') } catch (error) { if (error.code !== 'ENOENT') throw error }
  return Object.fromEntries(await Promise.all(paths.sort().map(async path => [path, await digest(join(home, path))])))
}

async function copySet(home, target) {
  assert(!child, 'Copy only after confirmed shutdown')
  const manifest = await files(home)
  for (const path of Object.keys(manifest)) {
    await mkdir(dirname(join(target, path)), { recursive: true })
    await cp(join(home, path), join(target, path), { force: false, errorOnExist: true })
  }
  assert.deepEqual(await files(target), manifest); return manifest
}

function verifyDb(home, version) {
  const db = new DatabaseSync(join(home, 'storages', 'tasks.sqlite'), { readOnly: true })
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.equal(db.prepare("SELECT version FROM units WHERE name='tasks'").get().version, version)
  } finally { db.close() }
}

try {
  await mkdir(output, { recursive: true }); await mkdir(join(root, 'documents'))
  const legal = ['LICENSE', 'licenses/dsh-kanban-MIT.txt', 'licenses/looseleaf-MIT.txt', 'licenses/uiarc-MIT.txt', 'lib/client.js.LEGAL.txt', 'bin/tasks-mcp.js']
  const entries = (await run('tar', ['-tf', candidate])).stdout.split(/\r?\n/)
  for (const file of legal) assert(entries.includes('package/' + file), `Missing ${file}`)
  pass('Candidate tarball contains MCP bridge, component licenses and upstream attribution')
  await install(live, old); await start(live, 'old-host', true)
  const seed = JSON.parse(await readFile(join(control, 'seed.json'), 'utf8'))
  assert.equal(new Set(seed.map(task => task.workspaceId)).size, 3)
  await stop(); verifyDb(live, 5)
  const oldBackup = join(root, 'before-upgrade'), before = await copySet(live, oldBackup)
  pass('Frozen package creates three tasks through sibling taskService; replay is idempotent; stopped v5 backup verified')
  const readPackageName = async archive => JSON.parse((await run('tar', ['-xOf', archive, 'package/package.json'])).stdout).name
  const oldPackageName = await readPackageName(old)
  const candidatePackageName = await readPackageName(candidate)
  if (oldPackageName !== candidatePackageName) await command(live, ['plugin', '--profile', 'web', 'remove', oldPackageName, '--offline'])
  await install(live, candidate)
  browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-gpu'] })
  const login = new URL(await start(live, 'upgraded')), page = await board(login.href)
  const { task } = await tool('get', { taskId: seed[0].id }), taskId = task.id
  const bridge = new Client({ name: 'f5-installed-stdio', version: '1' })
  try {
    await bridge.connect(new StdioClientTransport({ command: process.execPath, args: [join(live, 'profiles/web/node_modules', candidatePackageName, 'bin/tasks-mcp.js')],
      cwd: root, env: { ...env, DSH_HOME: live, DSH_TASKS_URL: login.origin, DSH_TASKS_TOKEN: login.searchParams.get('token') }, stderr: 'pipe' }))
    const tools = (await bridge.listTools()).tools.map(tool => tool.name)
    assert(tools.includes('tasks_comment') && tools.includes('tasks_move')); assert(!tools.some(tool => /launch|delete/.test(tool)))
    const read = await bridge.callTool({ name: 'tasks_get', arguments: { taskId } }); assert.deepEqual(read.structuredContent.value.task, task)
  } finally { await bridge.close() }
  pass('Installed stdio bridge authenticates its own API peer and reads the same sourced task without browser cookies')
  assert.deepEqual(task.externalRef, seed[0].externalRef); assert.equal(task.columnId, 'stage:todo')
  for (const { title } of seed) await page.getByRole('button', { name: title, exact: true }).waitFor()
  const drawer = page.locator('.dsh-tasks-drawer')
  const settings = page.locator('.dsh-tasks-settings > summary')
  const manager = page.locator('dialog.dsh-tasks-management-dialog[open]')
  for (const [manage, name] of [[/^(管理列|Manage columns)$/, 'F5 Review'], [/^(管理标签|Manage labels)$/, 'F5 Shared']]) {
    await settings.click(); await page.getByRole('button', { name: manage }).click()
    const form = manager.locator('.dsh-tasks-manage-create'); await form.locator('input[name=name]').fill(name); await form.locator('[type=submit]').click()
    await manager.locator(`.dsh-tasks-manage-list input[value="${name}"]`).waitFor(); await page.keyboard.press('Escape'); await manager.waitFor({ state: 'hidden' })
    assert(await settings.evaluate(element => document.activeElement === element))
  }
  const summary = page.locator('.dsh-tasks-filter summary'); await summary.click()
  const filter = page.locator('.dsh-tasks-filter').getByRole('combobox').first()
  for (const [label, expected] of [['F5 Alpha', seed[0]], ['F5 Beta', seed[1]], [/^(未分组|Ungrouped)$/, seed[2]]]) {
    await filter.click(); await page.getByRole('option', { name: label, exact: true }).click()
    await page.getByRole('button', { name: expected.title, exact: true }).waitFor()
    assert.equal(await page.locator('.dsh-tasks-card').count(), 1)
    await page.locator('.dsh-tasks-col[aria-label="F5 Review"]').waitFor()
    const labels = page.locator('.dsh-tasks-filter .dsh-tasks-select').filter({ has: page.locator('input[name=labelId]') })
    await labels.getByRole('combobox').click(); await labels.getByRole('option', { name: 'F5 Shared' }).waitFor(); await page.keyboard.press('Escape')
  }
  await filter.click(); await page.getByRole('option', { name: /全部工作区|All workspaces/i }).click(); await summary.click()
  pass('Installed candidate upgrades same home; two workspaces and ungrouped share a board and filter independently')
  await reconnect(page, seed[1].title)
  await tool('move', { taskId, columnId: 'stage:doing', expectedRevision: task.revision })
  await tool('comment', { taskId, text: 'F5 handoff', requestId: 'f5-comment' })
  const card = page.locator('[data-column-id="stage:doing"]').getByRole('button', { name: task.title, exact: true }); await card.click()
  await page.locator('.dsh-tasks-drawer li', { hasText: 'F5 handoff' }).waitFor()
  const bytes = Buffer.from(await page.evaluate(() => document.createElement('canvas').toDataURL('image/png').split(',')[1]), 'base64')
  await page.locator('.dsh-tasks-images input[type=file]').setInputFiles({ name: 'restore.png', mimeType: 'image/png', buffer: bytes })
  const image = page.locator('.dsh-tasks-thumb img'); await image.waitFor()
  const imageUrl = new URL(await image.evaluate(element => element.src)), imagePath = imageUrl.pathname + imageUrl.search
  const readImage = async page => { const res = await context.request.get(new URL(imagePath, page.url()).href); assert(res.ok()); return hash(await res.body()) }
  const imageDigest = hash(bytes); assert.equal(await readImage(page), imageDigest)
  const history = await tool('history', { taskId }), tasks = await tool('list'), layout = await tool('board')
  assert(history.events.some(event => event.kind === 'comment' && event.source === 'agent'))
  assert(history.events.some(event => event.kind === 'image-added'))
  const palette = async () => drawer.evaluate(element => getComputedStyle(element).color)
  await page.emulateMedia({ colorScheme: 'light' }); await page.locator('body:not([data-ds-dark-theme])').waitFor()
  const lightText = await palette(); await page.screenshot({ path: join(output, 'mcp-browser-image.png') })
  await page.emulateMedia({ colorScheme: 'dark' }); await page.locator('body[data-ds-dark-theme]').waitFor()
  assert.notEqual(await palette(), lightText); await page.screenshot({ path: join(output, 'mcp-browser-dark.png') })
  pass('Open task drawer follows the light and dark Host palettes')
  await stop(); verifyDb(live, 8)
  const snapshot = join(root, 'snapshot'), manifest = await copySet(live, snapshot)
  assert(Object.keys(manifest).some(path => path.startsWith('attachments/v1/')))
  pass('Agent MCP move/comment reaches browser over SSE; native PNG bytes and SQLite captured together after Host disposal')
  await board(await start(live, 'post-backup')); await tool('create', { title: 'After snapshot', requestId: 'post-backup' }); assert.equal((await tool('list')).total, tasks.total + 1); await stop()
  const later = await files(live); assert.notDeepEqual(later, manifest)
  await install(restored, candidate); await copySet(snapshot, restored); verifyDb(restored, 8)
  const recovered = await board(await start(restored, 'restore-host'))
  assert.deepEqual(await tool('list'), tasks); assert.deepEqual(await tool('board'), layout); assert.deepEqual(await tool('history', { taskId }), history)
  assert.equal(await readImage(recovered), imageDigest)
  await tool('comment', { taskId, text: 'F5 handoff', requestId: 'f5-comment' }); assert.deepEqual(await tool('history', { taskId }), history)
  if (process.env.FUSION_F5_TOUCH === '1') {
    const { verifyTouch } = await import('./kanban-fusion-f5-touch.mjs')
    await verifyTouch({ page: recovered, tool, title: task.title, taskId, output, pass })
  }
  await stop(); assert.deepEqual(await files(live), later); assert.deepEqual(await files(oldBackup), before); assert.deepEqual(await files(snapshot), manifest)
  pass('Fresh restore matches task IDs/order, board, history, replay and original image hash; later live writes and backups untouched')
  await writeFile(join(output, 'release-probe.json'), JSON.stringify({ capturedAt: new Date().toISOString(), node: process.version, dsh: (await command(live, ['--version'])).stdout.trim(), browser: browser.version(), checks, candidate: await digest(candidate), v5: await digest(old), imageDigest, manifest }, null, 2) + '\n')
  completed = true
} finally {
  await browser?.close()
  if (child && child.exitCode === null && child.signalCode === null) {
    try { await stop() } catch { if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32') await run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); else child.kill('SIGKILL')
      await exited
    } }
  }
  if (completed) {
    const target = await realpath(root); assert.equal(dirname(target), await realpath(tmpdir())); assert(basename(target).startsWith('tavlo-f5-'))
    await rm(target, { recursive: true, force: true })
  } else console.error('Private synthetic fixture retained for diagnosis:', root)
}
