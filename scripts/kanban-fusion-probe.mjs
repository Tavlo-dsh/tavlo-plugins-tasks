import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const required = name => { assert(process.env[name], `Set ${name}`); return resolve(process.env[name]) }
const cli = required('DSH_CLI')
const playwright = required('PLAYWRIGHT_MODULE')
const executablePath = required('BROWSER_EXE')
const output = required('FUSION_PROBE_OUTPUT')
const tavloPackage = required('FUSION_TAVLO_PACKAGE')
const kanbanPackage = required('FUSION_KANBAN_PACKAGE')
const themePackage = process.env.FUSION_F1_THEME_PACKAGE && required('FUSION_F1_THEME_PACKAGE')
const { chromium } = await import(pathToFileURL(playwright).href)
const temp = await realpath(tmpdir())
const root = await mkdtemp(join(temp, 'tavlo-fusion-probe-'))
const workspace = join(root, 'F0 Fixture')
const workspaceRecord = join(root, 'workspace.json')
const env = { ...process.env, DSH_HOME: join(root, 'home'), DSH_TELEMETRY_DISABLED: '1' }
for (const key of Object.keys(env)) if (/API_?KEY|TOKEN|SECRET|PASSWORD|^NODE_(PATH|OPTIONS)$/i.test(key)) delete env[key]
const run = promisify(execFile)
const runDsh = args => run(process.execPath, [cli, ...args], { cwd: root, env, windowsHide: true, timeout: 180000 })
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const checks = []
const check = description => { checks.push(description); console.log('PASS: ' + description) }
const nextFrame = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const screenshot = (page, name) => process.env.FUSION_NO_SCREENSHOTS === '1' ? undefined : page.screenshot({ path: join(output, name), animations: 'disabled' })
const checkFocused = async locator => assert(await locator.evaluate(element => document.activeElement === element), 'Expected focus on the invoking control')
let host, browser, passed = false, phase = 'setup'

try {
  await mkdir(output, { recursive: true })
  await mkdir(workspace)
  await mkdir(join(root, 'documents'))
  const seedPath = join(root, 'seed-workspace.mjs')
  await writeFile(seedPath, `import { writeFile } from 'node:fs/promises'
export const inject = ['workspaceController']
export async function apply(ctx) {
  const result = await ctx.workspaceController.create({ path: ${JSON.stringify(workspace)} })
  await writeFile(${JSON.stringify(workspaceRecord)}, JSON.stringify(result.workspace))
}
`)
  const patch = join(root, 'offline.patch.yml')
  await writeFile(patch, `- id: agent-default-model
  config:
    provider: tasks-baseline-offline
    model: offline
- id: workspace-controller
  config:
    documentsDirectory: ${JSON.stringify(join(root, 'documents'))}
- id: ui-settings-general
  config:
    welcomeNoticeVersion: 2026-09-28.1
- id: ui-settings-account
  disabled: true
- id: ui-settings-models
  disabled: true
- insert:
    - id: f0-seed-workspace
      name: ${JSON.stringify(pathToFileURL(seedPath).href)}
`)
  phase = 'install isolated profile'
  console.log('Installing Tavlo and dsh-kanban in an isolated Web profile…')
  await runDsh(['plugin', '--profile', 'web', 'add', '--prod', tavloPackage, kanbanPackage, ...(themePackage ? [themePackage] : []), '--prefer-offline', '--reporter=append-only'])
  phase = 'boot loopback host'
  const logPath = join(root, 'host.log')
  const log = await open(logPath, 'w')
  try {
    host = spawn(process.execPath, [cli, '--profile', 'web', '--patch', patch, '--no-open', '--host', '127.0.0.1', '--port', '0'],
      { cwd: root, env, windowsHide: true, stdio: ['ignore', log.fd, log.fd] })
    await once(host, 'spawn')
  } finally { await log.close() }
  let login
  for (let attempt = 0; attempt < 720; attempt++) {
    assert.equal(host.exitCode, null, 'Host exited before printing its login URL')
    login = (await readFile(logPath, 'utf8')).match(/http:\/\/127\.0\.0\.1:\d+\/[^\s\x1b]*/)?.[0]
    if (login) break
    await delay(250)
  }
  assert(login, 'Timed out waiting for the loopback Host')
  const origin = new URL(login).origin
  const { workspaceId, path } = JSON.parse(await readFile(workspaceRecord, 'utf8'))
  assert(workspaceId)
  assert.equal(await realpath(path), await realpath(workspace))

  phase = 'open both boards in DSH'
  browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-gpu'] })
  const browserContext = await browser.newContext({ viewport: { width: 1680, height: 960 }, locale: 'zh-CN', serviceWorkers: 'block' })
  await browserContext.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  const page = await browserContext.newPage()
  page.setDefaultTimeout(60000)
  page.setDefaultNavigationTimeout(90000)
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.name))
  await page.addLocatorHandler(page.getByText(/^(开始使用|Get started)$/), async () => {
    await page.getByRole('button', { name: /^(关闭|Close)$/ }).last().click()
  })
  await page.goto(login, { waitUntil: 'domcontentloaded' })
  const showBoard = () => page.getByText(/^(看板|Board)$/).first().click()
  await page.getByText(/^(任务|Tasks)$/).first().click()
  await page.locator('[data-task-sync="live"]').waitFor()
  if (process.env.FUSION_F4 === '1') {
    phase = 'Tavlo F4 task images'
    const { verifyImages } = await import('./kanban-fusion-f4-images.mjs')
    await verifyImages({ page, check, screenshot, checkFocused })
  } else if (process.env.FUSION_F3 === '1') {
    phase = 'Tavlo F3 metadata, comments and search'
    const { verifyCollaboration } = await import('./kanban-fusion-f3-collaboration.mjs')
    await verifyCollaboration({ page, check, screenshot })
  } else if (process.env.FUSION_F2 === '1') {
    phase = 'Tavlo F2 column and drag checks'
    const { verifyColumns } = await import('./kanban-fusion-f2-columns.mjs')
    await verifyColumns({ page, check, screenshot })
  } else if (themePackage) {
    phase = 'Tavlo F1 drawer checks'
    const { verifyDrawers } = await import('./kanban-fusion-f1-drawers.mjs')
    await verifyDrawers({ page, check, checkFocused, screenshot })
  } else {
    await page.getByRole('button', { name: /^(新建任务|New task)$/ }).click({ force: true })
    const tavloDialog = page.locator('dialog.dsh-tasks-dialog[open]')
    await tavloDialog.waitFor()
    await page.keyboard.press('Escape')
    await tavloDialog.waitFor({ state: 'hidden' })
    check('Frozen Tavlo package loads in DSH, reaches real SSE and opens its original modal')
  }

  const call = async (method, args = {}) => {
    const response = await browserContext.request.post(origin + '/api/kanban', { data: { method, args: { ...args, workspaceId } } })
    assert(response.ok(), `Kanban ${method} returned HTTP ${response.status()}`)
    const result = await response.json()
    assert.equal(result.error, undefined)
    return result
  }
  const initial = await call('get')
  assert(initial.imageLimits?.mediaTypes.includes('image/png'), 'Published DSH exposes native PNG attachments')
  const [todo, doing] = initial.board.columns
  const titleA = 'F0 Drag A', titleB = 'F0 Drag B'
  const first = await call('addCard', { title: titleA, columnId: todo.id, note: 'Synthetic drag-and-image fixture' })
  await call('addCard', { title: titleB, columnId: todo.id })
  await showBoard()
  const card = title => page.locator(`.kanban-sortable-card[aria-label="${title}"]`)
  const column = name => page.locator('.kanban-column').filter({ has: page.locator('.kanban-column-title', { hasText: name }) }).first()
  const titles = async name => column(name).locator('.kanban-card-title').allTextContents()
  await card(titleA).waitFor()
  assert.deepEqual(await titles(todo.title), [titleA, titleB])
  const point = async (locator, relativeY = 0.5) => {
    const box = await locator.boundingBox()
    assert(box, 'Drag target must be rendered')
    return { x: box.x + box.width / 2, y: box.y + box.height * relativeY }
  }
  const drag = async (sourceCard, targetLocator, targetRelativeY) => {
    await sourceCard.hover({ force: true })
    const source = await point(sourceCard)
    const target = await point(targetLocator, targetRelativeY)
    await page.mouse.move(source.x, source.y)
    await page.mouse.down()
    await page.mouse.move(source.x + 12, source.y)
    await page.locator('.kanban-sortable-card.is-dragging').waitFor()
    await page.mouse.move(target.x, target.y, { steps: 15 })
    await nextFrame(page)
  }
  let moveRequests = 0
  const isMove = request => request.url() === origin + '/api/kanban' && request.postDataJSON()?.method === 'moveCard'
  page.on('request', request => { if (isMove(request)) moveRequests++ })
  const drop = async () => {
    const response = page.waitForResponse(value => isMove(value.request()))
    await page.mouse.up()
    const result = await response
    assert(result.ok(), `Drag write returned HTTP ${result.status()}`)
    assert.equal((await result.json()).persisted, true)
    await nextFrame(page)
  }
  phase = 'same-column ordering'
  await drag(card(titleA), card(titleB), 0.84)
  await drop()
  assert.deepEqual((await call('get')).board.cards.filter(row => row.columnId === todo.id).map(row => row.title), [titleB, titleA])
  await page.reload({ waitUntil: 'domcontentloaded' })
  await showBoard()
  await card(titleA).waitFor()
  assert.deepEqual(await titles(todo.title), [titleB, titleA])
  check('Upstream dnd-kit reorders cards with a real pointer and preserves order after reload')

  phase = 'cross-column drop and cancel'
  assert.deepEqual(await titles(doing.title), [])
  await drag(card(titleA), column(doing.title).locator('.kanban-column-empty'))
  await drop()
  const moved = (await call('get')).board.cards.find(row => row.id === first.cardId)
  assert.equal(moved.columnId, doing.id)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await showBoard()
  await card(titleA).waitFor()
  assert.deepEqual(await titles(doing.title), [titleA])
  await drag(card(titleA), card(titleB))
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await page.locator('.kanban-sortable-card.is-dragging').waitFor({ state: 'hidden' })
  assert.equal(moveRequests, 2)
  assert.deepEqual((await call('get')).board.cards.find(row => row.id === first.cardId), moved)
  assert.equal(await page.locator('.kanban-drawer-content').count(), 0)
  check('Upstream drops into an empty column, persists it and cancels with no write or drawer')
  await screenshot(page, 'upstream-drag-persisted.png')

  phase = 'real image and modal focus'
  await card(titleA).click()
  const drawer = page.locator('.kanban-drawer-content')
  await drawer.waitFor()
  const fixturePNG = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 480; canvas.height = 240
    const context = canvas.getContext('2d')
    context.fillStyle = '#17496a'; context.fillRect(0, 0, 480, 240)
    context.fillStyle = '#f5eedc'; context.fillRect(44, 42, 392, 156)
    context.fillStyle = '#17496a'; context.font = '25px sans-serif'; context.fillText('F0 image fixture', 70, 120)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  const uploaded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/kanban/image/upload')
  await drawer.locator('input[type="file"]').setInputFiles({ name: 'f0-fixture.png', mimeType: 'image/png', buffer: Buffer.from(fixturePNG, 'base64') })
  const upload = await uploaded
  assert(upload.ok(), `Image upload returned HTTP ${upload.status()}`)
  const uploadResult = await upload.json()
  assert.equal(uploadResult.persisted, true)
  const [image] = uploadResult.board.cards.find(row => row.id === first.cardId).images
  assert.deepEqual(Object.keys(image).sort(), ['attachmentId', 'bytes', 'height', 'mediaType', 'width'])
  const imagePath = '/api/kanban/image?' + new URLSearchParams({ workspaceId, cardId: first.cardId, attachmentId: image.attachmentId })
  const read = await browserContext.request.get(origin + imagePath)
  assert(read.ok())
  const bytes = await read.body()
  assert.equal(bytes.length, image.bytes)
  assert.equal('sha256:' + sha256(bytes), image.attachmentId)
  const thumb = drawer.locator('.kanban-image-open')
  await page.waitForFunction(() => document.querySelector('.kanban-image-open:not(:disabled) img')?.naturalWidth > 0)
  await screenshot(page, 'upstream-drawer.png')
  const titleField = drawer.getByRole('textbox', { name: /^(标题|Title)$/ })
  await titleField.fill('F0 unsaved draft')
  await thumb.click()
  const preview = page.getByRole('dialog', { name: /^(图片|Images)$/ })
  const close = preview.getByRole('button', { name: /^(关闭|Close)$/ })
  await close.waitFor()
  await checkFocused(close)
  await screenshot(page, 'upstream-native-preview.png')
  await page.keyboard.press('Escape')
  await preview.waitFor({ state: 'hidden' })
  assert(await drawer.isVisible(), 'First Escape must not dismiss the drawer')
  await checkFocused(thumb)
  assert.equal(await titleField.inputValue(), 'F0 unsaved draft')
  await titleField.fill(titleA)
  await page.keyboard.press('Escape')
  await drawer.waitFor({ state: 'hidden' })
  await checkFocused(card(titleA))
  check('Upstream uploads and reads a native PNG; Escape preserves the draft and returns focus preview → thumbnail → card')

  phase = 'native dialog top-layer conflict'
  await card(titleA).click()
  await thumb.click()
  await close.waitFor()
  const outsideInert = await close.evaluate(previewClose => {
    const dialog = document.createElement('dialog')
    const inside = document.createElement('button')
    inside.textContent = 'F0 native dialog focus witness'
    dialog.append(inside)
    document.body.prepend(dialog)
    try {
      dialog.showModal()
      previewClose.focus()
      return dialog.contains(document.activeElement) && !dialog.contains(previewClose)
    } finally {
      dialog.close()
      dialog.remove()
    }
  })
  assert(outsideInert, 'A body-portaled lightbox cannot take focus above an active native dialog')
  check('An active showModal() blocks focus into DSH’s body-portaled preview; F1 should share the Host modal layer')

  phase = 'verify durable fixture files'
  const disk = JSON.parse(await readFile(join(workspace, '.dsh-kanban.json'), 'utf8'))
  const saved = disk.cards.find(row => row.id === first.cardId)
  assert.equal(saved.columnId, doing.id)
  assert.deepEqual(saved.images, [image])
  assert.deepEqual(pageErrors, [])
  const { stdout } = await runDsh(['--version'])
  await writeFile(join(output, 'browser-probe.json'), JSON.stringify({
    capturedAt: new Date().toISOString(), checks, node: process.version, dsh: stdout.trim(), browser: browser.version(),
    playwright: JSON.parse(await readFile(join(dirname(playwright), 'package.json'), 'utf8')).version,
    tavloSha256: sha256(await readFile(tavloPackage)), kanbanSha256: sha256(await readFile(kanbanPackage)),
    harnessSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    ...(process.env.FUSION_F4 === '1' ? { imageChecksSha256: sha256(await readFile(new URL('./kanban-fusion-f4-images.mjs', import.meta.url))) } : {}),
    ...(process.env.FUSION_F3 === '1' ? { collaborationChecksSha256: sha256(await readFile(new URL('./kanban-fusion-f3-collaboration.mjs', import.meta.url))) } : {}),
    ...(process.env.FUSION_F2 === '1' ? { columnChecksSha256: sha256(await readFile(new URL('./kanban-fusion-f2-columns.mjs', import.meta.url))) } : {}),
    ...(themePackage ? { themeSha256: sha256(await readFile(themePackage)) } : {}),
    ...(themePackage && !process.env.FUSION_F4 && !process.env.FUSION_F3 && !process.env.FUSION_F2 ? { drawerChecksSha256: sha256(await readFile(new URL('./kanban-fusion-f1-drawers.mjs', import.meta.url))) } : {}),
    upstreamImage: { width: image.width, height: image.height, bytes: image.bytes, mediaType: image.mediaType },
  }, null, 2) + '\n')
  passed = true
} catch (error) {
  console.error(`Probe failed: ${phase}. Private diagnostics: ${root}`)
  const sanitize = text => text.replace(/https?:\/\/[^\s)"']+/g, '<url>')
  await writeFile(join(root, 'probe-error.log'), sanitize(String(error.stack ?? error)))
  console.error(sanitize(String(error.message ?? error).split('\n')[0]))
  process.exitCode = 1
} finally {
  await browser?.close()
  if (host?.exitCode === null && host.pid) {
    const exited = once(host, 'exit')
    if (process.platform === 'win32') await run('taskkill.exe', ['/PID', String(host.pid), '/T', '/F'], { windowsHide: true })
    else host.kill('SIGTERM')
    await exited
  }
  if (passed) {
    const target = await realpath(root)
    assert.equal(dirname(target), temp)
    assert(basename(target).startsWith('tavlo-fusion-probe-'))
    await rm(target, { recursive: true, force: true })
  }
}
