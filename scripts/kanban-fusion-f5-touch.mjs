import assert from 'node:assert/strict'
import { join } from 'node:path'

export async function verifyTouch({ page, tool, title, taskId, output, pass }) {
  const session = await page.context().newCDPSession(page)
  const card = page.getByRole('button', { name: title, exact: true })
  const drawer = page.locator('.dsh-tasks-drawer')
  const point = async locator => {
    await locator.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)))
    const rect = await locator.boundingBox(); assert(rect)
    const position = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    assert(await locator.evaluate((element, { x, y }) => element.contains(document.elementFromPoint(x, y)), position), 'Touch target is occluded')
    return position
  }
  const dispatch = (type, position) => session.send('Input.dispatchTouchEvent', { type, touchPoints: position ? [position] : [] })
  const swipe = async (from, to, end = 'touchEnd', dragging = false) => {
    await dispatch('touchStart', from)
    if (dragging) await page.locator('[data-dragging="true"]').first().waitFor()
    for (let step = 1; step <= 12; step++) {
      await dispatch('touchMove', { x: from.x + (to.x - from.x) * step / 12, y: from.y + (to.y - from.y) * step / 12 })
      await page.evaluate(() => new Promise(requestAnimationFrame))
    }
    if (dragging) await page.locator('[data-dragging="true"]').first().waitFor()
    await dispatch(end)
  }
  const tap = async locator => { await locator.scrollIntoViewIfNeeded(); await dispatch('touchStart', await point(locator)); await dispatch('touchEnd') }
  try {
    await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    const todo = page.locator('[data-column-id="stage:todo"]'), list = todo.locator('.dsh-tasks-collist')
    for (let index = 0; index < 12; index++) await tool('create', { title: `Touch scroll ${index}`, requestId: `touch-scroll-${index}` })
    const body = todo.locator('.dsh-tasks-card-title').nth(2); await body.scrollIntoViewIfNeeded()
    const before = await tool('list'), scrolled = await list.evaluate(element => element.scrollTop)
    const start = await point(body); await swipe(start, { x: start.x, y: start.y - 110 })
    await page.waitForFunction(({ scrolled }) => document.querySelector('[data-column-id="stage:todo"] .dsh-tasks-collist').scrollTop > scrolled + 20, { scrolled })
    assert(await drawer.isHidden()); assert.deepEqual(await tool('list'), before)
    pass('Emulated touch on card body scrolls the overflowing column without opening or mutating a task')

    const source = page.locator('.dsh-tasks-card').filter({ has: card }).locator('.dsh-tasks-card-state')
    const destination = page.locator('[data-column-id="stage:done"] .dsh-tasks-empty')
    await source.scrollIntoViewIfNeeded(); await destination.scrollIntoViewIfNeeded()
    await swipe(await point(source), await point(destination), 'touchCancel', true)
    await page.locator('[data-dragging="true"]').waitFor({ state: 'hidden' }); assert.deepEqual(await tool('list'), before)
    await swipe(await point(source), await point(destination), 'touchEnd', true)
    await page.locator('[data-column-id="stage:done"]').getByRole('button', { name: title, exact: true }).waitFor()
    const moved = (await tool('get', { taskId })).task
    assert.equal(moved.columnId, 'stage:done'); assert.equal(moved.revision, before.tasks.find(task => task.id === taskId).revision + 1)
    pass('Emulated long press on the card body cancels without writing and moves with exactly one revision')

    await page.reload({ waitUntil: 'domcontentloaded' }); await page.getByText(/^(任务|Tasks)$/).first().click()
    await page.locator('[data-column-id="stage:done"]').getByRole('button', { name: title, exact: true }).waitFor()
    await tap(card); const handle = drawer.getByRole('separator'); await handle.waitFor()
    await drawer.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)))
    const width = (await drawer.boundingBox()).width, edge = await point(handle)
    await swipe(edge, { x: edge.x - 60, y: edge.y }); assert.equal(Math.round((await drawer.boundingBox()).width), Math.round(width) + 60)
    await page.keyboard.press('Escape'); await drawer.waitFor({ state: 'hidden' }); await tap(card); await handle.waitFor()
    assert.equal(Math.round((await drawer.boundingBox()).width), Math.round(width) + 60)
    await page.setViewportSize({ width: 390, height: 740 }); await handle.waitFor({ state: 'hidden' }); assert.equal(Math.round((await drawer.boundingBox()).width), 390)
    const thumb = drawer.locator('.dsh-tasks-thumb').first(); await tap(thumb)
    const preview = page.getByRole('dialog', { name: /^(任务图片|Task images)$/ }); await preview.waitFor()
    await page.screenshot({ path: join(output, 'touch-preview-390.png') })
    await tap(preview.getByRole('button', { name: /关闭|close/i }).first()); await preview.waitFor({ state: 'hidden' })
    assert(await thumb.evaluate(element => document.activeElement === element))
    pass('Emulated touch resizes and remembers the drawer; 390px preview closes by touch and restores thumbnail focus')
  } finally { await session.detach() }
}
