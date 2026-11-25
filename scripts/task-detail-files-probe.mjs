import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { findTools, loadShell, readClientInputs, readAppearanceClient, mount, report } from './task-drawer-layout-probe.mjs'

// Exercise the installed client using the shipped DSH shell and theme components.
// All network requests and task changes remain inside this in-memory fixture.
const output = resolve(process.env.TASK_DETAIL_FILES_OUTPUT || '../artifacts/task-detail-0.2.2')
const findings = { passed: false, checks: [], screenshots: [], layouts: [], isolation: 'Synthetic .test origin; requests intercepted; no real tasks or sessions changed.' }
const check = message => { findings.checks.push(message); console.log('PASS: ' + message) }
const now = new Date().toISOString()
const seedId = '11111111-1111-4111-8111-111111111111'
const task = (id, title, fields = {}) => ({ id, title, stage: 'todo', columnId: 'stage:todo', orderKey: '1', position: 1, revision: 1,
  brief: '支持通用任务文件，提升表单与动态的阅读体验。', createdAt: now, updatedAt: now, ...fields })
const rows = new Map([[seedId, task(seedId, '任务详情优化', { priority: 'P1' })]])
const attachments = new Map(), contents = new Map(), events = new Map(), launches = []
const board = { revision: 1, columns: ['todo', 'doing', 'done'].map(stage => ({ id: 'stage:' + stage, stage })), labels: [], priorities: ['P0', 'P1', 'P2'].map(key => ({ key, name: key })) }
const limits = { maxFiles: 10, maxFileBytes: 10485760, maxImageBytes: 10485760, mediaTypes: ['image/png', 'image/jpeg', 'image/webp'] }
const ok = value => ({ ok: true, value })
const current = id => { assert(rows.has(id)); return rows.get(id) }
const baseline = () => ({ tasks: [...rows.values()], board, statuses: {} })
function addEvent(id, kind, fields = {}) {
  const list = events.get(id) || []
  list.unshift({ id: (list[0]?.id || 0) + 1, at: now, source: 'rpc', kind, ...fields })
  events.set(id, list)
}
addEvent(seedId, 'created')
addEvent(seedId, 'updated', { fields: ['title', 'dueDate', 'workspaceId'] })
addEvent(seedId, 'file-added', { name: '设计说明.pdf' })
addEvent(seedId, 'moved', { from: 'stage:todo', to: 'stage:doing' })
addEvent(seedId, 'comment', { text: '先让边框和下拉入口更清楚，再核对文件操作。\n图片预览继续保留。' })
const fixture = {
  rpc({ operation, input = {} }) {
    switch (operation) {
      case 'event-baseline': return { type: 'snapshot', streamId: 'task-files-probe', sequence: 0, ...baseline() }
      case 'list': return ok(baseline())
      case 'options': return ok({ workspaces: [], groups: [], presets: [], workspaceStatus: 'ready', modelStatus: 'ready', modelFailures: 0 })
      case 'files': return ok({ files: attachments.get(input.taskId) || [], limits, ...(input.taskId ? { revision: current(input.taskId).revision } : {}) })
      case 'images': return ok({ images: (attachments.get(input.taskId) || []).filter(file => file.width), limits: { ...limits, maxImages: 10 }, revision: current(input.taskId).revision })
      case 'history': return ok({ events: events.get(input.taskId) || [] })
      case 'launch': {
        const previous = current(input.taskId), sessionId = randomUUID()
        assert.equal(input.expectedRevision, previous.revision)
        const row = { ...previous, activeSessionId: sessionId, revision: previous.revision + 1 }
        rows.set(row.id, row); launches.push(input)
        return ok({ task: row, sessionId })
      }
      case 'create': {
        const row = task(randomUUID(), input.title, { brief: input.brief || '' })
        rows.set(row.id, row); addEvent(row.id, 'created')
        return ok({ task: row })
      }
      case 'remove-file': {
        const row = current(input.taskId), files = attachments.get(row.id)
        assert.equal(row.revision, input.expectedRevision)
        const removed = files.find(file => file.attachmentId === input.attachmentId)
        assert(removed)
        attachments.set(row.id, files.filter(file => file !== removed))
        row.fileCount = files.length - 1
        row.imageCount = attachments.get(row.id).filter(file => file.width).length || undefined
        row.revision++; addEvent(row.id, 'file-removed', { name: removed.name })
        return ok({ task: row })
      }
      case 'comment': {
        const row = current(input.taskId)
        row.revision++; row.commentCount = (row.commentCount || 0) + 1
        addEvent(row.id, 'comment', { text: input.text })
        return ok({ task: row })
      }
      default: throw new Error('Unexpected fixture operation: ' + operation)
    }
  },
  upload(params, request) {
    const row = current(params.get('taskId')), body = request.postDataBuffer() || Buffer.alloc(0)
    const mediaType = request.headers()['content-type'], name = params.get('name')
    const attachmentId = 'sha256:' + createHash('sha256').update(body).digest('hex')
    const file = { attachmentId, bytes: body.length, mediaType, name, ...(mediaType === 'image/png' ? { width: 96, height: 72 } : {}) }
    const files = attachments.get(row.id) || []
    files.push(file); attachments.set(row.id, files); contents.set(attachmentId, body)
    row.fileCount = files.length; row.imageCount = files.filter(file => file.width).length || undefined; row.revision++
    addEvent(row.id, 'file-added', { name })
    return ok({ task: row })
  },
  fileResponse(params) {
    const file = (attachments.get(params.get('taskId')) || []).find(row => row.attachmentId === params.get('attachmentId'))
    assert(file)
    return { body: contents.get(file.attachmentId), contentType: file.width ? file.mediaType : 'application/octet-stream',
      headers: params.get('download') || !file.width ? { 'Content-Disposition': `attachment; filename="download.bin"` } : {} }
  },
}

let browser, page
try {
  await mkdir(output, { recursive: true })
  const { pw, dist, themeClient, executablePath } = findTools()
  const { chromium } = await import(pathToFileURL(pw).href)
  const [shell, inputs, appearance] = await Promise.all([loadShell(dist, themeClient), readClientInputs(), readAppearanceClient()])
  inputs.appearance = appearance?.source
  findings.clientPath = process.env.TASK_DRAWER_LAYOUT_BUILT_CLIENT || 'lib/client.js'
  browser = await chromium.launch({ executablePath, headless: true })
  const context = await browser.newContext({ viewport: { width: 1366, height: 980 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', serviceWorkers: 'block', reducedMotion: 'reduce' })
  const run = await mount(context, dist, shell, inputs, fixture, 'zh')
  page = run.page
  const drawer = page.locator('.dsh-tasks-editor-drawer')
  const filesRegion = () => drawer.getByRole('region', { name: '任务文件', exact: true })
  const shot = async name => { await drawer.screenshot({ path: join(output, name + '.png'), animations: 'disabled' }); findings.screenshots.push(name + '.png') }
  await page.getByRole('button', { name: '新建任务', exact: true }).click()
  await filesRegion().getByRole('button', { name: '添加文件', exact: true }).waitFor()
  assert.equal(await filesRegion().locator('input[type=file]').getAttribute('accept'), null)
  await drawer.locator('[name=title]').fill('任务文件验收')
  const pdf = Buffer.from('%PDF-1.4\nTask file fixture\n%%EOF')
  const png = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 72
    const context = canvas.getContext('2d'); context.fillStyle = '#158a70'; context.fillRect(0, 0, 96, 72)
    return canvas.toDataURL('image/png').split(',')[1]
  }), 'base64')
  await filesRegion().locator('input[type=file]').setInputFiles([
    { name: '需求说明.pdf', mimeType: 'application/pdf', buffer: pdf },
    { name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) },
    { name: '预览.png', mimeType: 'image/png', buffer: png },
  ])
  assert.equal(await filesRegion().locator('.dsh-tasks-image-job').count(), 3)
  await drawer.locator('button[type=submit]').click()
  await drawer.getByRole('tab', { name: '详情', exact: true }).waitFor()
  await filesRegion().locator('.dsh-tasks-attachment-row:not(.dsh-tasks-image-job)').nth(2).waitFor()
  assert.equal(await filesRegion().locator('.dsh-tasks-image-job').count(), 0)
  check('新建任务支持混合图片/PDF/零字节文件，文件上传后保留名称和大小')
  const newTask = [...rows.values()].find(row => row.title === '任务文件验收')
  assert.equal(newTask.fileCount, 3); assert.equal(newTask.imageCount, 1)
  const downloadLink = filesRegion().getByRole('link', { name: '下载文件: 需求说明.pdf', exact: true })
  const downloadUrl = await downloadLink.getAttribute('href')
  const downloadedBytes = await page.evaluate(async url => [...new Uint8Array(await (await fetch(url)).arrayBuffer())], downloadUrl)
  assert.deepEqual(Buffer.from(downloadedBytes), pdf)
  assert.equal(new URL(downloadUrl, page.url()).searchParams.get('download'), '1')
  const downloading = page.waitForEvent('download')
  await downloadLink.click()
  const download = await downloading
  findings.headlessDownloadFailure = await download.failure()
  check('非图片下载链接使用正确附件与下载参数，返回原始字节并触发浏览器下载事件')
  await filesRegion().locator('.dsh-tasks-thumb').click()
  const preview = page.getByRole('dialog', { name: '任务图片', exact: true })
  await preview.waitFor(); await page.keyboard.press('Escape'); await preview.waitFor({ state: 'hidden' })
  check('图片仍可打开与关闭预览')
  await filesRegion().getByRole('button', { name: '移除文件: empty.txt', exact: true }).click()
  await filesRegion().getByText('empty.txt', { exact: true }).waitFor({ state: 'hidden' })
  assert.equal(newTask.fileCount, 2)
  check('移除单个附件后计数正确')
  await drawer.getByRole('button', { name: '开始任务', exact: true }).click()
  const launch = page.locator('dialog.dsh-tasks-launch-dialog[open]')
  const includeFiles = launch.getByRole('checkbox', { name: '随首条消息发送任务附件', exact: true })
  assert.equal(await includeFiles.isChecked(), true)
  await launch.getByText('需求说明.pdf', { exact: true }).waitFor()
  await launch.getByText('预览.png', { exact: true }).waitFor()
  await includeFiles.click()
  await launch.getByText('本条消息不会发送附件。', { exact: true }).waitFor()
  await includeFiles.click()
  await launch.screenshot({ path: join(output, 'launch-attachments.png'), animations: 'disabled' })
  findings.screenshots.push('launch-attachments.png')
  await launch.locator('button[type=submit]').click()
  await launch.waitFor({ state: 'hidden' })
  assert.equal(launches.length, 1)
  assert.equal(launches[0].includeFiles, true)
  assert.equal(launches[0].taskId, newTask.id)
  assert.equal(launches[0].includeImages, undefined)
  check('启动面板默认选中发送任务附件，展示 PDF 和图片，可取消勾选，提交时传入新版参数')
  await page.getByRole('button', { name: '任务详情优化', exact: true }).click()
  const inspectFields = async (theme, width) => {
    const fields = await drawer.locator('[data-task-ink=field]').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length).map(node => {
      const css = getComputedStyle(node)
      return { width: css.borderTopWidth, border: css.borderTopColor, fill: css.backgroundColor, overflow: node.scrollWidth - node.clientWidth }
    }))
    assert(fields.length >= 5 && fields.every(field => field.width === '1px' && field.border !== 'rgba(0, 0, 0, 0)'), JSON.stringify(fields))
    const overflow = await drawer.evaluate(node => node.scrollWidth - node.clientWidth)
    assert(overflow <= 1, 'Drawer overflow at ' + width)
    findings.layouts.push({ theme, width, fields: fields.length, overflow })
  }
  const combo = drawer.getByRole('combobox').first()
  await combo.click(); assert.equal(await combo.getAttribute('aria-expanded'), 'true')
  await page.keyboard.press('Escape'); assert.equal(await combo.getAttribute('aria-expanded'), 'false')
  await inspectFields('default', 1366); await shot('details-default')
  await drawer.getByRole('tab', { name: '动态', exact: true }).click()
  await drawer.locator('.dsh-tasks-activity-marker').nth(4).waitFor()
  assert.equal(await drawer.locator('.dsh-tasks-activity-fields > li').count(), 3)
  await shot('activity-default')
  await drawer.getByRole('button', { name: '仅评论', exact: true }).click()
  assert.equal(await drawer.locator('.dsh-tasks-activity > li:not([data-kind=comment])').count(), 0)
  assert.equal(await drawer.locator('.dsh-tasks-activity > li[data-kind=comment]').count(), 1)
  await drawer.locator('textarea[name=comment]').fill('文件与动态验收通过。')
  await drawer.getByRole('button', { name: '发布评论', exact: true }).click()
  await drawer.getByText('文件与动态验收通过。', { exact: true }).waitFor()
  await drawer.getByRole('button', { name: '全部动态', exact: true }).click()
  assert.equal(await drawer.locator('.dsh-tasks-activity > li').count(), 6)
  check('动态显示事件图标、字段标签和文件名；评论可发布并独立筛选')
  for (const appearanceName of appearance ? ['paper', 'ios'] : ['default']) {
    if (appearance) await page.evaluate(async name => { await window.__taskDrawerAppearance.select(name); await window.__taskDrawerAppearance.select('inherit', 'taskAppearance') }, appearanceName)
    for (const dark of [false, true]) {
      await page.evaluate(dark => { document.body.toggleAttribute('data-ds-dark-theme', dark); document.documentElement.style.colorScheme = dark ? 'dark' : 'light'; window.__taskDrawerAppearance?.applyTokens() }, dark)
      for (const width of [1366, 375]) {
        await page.setViewportSize({ width, height: width === 375 ? 812 : 980 })
        await drawer.getByRole('tab', { name: '详情', exact: true }).click()
        await inspectFields(appearanceName + (dark ? '-dark' : '-light'), width)
        await shot('details-' + appearanceName + (dark ? '-dark-' : '-light-') + width)
        await drawer.getByRole('tab', { name: '动态', exact: true }).click()
        await shot('activity-' + appearanceName + (dark ? '-dark-' : '-light-') + width)
      }
    }
  }
  check('下拉框键盘开合正常；默认、纸面、iOS 的亮暗色及 375px 窄屏均保持完整控件边界')
  assert.deepEqual(run.errors, [])
  assert.deepEqual(report.pageErrors, [])
  findings.passed = true
} catch (error) {
  findings.error = { message: error.message, stack: error.stack }
  if (page && !page.isClosed()) await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
  console.error(error)
  process.exitCode = 1
} finally {
  await browser?.close()
  await writeFile(join(output, 'report.json'), JSON.stringify(findings, null, 2) + '\n')
}
