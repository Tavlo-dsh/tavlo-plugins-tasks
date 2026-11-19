import assert from 'node:assert/strict'
import test from 'node:test'
import { emptyList, mountClient, waitForState } from './fixtures.mjs'

test('the board no longer exposes a density switch or reads its saved preference', async t => {
  const reads = []
  const client = await mountClient(t, { call: async () => emptyList() }, {
    browserEvents: { addEventListener() {
      this.localStorage = { getItem(key) { reads.push(key); return 'comfortable' } }
    } },
  })
  await waitForState(client.tasks, 'ready')
  const nodes = client.render()
  assert(nodes.some(node => node.props?.className === 'dsh-tasks-board-toolbar'))
  assert(!nodes.some(node => node.props?.['aria-label'] === '卡片密度' || node.props?.['data-card-density']))
  assert(!reads.includes('dsh-tasks.card-density'))
})
