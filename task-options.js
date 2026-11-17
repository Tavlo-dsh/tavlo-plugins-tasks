/** Read live Host catalogs; saved tasks hold weak workspace/model references. */
export function createTaskOptions(ctx) {
  async function list() {
    let workspaces = []
    let groups = []
    let workspaceStatus = 'unavailable'
    let modelStatus = 'unavailable'
    let modelFailures = 0
    const registry = ctx.get('workspaceRegistry')
    const controller = ctx.get('sessionController')
    if (registry) {
      try {
        workspaces = registry.list().map(({ id, title, path }) => ({ id, title, path }))
        workspaceStatus = 'ready'
      } catch { workspaceStatus = 'error' }
    }
    if (controller) {
      try {
        const catalog = await controller.modelCatalog()
        groups = catalog.groups.map(group => ({
          id: group.id, name: group.name,
          models: group.models.map(model => ({
            id: model.id, name: model.name,
            ...(model.reasoning ? { reasoning: model.reasoning } : {}),
          })),
        }))
        modelFailures = catalog.failures.length
        modelStatus = 'ready'
      } catch { modelStatus = 'error' }
    }
    let presets = []
    try { presets = (await ctx.get('agentPresets')?.list() ?? []).filter(row => !row.broken).map(({ id, name }) => ({ id, name: name ?? id })) }
    catch { /* The default preset remains selectable; explicit presets must validate at launch. */ }
    return { workspaces, groups, workspaceStatus, modelStatus, modelFailures, presets }
  }

  async function validate(input) {
    const catalog = await list()
    if (input.workspaceId && (catalog.workspaceStatus !== 'ready'
      || !catalog.workspaces.some(workspace => workspace.id === input.workspaceId))) {
      return { code: 'tasks/workspace-unavailable', message: 'Selected workspace is unavailable' }
    }
    if (input.model) {
      const model = catalog.groups.find(group => group.id === input.model.provider)?.models
        .find(model => model.id === input.model.model)
      if (!model || (input.model.reasoningEffort
        && !model.reasoning?.efforts.some(effort => effort.id === input.model.reasoningEffort))) {
        return { code: 'tasks/model-unavailable', message: 'Selected model is unavailable' }
      }
    }
  }
  return { list, validate }
}
