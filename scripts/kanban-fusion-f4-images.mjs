import assert from 'node:assert/strict'

export async function verifyImages({ page, check, screenshot, checkFocused }) {
  const title = 'F4 Image verification', drawer = page.locator('.dsh-tasks-drawer'), section = drawer.locator('.dsh-tasks-images')
  await page.getByRole('button', { name: /^(新建任务|New task)$/ }).click()
  await drawer.locator('[name=title]').fill(title)
  const files = await page.evaluate(() => ['png', 'jpeg', 'webp'].map((type, index) => {
    const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 72
    const context = canvas.getContext('2d'); context.fillStyle = ['#aabb88', '#eeaaff', '#553388'][index]; context.fillRect(0, 0, 96, 72)
    return canvas.toDataURL('image/' + type).split(',')[1]
  }))
  const sendEvent = async (type, mime, data) => drawer.evaluate((element, { type, mime, data }) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([Uint8Array.from(atob(data), char => char.charCodeAt(0))], mime.slice(6), { type: mime }))
    element.dispatchEvent(type === 'paste' ? new ClipboardEvent(type, { clipboardData: transfer, bubbles: true, cancelable: true })
      : new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }))
  }, { type, mime, data })
  await section.locator('[type=file]').setInputFiles({ name: 'card.png', mimeType: 'image/png', buffer: Buffer.from(files[0], 'base64') })
  await sendEvent('paste', 'image/jpeg', files[1])
  assert.equal(await section.locator('.dsh-tasks-image-job').count(), 2)
  const uploads = [], route = '**/api/dsh-plugin-tasks/image/upload?*'
  await page.route(route, async entry => {
    uploads.push(entry.request().url())
    if (uploads.length === 2) return entry.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'tasks/images-unavailable' } }) })
    if (uploads.length !== 3) return entry.continue()
    const result = await entry.fetch(); assert((await result.json()).ok); await entry.abort('failed')
  })
  await drawer.locator('[type=submit]').click()
  const failed = section.locator('.dsh-tasks-image-job').filter({ hasText: /未确认|not confirmed/ })
  const retry = failed.getByRole('button', { name: /重试|Retry/i })
  await retry.waitFor(); assert.equal(await section.locator('.dsh-tasks-thumb').count(), 1)
  await retry.click(); await section.locator('.dsh-tasks-thumb').nth(1).waitFor(); await retry.click()
  await section.locator('.dsh-tasks-image-job').waitFor({ state: 'hidden' })
  assert.equal(uploads.length, 4); assert.equal(uploads[1], uploads[2]); assert.equal(uploads[2], uploads[3])
  await page.unroute(route)
  await sendEvent('drop', 'image/webp', files[2])
  const thumbs = section.locator('.dsh-tasks-thumb')
  await thumbs.nth(2).waitFor()
  await page.waitForFunction(() => [...document.querySelectorAll('.dsh-tasks-thumb img')].every(image => image.naturalWidth === 96))
  check('Tavlo creates once, accepts picker/paste/drop and retries only the failed file, even after losing its successful response')
  const brokenImage = await page.context().request.post(uploads[0].replace(/requestId=[^&]+/, 'requestId=invalid-bytes'), { headers: { 'content-type': 'image/png' }, data: Buffer.from('invalid fixture') })
  assert.equal((await brokenImage.json()).error.code, 'tasks/image-save-failed')
  await drawer.getByRole('button', { name: /^(编辑描述|Edit description)$/ }).click()
  await drawer.locator('[name=brief]').fill('unsaved local text')
  await thumbs.first().click()
  const preview = page.getByRole('dialog', { name: /^(任务图片|Task images)$/ })
  await preview.waitFor(); await screenshot(page, 'tavlo-f4-preview.png'); await page.keyboard.press('Escape'); await preview.waitFor({ state: 'hidden' })
  assert.equal(await drawer.locator('[name=brief]').inputValue(), 'unsaved local text'); await checkFocused(thumbs.first())
  await drawer.locator('[name=brief]').fill('')
  await screenshot(page, 'tavlo-f4-images.png')
  await page.keyboard.press('Escape'); await drawer.waitFor({ state: 'hidden' })
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.getByText(/^(任务|Tasks)$/).first().click()
  const card = page.getByRole('button', { name: title, exact: true }); await card.waitFor(); assert.equal(await card.count(), 1); await card.click()
  const peer = await page.context().newPage()
  try {
    await peer.goto(page.url(), { waitUntil: 'domcontentloaded' }); await peer.getByText(/^(任务|Tasks)$/).first().click()
    await peer.locator('.dsh-tasks-card').getByText(/(?:任务图片|Task images): 3/).waitFor()
    await thumbs.nth(2).waitFor(); await section.getByRole('button', { name: /^(移除图片|Remove image)$/ }).first().click()
    await thumbs.nth(2).waitFor({ state: 'hidden' }); assert.equal(await thumbs.count(), 2)
    await peer.locator('.dsh-tasks-card').getByText(/(?:任务图片|Task images): 2/).waitFor()
  } finally { await peer.close() }
  await drawer.getByRole('button', { name: /^(启动任务|Start task)$/ }).click()
  const includeImages = page.getByRole('checkbox', { name: /随首条消息发送任务图片|Send task images with the first message/ })
  assert(await includeImages.isChecked()); await includeImages.click(); assert(!await includeImages.isChecked()); await page.keyboard.press('Escape')
  check('Native preview restores focus and draft; images persist, unlink individually, and launch offers image delivery or text only')
  const theme = page.locator('.dsh-tasks-appearance select')
  if (await theme.count()) {
    for (const appearance of ['paper', 'ios']) {
      await theme.selectOption(appearance); await card.click(); await thumbs.nth(1).waitFor()
      await section.scrollIntoViewIfNeeded(); await screenshot(page, `tavlo-f4-${appearance}.png`)
      await page.keyboard.press('Escape'); await drawer.waitFor({ state: 'hidden' })
    }
    await theme.selectOption('inherit'); check('Image controls and gallery render with paper and iOS task appearances')
  }
}
