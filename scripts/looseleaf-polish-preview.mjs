/** Browser acceptance for paper controls and task deletion; isolated fixtures only. */
import assert from 'node:assert/strict'
import { join } from 'node:path'

export async function verifyPaper(page, output) {
  const results = {}
  const settle = () => page.evaluate(() => window.__tasksFixture.settle())
  await page.emulateMedia({ colorScheme: 'light' })
  await page.evaluate(async () => {
    document.body.removeAttribute('data-ds-dark-theme')
    document.documentElement.style.colorScheme = 'light'
    await window.__tasksFixture.load(18)
    const titles = ['整理本周的产品想法', '完善任务看板的纸面样式', '确认新版本的发布清单', '梳理用户反馈和验收标准', '排查会话启动的失败原因', '完成任务卡片的信息层级', '补充项目说明和操作示例', '归档上个迭代的设计记录', '回顾本周已完成的工作']
    window.__tasksFixture.tasks = window.__tasksFixture.tasks.map((task, i) => ({ ...task,
      title: titles[i % titles.length], brief: '把目标写清楚，整理需要完成的细节。保留上下文，让下一步更容易开始。' }))
    await window.__tasksBaselineSource.refresh()
  })
  await settle()
  const root = page.locator('.dsh-tasks-root')
  assert.equal(await root.getAttribute('data-tasks-appearance'), 'paper')
  assert.equal(await root.locator('.dsh-tasks-appearance').count(), 0)
  assert.equal(await page.evaluate(() => typeof window.__tasksBaselineSource.setAppearance), 'undefined')
  results.paperOnly = true
  const search = root.locator('.dsh-tasks-search')
  await search.focus()
  assert.equal(await search.evaluate(el => getComputedStyle(el).outlineStyle), 'none')
  const opener = page.getByRole('button', { name: '新建任务', exact: true })
  await opener.click()
  const dialog = page.getByRole('dialog', { name: '新建任务', exact: true })
  await dialog.locator('input[name=title]').fill('整理下周的任务安排')
  assert.equal(await dialog.locator('input[name=title]').evaluate(el => getComputedStyle(el).outlineStyle), 'none')
  const shade = await dialog.evaluate(el => getComputedStyle(el, '::backdrop').backgroundColor)
  assert.equal(shade, 'rgba(24, 23, 21, 0.22)')
  results.focusAndBackdrop = { textInputOutline: 'none', searchOutline: 'none', backdrop: shade }
  assert.equal(await root.locator('select').count(), 0)
  const workspace = dialog.getByRole('combobox', { name: '工作区', exact: true })
  await workspace.click()
  await page.getByRole('option', { name: '隔离基线工作区', exact: true }).click()
  assert.equal(await dialog.locator('input[name=workspaceId]').inputValue(), 'baseline-workspace')
  const stage = dialog.getByRole('combobox', { name: '任务分类', exact: true })
  assert.equal(await stage.count(), 0)
  assert.equal(await dialog.locator('input[name=stage]').inputValue(), 'todo')
  const model = dialog.getByRole('combobox', { name: '模型', exact: true })
  await model.click()
  await page.screenshot({ path: join(output, 'paper-select-light.png'), fullPage: true })
  await model.fill('deep'); await page.keyboard.press('Enter')
  assert.equal(await dialog.locator('input[name=model]').inputValue(), '["preview","deep"]')
  await workspace.click(); await page.keyboard.press('Escape')
  assert.equal(await workspace.getAttribute('aria-expanded'), 'false')
  assert(await dialog.isVisible(), 'First Escape closes the select, not its dialog')
  await workspace.click(); await dialog.locator('input[name=title]').click()
  assert.equal(await workspace.getAttribute('aria-expanded'), 'false')
  await workspace.click(); await page.keyboard.press('Tab')
  assert.equal(await workspace.getAttribute('aria-expanded'), 'false')
  await dialog.locator('input[name=title]').focus()
  await page.screenshot({ path: join(output, 'paper-create-light.png'), fullPage: true })
  for (let i = 0; i < 16; i++) {
    await page.keyboard.press('Tab')
    assert(await page.evaluate(() => !!document.activeElement.closest('dialog')))
  }
  await page.keyboard.press('Escape')
  assert.equal(await dialog.count(), 0)
  assert(await opener.evaluate(el => el === document.activeElement))
  results.customSelect = { nativeSelects: 0, pointer: true, keyboard: true, escape: true, outside: true, tab: true, groups: true }
  results.dialogFocus = true

  const card = page.locator('article[data-task-id]').first()
  const menu = card.locator('summary')
  const filter = root.locator('.dsh-tasks-filter')
  await menu.click(); await search.focus()
  assert.equal(await card.locator('details').evaluate(el => el.open), false)
  await menu.click(); await root.locator('.dsh-tasks-paper-note').click()
  assert.equal(await card.locator('details').evaluate(el => el.open), false)
  await menu.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Escape')
  assert.equal(await card.locator('details').evaluate(el => el.open), false)
  assert(await menu.evaluate(el => el === document.activeElement))
  await filter.locator('summary').click()
  await filter.getByRole('combobox').click()
  await page.screenshot({ path: join(output, 'paper-filter-light.png'), fullPage: true })
  await page.getByRole('option', { name: '未分组', exact: true }).click()
  assert.equal(await page.evaluate(() => window.__tasksBaselineSource.getSnapshot().workspaceFilter), 'ungrouped')
  await search.focus()
  assert.equal(await filter.evaluate(el => el.open), false)
  await page.evaluate(() => window.__tasksBaselineSource.setWorkspaceFilter(''))
  results.menuDismissal = { outsidePointer: true, focus: true, escape: true, filterSelect: true }

  await card.getByRole('button', { name: '启动任务', exact: true }).click()
  const launch = page.getByRole('dialog', { name: '启动任务', exact: true })
  await launch.getByRole('combobox', { name: '模型', exact: true }).click()
  await page.getByRole('option', { name: '深入推理', exact: true }).click()
  await launch.getByRole('combobox', { name: '思考强度', exact: true }).click()
  await page.getByRole('option', { name: '高', exact: true }).click()
  await launch.getByRole('combobox', { name: '智能体预设', exact: true }).click()
  await page.getByRole('option', { name: '计划助手', exact: true }).click()
  assert.equal(await page.evaluate(() => window.__tasksBaselineSource.getSnapshot().launchForm.model.reasoningEffort), 'high')
  await page.screenshot({ path: join(output, 'paper-launch-light.png'), fullPage: true })
  await page.keyboard.press('Escape')
  results.launchSelections = true

  await card.locator('.dsh-tasks-card-title').click()
  const detail = page.getByRole('dialog', { name: '任务详情', exact: true })
  await page.screenshot({ path: join(output, 'paper-detail-light.png'), fullPage: true })
  await detail.getByRole('button', { name: '删除任务', exact: true }).click()
  const confirm = page.getByRole('dialog', { name: '确认删除任务？', exact: true })
  await page.screenshot({ path: join(output, 'paper-delete-light.png'), fullPage: true })
  await confirm.getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(await root.locator('article').count(), 18)
  await menu.click()
  await card.getByRole('button', { name: '删除任务', exact: true }).click()
  await page.evaluate(() => { window.__tasksFixture.allowDelete = true })
  await confirm.getByRole('button', { name: '删除任务', exact: true }).click()
  await confirm.waitFor({ state: 'detached' })
  assert.equal(await root.locator('article').count(), 17)
  assert.equal(await page.evaluate(() => window.__tasksFixture.confirmedDeletes.length), 1)
  await page.evaluate(() => { window.__tasksFixture.allowDelete = false })
  results.deleteFlow = { cancelPreservesCard: true, confirmRemovesCard: true, writes: 1 }

  results.widths = []
  for (const width of [1366, 1024, 768, 375]) {
    await page.setViewportSize({ width, height: 960 }); await settle()
    await page.evaluate(() => document.activeElement?.blur())
    const dimensions = await root.evaluate(el => ({ width: el.clientWidth, scrollWidth: el.scrollWidth }))
    assert(dimensions.scrollWidth <= dimensions.width + 1, `Overflow at ${width}`)
    const overlaps = await root.evaluate(el => {
      const rects = [...el.querySelectorAll('.dsh-tasks-title, .dsh-tasks-search, .dsh-tasks-filter > summary, .dsh-tasks-toolbar > button')].map(node => node.getBoundingClientRect())
      return rects.some((a, i) => rects.slice(i + 1).some(b => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1))
    })
    assert.equal(overlaps, false, `Toolbar overlap at ${width}`)
    results.widths.push({ viewport: width, ...dimensions })
    await page.screenshot({ path: join(output, `paper-light-${width}.png`), fullPage: true })
    await opener.click(); await model.click()
    const bounds = await page.getByRole('listbox', { name: '模型', exact: true }).boundingBox()
    assert(bounds.x >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y >= 0 && bounds.y + bounds.height <= 961)
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape')
  }
  await page.setViewportSize({ width: 1366, height: 960 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.evaluate(() => { document.body.setAttribute('data-ds-dark-theme', ''); document.documentElement.style.colorScheme = 'dark'; document.activeElement?.blur() })
  await settle()
  await page.screenshot({ path: join(output, 'paper-dark-1366.png'), fullPage: true })
  await opener.click(); await workspace.click()
  await page.screenshot({ path: join(output, 'paper-select-dark.png'), fullPage: true })
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape')
  results.streams = await page.evaluate(() => window.__tasksFixture.streams())
  assert.equal(results.streams.streams, 1)
  return results
}
