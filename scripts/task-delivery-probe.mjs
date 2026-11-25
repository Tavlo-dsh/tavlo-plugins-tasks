/**
 * Offline browser acceptance probe. From this package: node scripts/task-delivery-probe.mjs
 * Uses the existing built Tasks client and the shipped DSH frontend via the drawer helpers.
 * See those helpers for PLAYWRIGHT_MODULE, BROWSER_EXE, DSH_FRONTEND_DIR and DSH_THEME_CLIENT.
 * TASK_DELIVERY_OUTPUT overrides the default workspace artifacts/task-layout-0.2.4 folder.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findTools, loadShell, mount, readClientInputs, readAppearanceClient, report as shellReport } from './task-drawer-layout-probe.mjs'

const output = process.env.TASK_DELIVERY_OUTPUT ? resolve(process.env.TASK_DELIVERY_OUTPUT)
  : fileURLToPath(new URL('../../artifacts/task-delivery-probe/', import.meta.url))
const fixtureStreamId = 'task-delivery-probe-v1'
const ids = {
  primary: '11111111-1111-4111-8111-111111111111', dependent: '22222222-2222-4222-8222-222222222222',
  session: '33333333-3333-4333-8333-333333333333',
  original: '44444444-4444-4444-8444-444444444444', resubmitted: '55555555-5555-4555-8555-555555555555',
  scratchColumn: '66666666-6666-4666-8666-666666666666',
}
const primaryTitle = 'CNAS 智能查询 T4｜限定单个文件并检索授权历史版本，核对数据导出和上线验证结果', dependentTitle = '发布数据导出说明'
const originalSummary = '已实现导出，共覆盖常规与大文件场景。'
const resubmittedSummary = '已增加空文件边界覆盖，并重新执行全部用例。'
const originalCriteria = '提交覆盖常规、大文件与空文件的验证结果。'
const feedback = '请补测空文件边界。\n重新提交时附上完整的验证结果。'
const evidenceLink = 'https://evidence-fixture.test/export/report'
const desktop = { width: 1366, height: 980 }, wide = { width: 1956, height: 1030 }, narrow = { width: 375, height: 812 }
const findings = {
  passed: false,
  isolation: 'Fresh headless Chromium context; synthetic .test origin and in-memory RPC/SSE; no live GUI, DSH profile, native agent, or network calls.',
  checks: [], screenshots: [], layouts: [], browserWrites: [], agentUpdates: [],
}
const check = description => { findings.checks.push(description); console.log('PASS: ' + description) }
const exact = name => ({ name, exact: true })
const ok = value => ({ ok: true, value })

function makeFixture() {
  let tick = Date.parse('2026-10-14T02:00:00Z'), sequence = 0
  const stamp = () => new Date(tick += 1000).toISOString()
  const createdAt = stamp()
  const row = (id, title, stage, position, fields) => ({
    id, title, stage, position, columnId: 'stage:' + stage, orderKey: String(position), revision: 1,
    createdAt, updatedAt: createdAt, ...fields,
  })
  const tasks = new Map([
    [ids.primary, row(ids.primary, primaryTitle, 'doing', 0, {
      acceptanceCriteria: '当前增加提交导出指南的要求。', activeSessionId: ids.session,
      brief: '在发布说明之前，先确认导出覆盖和复现步骤。',
    })],
    [ids.dependent, row(ids.dependent, dependentTitle, 'todo', 1, {
      acceptanceCriteria: '发布最终说明并附上已验收的验证链接。', dependencyIds: [ids.primary],
    })],
  ])
  const board = { revision: 1, columns: [{ id: ids.scratchColumn, stage: 'todo', name: '待细化' },
    ...['todo', 'doing', 'done'].map(stage => ({ id: 'stage:' + stage, stage }))],
    labels: [], priorities: ['P0', 'P1', 'P2'].map(key => ({ key, name: key })) }
  const statuses = { [ids.primary]: { status: 'idle', sessionId: ids.session } }
  const limits = { maxFiles: 10, maxFileBytes: 10485760, maxImages: 10, maxImageBytes: 10485760, mediaTypes: ['image/png'] }
  const history = []
  const get = id => { assert(tasks.has(id), 'Unknown fixture task: ' + id); return tasks.get(id) }
  const baseline = () => ({ tasks: [...tasks.values()], board, statuses })
  const replace = (task, updatedAt, fields) => {
    const next = { ...task, revision: task.revision + 1, updatedAt, ...fields }
    tasks.set(task.id, next)
    return next
  }
  const addHistory = (kind, text, source, at) => {
    history.unshift({ id: history.length + 1, kind, text, source, at, sessionId: ids.session })
  }

  return {
    async submitFromAgent(page, second = false) {
      const task = get(ids.primary), submittedAt = stamp(), id = second ? ids.resubmitted : ids.original
      assert.equal(task.activeSessionId, ids.session)
      if (second) {
        assert.equal(task.delivery?.status, 'returned')
        assert(task.delivery.continuedAt, 'Fixture resubmission follows explicit send')
      } else assert.equal(task.delivery, undefined)
      const summary = second ? resubmittedSummary : originalSummary
      const updated = replace(task, submittedAt, { delivery: {
        id, sessionId: ids.session, status: 'pending', submittedAt, summary, criteria: originalCriteria,
        verification: second ? '15 项用例全部通过。' : '12 项用例通过。', remaining: second ? '无。' : '尚未复测空文件边界。',
        links: [{ label: '导出验证报告', url: evidenceLink }],
      } })
      addHistory('delivery-submitted', summary, 'agent', submittedAt)
      const event = { type: 'upsert', streamId: fixtureStreamId, sequence: ++sequence, task: updated }
      await page.evaluate(event => window.__taskDeliveryProbePublish(event), event)
      findings.agentUpdates.push({ sequence, taskId: updated.id, revision: updated.revision, deliveryId: id, summary })
    },
    rpc({ operation, input = {} }) {
      switch (operation) {
        case 'event-baseline': return { type: 'snapshot', streamId: fixtureStreamId, sequence, ...baseline() }
        case 'list': return ok(baseline())
        case 'options': return ok({ workspaces: [], groups: [], presets: [], workspaceStatus: 'ready', modelStatus: 'ready', modelFailures: 0 })
        case 'files': return ok({ files: [], limits, ...(input.taskId ? { revision: get(input.taskId).revision } : {}) })
        case 'images': return ok({ images: [], limits, revision: get(input.taskId).revision })
        case 'history': return ok({ events: get(input.taskId).id === ids.primary ? history : [] })
        case 'review-delivery':
        case 'continue-delivery': {
          const task = get(input.taskId), delivery = task.delivery, updatedAt = stamp()
          assert.equal(task.id, ids.primary)
          assert.equal(input.deliveryId, delivery.id)
          assert.equal(input.expectedRevision, task.revision)
          findings.browserWrites.push({ operation, input })
          if (operation === 'continue-delivery') {
            assert.deepEqual(Object.keys(input).sort(), ['deliveryId', 'expectedRevision', 'taskId'])
            assert.equal(delivery.status, 'returned')
            assert.equal(delivery.continuedAt, undefined)
            assert.equal(delivery.sessionId, task.activeSessionId)
            return ok({ task: replace(task, updatedAt, { delivery: { ...delivery, continuedAt: updatedAt } }) })
          }
          assert.equal(delivery.status, 'pending')
          assert.match(input.requestId, /^[0-9a-f]{32}$/i)
          const accept = input.decision === 'accept'
          assert.equal(input.decision, accept ? 'accept' : 'return')
          assert.equal(input.feedback, accept ? undefined : feedback)
          const status = accept ? 'accepted' : 'returned', stage = accept ? 'done' : 'doing'
          const next = replace(task, updatedAt, {
            stage, columnId: 'stage:' + stage, ...(accept ? { completedAt: updatedAt } : {}),
            delivery: { ...delivery, status, reviewedAt: updatedAt, ...(accept ? {} : { feedback: input.feedback }) },
          })
          addHistory('delivery-' + status, input.feedback || delivery.summary, 'rpc', updatedAt)
          return ok({ task: next, deliveryId: delivery.id, mutation: { requestId: input.requestId } })
        }
        default: throw new Error('Unexpected fixture RPC: ' + operation)
      }
    },
    upload() { throw new Error('Unexpected fixture upload') },
    image() { throw new Error('Unexpected fixture image request') },
  }
}

// mount() creates its in-memory stream and supplies the baseline. Attach a publisher to
// that exact stream for simulated agent upserts; avoid replacing fetch or using a real server.
async function addFixtureEventPublisher(context) {
  await context.addInitScript(streamId => {
    const prototype = ReadableStreamDefaultController.prototype
    const enqueue = prototype.enqueue
    prototype.enqueue = function (chunk) {
      if (chunk instanceof Uint8Array) {
        const frame = new TextDecoder().decode(chunk)
        if (frame.startsWith('data: ')) {
          const event = JSON.parse(frame.slice(6))
          if (event.type === 'snapshot' && event.streamId === streamId) {
            window.__taskDeliveryProbePublish = next => enqueue.call(this, new TextEncoder().encode(`data: ${JSON.stringify(next)}\n\n`))
          }
        }
      }
      return enqueue.call(this, chunk)
    }
  }, fixtureStreamId)
}

let browser, page, mounted
let phase = 'setup'
try {
  await mkdir(output, { recursive: true })
  const { pw, dist, themeClient, executablePath } = findTools()
  process.env.TASK_DRAWER_LAYOUT_CLIENT = 'built'
  const [shell, inputs, appearance, playwright] = await Promise.all([loadShell(dist, themeClient), readClientInputs(), readAppearanceClient(), import(pathToFileURL(pw).href)])
  if (appearance) inputs.appearance = appearance.source
  const chromium = playwright.chromium ?? playwright.default?.chromium
  assert(chromium, 'Selected Playwright entry does not export Chromium')
  browser = await chromium.launch({ executablePath, headless: true })
  findings.environment = { browser: browser.version(), executablePath, dist, themeClient, clientMode: inputs.mode,
    clientSha256: createHash('sha256').update(inputs.client).digest('hex'), desktop, wide, narrow, locale: 'zh-CN' }
  const context = await browser.newContext({ viewport: desktop, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
    colorScheme: 'light', serviceWorkers: 'block', reducedMotion: 'reduce' })
  const fixture = makeFixture()
  await addFixtureEventPublisher(context)
  mounted = await mount(context, dist, shell, inputs, fixture, 'zh')
  page = mounted.page
  if (appearance) {
    await page.evaluate(() => window.__taskDrawerAppearance.select('paper'))
    await page.locator('body[data-dsh-paper-theme="paper"]').waitFor()
    findings.environment.appearance = 'paper'
  }

  const drawer = page.getByRole('dialog', exact('任务详情'))
  const tab = name => drawer.getByRole('tab', exact(name))
  const evidence = drawer.getByRole('tabpanel', exact('Agent 交付')).getByRole('region', exact('Agent 交付'))
  const button = (within, name) => within.getByRole('button', exact(name))
  const text = (within, label) => within.getByText(label, { exact: true })
  const card = id => page.locator(`article[data-task-id="${id}"]`)
  const dependent = card(ids.dependent), primary = card(ids.primary)
  const attention = page.locator('details.dsh-tasks-attention')
  const returnButton = button(evidence, '退回修改'), send = button(evidence, '把意见发给 Agent')
  const accept = button(evidence, '接受并完成')
  const shot = async name => {
    const filename = name + '.png'
    await page.screenshot({ path: join(output, filename), animations: 'disabled' })
    findings.screenshots.push(filename)
  }
  const closeDrawer = async () => { await page.keyboard.press('Escape'); await drawer.waitFor({ state: 'hidden' }) }
  const overview = button(page, '手记概览'), insights = page.locator('.dsh-tasks-insights')
  const strip = page.locator('.dsh-tasks-board-strip')
  const boardLayout = () => strip.evaluate(board => {
    const bounds = board.getBoundingClientRect(), style = getComputedStyle(board)
    const columns = [...board.querySelectorAll(':scope > .dsh-tasks-col')].map(column => ({
      width: column.getBoundingClientRect().width, right: column.getBoundingClientRect().right, collapsed: column.hasAttribute('data-collapsed'),
    }))
    return { width: bounds.width, clientWidth: board.clientWidth, scrollWidth: board.scrollWidth, columns,
      rightGap: bounds.right - columns.at(-1).right, padding: parseFloat(style.paddingRight) }
  })
  const checkFilledBoard = async expectExpanded => {
    const layout = await boardLayout()
    assert.equal(layout.columns.length, 4)
    assert(layout.columns[0].collapsed && Math.abs(layout.columns[0].width - 48) <= 1)
    assert(Math.abs(layout.rightGap - layout.padding) <= 2, `Unexpected right gap: ${JSON.stringify(layout)}`)
    assert(layout.scrollWidth <= layout.clientWidth + 1, 'Wide board unexpectedly scrolls')
    const widths = layout.columns.slice(1).map(column => column.width)
    assert(Math.max(...widths) - Math.min(...widths) <= 1, 'Expanded columns do not share space equally')
    if (expectExpanded) assert(Math.min(...widths) > 390, 'Expanded columns were limited to the old fixed maximum')
    findings.layouts.push(layout)
  }

  phase = 'wide board redistribution and two-line title'
  await page.setViewportSize(wide)
  await button(dependent, '查看前置任务').waitFor()
  assert.equal(await overview.getAttribute('aria-expanded'), 'false')
  await checkFilledBoard(true)
  await shot('00-wide-board-no-overview')
  await overview.click()
  await insights.waitFor()
  await strip.locator('xpath=..').and(page.locator('[data-show-insights]')).waitFor()
  await checkFilledBoard(false)
  await shot('00-wide-board-docked-overview')
  await page.setViewportSize(narrow)
  await page.locator('[data-overlay-insights]').waitFor()
  const narrowLayout = await boardLayout()
  assert(narrowLayout.scrollWidth > narrowLayout.clientWidth, 'Narrow board must scroll rather than compress all columns')
  assert(narrowLayout.columns[1].width >= 280, 'Narrow board squashed task cards: ' + narrowLayout.columns[1].width)
  await overview.click()
  await insights.waitFor({ state: 'hidden' })
  const titleMetrics = await primary.locator('.dsh-tasks-card-title-text').evaluate(text => {
    const range = document.createRange(); range.selectNodeContents(text)
    const parents = [text, text.closest('button')].map(el => el.getBoundingClientRect())
    const lines = [...range.getClientRects()]
    const firstTwo = [...new Set(lines.map(rect => rect.top))].slice(0, 2)
    return { lines: firstTwo.length, fits: lines.filter(rect => firstTwo.includes(rect.top)).every(rect =>
      parents.every(box => rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1)),
      textHeight: parents[0].height, buttonHeight: parents[1].height }
  })
  assert.equal(titleMetrics.lines, 2)
  assert(titleMetrics.fits, `Visible title lines are vertically cropped: ${JSON.stringify(titleMetrics)}`)
  findings.layouts.push({ narrowLayout, titleMetrics })
  await page.setViewportSize(desktop)
  check('概览关闭后展开列填满宽屏，折叠列保持 48px；概览宽屏停靠、窄屏悬浮，窄屏仍可横滚，长中英标题前两行未被纵向裁切。')

  phase = 'locked prerequisite and idle session'
  await button(dependent, '查看前置任务').waitFor()
  assert.equal(await button(dependent, '开始任务').count(), 0)
  await text(dependent, '等待前置任务').waitFor()
  await shot('01-prerequisite-locked-desktop')
  await button(dependent, '查看前置任务').click()
  const dependency = drawer.locator('.dsh-tasks-prerequisites')
  await button(dependency, primaryTitle).waitFor()
  assert.equal(await button(drawer, '开始任务').count(), 0)
  await button(dependency, primaryTitle).click()
  assert.deepEqual(await drawer.getByRole('tab').allTextContents(), ['详情', '动态', 'Agent 交付'])
  assert.equal(await tab('详情').getAttribute('aria-selected'), 'true')
  await evidence.waitFor({ state: 'hidden' })
  await tab('详情').press('ArrowRight')
  assert.equal(await tab('动态').getAttribute('aria-selected'), 'true')
  await tab('动态').press('End')
  assert.equal(await tab('Agent 交付').getAttribute('aria-selected'), 'true')
  await text(evidence, '空闲').waitFor()
  await tab('Agent 交付').press('ArrowRight')
  assert.equal(await tab('详情').getAttribute('aria-selected'), 'true')
  await tab('详情').press('ArrowLeft')
  assert.equal(await tab('Agent 交付').getAttribute('aria-selected'), 'true')
  await evidence.getByText(/会话空闲不等于任务完成/).waitFor()
  assert.equal(await primary.getAttribute('data-stage'), 'doing')
  assert.equal(await attention.count(), 0)
  assert.deepEqual(findings.browserWrites, [])
  await closeDrawer()
  check('前置任务未完成时，卡片及详情不提供开始任务；可打开前置任务，且会话空闲不代表已经交付。')

  phase = 'first agent submission and attention'
  await fixture.submitFromAgent(page)
  await text(attention, '需要我处理 · 1').waitFor()
  await attention.locator('summary').click()
  const pendingGroup = attention.getByRole('region', exact('待验收'))
  await button(pendingGroup, primaryTitle).waitFor()
  await shot('02-needs-my-attention-desktop')
  await button(pendingGroup, primaryTitle).click()
  assert.equal(await tab('Agent 交付').getAttribute('aria-selected'), 'true')
  await closeDrawer()
  await button(primary, '验收成果').click()
  assert.equal(await tab('Agent 交付').getAttribute('aria-selected'), 'true')
  await tab('Agent 交付').press('Home')
  assert.equal(await tab('详情').getAttribute('aria-selected'), 'true')
  await tab('Agent 交付').click()
  check('详情、动态、Agent 交付按顺序排列，键盘可切换；卡面和待处理列表都能直接进入交付页签。')
  for (const label of ['Agent 提交的交付证据', originalSummary, '验证结果', '12 项用例通过。',
    '未验证或仍待解决', '尚未复测空文件边界。', '本次发给 Agent 的验收标准', originalCriteria, '待验收']) await text(evidence, label).waitFor()
  const link = evidence.getByRole('link', exact('导出验证报告'))
  assert.equal(await link.getAttribute('href'), evidenceLink)
  assert.equal(await link.getAttribute('target'), '_blank')
  assert.deepEqual((await link.getAttribute('rel')).split(/\s+/).sort(), ['noopener', 'noreferrer'])
  await shot('03-pending-evidence-desktop')
  check('Agent 的实时交付进入「需要我处理 → 待验收」；证据含摘要、验证、剩余事项、原验收标准及安全的新标签链接。')

  phase = 'return feedback textarea'
  await returnButton.click()
  const review = evidence.getByRole('textbox', exact('验收意见')).and(evidence.locator('textarea[name=reviewFeedback]'))
  await review.waitFor()
  assert(await returnButton.isDisabled(), 'Empty feedback must not be submitted')
  await review.fill('   ')
  assert(await returnButton.isDisabled(), 'Whitespace-only feedback must not be submitted')
  await review.fill('  ' + feedback + '  ')
  assert(await returnButton.isEnabled())
  assert.equal(await review.inputValue(), '  ' + feedback + '  ')
  assert.deepEqual(findings.browserWrites, [], 'Opening and typing the review must not make RPC writes')
  await shot('04-return-textarea-desktop')
  await page.setViewportSize(narrow)
  await review.scrollIntoViewIfNeeded()
  for (const control of [drawer, review, returnButton]) {
    const box = await control.boundingBox()
    assert(box && box.x >= -1 && box.x + box.width <= narrow.width + 1, 'Narrow control is horizontally clipped: ' + control)
  }
  findings.layouts.push({ viewport: narrow, textarea: await review.boundingBox(), drawer: await drawer.boundingBox() })
  await shot('05-return-textarea-narrow')
  await page.setViewportSize(desktop)
  await returnButton.click()
  await send.waitFor()
  await evidence.getByText(feedback, { exact: true }).waitFor()
  await review.waitFor({ state: 'hidden' })
  assert.deepEqual(findings.browserWrites.map(({ operation, input }) => [operation, input.decision, input.feedback]),
    [['review-delivery', 'return', feedback]], 'Return saves review only, with trimmed feedback')
  await shot('06-returned-awaiting-explicit-send-desktop')
  await closeDrawer()
  const returnedGroup = attention.getByRole('region', exact('待返工'))
  await button(returnedGroup, primaryTitle).waitFor()
  assert.equal(await button(dependent, '开始任务').count(), 0)
  check('退回区域是可输入多行的真实 textarea；空白禁用提交。退回只保存意见，不发消息，并切换到「待返工」队列。')

  phase = 'explicit send and second agent submission'
  await button(returnedGroup, primaryTitle).click()
  await send.click()
  await evidence.getByRole('status').filter({ hasText: '验收意见已发到原会话。' }).waitFor()
  await send.waitFor({ state: 'hidden' })
  await attention.waitFor({ state: 'hidden' })
  assert.deepEqual(findings.browserWrites.map(row => row.operation), ['review-delivery', 'continue-delivery'])
  assert.equal(findings.browserWrites[1].input.deliveryId, ids.original)
  await shot('07-feedback-sent-desktop')
  await fixture.submitFromAgent(page, true)
  await text(evidence, resubmittedSummary).waitFor()
  await text(evidence, '15 项用例全部通过。').waitFor()
  assert.equal(await text(evidence, originalSummary).count(), 0)
  assert.equal(await evidence.getByText(feedback, { exact: true }).count(), 0)
  await text(attention, '需要我处理 · 1').waitFor()
  await accept.waitFor()
  await shot('08-resubmitted-evidence-desktop')
  check('只有显式发送才调用 continue-delivery；模拟 Agent 再提交通过 SSE 在仍打开的抽屉中刷新，并重新进入待验收。')

  phase = 'acceptance and live prerequisite unlock'
  await accept.click()
  await evidence.getByText('已验收', { exact: true }).first().waitFor()
  await accept.waitFor({ state: 'hidden' })
  await attention.waitFor({ state: 'hidden' })
  assert.equal(await primary.getAttribute('data-stage'), 'done')
  assert.equal(findings.browserWrites[2].input.deliveryId, ids.resubmitted, 'Acceptance must use the replacement delivery ID')
  await shot('09-accepted-evidence-desktop')
  await drawer.getByRole('tab', exact('动态')).click()
  const activity = drawer.getByRole('tabpanel', exact('动态'))
  await text(activity, '接受了交付成果').waitFor()
  assert.deepEqual(await activity.locator('li[data-kind^=delivery-]').evaluateAll(rows => rows.map(row => row.dataset.kind)),
    ['delivery-accepted', 'delivery-submitted', 'delivery-returned', 'delivery-submitted'])
  await closeDrawer()
  await button(dependent, '开始任务').waitFor()
  await text(dependent, '可开始').waitFor()
  assert.equal(await button(dependent, '查看前置任务').count(), 0)
  await shot('10-prerequisite-unlocked-desktop')
  await button(dependent, '开始任务').click()
  const launch = page.getByRole('dialog', exact('开始任务'))
  await launch.waitFor()
  await launch.locator('.dsh-tasks-launch-criteria summary').click()
  await text(launch, '发布最终说明并附上已验收的验证链接。').waitFor()
  await launch.locator('textarea[name=content]').fill('请据最新证据起草发布说明。')
  assert(await launch.locator('button[type=submit]').isEnabled(), 'Unlocked launch form can be submitted')
  await shot('11-unlocked-launch-preview-desktop')
  await page.keyboard.press('Escape')
  await launch.waitFor({ state: 'hidden' })
  assert.deepEqual(findings.browserWrites.map(({ operation, input }) => [operation, input.expectedRevision, input.decision]),
    [['review-delivery', 2, 'return'], ['continue-delivery', 3, undefined], ['review-delivery', 5, 'accept']])
  assert.notEqual(findings.browserWrites[0].input.requestId, findings.browserWrites[2].input.requestId)
  check('接受再提交后任务进入已完成、移出队列，动态保留两次交付与审阅历史，并实时解锁下游任务的启动表单。')

  assert.deepEqual(mounted.errors, [])
  assert.deepEqual(shellReport.pageErrors, [])
  findings.passed = true
} catch (error) {
  findings.error = { phase, message: error.message, stack: error.stack }
  if (page && !page.isClosed()) await page.screenshot({ path: join(output, 'failure.png'), animations: 'disabled' }).catch(() => {})
  console.error(error)
  process.exitCode = 1
} finally {
  findings.fixtureErrors = mounted?.errors ?? []
  findings.pageErrors = shellReport.pageErrors
  await browser?.close()
  await writeFile(join(output, 'report.json'), JSON.stringify(findings, null, 2) + '\n')
}
