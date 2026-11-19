import assert from 'node:assert/strict'
import { watchFile, unwatchFile } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const inject = ['taskService', 'workspaceController']

export async function apply(ctx, { control, seed }) {
  if (seed) {
    const tasks = []
    for (const name of ['F5 Alpha', 'F5 Beta', 'F5 Ungrouped']) {
      const workspace = name.endsWith('Ungrouped') ? null : (await ctx.workspaceController.create({ path: join(control, name) })).workspace
      const input = { title: name, requestId: name.replace(' ', '-'), ...(workspace && { workspaceId: workspace.workspaceId }),
        ...(tasks.length === 0 && { externalRef: { provider: 'fixture', connectionId: '22222222-2222-4222-8222-222222222222', scopeId: 'synthetic', objectType: 'issue', objectId: '123' } }) }
      const create = async () => {
        const result = await ctx.taskService.execute('create', input)
        assert(result.ok, JSON.stringify(result)); return result.value.task
      }
      const task = await create(); assert.deepEqual(await create(), task); tasks.push(task)
    }
    await writeFile(join(control, 'seed.json'), JSON.stringify(tasks))
  }
  const stop = join(control, 'stop')
  const listener = async stat => {
    if (!stat.isFile()) return
    unwatchFile(stop, listener)
    await ctx.root.fiber.dispose()
    await writeFile(join(control, 'disposed'), 'ok')
  }
  watchFile(stop, { interval: 100 }, listener)
  ctx.effect(() => () => unwatchFile(stop, listener))
}
