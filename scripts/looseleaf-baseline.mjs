/** Real DSH renderer + fixed in-memory task transport; no production writes.
 * Prerequisites: DSH 0.2.2-rc.1, Playwright, Chromium/Edge (all external dev tools).
 * Set DSH_CLI, PLAYWRIGHT_MODULE, BROWSER_EXE and BASELINE_OUTPUT to absolute paths.
 * Run: node scripts/looseleaf-baseline.mjs
 */
import assert from 'node:assert/strict'
import { readFile, writeFile, open, mkdir, mkdtemp } from 'node:fs/promises'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { tmpdir, cpus, release } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const source = fileURLToPath(new URL('../', import.meta.url))
const required = name => { assert(process.env[name], `Set ${name}`); return resolve(process.env[name]) }
const cli = required('DSH_CLI'), playwright = required('PLAYWRIGHT_MODULE'), executablePath = required('BROWSER_EXE')
const output = required('BASELINE_OUTPUT')
await mkdir(output, { recursive: true })
const root = await mkdtemp(join(tmpdir(), 'dsh-looseleaf-baseline-'))
const env = { ...process.env, DSH_HOME: join(root, 'home'), DSH_TELEMETRY_DISABLED: '1' }
for (const key of Object.keys(env)) if (/API_KEY|AUTH_TOKEN|ACCESS_TOKEN|NODE_PATH/.test(key)) delete env[key]
const run = args => new Promise((resolve, reject) => execFile(process.execPath, [cli, ...args],
  { cwd: root, env, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) =>
    error ? reject(new Error(`DSH command failed; private log: ${root}\n${stderr}`)) : resolve(stdout + stderr)))
const { chromium } = await import(pathToFileURL(playwright))
const client = await readFile(join(source, 'client.js'))
let css = client.toString().match(/const CSS = `([\s\S]*?)`/)?.[1]
assert(css, 'Inline stylesheet found')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const measureBytes = bytes => ({ bytes: Buffer.byteLength(bytes), gzipBytes: gzipSync(bytes, { level: 9 }).length, sha256: digest(bytes) })
const protectedPaths = process.env.BASELINE_PROTECTED_HOME ? ['storages/tasks.json', 'profiles/web/package.json', 'profiles/web/cordis.yml', 'profiles/web/cordis.patch.yml'] : []
const protectedBefore = await Promise.all(protectedPaths.map(async path => ({ path, hash: digest(await readFile(join(process.env.BASELINE_PROTECTED_HOME, path))) })))
let host, browser
const pageErrors = [], consoleErrors = [], unexpectedTaskWrites = []
try {
  console.log('Installing isolated Web profile…')
  await writeFile(join(root, 'install.log'), await run(['plugin', '--profile', 'web', 'add', '--prod', source, '--reporter=append-only']))
  await writeFile(join(root, 'offline.patch.yml'), '- id: agent-default-model\n  config:\n    provider: tasks-baseline-offline\n    model: offline\n- id: ui-settings-general\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n')
  const stdout = await open(join(root, 'host.log'), 'w'), stderr = await open(join(root, 'host-error.log'), 'w')
  host = spawn(process.execPath, [cli, '--profile', 'web', '--patch', join(root, 'offline.patch.yml'), '--no-open', '--port', '0'],
    { cwd: root, env, windowsHide: true, stdio: ['ignore', stdout.fd, stderr.fd] })
  await stdout.close(); await stderr.close()
  let login
  for (let i = 0; i < 400; i++) {
    assert.equal(host.exitCode, null, `Host exited; inspect ${root}`)
    login = (await readFile(join(root, 'host.log'), 'utf8')).match(/http:\/\/127\.0\.0\.1:\d+\/[^\s\x1b]*/)?.[0]
    if (login) break
    await delay(250)
  }
  assert(login, 'Host startup timeout')
  console.log('Measuring isolated browser…')
  browser = await chromium.launch({ executablePath, headless: true })
  const context = await browser.newContext({ viewport: { width: 1366, height: 960 }, deviceScaleFactor: 1, locale: 'zh-CN' })
  // Expose the real source's existing callbacks only in the served benchmark copy.
  // The shipped file, React instance, renderer, components and CSS stay byte-identical.
  let instrumented = 0, sourceChanged = false
  await context.route('**/*', async route => {
    if (route.request().resourceType() !== 'script') return route.continue()
    const response = await route.fetch()
    const body = await response.body()
    const marker = 'inject: () => ({ t, hooks: { tasks }, actions: tasks }),'
    if (!body.toString().includes(marker)) return route.fulfill({ response })
    if (!body.toString().includes(client.toString())) {
      sourceChanged = true
      return route.fulfill({ response })
    }
    instrumented++
    await route.fulfill({ response, body: body.toString().replace(marker,
      'inject: () => (window.__tasksBaselineSource = tasks, window.__tasksBaselineReact = React.version, { t, hooks: { tasks }, actions: tasks }),') })
  })
  await context.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window)
    let controller, sequence = 0, streams = 0, activeStreams = 0, maxStreams = 0
    const encoder = new TextEncoder()
    const fixture = window.__tasksFixture = { tasks: [], statuses: {}, writes: [], confirmedDeletes: [], streams: () => ({ streams, activeStreams, maxStreams }) }
    fixture.emit = (event) => controller.enqueue(encoder.encode('data: ' + JSON.stringify({ ...event, streamId: 'looseleaf-baseline-v1', sequence: ++sequence }) + '\n\n'))
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href)
      if (url.pathname === '/api/dsh-plugin-tasks/rpc') {
        const request = JSON.parse(init.body), operation = request.payload.operation
        if (operation === 'delete' && fixture.allowDelete) {
          const input = request.payload.input, task = fixture.tasks.find(row => row.id === input.taskId)
          if (!task || task.revision !== input.expectedRevision) throw new Error('Invalid fixture deletion')
          fixture.confirmedDeletes.push(input)
          fixture.tasks = fixture.tasks.filter(row => row.id !== input.taskId)
          fixture.emit({ type: 'remove', taskId: input.taskId, revision: task.revision + 1 })
          return Response.json({ type: 'server-response', rpcId: request.rpcId, result: { ok: true,
            value: { taskId: input.taskId, revision: task.revision + 1 }, streamId: 'looseleaf-baseline-v1', sequence } })
        }
        const value = operation === 'list' ? { tasks: fixture.tasks }
          : operation === 'options' ? { workspaces: [{ id: 'baseline-workspace', title: '隔离基线工作区', path: '/baseline/workspace' }],
            groups: [{ id: 'preview', name: '预览模型组', models: [{ id: 'quick', name: '轻量模型' }, { id: 'deep', name: '深入推理', reasoning: { efforts: [{ id: 'high', name: '高' }] } }] }],
            presets: [{ id: 'planner', name: '计划助手' }], workspaceStatus: 'ready', modelStatus: 'ready', modelFailures: 0 } : null
        if (!value) { fixture.writes.push(operation); throw new Error('Baseline forbids task mutations: ' + operation) }
        return Response.json({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } })
      }
      if (url.pathname === '/api/dsh-plugin-tasks/events') {
        streams++; activeStreams++; maxStreams = Math.max(maxStreams, activeStreams)
        let ended = false
        const end = () => { if (!ended) { ended = true; activeStreams--; controller.close() } }
        const stream = new ReadableStream({ start(value) { controller = value; fixture.emit({ type: 'snapshot', tasks: fixture.tasks, statuses: fixture.statuses }) }, cancel() { if (!ended) { ended = true; activeStreams-- } } })
        init.signal.addEventListener('abort', end, { once: true })
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
      }
      return nativeFetch(input, init)
    }
  })
  const page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  await page.addLocatorHandler(page.getByRole('button', { name: '继续', exact: true }), button => button.click())
  await page.addLocatorHandler(page.getByText('开始使用', { exact: true }), async () => {
    const close = page.getByRole('button', { name: /^(关闭|Close)$/ })
    if (await close.count()) await close.last().click(); else await page.keyboard.press('Escape')
  })
  await page.goto(login, { waitUntil: 'domcontentloaded' })
  await page.getByText('任务', { exact: true }).first().click()
  await page.locator('[data-task-sync="live"]').waitFor({ timeout: 30000 })
  assert.equal(sourceChanged, false, 'Client changed while the host was starting; rerun with a stable source file')
  assert.equal(instrumented, 1)
  await page.removeLocatorHandler(page.getByText('开始使用', { exact: true }))
  // The host's login prompt can appear after the first panel render. Settle it
  // before timings; evaluate/screenshot do not trigger Playwright locator handlers.
  try { await page.getByText('开始使用', { exact: true }).waitFor({ timeout: 10000 }) } catch { /* Already dismissed by a handler. */ }
  const dismissOnboarding = async () => {
    if (await page.getByText('开始使用', { exact: true }).isVisible()) {
      await page.getByRole('button', { name: /^(关闭|Close)$/ }).last().click()
    }
    assert.equal(await page.getByText('开始使用', { exact: true }).isVisible(), false)
  }
  await dismissOnboarding()
  css = await page.locator('style[data-dsh-tasks]').textContent()
  await page.evaluate(() => {
    const source = window.__tasksBaselineSource, fixture = window.__tasksFixture
    const states = ['notStarted', 'running', 'approval', 'question', 'error', 'idle', 'missing', 'archived', 'unknown']
    fixture.makeTasks = count => Array.from({ length: count }, (_, i) => {
      const status = states[i % states.length], id = 'baseline-' + String(i).padStart(4, '0')
      return { id, revision: 1, title: `${i % 10 === 0 ? '命中样本' : '基线任务'} ${String(i + 1).padStart(3, '0')} · 中文长标题与任务状态阅读验证`,
        brief: '固定任务说明：检查两行截断、工作区信息与操作按钮。后续纸面外观使用相同输入进行性能比较。',
        stage: ['todo', 'doing', 'done'][i % 3], position: i, createdAt: '2026-11-17T00:00:00.000Z', updatedAt: '2026-11-17T00:00:00.000Z',
        workspaceId: 'baseline-workspace', ...(status === 'notStarted' ? {} : { activeSessionId: 'session-' + id }) }
    })
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve))
    fixture.settle = async () => { await frame(); await frame() }
    fixture.measure = (action, predicate) => new Promise((resolve, reject) => {
      const started = performance.now()
      const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('Render did not reach expected DOM')) }, 10000)
      const observer = new MutationObserver(async () => {
        if (!predicate()) return
        observer.disconnect(); clearTimeout(timeout)
        // Includes layout; two rAFs provide a separate frame-aligned presentation proxy.
        document.querySelector('.dsh-tasks-root').getBoundingClientRect()
        const domMs = performance.now() - started
        await fixture.settle()
        resolve({ domMs, frameMs: performance.now() - started })
      })
      observer.observe(document.querySelector('.dsh-tasks-root'), { subtree: true, childList: true, attributes: true, characterData: true })
      Promise.resolve().then(action).catch(error => { observer.disconnect(); clearTimeout(timeout); reject(error) })
    })
    fixture.count = () => document.querySelectorAll('article[data-task-id]').length
    fixture.load = async count => {
      source.setQuery('')
      if (!source.getSnapshot().showAllDone['stage:done']) source.toggleDone()
      fixture.tasks = fixture.makeTasks(count)
      await source.refresh()
      for (let i = 0; i < count; i++) if (fixture.tasks[i].activeSessionId) fixture.emit({ type: 'status', taskId: fixture.tasks[i].id,
        status: { sessionId: fixture.tasks[i].activeSessionId, status: states[i % states.length] } })
      await fixture.settle()
      if (fixture.count() !== count) throw new Error('Expected every card mounted, including done')
    }
    fixture.round = async count => {
      source.setQuery(''); fixture.tasks = []; await source.refresh(); await fixture.settle()
      if (fixture.count() !== 0) throw new Error('Expected empty board before card mount')
      fixture.tasks = fixture.makeTasks(count)
      const mount = await fixture.measure(() => source.refresh(), () => fixture.count() === count)
      const search = await fixture.measure(() => {
        const input = document.querySelector('.dsh-tasks-search')
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '命中样本')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }, () => fixture.count() === count / 10)
      source.setQuery(''); await fixture.settle()
      // Twenty distinct SSE frames; each waits for its DOM commit to prevent batching away work.
      const updates = []
      const start = performance.now()
      for (let i = 0; i < 20; i++) {
        const task = fixture.tasks[1 + i % 8], status = i % 2 ? 'idle' : 'running'
        // Guarantee a visible change even when the previous round left the same value.
        const current = document.querySelector(`[data-task-id="${task.id}"] [data-task-status]`).dataset.taskStatus
        const next = current === status ? (status === 'running' ? 'idle' : 'running') : status
        updates.push(await fixture.measure(() => fixture.emit({ type: 'status', taskId: task.id,
          status: { sessionId: task.activeSessionId, status: next } }),
        () => document.querySelector(`[data-task-id="${task.id}"] [data-task-status]`).dataset.taskStatus === next))
      }
      return { mount, search, updates: { domMs: updates.reduce((n, row) => n + row.domMs, 0), frameMs: performance.now() - start, samples: updates } }
    }
  })
  const appearances = (process.env.BASELINE_APPEARANCES || 'paper').split(',')
  assert(appearances.every(value => value === 'paper'), 'Classic appearance was removed; historical comparisons are retained in docs.')
  const results = []
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme })
    // Drive the same public DOM theme selectors as DSH; don't copy or invent its palette.
    await page.evaluate(theme => {
      document.body.toggleAttribute('data-ds-dark-theme', theme === 'dark')
      document.documentElement.style.colorScheme = theme
    }, theme)
    for (const appearance of appearances) {
      await page.evaluate(appearance => window.__tasksBaselineSource.setAppearance?.(appearance), appearance)
      await page.evaluate(() => window.__tasksFixture.load(18))
      await dismissOnboarding()
      await page.screenshot({ path: join(output, `${appearance}-${theme}-1366.png`), fullPage: true })
    }
    for (const count of process.env.BASELINE_PREVIEW_ONLY === '1' ? [] : [100, 500]) {
      const byAppearance = Object.fromEntries(appearances.map(appearance => [appearance, []]))
      // Pair appearances in each round and reverse their order every round to
      // reduce time/order bias from ambient load, CPU scaling and JIT warm-up.
      for (let round = -1; round < 5; round++) {
        const order = round % 2 === 0 ? [...appearances].reverse() : appearances
        for (const appearance of order) {
          await page.evaluate(appearance => window.__tasksBaselineSource.setAppearance?.(appearance), appearance)
          await page.evaluate(count => window.__tasksFixture.load(count), count)
          await dismissOnboarding()
          const sample = await page.evaluate(count => window.__tasksFixture.round(count), count)
          if (round >= 0) byAppearance[appearance].push(sample)
        }
      }
      for (const appearance of appearances) {
        const samples = byAppearance[appearance]
        const medians = Object.fromEntries(['mount', 'search', 'updates'].map(key => [key,
          Object.fromEntries(['domMs', 'frameMs'].map(metric => [metric, median(samples.map(row => row[key][metric]))]))]))
        results.push({ appearance, theme, count, warmupRuns: 1, measuredRuns: 5, samples, medians })
        console.log(JSON.stringify({ appearance, theme, count, medians }))
      }
      await writeFile(join(output, 'timings.json'), JSON.stringify(results, null, 2) + '\n')
    }
  }
  const visualChecks = process.env.BASELINE_VISUAL === '1'
    ? await (await import('./looseleaf-polish-preview.mjs')).verifyPaper(page, output) : undefined
  unexpectedTaskWrites.push(...await page.evaluate(() => window.__tasksFixture.writes))
  const browserState = await page.evaluate(() => ({ react: window.__tasksBaselineReact, userAgent: navigator.userAgent,
    devicePixelRatio, hardwareConcurrency: navigator.hardwareConcurrency, streams: window.__tasksFixture.streams(),
    theme: { darkAttribute: document.body.hasAttribute('data-ds-dark-theme'), colorScheme: getComputedStyle(document.documentElement).colorScheme } }))
  const protectedFiles = await Promise.all(protectedBefore.map(async row => {
    const afterHash = digest(await readFile(join(process.env.BASELINE_PROTECTED_HOME, row.path)))
    return { ...row, afterHash, unchanged: row.hash === afterHash }
  }))
  const result = { capturedAt: new Date().toISOString(), fixtureVersion: 1, environment: {
    node: process.version, dsh: JSON.parse(await readFile(resolve(cli, '../../package.json'))).version,
    browser: browser.version(), os: `${process.platform} ${release()} ${process.arch}`, cpu: cpus()[0].model,
    playwright: JSON.parse(await readFile(new URL('./package.json', pathToFileURL(playwright)))).version,
    viewport: { width: 1366, height: 960 }, headless: true, cpuThrottle: 1, ...browserState },
    source: { client: measureBytes(client), embeddedCss: measureBytes(css), gzipLevel: 9 },
    fixtureSha256: digest(JSON.stringify(await page.evaluate(() => window.__tasksFixture.makeTasks(500)))),
    harnessSha256: digest(await readFile(fileURLToPath(import.meta.url))),
    method: { ordering: 'appearances paired at each theme/count; reversed every round; one warm-up + five measured rounds',
      mount: 'empty board -> all cards via real refresh + in-memory RPC', search: 'native input event -> 10% matches',
      updates: '20 sequential status SSE frames; DOM + two rAF per frame', domMs: 'action -> DOM predicate + forced layout',
      frameMs: 'action -> two requestAnimationFrame callbacks after DOM; presentation proxy, not GPU paint timing', doneColumn: 'expanded; all 100/500 cards present' },
    results, visualChecks, pageErrors, consoleErrors, unexpectedTaskWrites, protectedFiles,
  }
  await writeFile(join(output, 'baseline.json'), JSON.stringify(result, null, 2) + '\n')
  assert(protectedFiles.every(row => row.unchanged), 'Protected home changed during the run; see baseline.json hashes. This check does not identify the writer.')
  assert.equal(browserState.streams.maxStreams, 1)
  assert.deepEqual(unexpectedTaskWrites, [])
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(consoleErrors, [])
  // Private path only; the home may contain an authentication token. Never publish its logs.
  await writeFile(join(root, 'baseline-output.txt'), output)
  console.log('Baseline saved: ' + output)
} finally {
  await browser?.close()
  if (host?.exitCode === null) {
    if (process.platform === 'win32') await new Promise(resolve => execFile('taskkill.exe', ['/PID', String(host.pid), '/T', '/F'], { windowsHide: true }, resolve))
    else host.kill('SIGTERM')
  }
}
