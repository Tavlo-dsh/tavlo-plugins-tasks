/**
 * Step 05: exercise the current Tasks browser UI in an isolated, offline Chromium context.
 * Run with Node 24+: node scripts/task-drawer-layout-probe.mjs
 * Overrides: PLAYWRIGHT_MODULE (ESM entry), BROWSER_EXE, DSH_FRONTEND_DIR (built Web dist),
 * DSH_THEME_CLIENT (built theme client.js, if not a sibling of the frontend package),
 * TASK_DRAWER_PAPER_THEME_CLIENT (local paper theme client.js; enables Paper drawer and attachment checks),
 * TASK_DRAWER_LAYOUT_MANAGEMENT=1 (enables management modal checks in a separate fixture),
 * TASK_DRAWER_LAYOUT_EDITOR_ONLY=1 (skips the unrelated responsive board checks),
 * TASK_DRAWER_LAYOUT_INTERACTIONS=1 (focused external-link, edit, and drag checks),
 * DSH_TASK_APPEARANCE_CLIENT (legacy override for the board appearance check only),
 * TASK_DRAWER_LAYOUT_CLIENT (source, or built for an existing lib/client.js),
 * TASK_DRAWER_LAYOUT_BUILT_CLIENT (explicit bundle path in built mode), and
 * TASK_DRAWER_LAYOUT_OUTPUT (defaults to ../artifacts/task-drawer-layout relative to this package).
 * Requires a prebuilt DSH Web frontend. Source mode uses existing Tasks dev dependencies to compile
 * only calendar/drag modules in memory; built mode compiles nothing. No server, profile or install.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { delimiter, dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const workspace = resolve(root, '..')
const output = resolve(process.env.TASK_DRAWER_LAYOUT_OUTPUT || join(workspace, 'artifacts/task-drawer-layout'))
const origin = 'http://task-drawer-layout.test'
const externalLink = 'https://tapd-link.test/story?from=tasks#details'
const api = '/api/dsh-plugin-tasks'
const require = createRequire(import.meta.url)
const report = { passed: false, isolation: 'Fresh Chromium contexts; synthetic .test origin; all requests fulfilled locally or blocked; in-memory task fixtures', checks: [], layouts: [], screenshots: [], writes: [], pageErrors: [] }

function firstExisting(candidates) {
  return candidates.find(path => path && existsSync(path))
}

function resolvePackage(id) {
  try { return require.resolve(id) } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error }
}

function findTools() {
  const pathDirs = (process.env.PATH || '').split(delimiter).filter(Boolean)
  const pw = process.env.PLAYWRIGHT_MODULE ? resolve(process.env.PLAYWRIGHT_MODULE) : firstExisting([
    resolvePackage('playwright-core'), resolvePackage('playwright'),
    join(workspace, 'artifacts/task-panel-round1-20261118/tools/node_modules/playwright-core/index.mjs'),
  ])
  const shellDirs = [dirname(process.execPath), join(dirname(process.execPath), 'node_global'), process.env.NPM_CONFIG_PREFIX, process.env.APPDATA && join(process.env.APPDATA, 'npm'), ...pathDirs].filter(Boolean)
  const installedFrontend = resolvePackage('@deepseek-ai/dsh-web-frontend/package.json')
  const dist = process.env.DSH_FRONTEND_DIR ? resolve(process.env.DSH_FRONTEND_DIR) : firstExisting([
    installedFrontend && join(dirname(installedFrontend), 'dist'), join(workspace, '.refs/dsh-src/apps/web/dist'),
    ...shellDirs.map(dir => join(dir, 'node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist')),
    ...shellDirs.map(dir => join(dir, 'lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist')),
  ])
  const executablePath = process.env.BROWSER_EXE ? resolve(process.env.BROWSER_EXE) : firstExisting([
    ...[process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean).flatMap(dir => [
      join(dir, 'Google/Chrome/Application/chrome.exe'), join(dir, 'Microsoft/Edge/Application/msedge.exe'),
    ]), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ...['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome', 'msedge', 'chrome.exe', 'msedge.exe'].flatMap(name => pathDirs.map(dir => join(dir, name))),
  ])
  assert(pw && existsSync(pw), 'Cannot find Playwright; set PLAYWRIGHT_MODULE to its index.mjs')
  assert(dist && existsSync(join(dist, 'index.html')), 'Cannot find prebuilt DSH Web frontend; set DSH_FRONTEND_DIR to its dist directory')
  assert(!process.env.BROWSER_EXE || existsSync(executablePath), 'BROWSER_EXE does not exist')
  const themeClient = process.env.DSH_THEME_CLIENT ? resolve(process.env.DSH_THEME_CLIENT) : firstExisting([
    join(dist, '../../dsh-client-ui-theme/lib/client.js'), join(workspace, '.refs/dsh-src/packages/client/ui-theme/lib/client.js'),
  ])
  assert(themeClient && existsSync(themeClient), 'Cannot find built DSH theme client; set DSH_THEME_CLIENT to its lib/client.js')
  return { pw, dist, themeClient, executablePath }
}

async function loadShell(dist, themeClient) {
  const [html, themeSource] = await Promise.all([readFile(join(dist, 'index.html'), 'utf8'), readFile(themeClient, 'utf8')])
  // The shell normally gets these generated sheets from ui-theme's Cordis effect.
  // Consume the shipped sheets without running the theme service or writing settings.
  const themeCSS = [...themeSource.matchAll(/\b(?:var|let|const) \w+_css_default = ("(?:[^"\\]|\\.)*");/g)]
    .map(([, literal]) => JSON.parse(literal)).join('\n')
  assert(themeCSS.includes('--dsw-alias-bg-base') && themeCSS.includes('data-ds-dark-theme'), 'Could not extract shipped DSH theme tokens')
  const entry = [...html.matchAll(/<script\b[^>]*>/g)].find(([tag]) => /\btype="module"/.test(tag))?.[0].match(/\bsrc="([^"]+)"/)?.[1]
  assert(entry, 'Built DSH HTML has no module entry')
  const entryUrl = new URL(entry, origin)
  assert.equal(entryUrl.origin, origin, 'Shell entry must be local')
  const entryPath = entryUrl.pathname
  const source = await readFile(join(dist, entryPath.slice(1)), 'utf8')
  // Reuse the installed React and DSH primitives instead of reimplementing focus/Markdown.
  // Stop at the Web entry's final bootstrap so no Cordis app, auth or transport starts.
  const platform = source.match(/function\s+([\w$]+)\(\)\s*\{\s*return\s*\{(?=[^{}]*["']@deepseek-ai\/dsh-client-ui-primitives["']\s*:)/)?.[1]
  const bootError = source.lastIndexOf('web app: missing #root')
  const boot = [...source.slice(Math.max(0, bootError - 300), bootError).matchAll(/\btry\s*\{/g)].at(-1)
  assert(platform && bootError >= 0 && boot && /\.run\(/.test(source.slice(bootError)),
    'Unsupported DSH Web dist: expected its platform-module factory and final bootstrap; set DSH_FRONTEND_DIR to a compatible prebuilt dist')
  const entryBody = source.slice(0, Math.max(0, bootError - 300) + boot.index) + `\nwindow.__taskDrawerPlatform = ${platform}();\n`
  const styles = [...html.matchAll(/<link\b[^>]*>/g)].filter(([tag]) => /\brel="stylesheet"/.test(tag)).map(([tag]) => tag).join('\n')
  return { entryPath, entryBody, themeCSS, html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${styles}<link rel="stylesheet" href="/fixture-theme.css"></head><body><div id="root"></div><script type="module" src="${entryPath}"></script></body></html>` }
}

async function readClientInputs() {
  const mode = process.env.TASK_DRAWER_LAYOUT_CLIENT || 'source'
  assert(['source', 'built'].includes(mode), 'TASK_DRAWER_LAYOUT_CLIENT must be source or built')
  if (mode === 'built') {
    const path = process.env.TASK_DRAWER_LAYOUT_BUILT_CLIENT ? resolve(process.env.TASK_DRAWER_LAYOUT_BUILT_CLIENT) : join(root, 'lib/client.js')
    assert(existsSync(path), 'Built Tasks client is missing; use source mode or supply existing lib/client.js')
    return { mode, client: await readFile(path, 'utf8'), dependencies: {} }
  }
  // The existing calendar helper resolves aliases and entries relative to cwd.
  process.chdir(root)
  const [{ bundleCalendar }, { build }] = await Promise.all([import('./bundle-calendar.mjs'), import('esbuild')])
  const [client, calendar, dnd] = await Promise.all([
    readFile(join(root, 'client.js'), 'utf8'), bundleCalendar(),
    build({ stdin: { contents: "module.exports = require('@dnd-kit/core')", resolveDir: root },
      bundle: true, platform: 'browser', format: 'cjs', write: false, external: ['react', 'react-dom'],
      define: { 'process.env.NODE_ENV': '"production"' } }),
  ])
  return { mode, client, dependencies: { './calendar/task-date-picker.jsx': calendar.outputFiles[0].text, '@dnd-kit/core': dnd.outputFiles[0].text } }
}

async function readAppearanceClient() {
  const paper = process.env.TASK_DRAWER_PAPER_THEME_CLIENT
  const client = paper || process.env.DSH_TASK_APPEARANCE_CLIENT
  if (!client) return undefined
  const path = resolve(client)
  return { path, source: await readFile(path, 'utf8'), paper: !!paper }
}

function makeFixture({ overview = false } = {}) {
  const date = '2030-03-14', time = '2026-01-02T12:00:00.000Z', streamId = 'task-drawer-layout-v1'
  const seedId = 'layout-seed', snapshotId = 'layout-snapshot', launchRequestId = 'layout-launch'
  const markdown = '**Layout probe**\n\nA description with a second paragraph.\n\n- [ ] Unfinished task\n\n- [x] Completed task'
  const board = { revision: 1, columns: ['todo', 'doing', 'done'].map(stage => ({ id: 'stage:' + stage, stage })),
    labels: [{ id: 'layout-label', name: 'Planning', color: '#4879bc' }] }
  const options = { workspaces: [{ id: 'layout-workspace', title: 'Layout workspace', path: '/fixture/workspace' },
    { id: 'layout-empty', title: 'Empty workspace with a long name', path: '/fixture/empty' }],
    groups: [{ id: 'fixture', name: 'Fixture models', models: [{ id: 'one', name: 'Layout model' }] }], presets: [],
    workspaceStatus: 'ready', modelStatus: 'ready', modelFailures: 0 }
  const makeTask = ({ id, title, brief, stage = 'todo', position = 0, ...fields }) => ({
    id, revision: 1, title, brief, stage, position, columnId: 'stage:' + stage, orderKey: String(position).padStart(5, '0'),
    createdAt: time, updatedAt: time, ...fields,
  })
  const tasks = new Map([
    [seedId, makeTask({ id: seedId, title: 'Layout fixture task', brief: markdown, dueDate: date, labelId: 'layout-label', priority: 'P1', workspaceId: 'layout-workspace', model: { provider: 'fixture', model: 'one' } })],
    [snapshotId, makeTask({ id: snapshotId, title: 'Layout snapshot task', brief: markdown, position: 1, imageCount: 1,
      launch: { phase: 'prepared', sessionId: '12345678-abcd-1234-abcd-123456789abc', input: { taskId: snapshotId, requestId: launchRequestId, content: 'Fixture first message', includeImages: true, replaceActive: false } } })],
  ])
  if (overview) {
    const now = Date.now()
    const ago = days => new Date(now - 86400000 * days).toISOString()
    const rows = [
      { id: 'layout-attention', title: '核对待发布清单', priority: 'P0', stage: 'doing' },
      { id: 'layout-late', title: '确认筛选条件文案', stage: 'doing', workspaceId: 'layout-workspace', dueDate: ago(2).slice(0, 10) },
      { id: 'layout-today', title: '回查移动端布局', stage: 'doing', dueDate: ago(0).slice(0, 10) },
      { id: 'layout-completed', title: '完成周报初稿', stage: 'done', workspaceId: 'layout-workspace', completedAt: ago(1), createdAt: ago(3) },
      { id: 'layout-reviewed', title: '走查工作区切换', stage: 'done', completedAt: ago(3), createdAt: ago(4) },
      { id: 'layout-older', title: '整理组件库文档', stage: 'done', completedAt: ago(12), createdAt: ago(15) },
    ]
    for (const row of rows) tasks.set(row.id, makeTask({ ...row, position: tasks.size }))
  }
  const limits = { maxImages: 10, maxImageBytes: 2 * 1024 * 1024, maxFiles: 10, maxFileBytes: 2 * 1024 * 1024, mediaTypes: ['image/png'] }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+dH1sAAAAASUVORK5CYII=', 'base64')
  const snapshotImage = { attachmentId: 'snapshot-image', width: 1, height: 1, mediaType: 'image/png', bytes: png.length, size: png.length }
  const galleries = new Map([[snapshotId, []]])
  const files = new Map([[snapshotImage.attachmentId, png]])
  const ok = value => ({ ok: true, value })
  const mcpReads = []
  const get = id => { assert(tasks.has(id), `Unknown fixture task: ${id}`); return tasks.get(id) }
  const current = () => ({ tasks: [...tasks.values()], board, statuses: {} })
  let created = 0
  function rpc({ operation, input = {} }) {
    switch (operation) {
      case 'event-baseline': return { type: 'snapshot', streamId, sequence: 0, ...current() }
      case 'list': return ok(current())
      case 'options': return ok(options)
      case 'edit-columns': {
        assert.equal(input.expectedRevision, board.revision)
        if (input.action === 'reorder') {
          const from = board.columns.findIndex(column => column.id === input.columnId)
          assert(from >= 0 && input.before !== input.columnId)
          const [column] = board.columns.splice(from, 1)
          const to = input.before === null ? board.columns.length : board.columns.findIndex(row => row.id === input.before)
          assert(to >= 0)
          board.columns.splice(to, 0, column)
          board.revision++
          report.writes.push({ operation, id: column.id, input })
          return ok({ board })
        }
        assert.equal(input.action, 'add')
        assert(input.name?.trim() && ['todo', 'doing', 'done'].includes(input.stage))
        const id = `layout-column-${++board.revision}`
        board.columns.push({ id, name: input.name, stage: input.stage })
        report.writes.push({ operation, id, input })
        return ok({ board })
      }
      case 'edit-labels': {
        assert.equal(input.action, 'add')
        assert.equal(input.expectedRevision, board.revision)
        assert(input.name?.trim() && /^#[\da-f]{6}$/i.test(input.color), 'Invalid fixture label')
        const id = `layout-label-${++board.revision}`
        board.labels.push({ id, name: input.name, color: input.color })
        report.writes.push({ operation, id, input })
        return ok({ board })
      }
      case 'mcp-access': {
        // Probe only display of status. No real endpoint, clipboard data, credential or key.
        assert.equal(input.action, 'status')
        mcpReads.push(input.action)
        return ok({ enabled: true, active: false })
      }
      case 'move': {
        const task = get(input.taskId), target = board.columns.find(column => column.id === input.columnId)
        assert(target && task.revision === input.expectedRevision)
        const next = { ...task, revision: task.revision + 1, stage: target.stage, columnId: target.id }
        tasks.set(task.id, next)
        report.writes.push({ operation, id: task.id, input })
        return ok({ task: next })
      }
      case 'history': get(input.taskId); return ok({ events: [] })
      case 'files': {
        const { taskId, launchRequestId: requestId } = input
        const task = taskId ? get(taskId) : undefined
        if (requestId !== undefined) assert(taskId === snapshotId && requestId === launchRequestId, 'Unexpected launch snapshot request')
        return ok({ limits, files: requestId ? [snapshotImage] : galleries.get(taskId) || [], revision: task?.revision, launchRequestId: requestId })
      }
      case 'images': {
        const { taskId, launchRequestId: requestId } = input
        const task = taskId ? get(taskId) : undefined
        if (requestId !== undefined) assert(taskId === snapshotId && requestId === launchRequestId, 'Unexpected launch snapshot request')
        return ok({ limits, images: requestId ? [snapshotImage] : galleries.get(taskId) || [], revision: task?.revision, launchRequestId: requestId })
      }
      case 'create': {
        assert(input.requestId && input.title?.trim(), 'Invalid fixture create input')
        const { requestId, ...fields } = input
        const id = 'layout-created-' + ++created
        const task = makeTask({ ...fields, id, position: tasks.size })
        tasks.set(id, task)
        report.writes.push({ operation, id, input })
        return ok({ task })
      }
      case 'remove-file':
      case 'remove-image': {
        const task = get(input.taskId), images = galleries.get(task.id)
        assert.equal(input.expectedRevision, task.revision, 'Fixture file removal expected the current task revision')
        assert(input.requestId && images?.some(row => row.attachmentId === input.attachmentId), 'Invalid fixture file removal')
        const remaining = images.filter(row => row.attachmentId !== input.attachmentId)
        galleries.set(task.id, remaining)
        files.delete(input.attachmentId)
        const next = { ...task, fileCount: remaining.length, imageCount: remaining.length, revision: task.revision + 1 }
        tasks.set(task.id, next)
        report.writes.push({ operation, id: task.id, input })
        return ok({ task: next })
      }
      case 'update': {
        const task = get(input.taskId)
        assert.equal(task.revision, input.expectedRevision, 'Fixture update expected the current task revision')
        assert(input.requestId, 'Missing update request ID')
        const next = { ...task, ...input.patch, revision: task.revision + 1 }
        for (const key of Object.keys(input.patch)) if (input.patch[key] === null) delete next[key]
        tasks.set(task.id, next)
        report.writes.push({ operation, id: task.id, input })
        return ok({ task: next, mutation: { requestId: input.requestId } })
      }
      default: throw new Error('Unexpected fixture RPC: ' + operation)
    }
  }
  function upload(params, request) {
    const task = get(params.get('taskId')), requestId = params.get('requestId'), name = params.get('name')
    const body = request.postDataBuffer()
    assert(requestId && request.headers()['content-type'] === 'image/png' && body?.equals(png), 'Fixture upload should contain the original PNG bytes')
    const attachmentId = 'uploaded-' + requestId
    const images = [...(galleries.get(task.id) || []), { ...snapshotImage, attachmentId, ...(name ? { name } : {}) }]
    galleries.set(task.id, images)
    files.set(attachmentId, body)
    const next = { ...task, fileCount: images.length, imageCount: images.length, revision: task.revision + 1 }
    tasks.set(task.id, next)
    report.writes.push({ operation: 'upload', id: task.id, bytes: body.length })
    return ok({ task: next })
  }
  function image(params) {
    const id = params.get('attachmentId'), taskId = params.get('taskId')
    const requestId = params.get('launchRequestId')
    if (requestId) assert(taskId === snapshotId && requestId === launchRequestId && id === snapshotImage.attachmentId, 'Incorrect launch snapshot image URL')
    else assert(galleries.get(taskId)?.some(row => row.attachmentId === id), 'Image is not in the current gallery')
    return files.get(id)
  }
  return { rpc, upload, image, png, date, markdown, seedId, snapshotId, launchRequestId, mcpReads }
}

const mime = { '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff' }
async function mount(context, dist, shell, inputs, fixture, language = 'en') {
  const errors = []
  const intercept = work => async (...args) => {
    try { return await work(...args) }
    catch (error) { errors.push(error.message); throw error }
  }
  await context.exposeBinding('__taskDrawerRpc', intercept((_source, request) => fixture.rpc(request)))
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    // No route ever uses continue()/fetch(), including unknown same-origin requests.
    if (request.isNavigationRequest() && request.url().split('#')[0] === externalLink.split('#')[0]) {
      return route.fulfill({ contentType: 'text/html', body: '<title>External task fixture</title>' })
    }
    if (url.origin !== origin) return route.abort('blockedbyclient')
    try {
      if (url.pathname === '/' && request.isNavigationRequest()) return await route.fulfill({ contentType: 'text/html', body: shell.html })
      if (url.pathname === shell.entryPath) return await route.fulfill({ contentType: mime['.js'], body: shell.entryBody })
      if (url.pathname === '/fixture-theme.css') return await route.fulfill({ contentType: mime['.css'], body: shell.themeCSS })
      if ([api + '/image/upload', api + '/file/upload'].includes(url.pathname) && request.method() === 'POST') return await route.fulfill({ json: fixture.upload(url.searchParams, request) })
      if (url.pathname === api + '/file' && request.method() === 'GET') {
        if (fixture.fileResponse) return await route.fulfill(fixture.fileResponse(url.searchParams))
        const body = fixture.image(url.searchParams)
        return await route.fulfill({ contentType: 'image/png', body, ...(url.searchParams.get('download') ? { headers: { 'Content-Disposition': 'attachment; filename="fixture.png"' } } : {}) })
      }
      if (url.pathname === api + '/image' && request.method() === 'GET') return await route.fulfill({ contentType: 'image/png', body: fixture.image(url.searchParams) })
      const path = resolve(dist, '.' + decodeURIComponent(url.pathname)), contentType = mime[extname(path)]
      if (url.pathname.startsWith('/assets/') && path.startsWith(resolve(dist, 'assets') + sep) && contentType) {
        return await route.fulfill({ contentType, body: await readFile(path) })
      }
      errors.push(`Unexpected browser request: ${request.method()} ${url.pathname}`)
      return await route.abort('blockedbyclient')
    } catch (error) {
      errors.push(error.message)
      await route.fulfill({ status: 500, body: 'Fixture route failed' })
    }
  })
  await context.routeWebSocket('**/*', socket => { errors.push('Unexpected browser WebSocket'); socket.close() })
  await context.addInitScript(() => {
    const fetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : input, location.href).pathname
      if (path !== '/api/dsh-plugin-tasks/events') return fetch(input, init)
      const event = await window.__taskDrawerRpc({ operation: 'event-baseline' })
      const stream = new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(event) + '\n\n'))
        init.signal.addEventListener('abort', () => { try { controller.close() } catch { /* Reader already cancelled. */ } }, { once: true })
      } })
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    }
  })
  const page = await context.newPage()
  page.setDefaultTimeout(8000)
  page.on('pageerror', error => report.pageErrors.push(error.message))
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  const boot = async () => {
    await page.waitForFunction(() => !!window.__taskDrawerPlatform)
    await page.evaluate(({ inputs, language }) => {
      document.documentElement.lang = language === 'zh' ? 'zh-CN' : language
      const modules = window.__taskDrawerPlatform, React = modules.react
      const slot = {}
      const dictionaries = new Map()
      const locale = {
        register(ns, lang, messages) { dictionaries.set(ns + '/' + lang, messages) },
        bind(ns) { return key => (dictionaries.get(ns + '/' + language) ?? dictionaries.get(ns + '/en'))?.[key] ?? key },
      }
      const fixtureRequire = name => {
        if (modules[name]) return modules[name]
        if (Object.hasOwn(inputs.dependencies, name)) {
          const module = { exports: {} }
          new Function('require', 'module', inputs.dependencies[name])(fixtureRequire, module)
          return (modules[name] = module.exports)
        }
        throw new Error('Unmapped Tasks dependency: ' + name)
      }
      window.__ModuleLoader__ = { load({ id, factory }) {
        const cleanup = [], plugin = factory(fixtureRequire)
        if (id === '@tavlo-dsh/dsh-plugin-paper-theme') {
          addEventListener('pagehide', () => cleanup.forEach(dispose => dispose?.()), { once: true })
          const listeners = new Set()
          let snapshot = { status: 'ready', writable: true, value: { appearance: 'default', taskAppearance: 'inherit' } }
          // Mirror the host presenter's writes, but only for tokens from this local client.
          // The plugin still owns preference resolution, body markers and its stylesheet.
          let layer, applied = []
          const applyTokens = () => {
            const { body } = document, dark = body.hasAttribute('data-ds-dark-theme')
            for (const name of applied) body.style.removeProperty(name)
            applied = Object.keys(layer || {})
            for (const name of applied) body.style.setProperty(name, layer[name][dark ? 'dark' : 'light'])
          }
          plugin.apply({
            effect(run) { cleanup.push(run()) },
            locale,
            slots: { inject(_name, run) { run() }, register(spec, Component) { if (spec.name === 'tavlo-tasks.appearance') slot.appearance = { spec, Component } } },
            configForms: { get: () => ({ getSnapshot: () => snapshot, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
              async set(key, value) { snapshot = { ...snapshot, value: { ...snapshot.value, [key]: value } }; listeners.forEach(listener => listener()); return true },
            }) },
            theme: { overrideTokens(_source, tokens) {
              layer = tokens
              applyTokens()
              return () => { if (layer === tokens) { layer = undefined; applyTokens() } }
            } },
          })
          window.__taskDrawerAppearance = { applyTokens, select: slot.appearance?.spec.inject().select }
          return
        }
        if (id !== '@tavlo-dsh/dsh-plugin-tasks') throw new Error('Unexpected module: ' + id)
        plugin.apply({
          // The isolated task panel does not mount the optional host session menus.
          inject() {},
          effect(run) { cleanup.push(run()) },
          locale,
          slots: { inject(_name, run) { run() }, register(spec, Component) { if (spec.name === 'main') Object.assign(slot, { spec, Component }) } },
          connection: { rpc: { call(base, method, request) {
            if (base !== '/api' || method !== 'dsh-plugin-tasks/rpc') throw new Error('Unexpected Tasks RPC target')
            return window.__taskDrawerRpc(request)
          } } },
          get(name) { if (name !== 'workspaces') throw new Error('Unexpected host service: ' + name) },
        })
        const { hooks, ...props } = slot.spec.inject(), source = hooks.tasks
        const useTasks = select => select(React.useSyncExternalStore(source.subscribe, source.getSnapshot))
        const app = modules['react-dom/client'].createRoot(document.getElementById('root'))
        const renderSlot = slot.appearance ? () => {
          const { hooks, ...appearanceProps } = slot.appearance.spec.inject()
          const usePreference = select => select(React.useSyncExternalStore(hooks.preference.subscribe, hooks.preference.getSnapshot))
          return React.createElement(slot.appearance.Component, { ...appearanceProps, usePreference })
        } : undefined
        app.render(React.createElement(slot.Component, { ...props, useTasks, renderSlot }))
        addEventListener('pagehide', () => { app.unmount(); cleanup.forEach(dispose => dispose?.()) }, { once: true })
      } }
      // The selected clients are evaluated as-is, with only their host supplied here.
      if (inputs.appearance) new Function(inputs.appearance + '\n//# sourceURL=task-appearance-client.js')()
      new Function(inputs.client + '\n//# sourceURL=task-drawer-layout-client.js')()
    }, { inputs, language })
    await page.locator('[data-task-sync="live"]').waitFor()
  }
  await boot()
  return { page, errors, reload: async () => { await page.reload({ waitUntil: 'domcontentloaded' }); await boot() } }
}

const check = description => { report.checks.push(description); console.log('PASS: ' + description) }
const exact = name => ({ name, exact: true })
const images = drawer => drawer.getByRole('region', exact('Task files'))
const imageList = drawer => images(drawer).locator('ul.dsh-tasks-image-grid').and(images(drawer).getByRole('list'))
const imagePicker = drawer => images(drawer).getByRole('button', { name: /^(Add|Choose) (files|images)$/ })
async function chooseFixtureImage(page, picker, fixture, name = 'layout-fixture.png') {
  const chooser = page.waitForEvent('filechooser')
  await picker.click()
  await (await chooser).setFiles({ name, mimeType: 'image/png', buffer: fixture.png })
}
const screenshot = async (page, name) => {
  await page.screenshot({ path: join(output, name + '.png'), animations: 'disabled' })
  report.screenshots.push(name + '.png')
}
const closeWithEscape = async (page, dialog) => {
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
}
async function expectFocus(page, locator, message) {
  const target = await locator.elementHandle()
  try { await page.waitForFunction(el => document.activeElement === el, target, { timeout: 3000 }) }
  catch (error) { throw new Error(message, { cause: error }) }
  finally { await target.dispose() }
}
const rect = async locator => {
  const box = await locator.boundingBox()
  assert(box, `${locator} has no bounding box`)
  return box
}

async function setTheme(page, theme) {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
  await page.evaluate(theme => {
    document.body.toggleAttribute('data-ds-dark-theme', theme === 'dark')
    document.documentElement.style.colorScheme = theme
    window.__taskDrawerAppearance?.applyTokens()
  }, theme)
}

async function selectAppearance(page, appearance, taskAppearance) {
  const markers = await page.evaluate(async ({ appearance, taskAppearance }) => {
    const { select } = window.__taskDrawerAppearance
    await select(appearance)
    await select(taskAppearance, 'taskAppearance')
    return [document.body.getAttribute('data-dsh-paper-theme'), document.body.getAttribute('data-dsh-task-appearance')]
  }, { appearance, taskAppearance })
  assert.deepEqual(markers, [appearance === 'default' ? null : appearance, taskAppearance === 'inherit' ? null : taskAppearance])
}

async function inspectLayout(drawer, mode, width, theme, viewport) {
  const fields = drawer.locator('fieldset.dsh-tasks-task-fields')
  assert.equal(await fields.count(), 1, `${mode} should have exactly one shared task fieldset`)
  const title = mode === 'create'
    ? fields.getByRole('textbox', exact('Title')).and(fields.locator('[name=title]'))
    : drawer.locator('header').getByRole('textbox', exact('Title')).and(drawer.locator('header textarea[name=title]'))
  assert.equal(await fields.locator('[name=title]').count(), mode === 'create' ? 1 : 0, `${mode}: title should be in header only for detail`)
  const description = fields.locator('.dsh-tasks-description')
  const brief = description.getByRole('textbox', { name: /^Description/ }).and(fields.locator('textarea[name=brief]'))
  const preview = description.getByRole('button', exact('Preview'))
  const markdown = description.locator('.dsh-tasks-description-markdown')
  const label = fields.getByRole('combobox', exact('Label')), priority = fields.getByRole('combobox', exact('Priority'))
  const date = fields.getByRole('button', { name: /^Due date:/ })
  const workspace = fields.getByRole('combobox', exact('Workspace')), model = fields.getByRole('combobox', exact('Model'))
  const images = drawer.getByRole('region', exact('Task files'))
  const sequence = [title, description, label, priority, date, workspace, model, images]
  const elements = []
  try {
    for (const control of sequence) elements.push(await control.elementHandle())
    const ordered = await drawer.evaluate((dialog, nodes) => {
      return nodes.every((node, index) => dialog.contains(node) &&
        (!index || !!(nodes[index - 1].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)))
    }, elements)
    assert(ordered, `${mode} must place title → description → label → priority → date → workspace → model → attachments in order`)
  } finally { await Promise.all(elements.map(element => element.dispose())) }
  const [box, a, b, dBox, c, d] = await Promise.all([drawer, label, priority, date, workspace, model].map(rect))
  assert(Math.abs(box.width - width) < 1 && Math.abs(box.x + box.width - viewport.width) < 1, `${mode} drawer is not ${width}px and flush with the right edge`)
  if (width === 375) {
    for (const [left, right] of [[a, b], [b, dBox], [c, d]]) {
      assert(right.y >= left.y + left.height && Math.abs(right.x - left.x) < 2, `${mode}: paired/property fields must stack at 375px`)
    }
  } else {
    assert(b.x >= a.x + a.width && dBox.x >= b.x + b.width && Math.abs(b.y - a.y) < 4 && Math.abs(dBox.y - a.y) < 4,
      `${mode}: label, priority, and due date must share one 3-column row at 640px`)
    assert(d.x >= c.x + c.width && Math.abs(d.y - c.y) < 2, `${mode}: workspace and model must share a row at 640px`)
  }
  const details = await drawer.evaluate(dialog => {
    const panel = dialog.querySelector('.dsh-tasks-detail-panel:not([hidden])')
    const bounds = panel.getBoundingClientRect()
    return { horizontalOverflow: Math.max(panel.scrollWidth - panel.clientWidth, dialog.scrollWidth - dialog.clientWidth),
      background: getComputedStyle(dialog).backgroundColor,
      bodyWidth: bounds.width, textareaHeight: panel.querySelector('textarea[name=brief]')?.getBoundingClientRect().height ?? null }
  })
  assert(details.horizontalOverflow <= 1, `${mode} body overflows horizontally by ${details.horizontalOverflow}px`)
  report.layouts.push({ mode, theme, viewport, drawerWidth: box.width, ...details })
  return { title, brief, preview, markdown }
}

async function checkChecklist(markdown) {
  await markdown.locator('strong').getByText('Layout probe', exact('Layout probe')).waitFor()
  const items = await markdown.locator('li input[type=checkbox]').evaluateAll(boxes => boxes.map(box => {
    const item = box.closest('li'), text = box.parentElement.matches('p') ? box.parentElement : item
    const range = document.createRange(), walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode()) && !node.textContent.trim()) {}
    range.selectNodeContents(node)
    const a = box.getBoundingClientRect(), b = range.getBoundingClientRect()
    return { checked: box.checked, disabled: box.disabled, marker: getComputedStyle(item).listStyleType,
      beside: a.width > 0 && a.right <= b.left + 1 && a.top < b.bottom && a.bottom > b.top }
  }))
  assert.deepEqual(items, [false, true].map(checked => ({ checked, disabled: true, marker: 'none', beside: true })))
}

async function checkFooter(page, drawer, action, { scroll = false } = {}) {
  const footer = drawer.locator('.dsh-tasks-form-actions')
  const body = drawer.locator('.dsh-tasks-detail-panel:not([hidden])')
  const before = await rect(footer), viewport = page.viewportSize(), button = await rect(action)
  assert(before.y >= 0 && before.y + before.height <= viewport.height + 1, 'Footer must fit inside the viewport')
  assert(button.x >= 0 && button.x + button.width <= viewport.width + 1 && button.y >= before.y && button.y + button.height <= before.y + before.height + 1,
    'Primary action must be fully reachable within the footer')
  if (scroll) {
    const original = await body.evaluate(el => { const top = el.scrollTop; el.scrollTop = el.scrollHeight; return top })
    assert(await body.evaluate(el => el.scrollTop > 0), 'Narrow drawer must scroll inside its body')
    const after = await rect(footer)
    assert(Math.abs(after.y - before.y) < 1 && Math.abs(after.height - before.height) < 1, 'Footer moved while the body scrolled')
    await body.evaluate((el, top) => { el.scrollTop = top }, original)
  }
}

async function exercise(page, fixture, reload) {
  const opener = page.getByRole('button', exact('New task'))
  const create = page.getByRole('dialog', exact('New task'))
  const detail = page.getByRole('dialog', exact('Task details'))
  const card = id => page.locator(`article[data-task-id="${id}"] .dsh-tasks-card-title`)
  const seed = card(fixture.seedId)
  const briefField = drawer => drawer.locator('textarea[name=brief]')
  const titleField = drawer => drawer.locator('[name=title]')
  const createButton = create.getByRole('button', exact('Create task'))
  const startButton = detail.getByRole('button', exact('Start task'))
  await seed.waitFor()

  for (const theme of ['light', 'dark']) {
    await setTheme(page, theme)
    for (const viewport of [{ width: 1366, height: 900 }, { width: 375, height: 740 }]) {
      const width = viewport.width === 375 ? 375 : 640
      const suffix = `${theme}-${viewport.width}`
      await page.setViewportSize(viewport)
      await opener.click()
      await expectFocus(page, titleField(create), 'Create should focus Title')
      await titleField(create).fill('Layout create draft')
      const newFields = await inspectLayout(create, 'create', width, theme, viewport)
      assert.equal(await create.getByRole('separator').count(), width === 640 ? 1 : 0)
      assert(await newFields.preview.isDisabled(), 'Blank description must disable Preview')
      const compact = (await rect(newFields.brief)).height
      assert(compact >= 45 && compact <= 76, `Blank description should be about two lines, got ${compact}px`)
      await newFields.brief.fill(fixture.markdown)
      assert((await rect(newFields.brief)).height > compact + 40, 'Textarea should grow with multi-line content')
      assert(await newFields.brief.evaluate(node => node.scrollHeight <= node.clientHeight + 1), 'Textarea should not scroll internally')
      await newFields.brief.evaluate(node => node.setSelectionRange(2, 8, 'backward'))
      await newFields.preview.click()
      assert.equal(await newFields.brief.count(), 0, 'Preview should replace the textarea, not duplicate it')
      await checkChecklist(newFields.markdown)
      await checkFooter(page, create, createButton, { scroll: width === 375 })
      await screenshot(page, 'create-' + suffix)
      const edit = create.getByRole('button', exact('Edit'))
      await edit.click()
      await expectFocus(page, newFields.brief, 'Returning to Edit should focus the textarea')
      assert.equal(await newFields.brief.inputValue(), fixture.markdown)
      assert.deepEqual(await newFields.brief.evaluate(node => [node.selectionStart, node.selectionEnd, node.selectionDirection]), [2, 8, 'backward'])
      await newFields.title.fill('')
      await newFields.brief.fill('')
      assert(Math.abs((await rect(newFields.brief)).height - compact) <= 1, 'Textarea should shrink when emptied')
      await closeWithEscape(page, create)
      await expectFocus(page, opener, 'Create should restore its opener on Escape')

      await seed.click()
      await expectFocus(page, detail.getByRole('tab', exact('Details')), 'Detail should focus active Details tab')
      const existingFields = await inspectLayout(detail, 'detail', width, theme, viewport)
      assert.equal(await existingFields.brief.count(), 0, 'Detail should start in read mode')
      await checkChecklist(existingFields.markdown)
      await detail.getByRole('button', exact('Edit description')).click()
      await expectFocus(page, existingFields.brief, 'Edit description should focus the textarea')
      assert.equal(await existingFields.brief.inputValue(), fixture.markdown)
      await existingFields.preview.click()
      await checkChecklist(existingFields.markdown)
      await checkFooter(page, detail, startButton, { scroll: width === 375 })
      await screenshot(page, 'detail-' + suffix)
      await closeWithEscape(page, detail)
      await expectFocus(page, seed, 'Detail should restore the invoking task card on Escape')
    }
  }
  for (const mode of ['create', 'detail']) {
    assert.notEqual(report.layouts.find(row => row.mode === mode && row.theme === 'light').background,
      report.layouts.find(row => row.mode === mode && row.theme === 'dark').background, `${mode} drawer background did not change with theme`)
  }
  check('Create and detail share field order and Markdown editing; both themes fit 640px / 375px with reachable footers')

  await setTheme(page, 'light')
  await page.setViewportSize({ width: 1366, height: 900 })
  await opener.click()
  await titleField(create).fill('Created by the layout probe')
  await briefField(create).fill(fixture.markdown)
  await closeWithEscape(page, create)
  await expectFocus(page, opener, 'Draft close should restore the opener')
  await opener.click()
  assert.equal(await titleField(create).inputValue(), 'Created by the layout probe')
  await reload()
  await create.waitFor()
  assert.equal(await titleField(create).inputValue(), 'Created by the layout probe')
  assert.equal(await briefField(create).inputValue(), fixture.markdown)
  const createDate = create.getByRole('button', { name: /^Due date:/ })
  const emptyDateWidth = (await rect(createDate)).width
  await createDate.click()
  await create.getByRole('button', exact('Tomorrow')).click()
  const clearCreateDate = create.locator('.dsh-tasks-date-clear').and(create.getByRole('button', exact('Clear date')))
  await clearCreateDate.waitFor()
  assert(Math.abs((await rect(createDate)).width - emptyDateWidth) < 1, 'Choosing a date must not resize its trigger')
  await clearCreateDate.click()
  await expectFocus(page, createDate, 'Clearing the create date should focus its trigger')
  assert.match(await createDate.getAttribute('aria-label'), /Select date/)
  assert.equal(await clearCreateDate.count(), 0)
  assert(Math.abs((await rect(createDate)).width - emptyDateWidth) < 1, 'Clearing a date must not resize its trigger')
  assert.deepEqual(report.writes, [], 'Editing a create draft must not write tasks')
  check('Create draft survives close/reopen and reload; clearing its date restores trigger focus without a write')

  const createImages = images(create)
  await chooseFixtureImage(page, imagePicker(create), fixture)
  const pending = imageList(create).getByRole('listitem').filter({ hasText: 'layout-fixture.png' })
  await pending.getByRole('button', exact('Remove file: layout-fixture.png')).waitFor()
  await createImages.getByText('1/10', { exact: true }).waitFor()
  assert.equal(await imageList(create).getByRole('listitem').count(), 1)
  await pending.scrollIntoViewIfNeeded()
  await screenshot(page, 'create-pending-image')
  assert.deepEqual(report.writes, [], 'A pending create attachment must not be uploaded before create')
  await createButton.click()
  await create.waitFor({ state: 'hidden' })
  await detail.waitFor()
  const saved = imageList(detail).getByRole('listitem')
  await saved.getByRole('button', exact('layout-fixture.png')).waitFor()
  await images(detail).getByText('1/10', { exact: true }).waitFor()
  assert.equal(await imageList(detail).getByRole('listitem').count(), 1)
  assert.deepEqual(report.writes.map(entry => entry.operation), ['create', 'upload'])
  assert.equal(report.writes[0].input.brief, fixture.markdown)
  assert.equal(report.writes[0].input.dueDate, undefined)
  assert.equal(report.writes[1].id, report.writes[0].id)
  const savedImage = saved.locator('img')
  await savedImage.scrollIntoViewIfNeeded()
  await savedImage.evaluate(image => image.decode())
  await screenshot(page, 'detail-saved-image')
  await saved.getByRole('button', exact('Remove file: layout-fixture.png')).click()
  await imageList(detail).waitFor({ state: 'hidden' })
  await images(detail).getByText('0/10', { exact: true }).waitFor()
  assert.deepEqual(report.writes.map(entry => entry.operation), ['create', 'upload', 'remove-file'])
  assert.equal(report.writes[2].id, report.writes[0].id)
  await closeWithEscape(page, detail)
  await reload()
  await opener.click()
  assert.equal(await titleField(create).inputValue(), '', 'Successful create must clear the draft')
  await closeWithEscape(page, create)
  await card(report.writes[0].id).waitFor()
  check('Native file selection queues a semantic attachment row; create uploads once and clears the draft, and detail removal clears the saved row')

  await page.setViewportSize({ width: 375, height: 740 })
  await seed.click()
  const detailsTab = detail.getByRole('tab', exact('Details')), activity = detail.getByRole('tab', exact('Activity'))
  const deliveryTab = detail.getByRole('tab', exact('Agent delivery'))
  assert.deepEqual(await detail.getByRole('tab').allTextContents(), ['Details', 'Activity', 'Agent delivery'])
  await titleField(detail).focus()
  await page.keyboard.press('Tab')
  await expectFocus(page, detail.locator('summary.dsh-tasks-stage-pill'), 'Tab after header Title focuses header column switcher')
  const editDescription = detail.getByRole('button', exact('Edit description'))
  await detailsTab.focus()
  await page.keyboard.press('End')
  await expectFocus(page, deliveryTab, 'End should focus Agent delivery')
  await page.keyboard.press('ArrowLeft')
  await expectFocus(page, activity, 'ArrowLeft should move to Activity')
  assert.equal(await activity.getAttribute('aria-selected'), 'true')
  await detail.getByRole('tabpanel', exact('Activity')).waitFor()
  assert.equal(await detail.locator('.dsh-tasks-form-actions').count(), 0, 'Clean Activity omits the detail action footer')
  const accepted = await detail.evaluate((dialog, base64) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([Uint8Array.from(atob(base64), char => char.charCodeAt(0))], 'ignored.png', { type: 'image/png' }))
    const panel = dialog.querySelector('[role=tabpanel]:not([hidden])')
    return [panel.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })),
      panel.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }))]
  }, fixture.png.toString('base64'))
  assert.deepEqual(accepted, [true, true], 'Activity must not intercept image paste or drop')
  assert.equal(report.writes.length, 3, 'Activity must not upload images')
  await page.keyboard.press('ArrowLeft')
  await expectFocus(page, detailsTab, 'ArrowLeft should return to Details')
  assert.equal(await detailsTab.getAttribute('aria-selected'), 'true')
  await detail.getByRole('tabpanel', exact('Details')).waitFor()
  await startButton.focus()
  await page.keyboard.press('Tab')
  await expectFocus(page, titleField(detail), 'Tab from the footer should wrap to the header Title input')
  await page.keyboard.press('Shift+Tab')
  await expectFocus(page, startButton, 'Shift+Tab should wrap back to the footer')
  await detail.getByRole('button', exact('Add acceptance criteria')).click()
  const criteriaInput = detail.locator('textarea[name=acceptanceCriteria]')
  await criteriaInput.fill('Discardable criteria')
  await detail.getByRole('button', exact('Discard changes')).click()
  await startButton.waitFor()
  assert.equal(await criteriaInput.count(), 0, 'Discarding edits reverts disclosure state cleanly')
  const date = detail.getByRole('button', { name: /^Due date:/ })
  assert.match(await date.getAttribute('aria-label'), new RegExp(fixture.date))
  const clearDate = detail.locator('.dsh-tasks-date-clear').and(detail.getByRole('button', exact('Clear date')))
  await clearDate.focus()
  await page.keyboard.press('Enter')
  await expectFocus(page, date, 'Clearing a detail date with the keyboard should focus its trigger')
  assert.match(await date.getAttribute('aria-label'), /Select date/)
  await editDescription.click()
  await briefField(detail).fill('Saved layout description')
  const save = detail.getByRole('button', exact('Save changes'))
  await checkFooter(page, detail, save, { scroll: true })
  await screenshot(page, 'detail-dirty-light-375')
  await save.click()
  await startButton.waitFor()
  await detail.locator('.dsh-tasks-description-markdown').getByText('Saved layout description', exact('Saved layout description')).waitFor()
  assert.equal(await briefField(detail).count(), 0, 'Successful save returns to reading without closing')
  const [update] = report.writes.filter(entry => entry.operation === 'update')
  assert.equal(update?.input.patch.dueDate, null, 'Clearing a persisted date should submit an explicit null')
  assert.equal(update?.input.patch.brief, 'Saved layout description')
  assert.equal(report.writes.length, 4)
  await closeWithEscape(page, detail)
  await reload()
  await seed.click()
  await detail.locator('.dsh-tasks-description-markdown').getByText('Saved layout description', exact('Saved layout description')).waitFor()
  assert.equal(await briefField(detail).count(), 0)
  assert.match(await date.getAttribute('aria-label'), /Select date/)
  await editDescription.click()
  await briefField(detail).fill('Discard this local edit')
  await page.keyboard.press('Escape')
  const confirmation = page.getByRole('alertdialog')
  const keep = confirmation.getByRole('button', exact('Keep editing'))
  await keep.waitFor()
  await keep.click()
  await confirmation.waitFor({ state: 'hidden' })
  assert.equal(await briefField(detail).inputValue(), 'Discard this local edit')
  await expectFocus(page, briefField(detail), 'Keep editing should restore the last field')
  await page.keyboard.press('Escape')
  await screenshot(page, 'detail-discard-light-375')
  await confirmation.getByRole('button', exact('Discard and close')).click()
  await detail.waitFor({ state: 'hidden' })
  await expectFocus(page, seed, 'Discard should restore focus to the card')
  await seed.click()
  await detail.locator('.dsh-tasks-description-markdown').getByText('Saved layout description', exact('Saved layout description')).waitFor()
  assert.equal(await briefField(detail).count(), 0)
  assert.equal(report.writes.length, 4, 'Discard must not write')
  await closeWithEscape(page, detail)
  check('Keyboard focus and tabs work; Activity ignores image paste/drop; clear date saves, and discard keeps the saved version')

  await card(fixture.snapshotId).click()
  await detail.getByRole('button', { name: /Resume/ }).click()
  const launch = page.locator('dialog.dsh-tasks-launch-dialog[open]')
  await launch.waitFor()
  const snapshot = images(launch)
  await snapshot.getByText(/Attachments saved for this launch/).waitFor()
  const item = imageList(launch).getByRole('listitem')
  assert.equal(await item.count(), 1)
  const thumbnail = item.getByRole('button', exact('Image 1'))
  await thumbnail.scrollIntoViewIfNeeded()
  const snapshotImage = item.locator('img')
  await snapshotImage.evaluate(image => image.decode())
  assert.equal(new URL(await snapshotImage.getAttribute('src'), origin).searchParams.get('launchRequestId'), fixture.launchRequestId)
  assert.equal(await imagePicker(launch).count(), 0)
  assert.equal(await snapshot.getByRole('button', { name: /^Remove file/ }).count(), 0)
  assert.equal(await snapshot.locator('input[type=file]').count(), 0)
  await screenshot(page, 'launch-read-only-snapshot')
  await thumbnail.click()
  const imageDialog = page.getByRole('dialog', exact('Task images'))
  await imageDialog.waitFor()
  await imageDialog.locator('img').evaluate(image => image.decode())
  await closeWithEscape(page, imageDialog)
  await expectFocus(page, thumbnail, 'Closing read-only preview should return focus to its thumbnail')
  await closeWithEscape(page, launch)
  assert.equal(report.writes.length, 4, 'Previewing a saved launch snapshot must not write')
  check('The read-only launch snapshot shows its scoped image in the same semantic list, opens a preview and never offers mutations')
}

const paperDrawer = '.dsh-tasks-editor-drawer'
const neutralPaperTokens = ['control-fill', 'control-line', 'control-ink', 'focus', 'radius']
const settlePaint = page => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))

async function inspectPaperDrawer(drawer, mode = 'create') {
  return drawer.evaluate((dialog, { tokenNames, mode }) => {
    const aliases = {
      ...(mode === 'create' ? { title: '[name=title]' } : {}),
      description: '[name=brief]', label: '[role=combobox][aria-label=Label]',
      priority: '[role=combobox][aria-label=Priority]', workspace: '[role=combobox][aria-label=Workspace]',
      model: '[role=combobox][aria-label=Model]', date: '[data-slot=date-picker]',
    }
    const choose = dialog.querySelector('.dsh-tasks-image-head .dsh-tasks-image-add-button')
    const bounds = node => {
      if (!node) return null
      const { left, right, width } = node.getBoundingClientRect()
      return { left, right, width }
    }
    const inspect = (control, kind, directInk = false) => {
      if (!control) throw new Error(`Missing paper probe control (${kind})`)
      const frame = control.closest(`[data-task-ink=${kind}]`)
      const style = getComputedStyle(frame || control), controlStyle = getComputedStyle(control)
      const svg = directInk ? control.querySelector(':scope > svg[data-ink]')
        : frame?.querySelector(`[data-task-ink-layer=${kind}] svg[data-ink]`)
      const visible = node => {
        for (let element = node; element && element !== dialog; element = element.parentElement) {
          const { display, visibility, opacity } = getComputedStyle(element)
          if (display === 'none' || visibility !== 'visible' || +opacity <= 0) return false
        }
        return true
      }
      const ink = svg?.getBoundingClientRect()
      const inkVisible = !!ink && ink.width > 0 && ink.height > 0 && visible(svg)
      const colors = inkVisible ? [...svg.querySelectorAll('path, line, rect, polyline, polygon, circle, ellipse')].filter(visible)
        .flatMap(node => {
          const { stroke, strokeWidth, strokeOpacity, fill, fillOpacity } = getComputedStyle(node)
          // Looseleaf's rough pen strokes can be filled SVG outlines rather than SVG strokes.
          return [stroke !== 'none' && parseFloat(strokeWidth) > 0 && +strokeOpacity > 0 && stroke,
            fill !== 'none' && +fillOpacity > 0 && fill].filter(Boolean)
        }) : []
      return { marked: !!frame, fill: style.backgroundColor, controlFill: controlStyle.backgroundColor, ink: controlStyle.color,
        radius: style.borderTopLeftRadius, inkVisible, inkColors: [...new Set(colors)],
        boxes: { control: bounds(control), frame: bounds(frame), svg: inkVisible ? bounds(svg) : null },
        outline: { width: style.outlineStyle === 'none' ? 0 : parseFloat(style.outlineWidth), style: style.outlineStyle, color: style.outlineColor } }
    }
    // Resolve light-dark()/var() in the drawing's actual CSS scope, not in Node or on a detached element.
    const swatch = dialog.appendChild(document.createElement('span'))
    swatch.hidden = true
    const dialogStyle = getComputedStyle(dialog)
    const tokens = Object.fromEntries([...tokenNames, 'radius-sm', 'primary-fill', 'primary-ink', 'overlay-fill'].map(name => {
      const variable = '--dsh-looseleaf-' + name
      if (!dialogStyle.getPropertyValue(variable).trim()) return [name, null]
      const prop = name.startsWith('radius') ? 'borderTopLeftRadius' : 'color'
      swatch.style[prop] = `var(${variable})`
      return [name, getComputedStyle(swatch)[prop]]
    }))
    swatch.remove()
    const fields = Object.fromEntries(Object.entries(aliases).map(([name, selector]) =>
      [name, inspect(dialog.querySelector(selector), 'field', name === 'date')]))
    const attachment = inspect(choose, 'button')
    const empty = dialog.querySelector('.dsh-tasks-images .dsh-tasks-image-add[data-empty]')
    const action = dialog.querySelector('.dsh-tasks-form-actions .dsh-tasks-primary')
    const footer = inspect(action, 'button')
    const extras = Object.fromEntries(['tabs', 'badge'].map(kind => [kind, [...dialog.querySelectorAll(`[data-task-ink=${kind}]`)]
      .map(node => inspect(node, kind).inkVisible)]))
    const sections = {
      drawer: dialog, body: dialog.querySelector('.dsh-tasks-detail-panel:not([hidden])'),
      fields: dialog.querySelector('.dsh-tasks-task-fields'), footer: dialog.querySelector('.dsh-tasks-form-actions'), page: document.documentElement,
    }
    const overflow = Object.fromEntries(Object.entries(sections).map(([name, node]) =>
      [name, { ...bounds(node), scroll: node.scrollWidth - node.clientWidth }]))
    return { tokens, surface: dialogStyle.backgroundColor, fields, attachment, empty: empty && inspect(empty, 'empty'), footer, extras, overflow,
      outsidePaperTokens: [document.body, document.querySelector('.dsh-tasks-board-view')].map(node =>
        getComputedStyle(node).getPropertyValue('--dsh-looseleaf-control-fill').trim()) }
  }, { tokenNames: neutralPaperTokens, mode })
}

function contrast(first, second) {
  const luminance = value => {
    assert.match(value, /^rgb\(/, 'Expected an opaque, computed sRGB palette color')
    return value.match(/\d+(?:\.\d+)?/g).map(Number).map(channel => {
      const normalized = channel / 255
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
    }).reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0)
  }
  const [dark, light] = [luminance(first), luminance(second)].sort((a, b) => a - b)
  return (light + 0.05) / (dark + 0.05)
}

function checkPaperPaint(state, isPaper, tag) {
  const { tokens, surface, fields, attachment, empty, footer, extras, overflow } = state
  assert.deepEqual(state.outsidePaperTokens, ['', ''], `${tag} leaked editor tokens outside the drawer`)
  for (const [name, { scroll }] of Object.entries(overflow)) assert(scroll <= 1, `${tag}: ${name} overflows horizontally by ${scroll}px`)
  for (const name of neutralPaperTokens) assert.equal(!!tokens[name], isPaper, `${tag}: unexpected --dsh-looseleaf-${name} activation`)
  if (!isPaper) {
    // Due date already had its own artwork before the editor integration.
    for (const [name, paint] of Object.entries({ ...fields, attachment, empty, footer })) {
      if (paint && name !== 'date') assert(!paint.inkVisible, `${tag}: Paper ${name} ink leaked into non-Paper appearance`)
    }
    assert(!Object.values(extras).flat().includes(true), `${tag}: Paper tab/badge ink leaked into non-Paper appearance`)
    return
  }
  assert(!attachment.marked && !attachment.inkVisible, `${tag}: Add files must not have an Ink button frame`)
  for (const [name, paint] of Object.entries(fields)) {
    assert(paint.marked && paint.inkVisible, `${tag}: ${name} has no visible ink frame`)
    assert.equal(paint.fill, surface, `${tag}: ${name} should match the drawer paper surface`)
    assert([surface, 'rgba(0, 0, 0, 0)'].includes(paint.controlFill), `${tag}: ${name} control obscures its frame with ${paint.controlFill}`)
    assert.equal(paint.ink, tokens['control-ink'], `${tag}: ${name} should use the shared text ink`)
    assert.equal(paint.radius, tokens['radius-sm'], `${tag}: ${name} should use the shared control radius`)
    assert(paint.inkColors.includes(tokens['control-line']), `${tag}: ${name} ink ${paint.inkColors} does not include the shared line ${tokens['control-line']}`)
  }
  assert(empty?.marked && empty.inkVisible, `${tag}: attachments should have a visible empty area drawing`)
  assert.equal(empty.fill, surface, `${tag}: empty attachments should match the drawer paper surface`)
  assert.equal(empty.radius, tokens.radius, `${tag}: attachments should use the shared surface radius`)
  assert(empty.inkColors.includes(tokens['control-line']), `${tag}: attachment area ink should use the shared line paint`)
  assert(footer.marked && footer.inkVisible, `${tag}: primary action should have a visible button drawing`)
  assert(tokens['primary-fill'] && tokens['primary-ink'], `${tag}: primary action tokens are missing`)
  assert.equal(footer.fill, tokens['primary-fill'], `${tag}: primary action lost its accent fill`)
  assert.equal(footer.ink, tokens['primary-ink'], `${tag}: primary action lost its accent ink`)
  const focus = fields.description.outline
  assert(focus.style === 'solid' && focus.width >= 2 && focus.width > fields.label.outline.width, `${tag}: focused Description has no stronger outline`)
  assert.equal(focus.color, tokens.focus, `${tag}: focus outline should use the shared focus token`)
  const ratio = contrast(focus.color, surface)
  assert(ratio >= 3 && ratio > contrast(tokens['control-line'], surface), `${tag}: focus outline contrast is not stronger than the rest stroke (${ratio.toFixed(2)}:1)`)
  return +ratio.toFixed(2)
}

async function checkPaperOverlay(page, trigger, popup, tokens, tag) {
  await trigger.scrollIntoViewIfNeeded()
  await settlePaint(page)
  await trigger.click()
  await popup.waitFor()
  const paint = await popup.evaluate(node => {
    const { backgroundColor, borderTopColor, borderTopLeftRadius } = getComputedStyle(node)
    const { left, right } = node.getBoundingClientRect()
    return { marker: node.dataset.taskInk, fill: backgroundColor, line: borderTopColor, radius: borderTopLeftRadius,
      overflow: Math.max(0, -left, right - window.innerWidth, node.scrollWidth - node.clientWidth) }
  })
  assert.equal(paint.marker, 'overlay', `${tag}: overlay integration marker is missing`)
  assert(tokens['overlay-fill'], `${tag}: overlay token is missing`)
  assert.equal(paint.fill, tokens['overlay-fill'], `${tag}: overlay fill does not match shared tokens`)
  assert.equal(paint.line, tokens['control-line'], `${tag}: overlay line does not match shared tokens`)
  assert.equal(paint.radius, tokens.radius, `${tag}: overlay radius does not match shared tokens`)
  assert(paint.overflow <= 1, `${tag}: overlay overflows horizontally by ${paint.overflow}px`)
  await closeWithEscape(page, popup)
  await expectFocus(page, trigger, `${tag}: overlay should restore trigger focus`)
  return paint
}

async function exercisePaper(page, fixture) {
  const writes = report.writes.length
  assert.equal(await page.locator('style[data-dsh-paper-settings]').count(), 1, 'Local theme factory must inject the actual stylesheet once')
  const steps = [
    ['default', 'inherit', 'light', false],
    ['default', 'inherit', 'dark', false],
    ['paper', 'inherit', 'light', true],
    ['paper', 'inherit', 'dark', true],
    ['paper', 'ios', 'dark', false],
    ['ios', 'inherit', 'light', false],
    ['ios', 'paper', 'dark', true],
    ['default', 'inherit', 'dark', false],
    ['default', 'paper', 'light', true],
    ['default', 'inherit', 'light', false],
  ]
  for (const [mode, opener, dialogName] of [
    ['create', page.getByRole('button', exact('New task')), 'New task'],
    ['detail', page.locator(`article[data-task-id="${fixture.seedId}"] .dsh-tasks-card-title`), 'Task details'],
  ]) {
    await setTheme(page, 'light')
    await selectAppearance(page, 'default', 'inherit')
    await opener.click()
    await page.mouse.move(0, 0)
    const drawer = page.getByRole('dialog', exact(dialogName)).and(page.locator(paperDrawer))
    await drawer.waitFor()
    const title = drawer.locator('[name=title]'), brief = drawer.locator('textarea[name=brief]')
    const choose = images(drawer).getByRole('button', exact('Add files'))
    await choose.waitFor()
    const draft = { title: `Paper ${mode} draft`, brief: 'Select this text in the unsaved Markdown draft.' }
    await title.fill(draft.title)
    if (mode === 'detail') {
      await drawer.getByRole('button', exact('Edit description')).click()
      await expectFocus(page, brief, 'Opening the editor should focus the textbox')
    }
    await brief.fill(draft.brief)
    await expectFocus(page, brief, `${mode}: Description should be focused before switching appearance`)
    const controlSelector = 'button, input, textarea, select, summary, [role=tab]'
    await brief.evaluate((node, controlSelector) => {
      node.setSelectionRange(7, 16, 'backward')
      const dialog = node.closest('.dsh-tasks-editor-drawer')
      window.__taskDrawerOriginal = { drawer: dialog, controls: [...dialog.querySelectorAll(controlSelector)] }
    }, controlSelector)
    const selection = [7, 16, 'backward'], defaultPaint = new Map()
    let lightTokens, darkTokens
    for (const [appearance, taskAppearance, scheme, enabled] of steps) {
      const tag = `${mode} ${scheme} ${appearance}/${taskAppearance}`
      await selectAppearance(page, appearance, taskAppearance)
      await setTheme(page, scheme)
      // Allow the ink measurement effect to paint after a hidden-to-visible CSS switch.
      await settlePaint(page)
      const continuity = await brief.evaluate((node, controlSelector) => {
        const original = window.__taskDrawerOriginal, drawer = node.closest('.dsh-tasks-editor-drawer')
        const controls = [...drawer.querySelectorAll(controlSelector)]
        return { sameDrawer: drawer === original.drawer,
          sameControls: controls.length === original.controls.length && controls.every((control, index) => control === original.controls[index]),
          focused: document.activeElement === node, selection: [node.selectionStart, node.selectionEnd, node.selectionDirection],
          title: drawer.querySelector('[name=title]').value, brief: node.value }
      }, controlSelector)
      assert.deepEqual(continuity, { sameDrawer: true, sameControls: true, focused: true, selection, ...draft },
        `${tag}: appearance switch replaced nodes or lost the draft/focus/selection`)
      const paint = await inspectPaperDrawer(drawer, mode)
      const evidence = { mode, appearance, taskAppearance, scheme, enabled, ...paint, continuity }
      report.paper.layouts.push(evidence)
      evidence.focusContrast = checkPaperPaint(paint, enabled, tag)
      if (enabled && mode === 'detail') {
        for (const [name, drawings] of Object.entries(paint.extras)) assert(drawings.includes(true), `${tag}: missing ${name} drawing`)
      }
      if (appearance === 'default' && taskAppearance === 'inherit') {
        if (defaultPaint.has(scheme)) assert.deepEqual(paint, defaultPaint.get(scheme), `${tag}: round trip did not restore the default drawer paint`)
        else defaultPaint.set(scheme, paint)
      }
      if (appearance === 'paper' && taskAppearance === 'inherit') {
        if (scheme === 'light') lightTokens = paint.tokens
        else darkTokens = paint.tokens
        await screenshot(page, `paper-${mode}-${scheme}-375`)
      } else if (enabled) {
        assert.deepEqual(paint.tokens, scheme === 'light' ? lightTokens : darkTokens, `${tag}: explicit Paper must use the inherited Paper palette`)
      }
    }
    for (const name of neutralPaperTokens.filter(name => name !== 'radius')) {
      assert.notEqual(lightTokens[name], darkTokens[name], `${mode}: ${name} did not change across light/dark`)
    }
    // Check top-layer controls after the continuity sequence; opening them necessarily moves focus.
    await selectAppearance(page, 'default', 'paper')
    const overlays = { label: await checkPaperOverlay(page, drawer.getByRole('combobox', exact('Label')),
      drawer.getByRole('listbox', exact('Label')), lightTokens, `${mode} label`) }
    overlays.date = await checkPaperOverlay(page, drawer.getByRole('button', { name: /^Due date:/ }),
      drawer.getByRole('dialog', exact('Select date')), lightTokens, `${mode} date`)
    report.paper.overlays.push({ mode, ...overlays })
    await choose.scrollIntoViewIfNeeded()
    await screenshot(page, `paper-${mode}-attachments-light-375`)
    await checkFooter(page, drawer, drawer.getByRole('button', exact(mode === 'create' ? 'Create task' : 'Save changes')), { scroll: true })
    if (mode === 'create') await closeWithEscape(page, drawer)
    else {
      await page.keyboard.press('Escape')
      await page.getByRole('alertdialog').getByRole('button', exact('Discard and close')).click()
      await drawer.waitFor({ state: 'hidden' })
    }
    await expectFocus(page, opener, `${mode} paper drawer should restore its opener`)
  }
  assert.equal(report.writes.length, writes, 'Paper appearance switches and previewing controls must not write tasks')
  check('Paper create/detail at 375px share visible field and attachment artwork, tokenized paints and stronger focus in light and dark')
  check('Task-only and inherited Paper match; iOS/default stay isolated, and in-place switches preserve drawer, draft, focus and selection')
}

async function inspectAttachmentHeader(drawer, { empty, pending }) {
  const section = images(drawer)
  const heading = section.getByRole('heading', exact('Task files'))
  const add = section.getByRole('button', exact('Add files'))
  await add.waitFor()
  assert.equal(await imagePicker(drawer).count(), 1, 'Task files should have exactly one file picker action')
  assert.equal(await section.locator('input[type=file][hidden][multiple]').count(), 1, 'Header action should keep the native file input')
  assert.equal(await heading.and(section.locator('.dsh-tasks-image-head h3')).count(), 1)
  assert.equal(await add.and(section.locator('.dsh-tasks-image-head .dsh-tasks-image-add-button')).count(), 1,
    'Add files should be in the attachment header')
  assert.equal((await add.innerText()).trim(), 'Add files')
  assert.equal(await section.locator('.dsh-tasks-image-add[data-empty]').count(), empty ? 1 : 0,
    'The empty drop-zone frame should only apply while the gallery is empty')
  assert.equal(await section.getByText(/Drop or paste files here/).count(), 1)
  assert.equal(await section.getByText('Refreshing discards pending files.', exact('Refreshing discards pending files.')).count(), pending ? 1 : 0,
    'The pending help should only appear while files are queued')
  return add
}

async function checkFlatImageAction(page, action, tag, { tinted = false } = {}) {
  await action.scrollIntoViewIfNeeded()
  await page.mouse.move(0, 0)
  await action.evaluate(button => button.blur())
  const paint = () => action.evaluate(button => {
    const css = getComputedStyle(button)
    const border = ['Top', 'Right', 'Bottom', 'Left'].map(side =>
      parseFloat(css[`border${side}Width`]) > 0 && css[`border${side}Color`] !== 'rgba(0, 0, 0, 0)' &&
      !['none', 'hidden'].includes(css[`border${side}Style`]))
    return { fill: css.backgroundColor, ink: css.color, shadow: css.boxShadow, backgroundImage: css.backgroundImage,
      hasBorder: border.some(Boolean), hasInk: !!button.closest('[data-task-ink=button]') || !!button.querySelector('svg[data-ink]'),
      focused: button.matches(':focus-visible'), outline: css.outlineStyle, outlineWidth: parseFloat(css.outlineWidth),
      outlineOffset: parseFloat(css.outlineOffset), outlineColor: css.outlineColor,
      surface: getComputedStyle(button.closest('.dsh-tasks-editor-drawer')).backgroundColor }
  })
  await settlePaint(page)
  const rest = await paint()
  await action.hover()
  await settlePaint(page)
  const hover = await paint()
  await page.mouse.move(0, 0)
  await action.focus()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  await expectFocus(page, action, `${tag}: the attachment action should be reachable by keyboard`)
  await settlePaint(page)
  const focus = await paint()
  for (const [state, style] of Object.entries({ rest, hover, focus })) {
    assert(!style.hasInk && style.shadow === 'none' && style.backgroundImage === 'none',
      `${tag} ${state}: action should remain free of shadow or Ink frame`)
    if (!tinted) assert(!style.hasBorder, `${tag} ${state}: icon action should remain borderless`)
  }
  if (!tinted) assert.equal(rest.fill, 'rgba(0, 0, 0, 0)', `${tag}: resting icon action should have no fill`)
  assert(hover.fill !== rest.fill || hover.ink !== rest.ink, `${tag}: hover should give feedback through fill or text color`)
  assert(focus.focused && focus.outline === 'solid' && focus.outlineWidth >= 2,
    `${tag}: keyboard focus should display a visible outline (${JSON.stringify(focus)})`)
  focus.contrast = +contrast(focus.outlineColor, focus.surface).toFixed(2)
  assert(focus.contrast >= 3, `${tag}: focus outline has insufficient contrast against the drawer (${focus.contrast}:1)`)
  await action.evaluate(button => button.blur())
  return { rest, hover, focus }
}

async function exercisePaperAttachments(page, fixture) {
  await selectAppearance(page, 'paper', 'inherit')
  const create = page.getByRole('dialog', exact('New task'))
  const detail = page.getByRole('dialog', exact('Task details'))
  const openCreate = page.getByRole('button', exact('New task'))
  const openDetail = page.locator(`article[data-task-id="${fixture.seedId}"] .dsh-tasks-card-title`)
  const remove = async (row, name) => {
    const target = row.getByRole('button', exact('Remove file: ' + name))
    await target.waitFor()
    assert.equal(await target.and(row.locator('.dsh-tasks-image-remove')).count(), 1)
    assert.equal((await target.innerText()).trim(), '', 'Remove file should have an icon, not visible text')
    assert.equal(await target.getAttribute('title'), 'Remove file')
    assert(await target.locator('[aria-hidden="true"] svg, svg[aria-hidden="true"]').isVisible(), 'Remove file should display a decorative icon')
    return target
  }
  for (const [scheme, width, height] of [['light', 375, 740], ['dark', 375, 740], ['light', 1366, 900]]) {
    await page.setViewportSize({ width, height })
    await setTheme(page, scheme)
    const start = report.writes.length
    await openCreate.click()
    const add = await inspectAttachmentHeader(create, { empty: true, pending: false })
    const tag = `${scheme} ${width}px`
    const addPaint = await checkFlatImageAction(page, add, `${tag} Add files`, { tinted: true })
    const name = `paper-${scheme}-fixture.png`
    await chooseFixtureImage(page, add, fixture, name)
    const pendingRow = imageList(create).getByRole('listitem').filter({ hasText: name })
    await pendingRow.getByText(/Upload after task creation/).waitFor()
    await images(create).getByText('1/10', { exact: true }).waitFor()
    await inspectAttachmentHeader(create, { empty: false, pending: true })
    const removePending = await remove(pendingRow, name)
    const pendingPaint = await checkFlatImageAction(page, removePending, `${tag} pending Remove file`)
    await pendingRow.scrollIntoViewIfNeeded()
    await screenshot(page, `paper-create-pending-${scheme}-${width}`)
    await removePending.focus()
    await page.keyboard.press('Enter')
    await pendingRow.waitFor({ state: 'hidden' })
    await inspectAttachmentHeader(create, { empty: true, pending: false })
    assert.equal(report.writes.length, start, 'Adding and removing a draft image must not upload or write a task')
    await closeWithEscape(page, create)

    await openDetail.click()
    const addSaved = await inspectAttachmentHeader(detail, { empty: true, pending: false })
    await chooseFixtureImage(page, addSaved, fixture, name)
    const savedRow = imageList(detail).getByRole('listitem').filter({ has: page.getByRole('button', exact(name)) })
    await savedRow.getByText(/Uploaded/).waitFor()
    await images(detail).getByText('1/10', { exact: true }).waitFor()
    await inspectAttachmentHeader(detail, { empty: false, pending: false })
    const savedImage = savedRow.locator('img')
    await savedImage.scrollIntoViewIfNeeded()
    await savedImage.evaluate(image => image.decode())
    const removeSaved = await remove(savedRow, name)
    const savedPaint = await checkFlatImageAction(page, removeSaved, `${tag} saved Remove file`)
    await savedRow.scrollIntoViewIfNeeded()
    await screenshot(page, `paper-detail-uploaded-${scheme}-${width}`)
    await removeSaved.focus()
    await page.keyboard.press('Enter')
    await savedRow.waitFor({ state: 'hidden' })
    await images(detail).getByText('0/10', exact('0/10')).waitFor()
    await inspectAttachmentHeader(detail, { empty: true, pending: false })
    await closeWithEscape(page, detail)
    const writes = report.writes.slice(start)
    assert.deepEqual(writes.map(({ operation, id }) => [operation, id]), [['upload', fixture.seedId], ['remove-file', fixture.seedId]],
      'Paper attachment actions should upload once and remove once only on the selected synthetic task')
    report.paper.attachmentStates.push({ scheme, viewport: { width, height }, add: addPaint, removePending: pendingPaint, removeSaved: savedPaint })
  }
  check('Paper files use one header action and flat, keyboard-operable icon-only removal; pending and uploaded rows retain their original write behavior')
}

async function exerciseBoardScrollbar(page) {
  const scroller = page.locator('.dsh-tasks-insight-body')
  const box = await scroller.boundingBox()
  const { clientWidth, clientHeight, scrollHeight } = await scroller.evaluate(el => ({
    clientWidth: el.clientWidth, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight,
  }))
  assert(scrollHeight > clientHeight, 'The overview must overflow to exercise its scrollbar')
  assert.equal(Math.round(box.width) - clientWidth, 8, 'The overview needs a fixed 8px scrollbar hit area')
  // Native scrollbar hover is painted by Chromium, not exposed by getComputedStyle.
  const x = Math.round(box.x + box.width) - 8, y = Math.round(box.y) + 32
  const pixels = async () => {
    const png = await page.screenshot({ clip: { x, y, width: 8, height: 1 }, scale: 'css' })
    return page.evaluate(async data => {
      const image = new Image()
      image.src = 'data:image/png;base64,' + data
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const ctx = canvas.getContext('2d')
      ctx.drawImage(image, 0, 0)
      const row = ctx.getImageData(0, 0, image.width, 1).data
      return Array.from({ length: image.width }, (_, i) => Array.from(row.slice(i * 4, i * 4 + 3)))
    }, png.toString('base64'))
  }
  const difference = (a, b) => a.reduce((sum, channel, i) => sum + Math.abs(channel - b[i]), 0)
  await page.mouse.move(x - 20, y)
  const idle = await pixels()
  assert(difference(idle[1], idle[4]) > 8 && difference(idle[1], idle[6]) <= 2, 'Idle thumb paints only in the center of the hit area')
  await page.mouse.move(x + 4, y)
  const hover = await pixels()
  assert(difference(hover[1], idle[1]) > 8 && difference(hover[6], idle[6]) > 8 && difference(hover[4], idle[4]) > 8,
    'Hover paints a wider and more opaque thumb')
  await page.mouse.down()
  try {
    const active = await pixels()
    assert(difference(active[4], hover[4]) > 8, 'Pressing the thumb strengthens its contrast again')
    await page.mouse.move(x + 4, y + 60, { steps: 6 })
  } finally { await page.mouse.up() }
  assert(await scroller.evaluate((el, width) => el.scrollTop > 0 && el.clientWidth === width, clientWidth), 'Dragging scrolls without resizing the overview')
  check('The native overview thumb paints thin at rest, thickens on hover and press, and remains draggable without shifting content')
}

async function exerciseBoard(page, hasAppearance) {
  const toolbar = page.locator('.dsh-tasks-board-toolbar')
  const settings = toolbar.getByText('看板设置', exact('看板设置'))
  const settingsTrigger = toolbar.locator('summary[aria-label="看板设置"]')
  const workspace = toolbar.getByRole('combobox', exact('按工作区筛选'))
  const insights = page.getByRole('complementary', exact('手记概览'))
  const cards = page.locator('article[data-task-id]')
  assert.equal(await workspace.inputValue(), '全部工作区')
  assert.equal(await toolbar.getByLabel('卡片密度').count(), 0)
  const pick = async (name, search) => {
    await workspace.click()
    if (search) await workspace.fill(search)
    await page.getByRole('option', exact(name)).click()
    assert.equal(await workspace.inputValue(), name)
  }
  await pick('Empty workspace with a long name', 'Empty workspace')
  assert.equal(await cards.count(), 0)
  await pick('Layout workspace')
  assert.equal(await cards.count(), 3)
  await pick('未分组')
  assert.equal(await cards.count(), 5)
  await pick('全部工作区')
  assert.equal(await cards.count(), 8)
  await settingsTrigger.click()
  await settings.waitFor()
  await page.getByRole('button', exact('管理列')).waitFor()
  await page.getByRole('button', exact('管理标签')).waitFor()
  await page.getByRole('button', exact('MCP 接入')).waitFor()
  if (hasAppearance) await page.getByRole('combobox', exact('任务卡片外观')).selectOption('paper')
  await page.keyboard.press('Escape')
  await settings.waitFor({ state: 'hidden' })
  if (hasAppearance) assert.equal(await page.locator('body').getAttribute('data-dsh-task-appearance'), 'paper')

  const resize = async (width, height, sidebar) => {
    await page.setViewportSize({ width, height })
    await page.locator('#root').evaluate((el, sidebar) => {
      el.style.marginInlineStart = `${sidebar}px`
      el.style.width = `calc(100% - ${sidebar}px)`
    }, sidebar)
  }
  const measure = () => toolbar.evaluate(el => {
      const root = el.closest('.dsh-tasks-board-view')
      const outer = el.getBoundingClientRect()
      const controls = [...el.querySelectorAll('.dsh-tasks-heading, .dsh-tasks-toolbar-button, .dsh-tasks-search, .dsh-tasks-workspace-picker')]
        .filter(node => node.getClientRects().length).map(node => ({ name: node.className, rect: node.getBoundingClientRect() }))
      const overlaps = controls.flatMap(({ name, rect }, i) => controls.slice(i + 1).filter(({ rect: other }) =>
        Math.min(rect.right, other.right) - Math.max(rect.left, other.left) > 1 && Math.min(rect.bottom, other.bottom) - Math.max(rect.top, other.top) > 1
      ).map(other => [name, other.name]))
      const board = root.querySelector('.dsh-tasks-board')
      const columns = [...board.querySelectorAll('.dsh-tasks-col')].map(node => node.getBoundingClientRect())
      const summary = root.querySelector('.dsh-tasks-insights').getBoundingClientRect()
      const last = columns.at(-1)
      return { panelWidth: root.clientWidth, stacked: getComputedStyle(el).gridTemplateRows.split(' ').length === 2,
        fullscreen: !!document.fullscreenElement, overlaps, offEdge: controls.filter(({ rect }) => rect.left < outer.left || rect.right > outer.right + 1).map(({ name }) => name),
        boardOverflow: board.scrollWidth - board.clientWidth, rootOverflow: root.scrollWidth - root.clientWidth,
        columns: columns.map(({ width }) => width), insightsWidth: summary.width,
        statsColumns: getComputedStyle(root.querySelector('.dsh-tasks-insight-sections')).gridTemplateColumns.split(' ').length,
        taskListColumns: getComputedStyle(root.querySelector('.dsh-tasks-insight-lists')).gridTemplateColumns.split(' ').length,
        startGutter: (summary.width ? summary.left : columns[0].left) - outer.left, endGutter: outer.right - last.right,
        insightsGap: summary.width ? columns[0].left - summary.right : 0,
        insightsHeight: summary.height, columnsHeight: columns[0].height,
        aligned: Math.abs(summary.top - columns[0].top) <= 1 && summary.bottom <= columns[0].bottom + 1 }
    })
  for (const [width, height, sidebar, show, stacked] of [
    [375, 630, 56, false, true], [900, 630, 280, false, true], [900, 630, 56, false, false],
    [1440, 840, 280, false, false], [1613, 840, 280, false, false], [1614, 840, 280, true, false],
    [2499, 1064, 280, true, false],
  ]) {
    await resize(width, height, sidebar)
    await insights.waitFor({ state: show ? 'visible' : 'hidden' })
    const layout = await measure()
    assert.equal(layout.fullscreen, false)
    assert.equal(layout.stacked, stacked, `Toolbar layout at ${width}px - ${sidebar}px`)
    assert.deepEqual(layout.overlaps, [])
    assert.deepEqual(layout.offEdge, [])
    assert(layout.rootOverflow <= 1)
    const minColumnWidth = Math.min(312, layout.panelWidth - 24)
    assert(layout.columns.every(column => column >= minColumnWidth && column <= 390), `${width}px: columns are too narrow or too wide`)
    if (show) {
      assert(layout.boardOverflow <= 1, 'Three default columns must fit when the overview appears')
      assert(layout.aligned && layout.insightsWidth >= 296)
      for (const space of [layout.startGutter, layout.endGutter, layout.insightsGap]) assert(space >= 12 && space <= 25, 'Only one gutter between each panel or edge')
      assert.equal(layout.statsColumns, width >= 2499 ? 3 : 1)
      assert.equal(layout.taskListColumns, width >= 2499 ? 2 : 1)
      if (width === 2499) assert(layout.insightsHeight < layout.columnsHeight - 120, 'Sparse statistics must not fill the full board height')
    }
    report.layouts.push({ mode: 'board', viewport: { width, height }, sidebar, ...layout })
    if ([900, 2499].includes(width) && sidebar === (width === 900 ? 56 : 280)) await screenshot(page, `board-${width}`)
  }
  const columnsOverview = insights.getByRole('region', exact('任务列分布'))
  const readColumnCount = async name => Number(await columnsOverview.getByRole('listitem').filter({ has: page.getByText(name, exact(name)) }).locator('strong').textContent())
  const attention = insights.getByRole('region', exact('待处理清单'))
  const recent = insights.getByRole('region', exact('最近完成'))
  const titles = list => list.getByRole('button').locator('strong').allTextContents()
  assert.equal(await readColumnCount('待开始'), 2)
  assert.deepEqual(await titles(attention), ['确认筛选条件文案', '回查移动端布局', '核对待发布清单', 'Layout fixture task'])
  assert.deepEqual(await titles(recent), ['完成周报初稿', '走查工作区切换', '整理组件库文档'])
  await pick('Layout workspace')
  assert.equal(await readColumnCount('待开始'), 1)
  assert.deepEqual(await titles(attention), ['确认筛选条件文案', 'Layout fixture task'])
  assert.deepEqual(await titles(recent), ['完成周报初稿'])
  await pick('Empty workspace with a long name')
  await attention.getByText('当前没有需要处理的任务。', exact('当前没有需要处理的任务。')).waitFor()
  await recent.getByText('暂无带完成时间的任务。', exact('暂无带完成时间的任务。')).waitFor()
  await pick('全部工作区')
  for (const row of [attention.getByRole('button', { name: /^核对待发布清单/ }), recent.getByRole('button', { name: /^完成周报初稿/ })]) {
    await row.click()
    const taskDetails = page.getByRole('dialog', exact('任务详情'))
    await taskDetails.waitFor()
    await closeWithEscape(page, taskDetails)
    await expectFocus(page, row, 'Closing details returns focus to the list row')
  }
  check('The overview aligns left, stacks task lists when narrow, reflects workspace scope, and opens details from either list')

  const board = page.getByRole('region', exact('看板列'))
  const drawer = page.getByRole('dialog', exact('管理列'))
  const add = async names => {
    await settingsTrigger.click()
    await settings.waitFor()
    await page.getByRole('button', exact('管理列')).click()
    for (const name of names) {
      await drawer.getByRole('textbox', exact('添加列')).fill(name)
      await drawer.getByRole('button', exact('添加列')).click()
      await page.locator(`.dsh-tasks-col[aria-label="${name}"]`).waitFor({ state: 'attached' })
    }
    await closeWithEscape(page, drawer)
  }
  const inspect = async (name, count, show, scroll, collapsed = 0) => {
    await insights.waitFor({ state: show ? 'visible' : 'hidden' })
    const layout = await measure()
    assert.equal(layout.columns.length, count)
    assert.equal(layout.columns.filter(width => width === 48).length, collapsed)
    assert(layout.columns.every(width => width === 48 || width >= 312 && width <= 390))
    assert.equal(layout.boardOverflow > 1, scroll)
    assert(layout.rootOverflow <= 1)
    if (show) {
      assert(layout.aligned && layout.insightsWidth >= 296)
      for (const space of [layout.startGutter, layout.endGutter, layout.insightsGap]) assert(space >= 12 && space <= 25)
    }
    report.layouts.push({ mode: 'board-column-management', scenario: name, ...layout })
    return layout
  }
  await add(['待验收'])
  assert.equal((await inspect('four columns on a wide window', 4, true, false)).statsColumns, 2)
  assert.equal(await readColumnCount('待验收'), 0)
  const col = name => board.getByRole('region', exact(name))
  const grip = name => col(name).getByRole('button', exact('调整列顺序: ' + name))
  const order = () => board.locator('.dsh-tasks-col').evaluateAll(rows => rows.map(row => row.getAttribute('aria-label')))
  const drag = async (from, to, x, y, active, cancel = false, during) => {
    await from.scrollIntoViewIfNeeded()
    const source = await from.boundingBox(), dst = await to.boundingBox()
    assert(source && dst)
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
    await page.mouse.down()
    await page.mouse.move(source.x + source.width / 2 + 10, source.y + source.height / 2)
    await page.locator(active).waitFor()
    const landing = { x: dst.x + dst.width * x, y: dst.y + dst.height * y }
    await page.mouse.move(landing.x, landing.y, { steps: 12 })
    await during?.(landing)
    if (cancel) await page.keyboard.press('Escape')
    await page.mouse.up()
    await page.locator(active).waitFor({ state: 'hidden' })
  }
  const dragColumn = (from, to, x, cancel, during) => drag(grip(from), col(to), x, .1, '[data-column-dragging]', cancel, during)
  const initialOrder = await order(), beforeCancel = report.writes.length
  const preview = page.locator('.dsh-tasks-column-preview')
  const marker = board.locator('[data-column-insert]')
  await dragColumn('待验收', '待开始', .2, true, async () => {
    await preview.getByText('松手放在「待开始」前', exact('松手放在「待开始」前')).waitFor()
    assert.equal(await marker.getAttribute('data-column-insert'), 'before')
    assert.deepEqual(await order(), initialOrder, 'Preview must not reorder the board before release')
    assert.equal(report.writes.length, beforeCancel)
  })
  await dragColumn('待验收', '待开始', .2, false, async () => {
    await marker.waitFor()
    await page.mouse.move(350, 103)
    await preview.getByText('拖到两列之间调整顺序', exact('拖到两列之间调整顺序')).waitFor()
    await marker.waitFor({ state: 'hidden' })
  })
  assert.deepEqual(await order(), initialOrder)
  assert.equal(report.writes.length, beforeCancel)
  await dragColumn('待验收', '待开始', .2)
  await board.locator('.dsh-tasks-col').first().filter({ has: page.getByRole('button', exact('调整列顺序: 待验收')) }).waitFor()
  assert.deepEqual(await order(), ['待验收', '待开始', '进行中', '已完成'])
  assert.equal(await readColumnCount('待验收'), 0, 'Column drags must not move a task')
  await grip('待验收').press('ArrowRight')
  await board.locator('.dsh-tasks-col').nth(1).filter({ has: page.getByRole('button', exact('调整列顺序: 待验收')) }).waitFor()
  assert.deepEqual(await order(), ['待开始', '待验收', '进行中', '已完成'])
  await expectFocus(page, grip('待验收'), 'Keyboard reorder keeps focus on the moved column')
  await col('进行中').locator('.dsh-tasks-coltitle').click()
  await dragColumn('待验收', '进行中', 1.1, false, async ({ x }) => {
    await preview.getByText('松手放在「已完成」前', exact('松手放在「已完成」前')).waitFor()
    assert.equal(await marker.getAttribute('aria-label'), '已完成')
    const [left, right] = await Promise.all([col('进行中').boundingBox(), col('已完成').boundingBox()])
    assert(x > left.x + left.width && x < right.x, 'The pointer must really be in the column gap')
    assert(await marker.evaluate(el => getComputedStyle(el, '::after').width === '3px'))
    assert((await preview.boundingBox()).width <= 244)
    await screenshot(page, 'column-reorder-drop-preview')
  })
  await board.locator('.dsh-tasks-col').nth(2).filter({ has: page.getByRole('button', exact('调整列顺序: 待验收')) }).waitFor()
  assert.deepEqual(await order(), ['待开始', '进行中', '待验收', '已完成'])
  await col('进行中').locator('.dsh-tasks-coltitle').click()
  await drag(col('待开始').locator('.dsh-tasks-card-title', { hasText: 'Layout fixture task' }), col('待验收'), .5, .3, '[data-dragging=true]')
  await col('待验收').getByRole('button', exact('Layout fixture task')).waitFor()
  assert.equal(await readColumnCount('待验收'), 1)
  assert.deepEqual(await order(), ['待开始', '进行中', '待验收', '已完成'], 'Card drags must not reorder columns')
  await grip('待验收').click()
  await drawer.waitFor()
  const managed = name => drawer.locator('.dsh-tasks-column-form').filter({ has: page.locator(`input[value="${name}"]`) })
  await drag(managed('待验收').locator('.dsh-tasks-grip'), managed('已完成'), .4, .8, '.dsh-tasks-drag-preview')
  await closeWithEscape(page, drawer)
  await board.locator('.dsh-tasks-col').last().filter({ has: page.getByRole('button', exact('调整列顺序: 待验收')) }).waitFor()
  assert.deepEqual(await order(), initialOrder)
  check('Main-board pointer and keyboard reorder columns, including collapsed targets; cancellation and task dragging stay independent, and the manager still reorders')
  await screenshot(page, 'board-2499-four-columns')
  await resize(1637, 1034, 280)
  const reference = await inspect('four columns match the reference width without an overview', 4, false, false)
  assert(reference.columns.every(width => Math.abs(width - 314) <= 1))
  await screenshot(page, 'board-1637-four-columns')
  await resize(1701, 1034, 280)
  await inspect('the overview stays hidden rather than squeezing the four columns', 4, false, false)
  await resize(1955, 1034, 280)
  await inspect('one pixel below the four-column overview threshold', 4, false, false)
  await resize(1956, 1034, 280)
  await inspect('the overview appears only once all four columns fit at their minimum width', 4, true, false)
  await screenshot(page, 'board-1956-four-columns-with-overview')
  await resize(1956, 630, 280)
  await exerciseBoardScrollbar(page)
  await resize(2499, 1064, 280)
  await add(['排期', '评审'])
  await inspect('six columns fit without an overview', 6, false, false)
  await add(['待发布', '已发布', '归档'])
  await inspect('nine columns scroll inside the board', 9, false, true)
  const lastColumn = board.getByRole('region', exact('归档'))
  await board.focus()
  await board.press('ArrowRight')
  await page.waitForFunction(() => document.querySelector('.dsh-tasks-board-strip').scrollLeft > 0)
  await board.evaluate(el => { el.scrollLeft = el.scrollWidth })
  const fullyVisible = await lastColumn.evaluate(el => {
    const column = el.getBoundingClientRect(), board = el.parentElement.getBoundingClientRect()
    return column.left >= board.left && column.right <= board.right
  })
  assert(fullyVisible, 'Horizontal scrolling reaches the last custom column')
  for (const name of ['归档', '已发布', '待发布', '评审', '排期']) {
    await board.getByRole('region', exact(name)).locator('.dsh-tasks-coltitle').click()
  }
  await inspect('collapsing enough columns restores the overview', 9, true, false, 5)
  await page.setViewportSize({ width: 900, height: 630 })
  await insights.waitFor({ state: 'hidden' })
  check('Adding and folding real columns reallocates wide space and all overflow stays inside the keyboard-scrollable board')
  await page.locator('#root').evaluate(el => { el.style.marginInlineStart = ''; el.style.width = '' })
  if (hasAppearance) await selectAppearance(page, 'default', 'inherit')
  await page.setViewportSize({ width: 375, height: 740 })
}

async function inspectAddColumnForm(dialog, tag) {
  const form = dialog.locator('.dsh-tasks-manage-create')
  await form.scrollIntoViewIfNeeded()
  const boxes = await form.evaluate(form => {
    const box = element => {
      const { left, top, right, bottom, width, height } = element.getBoundingClientRect()
      return { left, top, right, bottom, width, height }
    }
    return { form: box(form), name: box(form.querySelector('.dsh-tasks-input')),
      stage: box(form.querySelector('[role=combobox]')), submit: box(form.querySelector('button[type=submit]')) }
  })
  const controls = [boxes.name, boxes.stage, boxes.submit]
  for (const [index, a] of controls.entries()) {
    assert(a.width > 0 && a.height >= 35 && a.left >= boxes.form.left && a.right <= boxes.form.right && a.top >= boxes.form.top && a.bottom <= boxes.form.bottom,
      `${tag}: control must fit inside the form: ${JSON.stringify(boxes)}`)
    for (const b of controls.slice(index + 1)) {
      assert(a.right <= b.left - 4 || b.right <= a.left - 4 || a.bottom <= b.top - 4 || b.bottom <= a.top - 4,
        `${tag}: controls must not overlap and need a gap: ${JSON.stringify(boxes)}`)
    }
  }
  assert(Math.abs(boxes.name.width - boxes.stage.width) <= 1 && Math.abs(boxes.name.height - boxes.stage.height) <= 1,
    `${tag}: column name and stage should be equal in both dimensions: ${JSON.stringify(boxes)}`)
  return boxes
}

async function exerciseManagement(page, fixture, hasPaper = false) {
  const settings = page.locator('.dsh-tasks-board-toolbar summary[aria-label="Board settings"]')
  const open = async name => {
    await settings.click()
    await page.getByRole('button', exact(name)).click()
    const dialog = page.getByRole('dialog', exact(name))
    await dialog.waitFor()
    return dialog
  }
  const names = [['columns', 'Manage columns', 'Add column'], ['labels', 'Manage labels', 'Add label'], ['mcp', 'MCP access', 'Generate key']]
  const initialWrites = report.writes.length
  await setTheme(page, 'light')
  for (const viewport of [{ width: 1366, height: 900 }, { width: 375, height: 740 }]) {
    await page.setViewportSize(viewport)
    for (const [mode, name, actionName] of names) {
      const tag = `${name} at ${viewport.width}px`
      const dialog = await open(name)
      const isManager = mode !== 'mcp'
      if (isManager) assert.equal(await dialog.and(page.locator('dialog.dsh-tasks-management-dialog[open]')).count(), 1,
        `${tag} must be a native management modal rather than an editor drawer`)
      const close = dialog.locator('.dsh-tasks-dialog-head').getByRole('button', exact('Close'))
      await close.waitFor()
      if (isManager) await expectFocus(page, close, `${tag} should initially focus its close button`)
      else await dialog.getByRole('status').getByText('No key is active.', exact('No key is active.')).waitFor()
      const body = dialog.locator(isManager ? '.dsh-tasks-management' : '.dsh-tasks-mcp-body')
      const action = dialog.getByRole('button', exact(actionName))
      await action.waitFor()
      const [box, head] = await Promise.all([rect(dialog), rect(close)])
      const measure = await body.evaluate(node => ({ horizontalOverflow: node.scrollWidth - node.clientWidth,
        verticalOverflow: node.scrollHeight - node.clientHeight, overflowY: getComputedStyle(node).overflowY }))
      assert(Math.abs(box.x + box.width / 2 - viewport.width / 2) <= 2 && Math.abs(box.y + box.height / 2 - viewport.height / 2) <= 2,
        `${tag} should center in the viewport, not attach to an edge`)
      assert(box.x >= 6 && box.y >= 6 && box.x + box.width <= viewport.width - 6 && box.y + box.height <= viewport.height - 6,
        `${tag} must fit with margins on all four sides`)
      if (isManager && viewport.width === 1366) assert(box.width <= 560 && box.height <= 630, `${tag} should remain compact on desktop`)
      assert(measure.horizontalOverflow <= 1, `${tag} must not scroll horizontally`)
      assert(head.x >= box.x && head.x + head.width <= box.x + box.width + 1 && head.y >= box.y,
        `${tag} close control must be inside the dialog`)
      assert(await dialog.evaluate(el => el.matches(':modal')), `${tag} must block interaction with the underlying task board`)
      report.management.layouts.push({ mode, viewport, box, ...measure })
      await screenshot(page, `management-${mode}-${viewport.width}`)
      await action.scrollIntoViewIfNeeded()
      const actionBox = await rect(action), closeAfterScroll = await rect(close)
      assert(actionBox.x >= box.x && actionBox.x + actionBox.width <= box.x + box.width + 1 &&
        actionBox.y >= box.y && actionBox.y + actionBox.height <= box.y + box.height + 1, `${tag} primary action is clipped`)
      if (isManager && measure.verticalOverflow > 1) {
        assert(['auto', 'scroll'].includes(measure.overflowY), `${tag} overflowing content must scroll internally`)
        assert(Math.abs(closeAfterScroll.y - head.y) <= 1, `${tag} header must stay in place as the body scrolls`)
      }
      if (mode === 'columns') {
        report.management.addColumnForms.push({ viewport, ...(await inspectAddColumnForm(dialog, tag)) })
        await screenshot(page, `add-column-${viewport.width}`)
      }
      if (viewport.width === 375 && isManager) {
        const form = dialog.locator('.dsh-tasks-manage-create')
        const value = mode === 'columns' ? 'Fixture review' : 'Fixture important'
        const textboxName = mode === 'columns' ? 'Add column' : 'Label name'
        await form.getByRole('textbox', exact(textboxName)).fill(value)
        if (mode === 'columns') {
          const stage = form.getByRole('combobox', exact('Task column'))
          await stage.press('ArrowDown')
          await dialog.getByRole('listbox', exact('Task column')).waitFor()
          await stage.press('ArrowDown')
          await stage.press('Enter')
          assert.equal(await stage.inputValue(), 'Done')
        }
        await action.click()
        await dialog.locator(`.dsh-tasks-manage-list input[value="${value}"]`).waitFor()
        assert.equal(report.writes.at(-1).input.name, value)
        if (mode === 'columns') assert.equal(report.writes.at(-1).input.stage, 'done')
      }
      await closeWithEscape(page, dialog)
      if (isManager) await expectFocus(page, settings, `${tag} should restore the board settings trigger on Escape`)
    }
  }
  await page.setViewportSize({ width: 1366, height: 900 })
  const quickRename = page.getByRole('button', exact('Rename: To do'))
  await quickRename.click()
  const columns = page.getByRole('dialog', exact('Manage columns'))
  const selected = columns.locator('[data-column-id="stage:todo"]').getByRole('textbox', exact('Column name'))
  await expectFocus(page, selected, 'Board column rename should focus the matching column input')
  await closeWithEscape(page, columns)
  await expectFocus(page, quickRename, 'Column management Escape should restore its board-column trigger')
  const writes = report.writes.slice(initialWrites)
  assert.deepEqual(writes.map(({ operation, input }) => [operation, input.action, input.expectedRevision]),
    [['edit-columns', 'add', 1], ['edit-labels', 'add', 2]], 'Only the two explicit submissions should write synthetic board state')
  assert.deepEqual(fixture.mcpReads, ['status', 'status'], 'MCP check must only read fixture status once per viewport')
  check('Management modals are centered and compact at 1366px, fit at 375px, restore column or settings focus on Escape, and preserve add operations')
  await page.setViewportSize({ width: 320, height: 640 })
  if (hasPaper) await selectAppearance(page, 'paper', 'inherit')
  const narrow = await open('Manage columns')
  report.management.addColumnForms.push({ viewport: page.viewportSize(), ...(await inspectAddColumnForm(narrow, 'Manage columns at 320px')) })
  await screenshot(page, 'add-column-320')
  await closeWithEscape(page, narrow)
  check('Add column fields match in height and width, and the submit control never overlaps at 1366, 375 or 320px')
}

async function exerciseChineseDate(page) {
  const newTask = page.getByRole('button', exact('新建任务'))
  const drawer = page.getByRole('dialog', exact('新建任务'))
  const trigger = drawer.getByRole('button', { name: /^截止日期:/ })
  const calendar = drawer.getByRole('dialog', exact('选择日期'))
  await newTask.click()
  await trigger.click()
  await calendar.getByRole('button', exact('今天')).waitFor()
  await calendar.getByRole('button', exact('明天')).waitFor()
  await screenshot(page, 'create-date-zh-375')
  await closeWithEscape(page, calendar)
  await drawer.waitFor()
  await expectFocus(page, trigger, 'Escape should close only the Chinese calendar and focus its trigger')
  await trigger.click()
  await calendar.getByRole('button', exact('今天')).click()
  const clear = drawer.getByRole('button', exact('清除日期'))
  await clear.click()
  await expectFocus(page, trigger, 'Clearing a date should return focus in Chinese too')
  assert.match(await trigger.getAttribute('aria-label'), /选择日期/)
  await closeWithEscape(page, drawer)
  await expectFocus(page, newTask, 'Second-level Escape should restore the Chinese create opener')
  check('Chinese date presets, clear label, and nested Escape focus are accessible at 375px')
}

async function exerciseInteractions(page, fixture, { updateStarted, releaseUpdate, requests }) {
  const strip = page.locator('.dsh-tasks-board-strip')
  const card = id => strip.locator(`article[data-task-id="${id}"]`)
  const source = card(fixture.seedId), other = card(fixture.snapshotId)
  const detail = page.getByRole('dialog', exact('Task details'))
  const grab = other.locator('.dsh-tasks-grip')
  const gripNode = await grab.elementHandle()
  const boardNode = await strip.elementHandle()
  await source.locator('.dsh-tasks-card-title').click()
  await detail.getByRole('button', exact('Edit description')).click()
  const saved = `A description with [Open in TAPD](<${externalLink}>)`
  await detail.locator('textarea[name=brief]').fill(saved)
  try {
    await detail.getByRole('button', exact('Save changes')).click()
    await updateStarted
    assert(await gripNode.evaluate(el => el.isConnected && el.matches('.dsh-tasks-grip')), 'Saving must not remove unrelated card grips')
    assert(await boardNode.evaluate(el => el.isConnected), 'Saving must not remount the board')
  } finally { releaseUpdate() }
  const link = detail.getByRole('link', exact('Open in TAPD'))
  await link.waitFor()
  assert.equal(await link.getAttribute('href'), externalLink)
  assert.equal(await link.getAttribute('rel'), 'noopener noreferrer')
  const originalUrl = page.url()
  await page.evaluate(() => {
    const open = window.open
    window.__taskOpenCalls = []
    window.open = (...args) => { window.__taskOpenCalls.push(args); return open.apply(window, args) }
  })
  for (const open of [() => link.click(), () => link.press('Enter')]) {
    const [popup] = await Promise.all([page.context().waitForEvent('page'), open()])
    await popup.waitForURL(externalLink)
    await popup.close()
    assert.equal(page.url(), originalUrl)
    assert(await detail.isVisible())
  }
  assert.deepEqual(await page.evaluate(() => window.__taskOpenCalls), Array.from({ length: 2 }, () => [externalLink, '_blank', 'noopener,noreferrer']))
  assert.equal(requests.filter(operation => operation === 'list').length, 1, 'Saving should not request a fresh board')
  await closeWithEscape(page, detail)
  assert(await gripNode.evaluate(el => el.isConnected), 'Successful save must preserve unrelated card controls')
  check('TAPD-style link delegates pointer and Enter to the opener; editing and saving keep the board and unrelated grips mounted')

  const target = strip.locator('[data-column-id="stage:doing"]')
  async function drag(cancel) {
    const grip = source.locator('.dsh-tasks-grip')
    await grip.scrollIntoViewIfNeeded()
    const from = await grip.boundingBox(), to = await target.boundingBox()
    assert(from && to)
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2)
    await page.locator('.dsh-tasks-drag-preview').waitFor()
    await page.mouse.move(to.x + to.width / 2, to.y + Math.min(to.height / 2, 120), { steps: 16 })
    await target.locator(':scope[data-drop="true"]').waitFor()
    assert.equal(requests.filter(operation => operation === 'move').length, 0, 'No mutation before drop')
    if (cancel) await page.keyboard.press('Escape')
    await page.mouse.up()
    await page.locator('.dsh-tasks-drag-preview').waitFor({ state: 'hidden' })
  }
  await drag(true)
  assert.equal(requests.filter(operation => operation === 'move').length, 0)
  await drag(false)
  await target.locator(`[data-task-id="${fixture.seedId}"]`).waitFor()
  assert.equal(requests.filter(operation => operation === 'move').length, 1)
  assert(await gripNode.evaluate(el => el.isConnected))
  check('Mouse drag marks the destination, Escape cancels, and drop moves only the selected card')
}

export { findTools, loadShell, readClientInputs, readAppearanceClient, mount, report }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
let browser, page, mounted, paperMounted, managed, chinese, phase = 'setup'
const fixtureErrors = () => [mounted, paperMounted, managed, chinese].flatMap(run => run?.errors ?? [])
try {
  await mkdir(output, { recursive: true })
  const { pw, dist, themeClient, executablePath } = findTools()
  const playwright = await import(pathToFileURL(pw).href)
  const chromium = playwright.chromium ?? playwright.default?.chromium
  assert(chromium, 'Selected Playwright entry does not export Chromium')
  const [shell, appearance, inputs] = await Promise.all([loadShell(dist, themeClient), readAppearanceClient(), readClientInputs()])
  inputs.appearance = appearance?.source
  report.client = inputs.mode
  report.tools = { playwright: pw, frontend: dist, themeClient, browser: executablePath || chromium.executablePath() }
  browser = await chromium.launch({ executablePath, headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] })
  const contextOptions = { timezoneId: 'UTC', serviceWorkers: 'block', reducedMotion: 'reduce' }
  const context = await browser.newContext({ ...contextOptions, viewport: { width: 1366, height: 900 }, locale: 'en-US' })
  phase = 'mount fixture'
  const fixture = makeFixture()
  const interactionsOnly = process.env.TASK_DRAWER_LAYOUT_INTERACTIONS === '1'
  const requests = [], updateStarted = Promise.withResolvers(), updateGate = Promise.withResolvers()
  if (interactionsOnly) {
    const rpc = fixture.rpc
    fixture.rpc = async request => {
      requests.push(request.operation)
      if (request.operation === 'update') { updateStarted.resolve(); await updateGate.promise }
      return rpc(request)
    }
  }
  mounted = await mount(context, dist, shell, inputs, fixture)
  page = mounted.page
  phase = 'exercise Tasks UI'
  if (interactionsOnly) await exerciseInteractions(page, fixture, { updateStarted: updateStarted.promise, releaseUpdate: updateGate.resolve, requests })
  else {
  await exercise(page, fixture, mounted.reload)
  if (appearance?.paper) {
    phase = 'mount Paper fixture'
    report.paper = { client: appearance.path, layouts: [], overlays: [], attachmentStates: [] }
    const paperContext = await browser.newContext({ ...contextOptions, viewport: { width: 375, height: 740 }, locale: 'en-US' })
    const paperFixture = makeFixture()
    paperMounted = await mount(paperContext, dist, shell, inputs, paperFixture)
    page = paperMounted.page
    phase = 'exercise Paper create and detail drawers'
    await exercisePaper(page, paperFixture)
    phase = 'exercise Paper attachment states'
    await exercisePaperAttachments(page, paperFixture)
  }
  if (process.env.TASK_DRAWER_LAYOUT_MANAGEMENT === '1') {
    phase = 'mount management fixture'
    report.management = { layouts: [], addColumnForms: [] }
    const managementContext = await browser.newContext({ ...contextOptions, viewport: { width: 1366, height: 900 }, locale: 'en-US' })
    const managementFixture = makeFixture()
    managed = await mount(managementContext, dist, shell, inputs, managementFixture)
    page = managed.page
    phase = 'exercise management modals'
    await exerciseManagement(page, managementFixture, !!appearance?.paper)
  }
  phase = 'mount Chinese fixture'
  const chineseContext = await browser.newContext({ ...contextOptions, viewport: { width: 375, height: 740 }, locale: 'zh-CN' })
  chinese = await mount(chineseContext, dist, shell, inputs, makeFixture({ overview: true }), 'zh')
  page = chinese.page
  if (process.env.TASK_DRAWER_LAYOUT_EDITOR_ONLY !== '1') {
    phase = 'exercise responsive board'
    await exerciseBoard(page, !!appearance)
  }
  phase = 'exercise Chinese calendar'
  const writes = report.writes.length
  await exerciseChineseDate(page)
  assert.equal(report.writes.length, writes, 'Chinese calendar preview and clear must not write')
  }
  phase = 'check browser and fixture errors'
  assert.deepEqual(report.pageErrors, [], 'Unexpected browser errors')
  assert.deepEqual(fixtureErrors(), [], 'Unexpected fixture errors')
  report.passed = true
} catch (error) {
  report.failure = { phase, message: error.message, stack: error.stack, ...(error.cause ? { cause: error.cause.message } : {}) }
  if (page && !page.isClosed()) {
    try { await screenshot(page, 'failure') } catch (screenshotError) { report.failure.screenshotError = screenshotError.message }
  }
  console.error(error)
  process.exitCode = 1
} finally {
  report.fixtureErrors = fixtureErrors()
  try { await browser?.close() }
  finally {
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    console.log(`${report.passed ? 'PASS' : 'FAIL'}: ${join(output, 'report.json')}`)
  }
}
}
