/**
 * Task board Client half.
 *
 * One lifecycle-owned Connection data source, consumed by the slot hook.
 * Components receive state/actions and never access a Cordis context.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-tasks',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'tasks'
    const NS = 'tavlo-tasks'
    const STAGES = { todo: 'colTodo', doing: 'colDoing', done: 'colDone' }
    const DRAFT_KEY = 'dsh-plugin-tasks:create-v1'
    const LAUNCH_KEY = 'dsh-plugin-tasks:launch-v1'
    const RUNTIME = ['running', 'approval', 'question', 'error', 'idle', 'missing', 'archived', 'unknown']

    const EN = {
      paperTitle: 'Task notebook', paperNote: 'Write it down. One thing at a time.',
      deleteTask: 'Delete task', confirmDelete: 'Delete this task?', deleting: 'Deleting…', cancelDelete: 'Cancel',
      deleteNotice: 'This removes the task card. Linked conversations are kept and will continue running.',
      deleteFailed: 'Deletion failed. The task is still here; please retry.', deleteUnknown: 'Deletion result is unknown. Retry to confirm the same deletion.',
      deleteConflict: 'This task changed. Close this dialog, refresh, and review it before deleting.',
      taskDeleted: 'This task was deleted.', deletePendingLaunch: 'Resolve or end the pending launch before deleting this task.',
      launch: 'Start task', start: 'Start', starting: 'Starting…', openSession: 'Open conversation',
      resumeLaunch: 'Resume launch', newSession: 'Start a new conversation', firstMessage: 'First message',
      preset: 'Agent preset', defaultPreset: 'Default preset', modelDefaultNotice: 'Selecting a model also updates the DSH default model.',
      launchFailed: 'Launch is incomplete. Resume this request or open the saved conversation to inspect it.',
      launchUnknown: 'Launch result is unknown. Retry the same request to recover it.',
      sessionBusy: 'The existing conversation is active. Open it to continue.',
      sessionExists: 'Continue in the existing conversation, or explicitly start a new one.',
      navigationFailed: 'Unable to open the conversation. Return to the board and try again.',
      sessionUnavailable: 'The session service is unavailable.', presetUnavailable: 'The selected preset is unavailable.',
      launchPending: 'Resume the unfinished launch first.', launchSaved: 'The launch request and session reference are saved. Resuming reuses them.',
      running: 'Running', approval: 'Needs approval', question: 'Needs an answer', error: 'Error', idle: 'Idle',
      missing: 'Conversation missing', archived: 'Conversation archived', unknown: 'Status unavailable',
      attention: 'Tasks need your attention', history: 'Previous conversations', session: 'Conversation',
      abandonLaunch: 'End this launch', abandonHint: 'No prompt has been admitted. Ending this launch keeps its conversation in task history.',
      launchAbandoned: 'This launch has ended. Start a new launch from the card.', reasoningEffort: 'Reasoning effort',
      title: 'Tasks',
      subtitle: 'Organize tasks into three columns. Changes are saved automatically.',
      newTask: 'New task',
      search: 'Search title or description…',
      colTodo: 'To do',
      colDoing: 'In progress',
      colDone: 'Done',
      emptyTodo: 'Nothing waiting',
      emptyDoing: 'No tasks in progress',
      emptyDone: 'Nothing finished yet',
      loading: 'Loading tasks…',
      loaded: 'No tasks yet.',
      loadFailed: 'Could not load tasks. Please retry.',
      storageUncertain: 'Task storage state is uncertain. Re-enable the Tasks plugin or restart DSH before retrying.',
      listUnavailable: 'Task list unavailable',
      retry: 'Retry',
      refresh: 'Refresh',
      taskTitle: 'Title',
      taskBrief: 'Description (optional)',
      cancel: 'Close',
      create: 'Create task',
      creating: 'Saving…',
      createUnknown: 'The creation result is unknown. Retry this same request to avoid duplicates. Your input is preserved.',
      resumeCreate: 'Resume creation',
      createFailed: 'Could not create the task. Your input is preserved; please retry.',
      titleRequired: 'Enter a nonblank title.',
      badRequest: 'Check the title and description, including their length.',
      limitReached: 'The task limit has been reached.',
      requestConflict: 'This creation request conflicts with an existing task. Refresh to check the board before trying again.',
      revisionConflict: 'This task changed elsewhere. Refresh, then choose its column again.',
      stageUnknown: 'The change result is unknown. Refresh to check the saved column.',
      stageFailed: 'Could not change the column. Refresh before trying again.',
      moveTask: 'Task column',
      moving: 'Changing column…',
      attemptedColumn: 'Requested column',
      noMatches: 'No matching tasks',
      countLabel: 'Matching / total tasks',
      total: 'Total tasks',
      matched: 'Matching tasks',
      manualStage: 'Changing a column saves its category; conversations are not started by this control.',
      stale: 'Showing the last loaded tasks. Refresh before making changes.',
      syncLive: 'Live sync',
      syncConnecting: 'Connecting live sync…',
      syncOffline: 'Live sync disconnected. Tasks may be out of date; reconnecting automatically.',
      workspace: 'Workspace',
      optional: 'Optional',
      model: 'Model preference',
      ungrouped: 'Ungrouped',
      defaultModel: 'Use default model',
      workspaceMissing: 'Workspace removed',
      workspaceUnavailable: 'Workspace list unavailable. Retry or leave it ungrouped.',
      modelUnavailable: 'Model list unavailable. Retry or use the default.',
      partialModels: 'Some providers could not be loaded.',
      optionsLoading: 'Loading workspaces and models…',
      reloadOptions: 'Reload options',
      workspaceRejected: 'This workspace is no longer available. Reload options and choose again.',
      modelRejected: 'This model is no longer available. Reload options and choose again.',
      modelHint: 'Saved as a preference for starting the task later.',
      createIntro: 'Turn what needs doing into a task card.',
      titlePlaceholder: 'What needs to be done?',
      briefPlaceholder: 'Describe the goal, context, or acceptance criteria…',
      draftHint: 'Closing keeps this draft in the current tab.',
      close: 'Close',
      filter: 'Filter',
      allWorkspaces: 'All workspaces',
      notStarted: 'Not started',
      justNow: 'Just now',
      minutesAgo: 'minutes ago',
      hoursAgo: 'hours ago',
      daysAgo: 'days ago',
      moreTask: 'Task actions',
      details: 'Task details',
      moveTo: 'Move to',
      add: 'New',
      showAll: 'Show all',
      showRecent: 'Show recent 10',
      collapse: 'Collapse column',
      created: 'Created',
    }

    const ZH = {
      paperTitle: '任务手记', paperNote: '记下计划，专注眼前。',
      deleteTask: '删除任务', confirmDelete: '确认删除任务？', deleting: '正在删除…', cancelDelete: '取消',
      deleteNotice: '删除后，任务卡片将移除。关联对话会保留，正在执行的对话会继续运行。',
      deleteFailed: '删除失败，任务仍保留，请重试。', deleteUnknown: '删除结果尚未确认，请重试确认同一次删除。',
      deleteConflict: '任务已有更新，请关闭弹框并刷新，确认内容后再删除。',
      taskDeleted: '该任务已被删除。', deletePendingLaunch: '请先恢复或结束尚未完成的启动，再删除任务。',
      launch: '启动任务', start: '开始', starting: '正在启动…', openSession: '打开对话',
      resumeLaunch: '恢复启动', newSession: '新开一个对话', firstMessage: '首条消息',
      preset: '智能体预设', defaultPreset: '默认预设', modelDefaultNotice: '选择具体模型也会更新 DSH 的全局默认模型。',
      launchFailed: '启动尚未完成。可恢复本次启动，或打开已保存的对话查看。',
      launchUnknown: '启动结果尚未确认。重试同一请求可恢复进度。',
      sessionBusy: '已有对话正在执行或等待输入，请打开对话继续。',
      sessionExists: '可接着使用已有对话，也可明确选择新开一个对话。',
      navigationFailed: '暂时无法打开对话，请返回看板重试。',
      sessionUnavailable: '会话服务暂不可用。', presetUnavailable: '所选预设不可用。',
      launchPending: '请先恢复尚未完成的启动。', launchSaved: '启动请求和会话引用已保存，恢复时会复用同一次请求。',
      running: '执行中', approval: '待审批', question: '待回答', error: '出错', idle: '空闲',
      missing: '对话不存在', archived: '对话已归档', unknown: '状态暂不可用',
      attention: '件事在等你处理', history: '历史对话', session: '对话',
      abandonLaunch: '结束本次启动', abandonHint: '尚未投递消息。结束本次启动后，会话引用保留在任务历史中。',
      launchAbandoned: '本次启动已结束，可从卡片重新启动。', reasoningEffort: '推理强度',
      title: '任务',
      subtitle: '按三列整理任务，修改会自动保存。',
      newTask: '新建任务',
      search: '搜索标题或描述…',
      colTodo: '待开始',
      colDoing: '进行中',
      colDone: '已完成',
      emptyTodo: '没有待开始的任务',
      emptyDoing: '没有进行中的任务',
      emptyDone: '还没有已完成的任务',
      loading: '正在加载任务…',
      loaded: '暂无任务。',
      loadFailed: '无法加载任务，请重试。',
      storageUncertain: '任务存储状态不确定，请重新启用任务插件或重启 DSH 后重试。',
      listUnavailable: '任务列表暂不可用',
      retry: '重试',
      refresh: '刷新',
      taskTitle: '标题',
      taskBrief: '描述（可选）',
      cancel: '收起',
      create: '创建任务',
      creating: '正在保存…',
      createUnknown: '创建结果尚未确认。请重试同一请求，避免重复创建；输入已保留。',
      resumeCreate: '继续创建',
      createFailed: '创建失败，输入已保留，请重试。',
      titleRequired: '请输入非空标题。',
      badRequest: '标题或描述不符合要求，请检查内容和长度。',
      limitReached: '任务数量已达到上限。',
      requestConflict: '创建请求与已有任务冲突，请先刷新检查看板再试。',
      revisionConflict: '该任务已被其他操作修改。请刷新后重新选择分类。',
      stageUnknown: '分类修改结果尚未确认，请刷新查看已保存的分类。',
      stageFailed: '分类修改失败，请刷新后重试。',
      moveTask: '任务分类',
      moving: '正在修改分类…',
      attemptedColumn: '想要移入',
      noMatches: '没有匹配的任务',
      countLabel: '匹配数 / 总任务数',
      total: '总任务数',
      matched: '匹配任务数',
      manualStage: '改列只保存任务分类，不会启动对话。',
      stale: '当前显示上次加载的任务，请刷新后再修改。',
      syncLive: '实时同步已连接',
      syncConnecting: '正在连接实时同步…',
      syncOffline: '实时同步已断开，任务可能不是最新状态；正在自动重连。',
      workspace: '工作区',
      optional: '可选',
      model: '模型偏好',
      ungrouped: '未分组',
      defaultModel: '使用默认模型',
      workspaceMissing: '工作区已移除',
      workspaceUnavailable: '工作区列表暂不可用，可重试或保持未分组。',
      modelUnavailable: '模型列表暂不可用，可重试或使用默认模型。',
      partialModels: '部分模型提供方加载失败。',
      optionsLoading: '正在加载工作区和模型…',
      reloadOptions: '重新加载选项',
      workspaceRejected: '所选工作区已不可用，请重新加载选项后选择。',
      modelRejected: '所选模型已不可用，请重新加载选项后选择。',
      modelHint: '作为以后启动任务时的偏好保存。',
      createIntro: '把要做的事，整理成一张任务卡片。',
      titlePlaceholder: '这次要做什么？',
      briefPlaceholder: '补充目标、背景或验收标准…',
      draftHint: '关闭后，草稿会保留在当前标签页。',
      close: '关闭',
      filter: '筛选',
      allWorkspaces: '全部工作区',
      notStarted: '未启动',
      justNow: '刚刚',
      minutesAgo: '分钟前',
      hoursAgo: '小时前',
      daysAgo: '天前',
      moreTask: '任务操作',
      details: '任务详情',
      moveTo: '移入',
      add: '新建',
      showAll: '查看全部',
      showRecent: '只看最近 10 条',
      collapse: '折叠列',
      created: '创建于',
    }

    /* Every value is a host token, so light and dark both follow the app. */
    const CSS = `
.dsh-tasks-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.5;
}
.dsh-tasks-toolbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 48px;
  box-sizing: border-box;
  padding: 8px 16px;
  background: var(--dsw-alias-bg-base);
  flex-wrap: wrap;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dsh-tasks-heading { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dsh-tasks-title { font-size: 15px; font-weight: 700; letter-spacing: -0.02em; margin: 0; }
.dsh-tasks-subtitle {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-tasks-spacer { flex: 1; }
.dsh-tasks-search {
  width: 224px;
  height: 28px;
  padding: 0 10px 0 30px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: color-mix(in srgb, var(--dsw-alias-label-secondary) 4%, var(--dsw-alias-bg-base));
  color: var(--dsw-alias-label-primary);
  font: inherit;
  outline: none;
}
.dsh-tasks-search::placeholder { color: var(--dsw-alias-label-secondary); }
.dsh-tasks-root :is(input, textarea, select, button):focus-visible {
  outline: 2px solid var(--dsw-alias-label-primary);
  outline-offset: 2px;
}
.dsh-tasks-root button:disabled { opacity: 0.5; cursor: default; }
.dsh-tasks-primary {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 12px;
  border-radius: 6px;
  border: none;
  cursor: pointer;
  font: inherit;
  font-weight: 500;
  color: var(--dsw-alias-bg-base);
  background: var(--dsw-alias-label-primary);
}
.dsh-tasks-primary:hover { opacity: 0.88; }
.dsh-tasks-board {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 16px;
  padding: 16px;
  overflow-x: auto;
  align-items: stretch;
}
.dsh-tasks-col {
  flex: 1 1 0;
  min-width: 280px;
  max-width: 380px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-specific-sidebar-fill);
  overflow: hidden;
}
.dsh-tasks-colhead {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
}
.dsh-tasks-colname { font-size: 13px; font-weight: 600; }
.dsh-tasks-count {
  min-width: 16px;
  height: 16px;
  padding: 0 5px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
}
.dsh-tasks-collist { flex: 1; min-height: 0; overflow-y: auto; padding: 0 8px 8px; }
.dsh-tasks-empty {
  padding: 18px 8px;
  text-align: center;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-tasks-card {
  position: relative;
  margin-bottom: 8px;
  padding: 10px 10px 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
  box-shadow: 0 1px 2px rgb(0 0 0 / 4%);
  transition: border-color 150ms, box-shadow 150ms;
}
.dsh-tasks-card:hover { border-color: var(--dsw-alias-border-l2); box-shadow: 0 2px 4px rgb(0 0 0 / 6%); }
.dsh-tasks-card[data-stage="done"] .dsh-tasks-card-title { color: var(--dsw-alias-label-secondary); text-decoration: line-through; }
.dsh-tasks-stripe {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: transparent;
}
.dsh-tasks-card-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-tasks-card-brief {
  margin-top: 4px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.dsh-tasks-card-state {
  margin-top: 6px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-tasks-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  border: 1.5px solid var(--dsw-alias-label-secondary);
  flex: none;
}
.dsh-tasks-card-meta {
  margin-top: 6px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-tasks-footnote {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 16px 12px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-tasks-secondary, .dsh-tasks-retry {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  padding: 3px 10px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  cursor: pointer;
}
.dsh-tasks-form { margin: 0; }
.dsh-tasks-fields { border: 0; padding: 0; margin: 0; display: grid; gap: 8px; }
.dsh-tasks-fields label { display: grid; gap: 4px; }
.dsh-tasks-fields input, .dsh-tasks-fields textarea, .dsh-tasks-stage {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
}
.dsh-tasks-fields textarea { min-height: 112px; resize: vertical; line-height: 1.6; }
.dsh-tasks-fields { gap: 18px; }
.dsh-tasks-form-actions { display: flex; align-items: center; gap: 8px; padding: 16px 24px; border-top: 1px solid var(--dsw-alias-border-l1); }
.dsh-tasks-feedback { margin: 8px 0 0; font-size: 12px; overflow-wrap: anywhere; }
.dsh-tasks-stage-label { display: grid; gap: 4px; margin-top: 10px; font-size: 11px; }
.dsh-tasks-hint { flex-basis: 100%; }
.dsh-tasks-icon { display: inline-flex; align-items: center; justify-content: center; flex: none; }
.dsh-tasks-logo { width: 26px; height: 26px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); }
.dsh-tasks-divider { height: 16px; border-left: 1px solid var(--dsw-alias-border-l1); }
.dsh-tasks-search-wrap { position: relative; }
.dsh-tasks-search-wrap > .dsh-tasks-icon { position: absolute; top: 7px; left: 9px; color: var(--dsw-alias-label-secondary); pointer-events: none; }
.dsh-tasks-icon-button { padding: 5px; width: 28px; height: 28px; border: 1px solid transparent; border-radius: 5px; display: inline-flex; align-items: center; justify-content: center; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.dsh-tasks-icon-button:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-tasks-coltitle { display: flex; align-items: center; gap: 6px; padding: 0; border: 0; color: inherit; background: transparent; font: inherit; cursor: pointer; }
.dsh-tasks-colhead { justify-content: space-between; }
.dsh-tasks-count { font-family: ui-monospace, monospace; background: var(--dsw-alias-bg-base); }
.dsh-tasks-col[data-stage="doing"] .dsh-tasks-count { color: var(--dsw-alias-state-business-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 25%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 9%, var(--dsw-alias-bg-base)); }
.dsh-tasks-colfoot { padding: 8px; border-top: 1px solid var(--dsw-alias-border-l1); }
.dsh-tasks-add { width: 100%; border: 0; background: transparent; border-radius: 6px; color: var(--dsw-alias-label-secondary); padding: 5px; display: flex; align-items: center; justify-content: center; gap: 5px; cursor: pointer; font: inherit; }
.dsh-tasks-add:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); }
.dsh-tasks-card-heading { display: flex; align-items: flex-start; gap: 4px; }
.dsh-tasks-card-title { flex: 1; min-width: 0; border: 0; padding: 0; margin: 0; text-align: left; background: transparent; color: inherit; font-family: inherit; cursor: pointer; line-height: 20px; }
.dsh-tasks-card-actions { flex: none; position: relative; }
.dsh-tasks-card-actions > summary { list-style: none; width: 20px; height: 20px; padding: 0; opacity: 0; }
.dsh-tasks-card-actions > summary::-webkit-details-marker { display: none; }
.dsh-tasks-card:hover summary, .dsh-tasks-card:focus-within summary, .dsh-tasks-card-actions[open] > summary { opacity: 1; }
.dsh-tasks-menu { position: absolute; right: 0; top: 24px; z-index: 4; padding: 5px; min-width: 150px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-base); box-shadow: 0 4px 16px rgb(0 0 0 / 12%); }
.dsh-tasks-menu button { display: flex; align-items: center; gap: 7px; width: 100%; padding: 7px 9px; border: 0; border-radius: 5px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.dsh-tasks-menu button:hover { background: var(--dsw-alias-bg-layer-2); }
.dsh-tasks-menu-label { padding: 4px 9px; font-size: 10px; color: var(--dsw-alias-label-secondary); }
.dsh-tasks-card-state { margin: 6px 0; }
.dsh-tasks-card-meta { margin-top: 0; display: flex; align-items: center; gap: 5px; }
.dsh-tasks-meta-workspace { overflow: hidden; text-overflow: ellipsis; }
.dsh-tasks-meta-model { flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; }
.dsh-tasks-dialog { padding: 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px; width: min(560px, calc(100vw - 32px)); max-height: calc(100dvh - 48px); overflow-y: auto; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); box-shadow: 0 24px 80px rgb(0 0 0 / 22%); font: inherit; }
.dsh-tasks-dialog::backdrop { background: rgb(24 23 21 / 22%); }
.dsh-tasks-dialog-head { display: flex; gap: 12px; align-items: flex-start; padding: 24px 24px 20px; }
.dsh-tasks-dialog-head h2 { margin: 0; font-size: 18px; font-weight: 650; letter-spacing: -.02em; }
.dsh-tasks-dialog-head p { margin: 5px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsh-tasks-dialog-head .dsh-tasks-icon-button { margin-left: auto; }
.dsh-tasks-dialog-head .dsh-tasks-logo { width: 36px; height: 36px; border-radius: 9px; }
.dsh-tasks-dialog-body { padding: 0 24px 24px; }
.dsh-tasks-field-title { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 550; }
.dsh-tasks-optional { font-size: 10px; color: var(--dsw-alias-label-secondary); font-weight: 400; }
.dsh-tasks-fields input, .dsh-tasks-fields textarea, .dsh-tasks-fields select { padding: 9px 11px; background: color-mix(in srgb, var(--dsw-alias-label-secondary) 3%, var(--dsw-alias-bg-base)); }
.dsh-tasks-fields input[name="title"] { font-size: 14px; }
.dsh-tasks-fields input::placeholder, .dsh-tasks-fields textarea::placeholder { color: var(--dsw-alias-label-secondary); }
.dsh-tasks-bindings { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; align-items: start; }
.dsh-tasks-field-hint { margin: 0; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsh-tasks-draft-hint { margin-right: auto; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dsh-tasks-detail-brief { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.7; margin: 0 0 24px; }
.dsh-tasks-detail-grid { display: grid; grid-template-columns: 80px 1fr; gap: 12px; font-size: 12px; }
.dsh-tasks-detail-grid dt { color: var(--dsw-alias-label-secondary); }
.dsh-tasks-detail-grid dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.dsh-tasks-footnote { padding: 4px 16px 10px; }
.dsh-tasks-filter { position: relative; }
.dsh-tasks-filter > summary { list-style: none; display: flex; gap: 5px; align-items: center; cursor: pointer; }
.dsh-tasks-filter > summary::-webkit-details-marker { display: none; }
.dsh-tasks-filter select { max-width: 230px; }
@media (hover: none) { .dsh-tasks-card-actions > summary { opacity: 1; } }
@media (max-width: 620px) { .dsh-tasks-divider { display: none; } .dsh-tasks-search { width: 180px; } .dsh-tasks-bindings { grid-template-columns: 1fr; } .dsh-tasks-draft-hint { display: none; } }
@media (prefers-reduced-motion: reduce) { .dsh-tasks-card { transition: none; } }
`


    // Texture URIs and hashSeed/avalanche adapted from Looseleaf MIT,
    // 4bdb647940e2fefb3cebb394f3bad25c766a27d2; see licenses/looseleaf-MIT.txt
    // and docs/looseleaf-source-map.md. PNG bytes are copied without alteration.
    const PAPER_SLIP = 'data:image/png;base64,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ZnN/zxvdF/8e95t3mnfam0rf87Snsd/i3Z6qoI5tlW1ndLf/7WCrbGV4/54uFLnbOAzeStuY6cxl6AbsTRtm462oe7tPzLyVvdf13vS/3FN/7b0r/fmhv7P9e+5zQyrd3gTX28adbdvKHveRuV3mXldzlNKCGk2N+D1d7J3382XyQKbChqnbCurLc7NNDfs1NrH7fNjChKY76C+6u7Lnor+oju3xl9vb21zJyARSGVjmu2IbxR5KX17usu1osDe4vMGLbchz7SkTxKixdMV0Z7D3iLYZ0fUc8Ou2VmbqvDdt6Q777e/2uj98gdrXfrOBMPq81aiEvaHbHbM962O/BWRL2I/2Kt4baP80ryXbsncZqGaWudhItemaiTcyeqjanY73ut+rNx1veeyH/d5fmt3efd7y97je0m7f/j0O69M2ansddRZ7D/f18N5GtbffRJb988W8eW3wnixt3LbVtbAHC6QVIyoH8/ud7cneM+HsdRci7ffaGIOt8x70efS2/el4zt988S6/53n83d6uYnQ6nY1khv5iy57u2O9hC9tvV2PgttdeNa5Kv4eqaU95E2ebMjaqMfx+e7dHzxsV1a+PsbBXwUa86drovlz2g8qu9tf32Zt7P37l70CT5ypfZW8zNtyXrdyP4m0w5hddGHznvb3p2zCl+3Hxm614T1xMZ7Jflezt9nR7q3pJh3RhEM/dIzpnT1/dusLWb7IubPvr9lbvDV2XbbzO781aA9hj9F02acneTGXzNufOlqljG33sxbts+U77rem2TQfq2sTK7D0eVyt3bgkwGIy9DrcdZS42F/x+bmLDfqu/2+99356jxLixl8y8vc57grgPFns/vEnfMbZMNvYmfj/H3TZhmC7GhG0NI6Go9t5wuWMsVJtA9pZpe7vtVcTbW17v9fS16FIHm76/vd2X/LFt2tpU3f2e6z173vy+680dG2z/AVcdE99mr8neztvPXULYdm3b76PvTddITM28BfbeoFMWe10Bbdj7ya4t3mbysyns2VxsdK/LKH/9vd2F8H7ayJx9qlK3B9N+u2y/Ls/PqvUVbKiN7exN3upio2qzjHco3ambuxltXHuYetwFDYqZo8HDuhReYdApj/s0799am+ytt+zvwbZXvx9juTdb37bssUF5U/Nb4U13qpZNIHG86Tx33lAN1FD2sjsc0jKrm/fWKnZf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'
    const PAPER_FIBRE = 'data:image/png;base64,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'

    const CONTROLS_CSS = `
.dsh-tasks-root {
  --dsh-tasks-paper: var(--dsw-alias-bg-layer-1);
  --dsh-tasks-ink: var(--dsw-alias-label-primary);
  --dsh-tasks-muted: var(--dsw-alias-label-secondary);
  --dsh-tasks-line: var(--dsw-alias-border-l3);
  --dsh-tasks-rule: var(--dsw-alias-border-l2);
  --dsh-tasks-highlight: var(--dsw-alias-state-business-tertiary);
  --dsh-tasks-focus: var(--dsw-alias-state-business-primary);
  --dsh-tasks-shadow: rgb(0 0 0 / 15%);
  --dsh-tasks-slip: none;
}
.dsh-tasks-root .dsh-tasks-paper-title { display: none; }
body[data-dsh-paper-theme="paper"] .dsh-tasks-root .dsh-tasks-host-title { display: none; }
body[data-dsh-paper-theme="paper"] .dsh-tasks-root .dsh-tasks-paper-title { display: inline; }
.dsh-tasks-root :is(input, textarea, .dsh-tasks-select-trigger):focus { outline: none; box-shadow: none; border-color: var(--dsh-tasks-focus); }
.dsh-tasks-root summary:focus-visible { outline: 2px solid var(--dsh-tasks-focus); outline-offset: 2px; }
.dsh-tasks-root .dsh-tasks-danger { color: var(--dsw-alias-state-error-primary); }
.dsh-tasks-root .dsh-tasks-danger.dsh-tasks-primary { background: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-label-primary-foreground); }
.dsh-tasks-root .dsh-tasks-delete-title { font-weight: 600; overflow-wrap: anywhere; }
.dsh-tasks-root .dsh-tasks-filter .dsh-tasks-menu { min-width: 220px; max-width: calc(100vw - 40px); }
.dsh-tasks-root .dsh-tasks-select { display: block; min-width: 0; width: 100%; }
.dsh-tasks-root .dsh-tasks-select-trigger { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; min-height: 40px; padding: 9px 11px; border: 1px solid var(--dsh-tasks-line); border-radius: 3px 5px 2px 4px; background: var(--dsh-tasks-paper); color: var(--dsh-tasks-ink); font: inherit; text-align: left; cursor: pointer; }
.dsh-tasks-root .dsh-tasks-select-trigger > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-tasks-root .dsh-tasks-select-trigger[aria-expanded="true"] { border-color: var(--dsh-tasks-focus); }
.dsh-tasks-root .dsh-tasks-select-list { position: fixed; inset: auto; margin: 0; box-sizing: border-box; padding: 5px; border: 1px solid var(--dsh-tasks-line); border-radius: 2px 5px 3px 2px; color: var(--dsh-tasks-ink); background: var(--dsh-tasks-paper); background-image: var(--dsh-tasks-slip); background-size: 128px 128px; background-blend-mode: var(--dsh-tasks-texture-blend, normal); box-shadow: 0 5px 16px var(--dsh-tasks-shadow); overflow: auto; overscroll-behavior: contain; font: inherit; }
.dsh-tasks-root .dsh-tasks-select-list::backdrop { background: transparent; }
.dsh-tasks-root .dsh-tasks-select-option { display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 6px 9px; box-sizing: border-box; border-radius: 2px; cursor: pointer; overflow-wrap: anywhere; }
.dsh-tasks-root .dsh-tasks-select-option[aria-selected="true"] { font-weight: 600; }
.dsh-tasks-root .dsh-tasks-select-option[data-active="true"] { background: var(--dsh-tasks-highlight); }
.dsh-tasks-root .dsh-tasks-select-option[aria-disabled="true"] { opacity: .5; cursor: default; }
.dsh-tasks-root .dsh-tasks-select-group { padding: 8px 9px 4px; font-size: 11px; color: var(--dsh-tasks-muted); border-top: 1px dashed var(--dsh-tasks-rule); }

`

    const PAPER_CSS = `
.dsh-tasks-root .dsh-tasks-paper-note { display: none; }
.dsh-tasks-root .dsh-tasks-status-label { display: contents; }
body[data-dsh-paper-theme="paper"] .dsh-tasks-root {
  --dsh-tasks-desk: var(--dsh-paper-desk);
  --dsh-tasks-paper: var(--dsh-paper-paper);
  --dsh-tasks-sheet: var(--dsh-paper-sheet);
  --dsh-tasks-ink: var(--dsh-paper-ink);
  --dsh-tasks-muted: var(--dsh-paper-muted);
  --dsh-tasks-line: var(--dsh-paper-line);
  --dsh-tasks-rule: var(--dsh-paper-rule);
  --dsh-tasks-highlight: var(--dsh-paper-highlight);
  --dsh-tasks-tape: var(--dsh-paper-tape);
  --dsh-tasks-focus: var(--dsh-paper-accent);
  --dsh-tasks-shadow: var(--dsh-paper-shadow);
  --dsh-tasks-slip: url("${PAPER_SLIP}");
  --dsh-tasks-fibre: url("${PAPER_FIBRE}");
  color: var(--dsh-tasks-ink);
  background-color: var(--dsh-tasks-desk);
  background-image: var(--dsh-tasks-fibre), repeating-linear-gradient(0deg, transparent 0 2px, #ffffff0a 2px 3px), repeating-linear-gradient(90deg, transparent 0 2px, #29423408 2px 3px);
  background-size: 240px 240px, 3px 3px, 3px 3px;
  font-family: inherit; min-width: 0; isolation: isolate;
  background-blend-mode: var(--dsh-tasks-texture-blend, normal);
  & :is(.dsh-tasks-toolbar, .dsh-tasks-col, .dsh-tasks-card, .dsh-tasks-dialog) { background-blend-mode: var(--dsh-tasks-texture-blend, normal); }
  & .dsh-tasks-toolbar {
    margin: 14px 18px 0; padding: 12px 16px; gap: 12px;
    border: 1px solid color-mix(in srgb, var(--dsh-tasks-line) 45%, transparent); border-radius: 1px 3px 2px 1px;
    background-color: var(--dsh-tasks-paper); background-image: var(--dsh-tasks-slip); background-size: 128px 128px;
    box-shadow: 0 2px 3px var(--dsh-tasks-shadow), 0 7px 16px -10px var(--dsh-tasks-shadow);
    position: relative; z-index: 5;
  }
  & .dsh-tasks-title { font-size: 21px; font-weight: 650; letter-spacing: .06em; white-space: nowrap; }
  & .dsh-tasks-heading { flex-shrink: 0; }
  & .dsh-tasks-logo { background: transparent; border: 0; color: var(--dsh-tasks-ink); }
  & .dsh-tasks-divider { border-color: var(--dsh-tasks-line); }
  & .dsh-tasks-paper-note { display: block; flex: none; margin: 16px 28px 0; font-size: 12px; letter-spacing: .12em; color: var(--dsh-paper-muted); }
  & .dsh-tasks-board { gap: 23px; padding: 30px 24px 18px; }
  & .dsh-tasks-col {
    position: relative; overflow: visible; border-radius: 2px 1px 3px 1px;
    border: 1px solid color-mix(in srgb, var(--dsh-tasks-line) 65%, transparent);
    background-color: var(--dsh-tasks-sheet);
    background-image: var(--dsh-tasks-slip), repeating-linear-gradient(0deg, transparent 0 27px, var(--dsh-tasks-rule) 27px 28px);
    background-size: 128px 128px, 100% 28px;
    box-shadow: 1px 2px 2px var(--dsh-tasks-shadow), 0 9px 15px -7px var(--dsh-tasks-shadow);
    min-width: 270px; max-width: none;
  }
  & .dsh-tasks-col::before {
    content: ''; position: absolute; z-index: 2; width: 72px; height: 24px; top: -13px; left: calc(50% - 36px);
    background: var(--dsh-tasks-fibre), var(--dsh-tasks-tape); background-size: 160px 160px; transform: rotate(-4deg); pointer-events: none;
    clip-path: polygon(2% 0, 99% 3%, 97% 20%, 100% 40%, 98% 65%, 100% 99%, 1% 96%, 3% 75%, 0 54%, 2% 28%);
  }
  & .dsh-tasks-col[data-stage="doing"]::before { transform: rotate(3deg); }
  & .dsh-tasks-col[data-stage="done"]::before { transform: rotate(-2deg); }
  & .dsh-tasks-colhead { padding: 22px 16px 13px; }
  & .dsh-tasks-coltitle { min-height: 28px; gap: 10px; }
  & .dsh-tasks-colname { font-size: 16px; letter-spacing: .05em; position: relative; isolation: isolate; }
  & .dsh-tasks-colname::before { content: ''; position: absolute; z-index: -1; inset: 35% -5px 0 -3px; background: var(--dsh-tasks-highlight); border-radius: 35% 12% 20% 8% / 22% 30% 35% 38%; transform: rotate(-2deg); pointer-events: none; }
  & .dsh-tasks-col[data-stage="doing"] .dsh-tasks-colname::before { background: var(--dsh-paper-infoSoft); }
  & .dsh-tasks-col[data-stage="done"] .dsh-tasks-colname::before { background: var(--dsh-paper-successSoft); }
  & .dsh-tasks-count { color: var(--dsh-tasks-muted); background: transparent; border: 0; padding: 0; font-size: 12px; }
  & .dsh-tasks-collist { padding: 4px 12px 8px; }
  & .dsh-tasks-card {
    padding: 14px; margin-bottom: 13px; color: var(--dsh-tasks-ink);
    border: 1px solid color-mix(in srgb, var(--dsh-tasks-line) 55%, transparent); border-radius: 2px 4px 3px 1px;
    background-color: var(--dsh-tasks-paper); background-image: var(--dsh-tasks-fibre), var(--dsh-tasks-slip);
    background-size: 240px 240px, 128px 128px; background-position: var(--dsh-tasks-paper-x) var(--dsh-tasks-paper-y);
    box-shadow: 1px 2px 2px var(--dsh-tasks-shadow), 0 5px 8px -5px var(--dsh-tasks-shadow);
  }
  & .dsh-tasks-card:hover { border-color: var(--dsh-tasks-line); box-shadow: 1px 2px 3px var(--dsh-tasks-shadow), 0 6px 10px -5px var(--dsh-tasks-shadow); }
  & .dsh-tasks-card-title { font-size: 14px; line-height: 24px; letter-spacing: .01em; }
  & .dsh-tasks-card[data-stage="done"] .dsh-tasks-card-title { color: var(--dsh-tasks-muted); text-decoration-color: color-mix(in srgb, var(--dsh-tasks-muted) 65%, transparent); }
  & :is(.dsh-tasks-card-brief, .dsh-tasks-card-meta, .dsh-tasks-card-state, .dsh-tasks-menu-label, .dsh-tasks-field-hint, .dsh-tasks-draft-hint, .dsh-tasks-optional, .dsh-tasks-detail-grid dt) { color: var(--dsh-tasks-muted); }
  & .dsh-tasks-card-brief { margin-top: 7px; line-height: 1.75; }
  & .dsh-tasks-card-meta { font-family: inherit; font-size: 11px; padding-top: 4px; }
  & .dsh-tasks-card-state { margin: 10px 0 5px; gap: 7px; flex-wrap: wrap; }
  & .dsh-tasks-status-label { display: inline-flex; align-items: center; gap: 5px; padding: 2px 7px; min-height: 18px; border: 1px solid color-mix(in srgb, currentColor 32%, transparent); border-radius: 4px 2px 5px 2px; color: var(--dsh-tasks-muted); background: var(--dsh-paper-sheet); }
  & [data-task-status="running"] .dsh-tasks-status-label { color: var(--dsh-paper-info); background: var(--dsh-paper-infoSoft); }
  & :is([data-task-status="approval"], [data-task-status="question"]) .dsh-tasks-status-label { color: var(--dsh-paper-warning); background: var(--dsh-paper-warningSoft); }
  & [data-task-status="error"] .dsh-tasks-status-label { color: var(--dsh-paper-danger); background: var(--dsh-paper-dangerSoft); }
  & [data-task-status="idle"] .dsh-tasks-status-label { color: var(--dsh-paper-success); background: var(--dsh-paper-successSoft); }
  & .dsh-tasks-dot { border-color: currentColor; width: 6px; height: 6px; }
  & :is(.dsh-tasks-primary, .dsh-tasks-secondary, .dsh-tasks-retry) { min-height: 30px; height: auto; box-sizing: border-box; padding: 4px 10px; border: 1px solid var(--dsh-tasks-line); border-radius: 3px 5px 2px 4px; color: var(--dsh-tasks-ink); background: var(--dsh-tasks-paper); box-shadow: 1px 1px 0 color-mix(in srgb, var(--dsh-tasks-line) 55%, transparent); }
  & .dsh-tasks-primary { background: var(--dsh-tasks-highlight); border-color: var(--dsh-paper-warning); font-weight: 600; }
  & :is(.dsh-tasks-primary, .dsh-tasks-secondary, .dsh-tasks-retry):hover:not(:disabled) { background: color-mix(in srgb, var(--dsh-tasks-highlight) 40%, var(--dsh-tasks-paper)); opacity: 1; }
  & .dsh-tasks-card-buttons { flex-wrap: wrap; border-top: 1px dashed var(--dsh-tasks-rule); padding-top: 10px; }
  & .dsh-tasks-icon-button { color: var(--dsh-tasks-muted); min-width: 26px; min-height: 26px; }
  & .dsh-tasks-icon-button:hover { color: var(--dsh-tasks-ink); background: color-mix(in srgb, var(--dsh-tasks-highlight) 35%, transparent); }
  & .dsh-tasks-card-actions > summary { opacity: 1; width: 24px; height: 24px; }
  & .dsh-tasks-search { color: var(--dsh-tasks-ink); background: var(--dsh-tasks-paper); border: 1px solid var(--dsh-tasks-line); height: 32px; border-radius: 3px 5px 2px 4px; }
  & .dsh-tasks-search-wrap > .dsh-tasks-icon { color: var(--dsh-tasks-muted); top: 9px; }
  & :is(.dsh-tasks-search, .dsh-tasks-fields input, .dsh-tasks-fields textarea)::placeholder { color: var(--dsh-tasks-muted); opacity: 1; }
  & .dsh-tasks-colfoot { border-top: 1px solid var(--dsh-tasks-rule); padding: 10px 12px; }
  & .dsh-tasks-add { color: var(--dsh-tasks-muted); border: 1px dashed var(--dsh-tasks-line); min-height: 30px; border-radius: 3px; }
  & .dsh-tasks-add:hover { color: var(--dsh-tasks-ink); background: var(--dsh-tasks-paper); }
  & .dsh-tasks-empty { padding: 38px 4px; line-height: 1.8; color: var(--dsh-tasks-muted); }
  & .dsh-tasks-empty::before { content: ''; display: block; width: 42px; height: 55px; margin: 0 auto 20px; border: 1px solid var(--dsh-tasks-line); transform: rotate(-5deg); background: repeating-linear-gradient(0deg, transparent 0 10px, var(--dsh-tasks-rule) 10px 11px), var(--dsh-tasks-paper); box-shadow: 3px 3px 0 color-mix(in srgb, var(--dsh-tasks-line) 20%, transparent); }
  & .dsh-tasks-attention { margin-top: 14px !important; padding: 10px 14px; background: var(--dsh-paper-warningSoft); border: 1px solid var(--dsh-paper-warning); border-radius: 1px 4px 2px 1px; color: var(--dsh-tasks-ink); box-shadow: 0 2px 3px var(--dsh-tasks-shadow); }
  & .dsh-tasks-attention summary { min-height: 24px; cursor: pointer; }
  & .dsh-tasks-footnote { padding: 0 24px 13px; color: var(--dsh-paper-muted); }
  & .dsh-tasks-menu { color: var(--dsh-tasks-ink); background: var(--dsh-tasks-paper); border-color: var(--dsh-tasks-line); border-radius: 2px 4px 1px 3px; }
  & .dsh-tasks-menu button:hover { background: var(--dsh-tasks-highlight); }
  & .dsh-tasks-dialog { background-color: var(--dsh-tasks-paper); background-image: var(--dsh-tasks-slip); background-size: 128px 128px; color: var(--dsh-tasks-ink); border: 1px solid var(--dsh-tasks-line); border-radius: 2px 6px 2px 3px; }
  & .dsh-tasks-dialog::backdrop { background: rgb(24 23 21 / 22%); }
  & .dsh-tasks-dialog-head h2 { background: linear-gradient(transparent 55%, var(--dsh-tasks-highlight) 55% 90%, transparent 90%); width: fit-content; }
  & .dsh-tasks-dialog-head p { color: var(--dsh-tasks-muted); }
  & .dsh-tasks-form-actions { border-color: var(--dsh-tasks-rule); }
  & :is(.dsh-tasks-fields input, .dsh-tasks-fields textarea, .dsh-tasks-stage) { color: var(--dsh-tasks-ink); background: var(--dsh-tasks-paper); border-color: var(--dsh-tasks-line); border-radius: 3px 5px 2px 4px; }
  & :is(input, textarea, select, button, summary):focus-visible { outline: 2px solid var(--dsh-tasks-focus); outline-offset: 3px; }
  & :is(input, textarea, .dsh-tasks-select-trigger):focus { outline: none; box-shadow: none; border-color: var(--dsh-tasks-focus); }
  & .dsh-tasks-menu .dsh-tasks-danger, & .dsh-tasks-danger { color: var(--dsh-paper-danger); }
  & .dsh-tasks-menu .dsh-tasks-danger { border-top: 1px dashed var(--dsh-tasks-rule); margin-top: 5px; padding-top: 10px; }
  & .dsh-tasks-danger.dsh-tasks-primary { background: var(--dsh-paper-dangerSoft); border-color: var(--dsh-paper-danger); }
  & .dsh-tasks-delete-title { font-weight: 600; overflow-wrap: anywhere; }
  & .dsh-tasks-filter .dsh-tasks-menu { min-width: 220px; max-width: calc(100vw - 40px); }
  & button:disabled { opacity: .55; box-shadow: none; cursor: default; }
  @media (max-width: 1100px) { & .dsh-tasks-toolbar { gap: 8px; } & .dsh-tasks-search { width: 185px; } }
  @media (max-width: 620px) {
    & .dsh-tasks-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; margin: 8px 8px 0; padding: 10px; gap: 8px; }
    & .dsh-tasks-heading { grid-area: 1 / 1; }
    & .dsh-tasks-filter { grid-area: 2 / 3; justify-self: end; }
    & .dsh-tasks-toolbar > .dsh-tasks-icon-button { grid-area: 1 / 2; }
    & .dsh-tasks-toolbar > .dsh-tasks-primary { grid-area: 1 / 3; }
    & .dsh-tasks-toolbar > .dsh-tasks-spacer { display: none; }
    & .dsh-tasks-search-wrap { grid-area: 2 / 1 / 3 / 3; width: 100%; }
    & .dsh-tasks-search { width: 100%; box-sizing: border-box; }
    & .dsh-tasks-title { font-size: 18px; }
    & .dsh-tasks-board { padding: 25px 12px 14px; gap: 18px; }
    & .dsh-tasks-paper-note { margin: 12px 16px 0; }
    & .dsh-tasks-footnote { padding: 0 12px 12px; }
  }
  @media (pointer: coarse) { & :is(button, summary, select, .dsh-tasks-search) { min-height: 44px; } & .dsh-tasks-card-actions > summary { min-width: 44px; } }
  @media (prefers-reduced-motion: reduce) { & * { transition: none; } }
  @media (forced-colors: active) { & { background: Canvas; color: CanvasText; } & :is(.dsh-tasks-toolbar, .dsh-tasks-col, .dsh-tasks-card, .dsh-tasks-dialog, .dsh-tasks-status-label, .dsh-tasks-attention) { background: Canvas; color: CanvasText; border: 1px solid CanvasText; box-shadow: none; } & :is(.dsh-tasks-col, .dsh-tasks-colname)::before { display: none; } & :is(button, input, textarea, select, summary):focus-visible { outline-color: Highlight; } }
}
`

    const PAPER_DARK_CSS = 'body[data-ds-dark-theme][data-dsh-paper-theme="paper"] .dsh-tasks-root { --dsh-tasks-texture-blend: soft-light; }'

    function avalanche(h) {
      h ^= h >>> 16
      h = Math.imul(h, 0x85ebca6b)
      h ^= h >>> 13
      h = Math.imul(h, 0xc2b2ae35)
      h ^= h >>> 16
      return h >>> 0
    }

    // String-only adaptation of hashSeed: task ID + role is stable across mounts.
    function paperSeed(s) {
      let hash = 0x811c9dc5
      for (let i = 0; i < s.length; i++) {
        hash ^= s.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
      }
      return avalanche(hash) || 0x9e3779b9
    }

    // No layout reads, observer, animation loop or cross-task cache.
    function PaperFrame({ seed, style, children, ...props }) {
      const value = paperSeed(seed + ':paper')
      return h('article', { ...props, style: {
        '--dsh-tasks-paper-x': -(value % 240) + 'px',
        '--dsh-tasks-paper-y': -((value >>> 11) % 240) + 'px', ...style,
      } }, children)
    }

    function TaskButton({ type = 'button', children, ...props }) {
      return h('button', { type, ...props }, children)
    }

    /** Existing menu semantics, with outside-pointer/focus dismissal while open. */
    class Dropdown extends React.Component {
      detach = () => {
        window.document.removeEventListener('pointerdown', this.outside, true)
        window.document.removeEventListener('focusin', this.outside, true)
        window.removeEventListener('blur', this.close)
      }
      close = () => { if (this.node) this.node.open = false; this.detach() }
      outside = event => { if (!this.node.contains(event.target)) this.close() }
      componentWillUnmount() { this.detach() }
      render() {
        const { children, onToggle, onKeyDown, ...props } = this.props
        return h('details', { ...props, ref: node => { this.node = node },
          onToggle: event => {
            this.detach()
            if (event.currentTarget.open) {
              for (const other of this.node.closest('.dsh-tasks-root').querySelectorAll('details[data-dismiss-menu][open]')) {
                if (other !== this.node) other.open = false
              }
              window.document.addEventListener('pointerdown', this.outside, true)
              window.document.addEventListener('focusin', this.outside, true)
              window.addEventListener('blur', this.close)
            }
            onToggle?.(event)
          },
          'data-dismiss-menu': '',
          onBlur: event => { if (!event.currentTarget.contains(event.relatedTarget)) this.close() },
          onKeyDown: event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(); this.node.querySelector('summary').focus() }
            else onKeyDown?.(event)
          },
        }, children)
      }
    }

    let selectSerial = 0
    /** Paper listbox; the browser popover layer avoids clipping inside dialogs. */
    class PaperSelect extends React.Component {
      constructor(props) {
        super(props)
        this.state = { open: false, active: -1 }
        this.id = 'dsh-tasks-select-' + ++selectSerial
      }
      options() {
        const rows = []
        const visit = (children, group) => React.Children.forEach(children, child => {
          if (!React.isValidElement(child)) return
          if (child.type === 'optgroup') visit(child.props.children, child.props.label)
          else if (child.type === 'option') rows.push({ value: String(child.props.value), label: child.props.children, disabled: child.props.disabled, group })
        })
        visit(this.props.children)
        return rows
      }
      componentDidMount() {
        this.panel.addEventListener('toggle', this.toggled)
      }
      componentWillUnmount() {
        this.panel.removeEventListener('toggle', this.toggled)
        this.detach()
      }
      detach = () => {
        window.removeEventListener('resize', this.close)
        window.removeEventListener('blur', this.close)
        window.document.removeEventListener('scroll', this.scrolled, true)
      }
      toggled = event => {
        const open = event.newState === 'open'
        this.setState({ open })
        this.detach()
        if (open) {
          window.addEventListener('resize', this.close)
          window.addEventListener('blur', this.close)
          window.document.addEventListener('scroll', this.scrolled, true)
        }
      }
      scrolled = event => { if (!this.panel.contains(event.target)) this.close() }
      close = () => { this.panel?.hidePopover(); this.detach(); this.setState({ open: false }) }
      open = (last = false) => {
        if (this.trigger.matches(':disabled')) return
        const rows = this.options()
        const selected = rows.findIndex(row => row.value === String(this.props.value ?? ''))
        const active = selected >= 0 ? selected : last ? rows.findLastIndex(row => !row.disabled) : rows.findIndex(row => !row.disabled)
        const rect = this.trigger.getBoundingClientRect()
        const below = window.innerHeight - rect.bottom - 12, above = rect.top - 12
        const upward = below < 180 && above > below
        Object.assign(this.panel.style, { width: Math.min(rect.width, window.innerWidth - 24) + 'px',
          left: Math.max(12, Math.min(rect.left, window.innerWidth - rect.width - 12)) + 'px',
          top: upward ? 'auto' : rect.bottom + 5 + 'px', bottom: upward ? window.innerHeight - rect.top + 5 + 'px' : 'auto',
          maxHeight: Math.max(60, Math.min(280, upward ? above : below)) + 'px' })
        this.panel.showPopover()
        this.setState({ open: true, active }, this.reveal)
      }
      reveal = () => { this.panel.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }) }
      choose = index => {
        const row = this.options()[index]
        if (!row || row.disabled || this.trigger.matches(':disabled')) return
        this.props.onChange?.({ target: { value: row.value } })
        this.close()
        this.trigger.focus()
      }
      keyDown = event => {
        const rows = this.options(), key = event.key
        if (key === 'Escape' && this.state.open) { event.preventDefault(); event.stopPropagation(); this.close(); return }
        if (key === 'Tab') { this.close(); return }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(key)) {
          event.preventDefault()
          if (!this.state.open) { this.open(key === 'ArrowUp' || key === 'End'); return }
          if (key === 'Enter' || key === ' ') { this.choose(this.state.active); return }
          const enabled = rows.map((row, index) => row.disabled ? -1 : index).filter(index => index >= 0)
          const position = enabled.indexOf(this.state.active)
          const active = key === 'Home' ? enabled[0] : key === 'End' ? enabled.at(-1)
            : enabled[(position + (key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length]
          this.setState({ active }, this.reveal)
        } else if (key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
          event.preventDefault()
          const now = Date.now()
          this.search = now - (this.typedAt || 0) < 700 ? (this.search || '') + key : key
          this.typedAt = now
          const active = rows.findIndex(row => !row.disabled && String(row.label).toLocaleLowerCase().startsWith(this.search.toLocaleLowerCase()))
          if (active >= 0) { if (!this.state.open) this.open(); this.setState({ active }, this.reveal) }
        }
      }
      render() {
        const { value = '', name, disabled, onChange, 'aria-label': label } = this.props
        const rows = this.options(), selected = rows.find(row => row.value === String(value))
        return h('div', { className: 'dsh-tasks-select', onBlur: event => {
          if (!event.currentTarget.contains(event.relatedTarget)) this.close()
        } },
        name ? h('input', { type: 'hidden', name, value, onChange }) : null,
        h('button', { type: 'button', className: 'dsh-tasks-select-trigger', role: 'combobox', 'aria-label': label,
          'aria-haspopup': 'listbox', 'aria-expanded': this.state.open, 'aria-controls': this.id,
          'aria-activedescendant': this.state.open && this.state.active >= 0 ? this.id + '-' + this.state.active : undefined,
          disabled, ref: node => { this.trigger = node }, onKeyDown: this.keyDown,
          onClick: () => { if (this.state.open) this.close(); else this.open() },
        }, selected?.label ?? '', h(Icon, { name: 'chevronDown', size: 14 })),
        h('div', { id: this.id, className: 'dsh-tasks-select-list', role: 'listbox', 'aria-label': label,
          popover: 'auto', ref: node => { this.panel = node } },
          rows.map((row, index) => h(React.Fragment, { key: row.value },
            row.group && row.group !== rows[index - 1]?.group ? h('div', { className: 'dsh-tasks-select-group', role: 'presentation' }, row.group) : null,
            h('div', { id: this.id + '-' + index, role: 'option', className: 'dsh-tasks-select-option',
              'aria-selected': row.value === String(value), 'aria-disabled': !!row.disabled, 'data-active': this.state.active === index,
              onMouseMove: () => { if (this.state.active !== index) this.setState({ active: index }) },
              onPointerDown: event => event.preventDefault(),
              onClick: event => { event.preventDefault(); event.stopPropagation(); this.choose(index) },
            }, h('span', { className: 'dsh-tasks-icon', 'aria-hidden': true, style: { width: 14 } }, row.value === String(value) ? h(Icon, { name: 'check', size: 14 }) : null), row.label))))
        )
      }
    }

    function StatusBadge({ status, label, time }) {
      return h('div', { className: 'dsh-tasks-card-state', 'data-task-status': status },
        h('span', { className: 'dsh-tasks-status-label' },
          h('span', { className: 'dsh-tasks-dot', 'aria-hidden': true,
            style: { background: ({ running: 'var(--dsw-alias-state-business-primary)', approval: '#ef4444', question: '#ef4444', error: '#f59e0b' })[status] } }), label),
        h('span', { className: 'dsh-tasks-status-time' }, '· ' + time))
    }

    /** Validate the public fields needed for rendering and revision updates. */
    function isModel(model) {
      return model && typeof model === 'object' && typeof model.provider === 'string'
        && typeof model.model === 'string' && (model.reasoningEffort === undefined
          || typeof model.reasoningEffort === 'string')
    }
    const isStatus = value => value && typeof value.sessionId === 'string' && RUNTIME.includes(value.status)
    const unfinishedLaunch = task => task.launch && !['complete', 'abandoned'].includes(task.launch.phase)
    const runtimeOf = (task, statuses) => task.activeSessionId
      ? statuses[task.id]?.sessionId === task.activeSessionId ? statuses[task.id].status : 'unknown'
      : 'notStarted'
    function isTask(task) {
      return task !== null && typeof task === 'object'
        && typeof task.id === 'string' && task.id.length > 0
        && Number.isSafeInteger(task.revision) && task.revision > 0
        && typeof task.title === 'string' && task.title.trim().length > 0
        && (task.brief === undefined || typeof task.brief === 'string')
        && (task.workspaceId === undefined || typeof task.workspaceId === 'string')
        && (task.model === undefined || isModel(task.model))
        && (task.activeSessionId === undefined || typeof task.activeSessionId === 'string')
        && (task.previousSessionIds === undefined || (Array.isArray(task.previousSessionIds) && task.previousSessionIds.every(id => typeof id === 'string')))
        && (task.launch === undefined || (typeof task.launch?.sessionId === 'string'
          && ['prepared', 'created', 'sending', 'complete', 'abandoned'].includes(task.launch.phase)
          && typeof task.launch.input?.requestId === 'string' && typeof task.launch.input?.content === 'string'))
        && Object.hasOwn(STAGES, task.stage)
        && Number.isFinite(task.position) && task.position >= 0
        && task.position <= Number.MAX_SAFE_INTEGER
        && typeof task.createdAt === 'string' && Number.isFinite(Date.parse(task.createdAt))
        && typeof task.updatedAt === 'string' && Number.isFinite(Date.parse(task.updatedAt))
    }

    /** Only the draft is stored in this tab; Host remains the source of tasks. */
    function readDraft() {
      try {
        const draft = JSON.parse(window.sessionStorage.getItem(DRAFT_KEY))
        if (!draft || typeof draft.title !== 'string' || typeof draft.brief !== 'string') return
        if ((draft.workspaceId !== undefined && typeof draft.workspaceId !== 'string')
          || (draft.model !== undefined && !isModel(draft.model))
          || (draft.stage !== undefined && !Object.hasOwn(STAGES, draft.stage))) return
        const input = draft.retryInput
        if (input && (typeof input.requestId !== 'string'
          || !/^[A-Za-z0-9._~-]{1,128}$/.test(input.requestId)
          || typeof input.title !== 'string' || typeof input.brief !== 'string'
          || input.title !== draft.title.trim() || input.brief !== draft.brief
          || input.workspaceId !== (draft.workspaceId || undefined)
          || JSON.stringify(input.model) !== JSON.stringify(draft.model)
          || (input.stage ?? 'todo') !== (draft.stage ?? 'todo'))) return
        return {
          title: draft.title, brief: draft.brief, stage: draft.stage || 'todo',
          workspaceId: draft.workspaceId || '', model: draft.model, retryInput: input || undefined,
        }
      } catch { /* Session storage may be unavailable; in-memory retry still works. */ }
    }

    /**
     * Own all RPCs, one SSE connection, and the stable slot source. Refresh and
     * writes never overlap; list responses cannot replace newer stream events.
     * Draft/pending state lives here so leaving the panel cannot lose a retry.
     */
    function createTaskList(connection, navigate) {
      const draft = readDraft()
      let savedLaunch
      try {
        const value = JSON.parse(window.sessionStorage?.getItem(LAUNCH_KEY) || 'null')
        if (value && typeof value.taskId === 'string' && typeof value.retryInput?.requestId === 'string'
          && typeof value.retryInput.content === 'string') savedLaunch = { ...value, open: true, pending: false, errorCode: 'tasks/launch-unknown' }
      } catch { /* Storage may be disabled or an old draft malformed. */ }
      let snapshot = {
        deletion: undefined,
        status: 'loading', tasks: [], errorCode: undefined, hasLoaded: false, sync: 'connecting',
        query: '', stages: {}, workspaceFilter: '', collapsed: {}, showAllDone: false, detailId: undefined,
        statuses: {}, launchForm: savedLaunch,
        options: { status: 'idle', workspaces: [], groups: [], workspaceStatus: 'unavailable', modelStatus: 'unavailable', modelFailures: 0 },
        form: {
          open: !!draft, title: draft?.title || '', brief: draft?.brief || '', pending: false,
          stage: draft?.stage || 'todo', workspaceId: draft?.workspaceId || '', model: draft?.model,
          retryInput: draft?.retryInput,
          errorCode: draft?.retryInput ? 'tasks/create-unknown' : undefined,
        },
      }
      let request
      let optionsRequest
      let disposed = false
      let formOpener
      let streamController
      let reconnectTimer
      let syncStarted = false
      let streamVersion = 0
      let retryDelay = 1000
      let currentStreamId
      let streamSequence = -1
      const pendingCommits = new Map()
      let suspended = false
      const listeners = new Set()
      const controllers = new Set()

      function changeLaunch(changes) {
        const launchForm = { ...snapshot.launchForm, ...changes }
        try {
          if (launchForm.retryInput) window.sessionStorage?.setItem(LAUNCH_KEY, JSON.stringify(launchForm))
          else window.sessionStorage?.removeItem(LAUNCH_KEY)
        } catch { /* Host receipts remain recoverable when tab storage is unavailable. */ }
        publish({ ...snapshot, launchForm })
      }

      function openLaunch(taskId) {
        if (snapshot.launchForm?.pending || snapshot.launchForm?.retryInput) {
          changeLaunch({ open: true })
          return
        }
        const task = snapshot.tasks.find(row => row.id === taskId)
        if (!task) return
        const unfinished = unfinishedLaunch(task) ? task.launch : undefined
        publish({ ...snapshot, detailId: undefined, launchForm: {
          taskId, open: true, pending: false, replaceActive: false,
          content: task.title + (task.brief ? '\n\n' + task.brief : ''),
          workspaceId: task.workspaceId || '', model: task.model, agentPreset: '',
          ...(unfinished ? { ...unfinished.input, retryInput: unfinished.input, resume: true } : {}),
        } })
        void loadOptions()
      }

      function openSession(sessionId) {
        try {
          navigate(sessionId)
          publish({ ...snapshot, detailId: undefined, navigationError: undefined })
          changeLaunch({ open: false, errorCode: undefined })
        } catch { publish({ ...snapshot, navigationError: 'tasks/navigation-failed' }) }
      }

      async function abandonLaunch() {
        const task = snapshot.tasks.find(row => row.id === snapshot.launchForm?.taskId)
        if (!task?.launch || snapshot.launchForm.pending || !writable()) return
        changeLaunch({ pending: true, errorCode: undefined })
        const host = currentStreamId
        try {
          const result = await call('abandon-launch', { taskId: task.id, expectedRevision: task.revision, requestId: task.launch.input.requestId })
          if (disposed) return
          if (host && host !== currentStreamId) throw new Error('Host changed')
          if (!result.ok) { changeLaunch({ pending: false, errorCode: result.error.code }); blockUncertain(result.error.code); return }
          if (!isTask(result.value?.task)) throw new TypeError('Invalid task')
          publish({ ...snapshot, tasks: upsert(result.value.task, result) })
          changeLaunch({ pending: false, retryInput: undefined, open: false })
        } catch { if (!disposed) changeLaunch({ pending: false, errorCode: 'tasks/launch-unknown' }) }
      }

      async function launchTask() {
        const form = snapshot.launchForm
        if (!form || form.pending || !writable()) return
        const task = snapshot.tasks.find(row => row.id === form.taskId)
        if (!task) return
        const input = form.retryInput || {
          taskId: task.id, expectedRevision: task.revision,
          requestId: Array.from(window.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''),
          content: form.content, replaceActive: form.replaceActive,
          ...(form.workspaceId ? { workspaceId: form.workspaceId } : {}),
          ...(form.model ? { model: form.model } : {}),
          ...(form.agentPreset ? { agentPreset: form.agentPreset } : {}),
        }
        changeLaunch({ pending: true, retryInput: input, errorCode: undefined })
        const host = currentStreamId
        try {
          const result = await call(form.resume ? 'resume-launch' : 'launch', form.resume ? { taskId: task.id, requestId: input.requestId } : input)
          if (disposed) return
          if (host && host !== currentStreamId) throw new Error('Host changed')
          if (!result.ok) {
            if (result.error.code === 'tasks/launch-abandoned') {
              changeLaunch({ pending: false, retryInput: undefined, open: false })
              return
            }
            const knownRejection = ['tasks/revision-conflict', 'tasks/workspace-unavailable', 'tasks/model-unavailable', 'tasks/preset-unavailable', 'tasks/session-busy', 'tasks/session-exists', 'tasks/bad-request'].includes(result.error.code)
            const persisted = snapshot.tasks.find(row => row.id === task.id)?.launch?.input.requestId === input.requestId
            changeLaunch({ pending: false, errorCode: result.error.code, retryInput: knownRejection && !persisted ? undefined : input })
            blockUncertain(result.error.code)
            return
          }
          if (!isTask(result.value?.task) || typeof result.value.sessionId !== 'string') throw new TypeError('Invalid launch result')
          publish({ ...snapshot, tasks: upsert(result.value.task, result) })
          changeLaunch({ pending: false, retryInput: undefined, open: false })
          openSession(result.value.sessionId)
        } catch {
          if (!disposed) changeLaunch({ pending: false, errorCode: 'tasks/launch-unknown' })
        }
      }

      function saveDraft(form) {
        try {
          if (!form.title && !form.brief && !form.retryInput && !form.workspaceId && !form.model) {
            window.sessionStorage.removeItem(DRAFT_KEY)
          } else {
            window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
              title: form.title, brief: form.brief, retryInput: form.retryInput,
              stage: form.stage, workspaceId: form.workspaceId, model: form.model,
            }))
          }
        } catch { /* Keep the in-memory draft if storage is disabled/full. */ }
      }

      async function loadOptions() {
        if (disposed || optionsRequest) return
        optionsRequest = true
        publish({ ...snapshot, options: { ...snapshot.options, status: 'loading' } })
        try {
          const result = await call('options', {})
          if (disposed) return
          const value = result.ok ? result.value : undefined
          if (!value || !Array.isArray(value.workspaces) || !Array.isArray(value.groups)
            || !value.workspaces.every(row => typeof row.id === 'string' && typeof row.title === 'string' && typeof row.path === 'string')
            || !value.groups.every(group => typeof group.id === 'string' && typeof group.name === 'string'
              && Array.isArray(group.models) && group.models.every(model => typeof model.id === 'string' && typeof model.name === 'string'))
            || !['ready', 'error', 'unavailable'].includes(value.workspaceStatus)
            || !['ready', 'error', 'unavailable'].includes(value.modelStatus)) throw new TypeError('Invalid task options')
          publish({ ...snapshot, options: { ...value, status: 'ready' } })
        } catch {
          if (!disposed) publish({ ...snapshot, options: { ...snapshot.options, status: 'error', workspaceStatus: 'error', modelStatus: 'error' } })
        } finally { optionsRequest = undefined }
      }

      function publish(next) {
        snapshot = next
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch (error) {
            console.error('[tavlo-tasks] task list listener threw:', error)
          }
        }
      }

      function changeForm(changes) {
        if (disposed) return
        const form = { ...snapshot.form, ...changes }
        saveDraft(form)
        publish({ ...snapshot, form })
      }

      const writing = () => snapshot.form.pending || snapshot.launchForm?.pending || snapshot.deletion?.pending || Object.values(snapshot.stages).some(row => row.pending)
      const writable = () => !disposed && snapshot.status === 'ready' && request === undefined

      async function call(operation, input) {
        const controller = new AbortController()
        controllers.add(controller)
        const timer = setTimeout(() => controller.abort(), 30000)
        controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
        try {
          const result = await connection.rpc.call('/api', 'dsh-plugin-tasks/rpc', {
            operation, input,
          }, controller.signal)
          if (controller.signal.aborted) throw new Error('Request cancelled')
          if (!result || typeof result.ok !== 'boolean'
            || (!result.ok && typeof result.error?.code !== 'string')) {
            throw new TypeError('Malformed task RPC result')
          }
          return result
        } finally {
          clearTimeout(timer)
          controllers.delete(controller)
        }
      }

      function rememberCommit(result, taskId, task) {
        if (!result || typeof result.streamId !== 'string' || !Number.isSafeInteger(result.sequence)) return
        if (currentStreamId === result.streamId && result.sequence <= streamSequence) return
        pendingCommits.set(taskId, { streamId: result.streamId, sequence: result.sequence, task })
        // A prolonged disconnected feed must not retain unlimited receipts.
        // Abort any queued old baseline and reconnect to a fresh authoritative one.
        if (pendingCommits.size > 1024) { pendingCommits.clear(); streamController?.abort() }
      }

      function upsert(task, result) {
        const current = snapshot.tasks.find(previous => previous.id === task.id)
        if (!current && result && result.streamId === currentStreamId && result.sequence <= streamSequence) return snapshot.tasks
        rememberCommit(result, task.id, task)
        // A replayed creation can return an existing record while another card
        // mutation is in flight; responses may arrive out of commit order.
        if (current && current.revision > task.revision) return snapshot.tasks
        if (!snapshot.hasLoaded) return snapshot.tasks
        const tasks = snapshot.tasks.filter(previous => previous.id !== task.id)
        tasks.push(task)
        return tasks
      }

      function removeTask(taskId, result) {
        rememberCommit(result, taskId, null)
        const stages = { ...snapshot.stages }, statuses = { ...snapshot.statuses }
        delete stages[taskId]; delete statuses[taskId]
        if (snapshot.launchForm?.taskId === taskId) {
          try { window.sessionStorage?.removeItem(LAUNCH_KEY) } catch { /* Keep removal usable without storage. */ }
        }
        publish({ ...snapshot, tasks: snapshot.tasks.filter(task => task.id !== taskId), stages, statuses,
          detailId: snapshot.detailId === taskId ? undefined : snapshot.detailId,
          deletion: snapshot.deletion?.taskId === taskId ? undefined : snapshot.deletion,
          launchForm: snapshot.launchForm?.taskId === taskId ? undefined : snapshot.launchForm })
      }

      function blockUncertain(code) {
        if (code !== 'tasks/persistence-unknown') return
        publish({ ...snapshot, status: 'error', tasks: [], hasLoaded: false, errorCode: code })
      }

      function receiveEvent(event, baseline, sequence) {
        if (!event || !Number.isSafeInteger(event.sequence) || event.sequence < 0
          || typeof event.streamId !== 'string' || !event.streamId) throw new TypeError('Invalid task event')
        if (!baseline) {
          if (event.type !== 'snapshot' || !Array.isArray(event.tasks) || !event.tasks.every(isTask)
            || new Set(event.tasks.map(task => task.id)).size !== event.tasks.length) throw new TypeError('Invalid task baseline')
          streamVersion++
          const tasks = new Map(event.tasks.map(task => [task.id, task]))
          // A committed RPC may arrive before an already queued baseline.
          // A new Host/store identity makes its full snapshot authoritative.
          if (!currentStreamId || currentStreamId === event.streamId) {
            for (const task of snapshot.tasks) {
              if (tasks.has(task.id) && tasks.get(task.id).revision < task.revision) tasks.set(task.id, task)
            }
          }
          for (const [id, commit] of pendingCommits) {
            if (commit.streamId !== event.streamId || commit.sequence <= event.sequence) { pendingCommits.delete(id); continue }
            if (commit.task) tasks.set(id, commit.task)
            else tasks.delete(id)
          }
          currentStreamId = event.streamId
          const statuses = event.statuses ?? {}
          if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses) || !Object.values(statuses).every(isStatus)) throw new TypeError('Invalid task statuses')
          publish({ ...snapshot, tasks: [...tasks.values()], statuses, hasLoaded: true, status: 'ready', errorCode: undefined, sync: 'live' })
          if (snapshot.launchForm && !tasks.has(snapshot.launchForm.taskId)) removeTask(snapshot.launchForm.taskId)
          if (snapshot.deletion && !tasks.has(snapshot.deletion.taskId)) removeTask(snapshot.deletion.taskId)
          if (event.tasks.some(task => task.workspaceId || task.model)) void loadOptions()
        } else {
          if (event.streamId !== currentStreamId || event.sequence !== sequence + 1) throw new TypeError('Task event gap')
          if (event.type === 'upsert' && isTask(event.task)) {
            streamVersion++
            const pending = pendingCommits.get(event.task.id)
            if (!pending || pending.streamId !== event.streamId || pending.sequence <= event.sequence) publish({ ...snapshot, tasks: upsert(event.task), sync: 'live' })
            if ((event.task.workspaceId || event.task.model) && snapshot.options.status !== 'ready') void loadOptions()
          } else if (event.type === 'remove' && typeof event.taskId === 'string' && Number.isSafeInteger(event.revision)) {
            streamVersion++
            removeTask(event.taskId)
          } else if (event.type === 'status' && typeof event.taskId === 'string' && isStatus(event.status)) {
            publish({ ...snapshot, statuses: { ...snapshot.statuses, [event.taskId]: event.status } })
          } else if (event.type === 'unavailable' && event.code === 'tasks/persistence-unknown') {
            streamVersion++
            blockUncertain(event.code)
            throw new Error('Task storage must be reopened')
          } else throw new TypeError('Invalid task change')
        }
        streamSequence = event.sequence
        for (const [id, commit] of pendingCommits) if (commit.streamId === event.streamId && commit.sequence <= event.sequence) pendingCommits.delete(id)
        return event.sequence
      }

      async function connectEvents() {
        if (disposed || suspended || streamController) return
        const startedAt = Date.now()
        const controller = new AbortController()
        streamController = controller
        let reader
        let timeout
        let baseline = false
        let sequence
        // The Host sends a heartbeat at most every 60s. A silent half-open
        // connection must eventually fetch a fresh baseline as well.
        const keepAlive = () => {
          clearTimeout(timeout)
          timeout = setTimeout(() => controller.abort(), baseline ? 90000 : 30000)
        }
        keepAlive()
        try {
          const response = await window.fetch('api/dsh-plugin-tasks/events', {
            method: 'GET', credentials: 'same-origin', cache: 'no-store',
            headers: { accept: 'text/event-stream' }, signal: controller.signal,
          })
          if (disposed || controller.signal.aborted) {
            await response.body?.cancel()
            return
          }
          if (!response.ok || response.headers.get('content-type')?.split(';', 1)[0] !== 'text/event-stream'
            || !response.body) throw new Error('Task event stream unavailable')
          reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffered = ''
          while (!disposed && !controller.signal.aborted) {
            const { done, value } = await reader.read()
            if (done) throw new Error('Task event stream ended')
            if (disposed || controller.signal.aborted) return
            if (baseline) keepAlive()
            buffered += decoder.decode(value, { stream: true })
            // A wire limit independent of the configurable Host queue bound.
            if (buffered.length > 268435456) throw new Error('Task event frame too large')
            let separator
            while (!disposed && !controller.signal.aborted && (separator = /\r?\n\r?\n/.exec(buffered))) {
              const frame = buffered.slice(0, separator.index)
              buffered = buffered.slice(separator.index + separator[0].length)
              const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
                .map(line => line.slice(5).replace(/^ /, '')).join('\n')
              if (!data) continue
              sequence = receiveEvent(JSON.parse(data), baseline, sequence)
              baseline = true
              keepAlive()
            }
          }
        } catch (error) {
          if (!disposed) publish({ ...snapshot, sync: 'offline' })
        } finally {
          clearTimeout(timeout)
          controller.abort()
          try { await reader?.cancel() } catch (error) { /* A disconnected reader is already released. */ }
          reader?.releaseLock()
          if (streamController === controller) streamController = undefined
          if (!disposed && !suspended) {
            // Short-lived connections keep backing off; a stable connection
            // resets the delay when scheduling its next recovery.
            if (baseline && Date.now() - startedAt >= 30000) retryDelay = 1000
            reconnectTimer = setTimeout(() => {
              reconnectTimer = undefined
              void connectEvents()
            }, retryDelay)
            retryDelay = Math.min(retryDelay * 2, 15000)
          }
        }
      }

      function startSync() {
        if (disposed || syncStarted) return
        syncStarted = true
        window.addEventListener?.('pagehide', pauseSync)
        window.addEventListener?.('pageshow', resumeSync)
        window.addEventListener?.('online', resumeSync)
        void connectEvents()
      }

      function pauseSync() {
        suspended = true
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
        streamController?.abort()
      }

      function resumeSync() {
        suspended = false
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
        if (!streamController) void connectEvents()
      }

      async function refresh() {
        if (disposed || request !== undefined || writing()) return
        request = true
        const version = streamVersion
        publish({ ...snapshot, status: 'loading', errorCode: undefined })
        try {
          const result = await call('list', {})
          if (disposed) return
          if (!result.ok) {
            if (streamVersion !== version && result.error.code !== 'tasks/persistence-unknown') return
            publish({ ...snapshot, status: 'error', errorCode: result.error.code })
            blockUncertain(result.error.code)
            return
          }
          if (streamVersion !== version) return
          const tasks = result.value?.tasks
          if (!Array.isArray(tasks) || !tasks.every(isTask)
            || new Set(tasks.map(task => task.id)).size !== tasks.length) {
            throw new TypeError('Invalid task list')
          }
          publish({ ...snapshot, status: 'ready', tasks, hasLoaded: true, stages: {}, errorCode: undefined })
          if (snapshot.launchForm && !tasks.some(task => task.id === snapshot.launchForm.taskId)) removeTask(snapshot.launchForm.taskId)
          if (snapshot.deletion && !tasks.some(task => task.id === snapshot.deletion.taskId)) removeTask(snapshot.deletion.taskId)
          if (tasks.some(task => task.workspaceId || task.model)) void loadOptions()
        } catch {
          if (!disposed && streamVersion === version) publish({ ...snapshot, status: 'error', errorCode: 'tasks/load-failed' })
        } finally {
          request = undefined
        }
      }

      async function create() {
        if (!writable() || snapshot.form.pending) return
        const form = snapshot.form
        if (!form.title.trim()) {
          changeForm({ errorCode: 'tasks/title-required' })
          return
        }
        const input = form.retryInput || {
          // getRandomValues also works in an HTTP GUI without a secure context.
          requestId: Array.from(window.crypto.getRandomValues(new Uint8Array(16)),
            byte => byte.toString(16).padStart(2, '0')).join(''),
          title: form.title.trim(), brief: form.brief,
          stage: form.stage,
          ...(form.workspaceId ? { workspaceId: form.workspaceId } : {}),
          ...(form.model ? { model: form.model } : {}),
        }
        // Persist the id before sending: reloading this tab after a lost response
        // replays the same canonical payload, even if the Host already committed.
        changeForm({ pending: true, retryInput: input, errorCode: undefined })
        const streamAtRequest = currentStreamId
        try {
          const result = await call('create', input)
          if (disposed) return
          if (streamAtRequest && currentStreamId !== streamAtRequest) throw new Error('Task store changed during creation')
          if (!result.ok) {
            const code = result.error.code
            const uncertain = code === 'tasks/persistence-unknown' || code === 'gateway/cancelled'
            changeForm({ pending: false, retryInput: uncertain ? input : undefined, errorCode: code })
            blockUncertain(code)
            return
          }
          const task = result.value?.task
          if (!isTask(task)) throw new TypeError('Invalid created task')
          const nextForm = { open: false, title: '', brief: '', pending: false, stage: 'todo', workspaceId: '', model: undefined, retryInput: undefined, errorCode: undefined }
          saveDraft(nextForm)
          publish({ ...snapshot, tasks: upsert(task, result), form: nextForm })
        } catch {
          if (!disposed) changeForm({ pending: false, retryInput: input, errorCode: 'tasks/create-unknown' })
        }
      }

      async function setStage(taskId, stage) {
        if (!writable() || !Object.hasOwn(STAGES, stage) || snapshot.stages[taskId]) return
        const task = snapshot.tasks.find(task => task.id === taskId)
        if (!task || task.stage === stage) return
        const row = { pending: true, stage, errorCode: undefined }
        const updateRow = changes => publish({ ...snapshot, stages: { ...snapshot.stages, [taskId]: { ...row, ...changes } } })
        updateRow({})
        const streamAtRequest = currentStreamId
        try {
          const result = await call('set-stage', { taskId, expectedRevision: task.revision, stage })
          if (disposed) return
          if (streamAtRequest && currentStreamId !== streamAtRequest) throw new Error('Task store changed during stage update')
          if (!result.ok) {
            updateRow({ pending: false, errorCode: result.error.code })
            blockUncertain(result.error.code)
            return
          }
          const updated = result.value?.task
          if (!isTask(updated) || updated.id !== taskId || updated.stage !== stage
            || updated.revision <= task.revision) throw new TypeError('Invalid updated task')
          const stages = { ...snapshot.stages }
          delete stages[taskId]
          publish({ ...snapshot, tasks: upsert(updated, result), stages })
        } catch {
          if (!disposed) updateRow({ pending: false, errorCode: 'tasks/stage-unknown' })
        }
      }

      async function deleteTask() {
        const deletion = snapshot.deletion
        if (!deletion || writing() || !writable()) return
        publish({ ...snapshot, deletion: { ...deletion, pending: true, errorCode: undefined } })
        const host = currentStreamId
        try {
          const result = await call('delete', { taskId: deletion.taskId, expectedRevision: deletion.expectedRevision })
          if (disposed || snapshot.deletion?.taskId !== deletion.taskId) return
          if (host && host !== currentStreamId) throw new Error('Task store changed')
          if (!result.ok) {
            if (result.error.code === 'tasks/not-found') { removeTask(deletion.taskId); return }
            publish({ ...snapshot, deletion: { ...deletion, pending: false, errorCode: result.error.code } })
            blockUncertain(result.error.code)
            return
          }
          if (result.value?.taskId !== deletion.taskId || !Number.isSafeInteger(result.value.revision)) throw new Error('Invalid delete result')
          removeTask(deletion.taskId, result)
        } catch {
          if (!disposed && snapshot.deletion?.taskId === deletion.taskId) publish({ ...snapshot, deletion: { ...deletion, pending: false, errorCode: 'tasks/delete-unknown' } })
        }
      }

      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          if (disposed) return () => {}
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        refresh,
        startSync,
        create,
        setStage,
        deleteTask,
        openDelete(taskId) {
          if (disposed || writing()) return
          const task = snapshot.tasks.find(row => row.id === taskId)
          if (task) publish({ ...snapshot, detailId: undefined, deletion: { taskId, title: task.title, expectedRevision: task.revision, pending: false } })
        },
        closeDelete() { if (!disposed && !snapshot.deletion?.pending) publish({ ...snapshot, deletion: undefined }) },
        openLaunch, launchTask, openSession, abandonLaunch,
        closeLaunch() { changeLaunch({ open: false }) },
        editLaunch(field, value) { if (!snapshot.launchForm?.pending && !snapshot.launchForm?.retryInput) changeLaunch({ [field]: value }) },
        loadOptions,
        setQuery(query) { if (!disposed) publish({ ...snapshot, query }) },
        setWorkspaceFilter(workspaceFilter) { if (!disposed) publish({ ...snapshot, workspaceFilter }) },
        toggleColumn(stage) { if (!disposed) publish({ ...snapshot, collapsed: { ...snapshot.collapsed, [stage]: !snapshot.collapsed[stage] } }) },
        toggleDone() { if (!disposed) publish({ ...snapshot, showAllDone: !snapshot.showAllDone }) },
        openDetails(detailId) { if (!disposed) publish({ ...snapshot, detailId }) },
        closeDetails() { if (!disposed) publish({ ...snapshot, detailId: undefined }) },
        openForm(stage = 'todo') {
          if (!snapshot.form.open) formOpener = window.document?.activeElement
          changeForm({ open: true, ...(!snapshot.form.title && !snapshot.form.retryInput ? { stage } : {}) })
          if (snapshot.options.status !== 'ready') void loadOptions()
        },
        closeForm() { changeForm({ open: false }) },
        restoreFormFocus() { if (formOpener?.isConnected) formOpener.focus() },
        editForm(field, value) {
          if (!snapshot.form.pending && !snapshot.form.retryInput && ['title', 'brief', 'workspaceId', 'model', 'stage'].includes(field)) {
            changeForm({ [field]: value, errorCode: undefined })
          }
        },
        dispose() {
          disposed = true
          pendingCommits.clear()
          clearTimeout(reconnectTimer)
          streamController?.abort()
          window.removeEventListener?.('pagehide', pauseSync)
          window.removeEventListener?.('pageshow', resumeSync)
          window.removeEventListener?.('online', resumeSync)
          for (const controller of controllers) controller.abort()
          listeners.clear()
        },
      }
    }

    /**
     * Host-token stylesheet; unmounting the component removes it.
     * @returns the style element.
     */
    function Styles() {
      return h('style', { 'data-dsh-tasks': '' }, CSS + CONTROLS_CSS + PAPER_CSS + PAPER_DARK_CSS)
    }

    /**
     * Sidebar launcher glyph.
     * @param props - host-supplied icon presentation.
     * @param props.size - requested square edge in pixels.
     * @param props.active - whether this panel is selected.
     * @returns the glyph.
     */
    function PanelIcon({ size = 18, active = false }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.75,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { opacity: active ? 1 : 0.85, display: 'block' },
        },
        h('rect', { x: 3, y: 4, width: 5, height: 12, rx: 1.2 }),
        h('rect', { x: 9.5, y: 4, width: 5, height: 16, rx: 1.2 }),
        h('rect', { x: 16, y: 4, width: 5, height: 8, rx: 1.2 }),
      )
    }

    /** Translate known failures without exposing transport/backend messages. */
    function failureText(t, code, fallback) {
      const launchCodes = {
        'tasks/launch-failed': 'launchFailed', 'tasks/launch-unknown': 'launchUnknown',
        'tasks/session-unavailable': 'sessionUnavailable', 'tasks/session-busy': 'sessionBusy',
        'tasks/session-exists': 'sessionExists', 'tasks/launch-pending': 'launchPending',
        'tasks/preset-unavailable': 'presetUnavailable', 'tasks/navigation-failed': 'navigationFailed',
        'tasks/session-archived': 'archived',
        'tasks/launch-abandoned': 'launchAbandoned',
      }
      if (launchCodes[code]) return t(launchCodes[code])
      const keys = {
        'tasks/deleted': 'taskDeleted',
        'tasks/title-required': 'titleRequired',
        'tasks/bad-request': 'badRequest',
        'tasks/limit-reached': 'limitReached',
        'tasks/request-conflict': 'requestConflict',
        'tasks/revision-conflict': 'revisionConflict',
        'tasks/persistence-unknown': 'storageUncertain',
        'tasks/create-unknown': 'createUnknown',
        'tasks/stage-unknown': 'stageUnknown',
        'tasks/workspace-unavailable': 'workspaceRejected',
        'tasks/model-unavailable': 'modelRejected',
        'tasks/options-unavailable': 'workspaceUnavailable',
      }
      return t(keys[code] || fallback)
    }

    function Icon({ name, size = 15 }) {
      const paths = {
        plus: 'M12 5v14M5 12h14',
        close: 'm6 6 12 12M18 6 6 18',
        search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
        refresh: 'M20 7v5h-5M4 17v-5h5M5 8a7 7 0 0 1 12-3l3 3M19 16a7 7 0 0 1-12 3l-3-3',
        filter: 'M4 6h16M7 12h10M10 18h4',
        folder: 'M3 7V5h7l2 2h9v13H3V7Z',
        chevron: 'm9 5 7 7-7 7',
        chevronDown: 'm6 9 6 6 6-6',
        trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
        check: 'm5 12 4 4L19 6',
        more: 'M5 12h.01M12 12h.01M19 12h.01',
      }
      return h('span', { className: 'dsh-tasks-icon', 'aria-hidden': true },
        name === 'board' ? h(PanelIcon, { size }) : h('svg', {
          width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
          strokeWidth: name === 'more' ? 4 : 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        }, h('path', { d: paths[name] })))
    }

    /** Native top-layer dialog provides background inertness and a focus trap. */
    class Modal extends React.Component {
      componentDidMount() {
        this.opener = window.document.activeElement
        this.dialog.showModal()
        const initial = this.dialog.querySelector('[data-dsh-initial-focus]:not(:disabled)')
          || this.dialog.querySelector('button[type="submit"]:not(:disabled)')
        initial?.focus()
      }
      componentWillUnmount() {
        this.dialog.close()
        const opener = this.opener
        const restore = this.props.restoreFocus
        queueMicrotask(() => {
          if (window.document.querySelector('dialog[open]')) return
          if (restore) restore()
          else if (opener?.isConnected) opener.focus()
          else window.document.querySelector('.dsh-tasks-toolbar > .dsh-tasks-primary')?.focus()
        })
      }
      render() {
        const { t, title, intro, onClose, children, dismissDisabled } = this.props
        return h('dialog', {
          className: 'dsh-tasks-dialog', 'aria-label': title,
          ref: element => { if (element) this.dialog = element },
          onCancel(event) { event.preventDefault(); onClose() },
          onKeyDown(event) {
            if (event.key !== 'Tab') return
            // Keep the cycle in the dialog; native top-layer inertness alone
            // can send focus to browser chrome when tabbing past its last item.
            const dialog = event.currentTarget
            const controls = [...dialog.querySelectorAll('button, input, textarea, select, summary, [href], [tabindex]')]
              .filter(node => node.tabIndex >= 0 && !node.matches(':disabled') && node.getClientRects().length)
            if (!controls.length) { event.preventDefault(); dialog.focus(); return }
            const first = controls[0], last = controls.at(-1), active = dialog.ownerDocument.activeElement
            if (event.shiftKey && (active === first || active === dialog)) { event.preventDefault(); last.focus() }
            else if (!event.shiftKey && (active === last || active === dialog)) { event.preventDefault(); first.focus() }
          },
          onClick(event) {
            if (event.target !== event.currentTarget) return
            const bounds = event.currentTarget.getBoundingClientRect()
            if (event.clientX < bounds.left || event.clientX > bounds.right
              || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose()
          },
        }, h('header', { className: 'dsh-tasks-dialog-head' },
          h('span', { className: 'dsh-tasks-icon dsh-tasks-logo' }, h(Icon, { name: 'board', size: 19 })),
          h('div', null, h('h2', null, title), intro ? h('p', null, intro) : null),
          h(TaskButton, { className: 'dsh-tasks-icon-button', type: 'button', 'aria-label': t('close'), disabled: dismissDisabled, onClick: onClose }, h(Icon, { name: 'close' })),
        ), children)
      }
    }

    const modelKey = model => model ? JSON.stringify([model.provider, model.model]) : ''
    function workspaceLabel(t, task, options) {
      if (!task.workspaceId) return t('ungrouped')
      const workspace = options.workspaces.find(row => row.id === task.workspaceId)
      return workspace?.title || (options.workspaceStatus === 'ready' ? t('workspaceMissing') : t('workspace'))
    }
    function modelLabel(task, options) {
      if (!task.model) return ''
      return options.groups.find(group => group.id === task.model.provider)?.models
        .find(model => model.id === task.model.model)?.name || task.model.model
    }
    function relativeTime(t, date) {
      const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(date)) / 60000))
      if (minutes < 1) return t('justNow')
      if (minutes < 60) return minutes + ' ' + t('minutesAgo')
      if (minutes < 1440) return Math.floor(minutes / 60) + ' ' + t('hoursAgo')
      return Math.floor(minutes / 1440) + ' ' + t('daysAgo')
    }

    function CreateForm({ t, form, actions, writable, options }) {
      const locked = form.pending || !!form.retryInput
      const models = options.groups.flatMap(group => group.models.map(model => ({
        key: JSON.stringify([group.id, model.id]), selection: { provider: group.id, model: model.id },
      })))
      return h(Modal, { t, title: t('newTask'), intro: t('createIntro'), onClose: actions.closeForm, restoreFocus: actions.restoreFormFocus }, h('form', {
        className: 'dsh-tasks-form', 'aria-label': t('newTask'), 'aria-busy': form.pending,
        onSubmit(event) { event.preventDefault(); void actions.create() },
      },
      h('div', { className: 'dsh-tasks-dialog-body' },
      h('fieldset', { className: 'dsh-tasks-fields', disabled: locked },
        h('label', null, h('span', { className: 'dsh-tasks-field-title' }, t('taskTitle')), h('input', {
          name: 'title', value: form.title, required: true, autoFocus: true,
          'data-dsh-initial-focus': '',
          placeholder: t('titlePlaceholder'),
          onChange: event => actions.editForm('title', event.target.value),
        })),
        h('label', null, h('span', { className: 'dsh-tasks-field-title' }, t('taskBrief')), h('textarea', {
          name: 'brief', value: form.brief, rows: 4, placeholder: t('briefPlaceholder'),
          onChange: event => actions.editForm('brief', event.target.value),
        })),
        h('div', { className: 'dsh-tasks-bindings' },
          h('label', null, h('span', { className: 'dsh-tasks-field-title' }, t('workspace'), h('span', { className: 'dsh-tasks-optional' }, t('optional'))),
            h(PaperSelect, {
              className: 'dsh-tasks-stage', name: 'workspaceId', 'aria-label': t('workspace'), value: form.workspaceId,
              onChange: event => actions.editForm('workspaceId', event.target.value),
            }, h('option', { value: '' }, t('ungrouped')),
            form.workspaceId && !options.workspaces.some(row => row.id === form.workspaceId)
              ? h('option', { value: form.workspaceId }, t('workspaceMissing')) : null,
            options.workspaces.map(row => h('option', { key: row.id, value: row.id }, row.title))),
            options.workspaces.find(row => row.id === form.workspaceId)
              ? h('p', { className: 'dsh-tasks-field-hint', style: { overflowWrap: 'anywhere' } }, options.workspaces.find(row => row.id === form.workspaceId).path) : null,
          ),
          h('label', null, h('span', { className: 'dsh-tasks-field-title' }, t('model'), h('span', { className: 'dsh-tasks-optional' }, t('optional'))),
            h(PaperSelect, {
              className: 'dsh-tasks-stage', name: 'model', 'aria-label': t('model'), value: modelKey(form.model),
              onChange: event => actions.editForm('model', models.find(row => row.key === event.target.value)?.selection),
            }, h('option', { value: '' }, t('defaultModel')),
            form.model && !models.some(row => row.key === modelKey(form.model))
              ? h('option', { value: modelKey(form.model) }, form.model.model) : null,
            options.groups.map(group => h('optgroup', { key: group.id, label: group.name }, group.models.map(model => h('option', {
              key: model.id, value: JSON.stringify([group.id, model.id]),
            }, model.name))))),
            h('p', { className: 'dsh-tasks-field-hint' }, t('modelHint')),
          ),
        ),
        h('label', null, h('span', { className: 'dsh-tasks-field-title' }, t('moveTask')),
          h(PaperSelect, { className: 'dsh-tasks-stage', value: form.stage, name: 'stage', 'aria-label': t('moveTask'), onChange: event => actions.editForm('stage', event.target.value) },
            Object.entries(STAGES).map(([stage, key]) => h('option', { key: stage, value: stage }, t(key))))),
      ),
      options.status === 'loading' ? h('p', { className: 'dsh-tasks-feedback', role: 'status' }, t('optionsLoading')) : null,
      options.status !== 'loading' && (options.workspaceStatus !== 'ready' || options.modelStatus !== 'ready' || options.modelFailures > 0)
        ? h('div', { className: 'dsh-tasks-feedback', role: 'status' },
          options.workspaceStatus !== 'ready' ? h('p', null, t('workspaceUnavailable')) : null,
          options.modelStatus !== 'ready' ? h('p', null, t('modelUnavailable')) : null,
          options.modelFailures > 0 ? h('p', null, t('partialModels')) : null,
          h(TaskButton, { className: 'dsh-tasks-retry', type: 'button', onClick: actions.loadOptions }, t('reloadOptions'))) : null,
      form.errorCode ? h('p', { className: 'dsh-tasks-feedback', role: 'alert' },
        failureText(t, form.errorCode, form.retryInput ? 'createUnknown' : 'createFailed')) : null,
      form.errorCode === 'tasks/workspace-unavailable' || form.errorCode === 'tasks/model-unavailable'
        ? h(TaskButton, { className: 'dsh-tasks-retry', type: 'button', onClick: actions.loadOptions }, t('reloadOptions')) : null,
      ),
      h('div', { className: 'dsh-tasks-form-actions' },
        h('span', { className: 'dsh-tasks-draft-hint' }, t('draftHint')),
        h(TaskButton, {
          className: 'dsh-tasks-retry', type: 'button', onClick: actions.closeForm,
        }, t('close')),
        h(TaskButton, {
          className: 'dsh-tasks-primary', type: 'submit',
          disabled: !writable || form.pending || !form.title.trim(),
        }, t(form.pending ? 'creating' : form.retryInput ? 'retry' : 'create')),
      )))
    }

    function TaskCard({ t, task, row, actions, writable, writing, options, menuAbove, runtime }) {
      const feedbackId = 'dsh-tasks-feedback-' + task.id
      return h(PaperFrame, { seed: task.id, className: 'dsh-tasks-card', 'aria-busy': !!row?.pending, 'data-task-id': task.id, 'data-stage': task.stage },
        h('div', { className: 'dsh-tasks-card-heading' },
          h(TaskButton, { type: 'button', className: 'dsh-tasks-card-title', title: task.title, onClick: () => actions.openDetails(task.id) }, task.title),
          h(Dropdown, { className: 'dsh-tasks-card-actions', name: 'dsh-tasks-card-actions',
            onKeyDown(event) {
              if (event.key !== 'Escape') return
              event.currentTarget.removeAttribute('open')
              event.currentTarget.querySelector('summary').focus()
            },
          },
            h('summary', { className: 'dsh-tasks-icon-button', 'aria-label': t('moreTask') + ': ' + task.title }, h(Icon, { name: 'more' })),
            h('div', { className: 'dsh-tasks-menu', style: menuAbove ? { top: 'auto', bottom: '24px' } : undefined },
              h('div', { className: 'dsh-tasks-menu-label' }, t('moveTask')),
              Object.entries(STAGES).map(([stage, key]) => h(TaskButton, {
                key: stage, type: 'button', disabled: !writable || !!row || task.stage === stage,
                title: t('manualStage'),
                onClick(event) {
                  event.currentTarget.closest('details').removeAttribute('open')
                  void actions.setStage(task.id, stage)
                },
              }, h(Icon, { name: task.stage === stage ? 'check' : 'chevron', size: 12 }), t('moveTo') + ' ' + t(key))),
              h(TaskButton, { className: 'dsh-tasks-danger', disabled: !writable || writing,
                onClick(event) { event.currentTarget.closest('details').removeAttribute('open'); actions.openDelete(task.id) },
              }, h(Icon, { name: 'trash', size: 14 }), t('deleteTask')),
            ),
          ),
        ),
        task.brief ? h('div', { className: 'dsh-tasks-card-brief', title: task.brief }, task.brief) : null,
        h(StatusBadge, { status: runtime, label: t(runtime), time: relativeTime(t, task.createdAt) }),
        h('div', { className: 'dsh-tasks-card-meta' },
          h(Icon, { name: 'folder', size: 12 }), h('span', { className: 'dsh-tasks-meta-workspace' }, workspaceLabel(t, task, options)),
          task.model ? h('span', { className: 'dsh-tasks-meta-model', title: modelLabel(task, options) }, '· ' + modelLabel(task, options)) : null),
        h('div', { className: 'dsh-tasks-card-buttons', style: { display: 'flex', gap: 8, marginTop: 10 } },
          task.activeSessionId ? h(TaskButton, { type: 'button', className: 'dsh-tasks-retry', onClick: () => actions.openSession(task.activeSessionId) }, t('openSession')) : null,
          h(TaskButton, { type: 'button', className: 'dsh-tasks-retry', disabled: !writable || writing, onClick: () => actions.openLaunch(task.id) },
            t(unfinishedLaunch(task) ? 'resumeLaunch' : 'launch'))),
        row?.pending ? h('p', { className: 'dsh-tasks-feedback', role: 'status' }, t('moving')) : null,
        row?.errorCode ? h('div', { className: 'dsh-tasks-feedback', id: feedbackId, role: 'alert' },
          h('p', null, failureText(t, row.errorCode, 'stageFailed')),
          h('p', null, t('attemptedColumn') + ': ' + t(STAGES[row.stage])),
          h(TaskButton, {
            className: 'dsh-tasks-retry', type: 'button', disabled: !writable || writing,
            onClick: actions.refresh,
          }, t('refresh')),
        ) : null,
      )
    }

    /** Counts show search matches / total; the actual classification is saved. */
    function Column({ t, stage, name, empty, ready, tasks, total, filtered, stages, actions, writable, writing, options, collapsed, showAllDone, statuses }) {
      const visible = stage === 'done' && !showAllDone
        ? [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 10) : tasks
      return h(
        'section',
        { className: 'dsh-tasks-col', 'aria-label': name, 'data-stage': stage },
        h(
          'div',
          { className: 'dsh-tasks-colhead' },
          h(TaskButton, { type: 'button', className: 'dsh-tasks-coltitle', 'aria-expanded': !collapsed,
            onClick: () => actions.toggleColumn(stage) }, h('span', { className: 'dsh-tasks-colname' }, name),
          h('span', { className: 'dsh-tasks-count', title: t('countLabel') },
            ready ? filtered ? tasks.length + ' / ' + total : String(total) : '—')),
          h(TaskButton, { type: 'button', className: 'dsh-tasks-icon-button', 'aria-label': t('add') + ': ' + name,
            onClick: () => actions.openForm(stage) }, h(Icon, { name: 'plus' })),
        ),
        !collapsed ? h('div', { className: 'dsh-tasks-collist' }, visible.length
          ? visible.map((task, index) => h(TaskCard, { key: task.id, t, task, row: stages[task.id], actions, writable, writing, options, menuAbove: index >= 2, runtime: runtimeOf(task, statuses) }))
          : h('p', { className: 'dsh-tasks-empty' }, empty))
        : h('div', { className: 'dsh-tasks-collist' }),
        h('div', { className: 'dsh-tasks-colfoot' },
          stage === 'done' && tasks.length > 10 ? h(TaskButton, { type: 'button', className: 'dsh-tasks-add', onClick: actions.toggleDone },
            t(showAllDone ? 'showRecent' : 'showAll') + (showAllDone ? '' : ' ' + tasks.length)) : null,
          h(TaskButton, { type: 'button', className: 'dsh-tasks-add', onClick: () => actions.openForm(stage) }, h(Icon, { name: 'plus' }), t('add'))),
      )
    }

    function TaskDetails({ t, task, options, actions, writable, writing }) {
      const workspace = options.workspaces.find(row => row.id === task.workspaceId)
      return h(Modal, { t, title: t('details'), intro: task.title, onClose: actions.closeDetails },
        h('div', { className: 'dsh-tasks-dialog-body' },
          task.brief ? h('p', { className: 'dsh-tasks-detail-brief' }, task.brief) : null,
          h('dl', { className: 'dsh-tasks-detail-grid' },
            h('dt', null, t('taskTitle')), h('dd', null, task.title),
            h('dt', null, t('moveTask')), h('dd', null, t(STAGES[task.stage])),
            h('dt', null, t('workspace')), h('dd', null, workspaceLabel(t, task, options), workspace ? h('p', { className: 'dsh-tasks-field-hint' }, workspace.path) : null),
            h('dt', null, t('model')), h('dd', null, modelLabel(task, options) || t('defaultModel')),
            h('dt', null, t('created')), h('dd', null, new Date(task.createdAt).toLocaleString()),
            task.activeSessionId ? h(React.Fragment, null, h('dt', null, t('session')), h('dd', null,
              h(TaskButton, { type: 'button', className: 'dsh-tasks-retry', onClick: () => actions.openSession(task.activeSessionId) }, t('openSession')))) : null,
            task.previousSessionIds?.length ? h(React.Fragment, null, h('dt', null, t('history')), h('dd', null,
              task.previousSessionIds.map(id => h(TaskButton, { key: id, type: 'button', className: 'dsh-tasks-retry', onClick: () => actions.openSession(id) }, id)))) : null,
          ),
        ),
        h('div', { className: 'dsh-tasks-form-actions' },
          h(TaskButton, { className: 'dsh-tasks-secondary dsh-tasks-danger', disabled: !writable || writing, onClick: () => actions.openDelete(task.id) }, h(Icon, { name: 'trash', size: 14 }), t('deleteTask')),
          h('span', { className: 'dsh-tasks-spacer' }),
          h(TaskButton, { className: 'dsh-tasks-secondary', onClick: actions.closeDetails }, t('close'))),
      )
    }

    function DeleteDialog({ t, deletion, actions, writable }) {
      const blocked = ['tasks/revision-conflict', 'tasks/launch-pending'].includes(deletion.errorCode)
      const error = deletion.errorCode === 'tasks/revision-conflict' ? t('deleteConflict')
        : deletion.errorCode === 'tasks/launch-pending' ? t('deletePendingLaunch')
        : deletion.errorCode === 'tasks/delete-unknown' ? t('deleteUnknown')
        : failureText(t, deletion.errorCode, 'deleteFailed')
      return h(Modal, { t, title: t('confirmDelete'), onClose: actions.closeDelete, dismissDisabled: deletion.pending },
        h('div', { className: 'dsh-tasks-dialog-body' },
          h('p', { className: 'dsh-tasks-delete-title' }, deletion.title),
          h('p', null, t('deleteNotice')),
          deletion.errorCode ? h('p', { className: 'dsh-tasks-feedback', role: 'alert' }, error) : null),
        h('div', { className: 'dsh-tasks-form-actions' },
          h('span', { className: 'dsh-tasks-spacer' }),
          h(TaskButton, { className: 'dsh-tasks-secondary', 'data-dsh-initial-focus': '', disabled: deletion.pending, onClick: actions.closeDelete }, t('cancelDelete')),
          h(TaskButton, { className: 'dsh-tasks-primary dsh-tasks-danger', disabled: !writable || deletion.pending || blocked,
            onClick: () => { void actions.deleteTask() } }, t(deletion.pending ? 'deleting' : 'deleteTask'))))
    }

    function LaunchForm({ t, form, task, options, actions, writable, runtime }) {
      const locked = form.pending || !!form.retryInput
      const existing = !!task.activeSessionId && !locked
      const busy = ['running', 'approval', 'question', 'unknown'].includes(runtime)
      const showFields = !existing || form.replaceActive
      const model = options.groups.find(group => group.id === form.model?.provider)?.models.find(row => row.id === form.model?.model)
      return h(Modal, { t, title: t('launch'), intro: task.title, onClose: actions.closeLaunch },
        h('form', { className: 'dsh-tasks-form', onSubmit(event) { event.preventDefault(); void actions.launchTask() } },
          h('div', { className: 'dsh-tasks-dialog-body' },
            existing ? h('div', { className: 'dsh-tasks-feedback' },
              h('p', null, t(busy ? 'sessionBusy' : 'sessionExists')),
              h(TaskButton, { type: 'button', className: 'dsh-tasks-retry', onClick: () => actions.openSession(task.activeSessionId) }, t('openSession')),
              !busy ? h('label', { style: { display: 'block', marginTop: 12 } }, h('input', { type: 'checkbox', checked: form.replaceActive,
                onChange: event => actions.editLaunch('replaceActive', event.target.checked) }), ' ' + t('newSession')) : null) : null,
            showFields ? h('fieldset', { className: 'dsh-tasks-fields', disabled: locked },
              h('label', null, h('span', { className: 'dsh-tasks-field-title' }, t('workspace')),
                h(PaperSelect, { className: 'dsh-tasks-stage', name: 'launchWorkspace', 'aria-label': t('workspace'), value: form.workspaceId,
                  onChange: event => actions.editLaunch('workspaceId', event.target.value) },
                  h('option', { value: '' }, t('ungrouped')),
                  form.workspaceId && !options.workspaces.some(row => row.id === form.workspaceId) ? h('option', { value: form.workspaceId }, t('workspaceMissing')) : null,
                  options.workspaces.map(row => h('option', { key: row.id, value: row.id }, row.title)))),
              h('label', null, h('span', { className: 'dsh-tasks-field-title' }, t('model')),
                h(PaperSelect, { className: 'dsh-tasks-stage', name: 'launchModel', 'aria-label': t('model'), value: modelKey(form.model), onChange(event) {
                  actions.editLaunch('model', event.target.value ? (() => { const [provider, model] = JSON.parse(event.target.value); return { provider, model } })() : undefined)
                } }, h('option', { value: '' }, t('defaultModel')),
                form.model && !model ? h('option', { value: modelKey(form.model) }, form.model.model) : null,
                options.groups.map(group => h('optgroup', { key: group.id, label: group.name }, group.models.map(row => h('option', {
                  key: row.id, value: JSON.stringify([group.id, row.id]),
                }, row.name))))), h('p', { className: 'dsh-tasks-field-hint' }, t('modelDefaultNotice'))),
              model?.reasoning?.efforts?.length ? h(PaperSelect, { className: 'dsh-tasks-stage', 'aria-label': t('reasoningEffort'), value: form.model.reasoningEffort || '',
                onChange: event => actions.editLaunch('model', { provider: form.model.provider, model: form.model.model, ...(event.target.value ? { reasoningEffort: event.target.value } : {}) }) },
                h('option', { value: '' }, t('defaultModel')), model.reasoning.efforts.map(row => h('option', { key: row.id, value: row.id }, row.name || row.id))) : null,
              h('label', null, h('span', { className: 'dsh-tasks-field-title' }, t('preset')),
                h(PaperSelect, { className: 'dsh-tasks-stage', name: 'agentPreset', 'aria-label': t('preset'), value: form.agentPreset || '', onChange: event => actions.editLaunch('agentPreset', event.target.value) },
                  h('option', { value: '' }, t('defaultPreset')), (options.presets || []).map(row => h('option', { key: row.id, value: row.id }, row.name)))),
              h('label', null, h('span', { className: 'dsh-tasks-field-title' }, t('firstMessage')),
                h('textarea', { name: 'content', rows: 6, required: true, 'data-dsh-initial-focus': '', value: form.content,
                  onChange: event => actions.editLaunch('content', event.target.value) }))) : null,
            unfinishedLaunch(task) ? h('div', { className: 'dsh-tasks-feedback' },
              h('p', null, t('launchSaved')), h(TaskButton, { type: 'button', className: 'dsh-tasks-retry', onClick: () => actions.openSession(task.launch.sessionId) }, t('openSession'))) : null,
            ['prepared', 'created'].includes(task.launch?.phase) && !form.pending ? h('div', { className: 'dsh-tasks-feedback' },
              h('p', null, t('abandonHint')), h(TaskButton, { type: 'button', className: 'dsh-tasks-retry', disabled: !writable, onClick: actions.abandonLaunch }, t('abandonLaunch'))) : null,
            form.errorCode ? h('p', { className: 'dsh-tasks-feedback', role: 'alert' }, failureText(t, form.errorCode, 'launchFailed')) : null,
            options.status === 'error' ? h(TaskButton, { type: 'button', className: 'dsh-tasks-retry', onClick: actions.loadOptions }, t('reloadOptions')) : null),
          h('div', { className: 'dsh-tasks-form-actions' },
            h('span', { className: 'dsh-tasks-spacer' }),
            h(TaskButton, { type: 'button', className: 'dsh-tasks-retry', onClick: actions.closeLaunch }, t('close')),
            showFields ? h(TaskButton, { type: 'submit', className: 'dsh-tasks-primary', disabled: !writable || form.pending || !form.content?.trim() || (existing && busy) },
              t(form.pending ? 'starting' : form.retryInput ? 'resumeLaunch' : 'start')) : null)))
    }

    /**
     * The task board panel.
     * @param props - slot props.
     * @param props.t - translate function bound to this plugin's namespace.
     * @param props.useTasks - renderer-bound task-list hook.
     * @param props.actions - stable data-source callbacks.
     * @returns the panel.
     */
    function TaskBoard({ t, useTasks, actions }) {
      const { status, errorCode, tasks, hasLoaded, sync, query, form, stages, options, workspaceFilter, collapsed, showAllDone, detailId, launchForm, statuses, navigationError, deletion } = useTasks(state => state)
      const ready = hasLoaded
      const writable = status === 'ready'
      const writing = form.pending || launchForm?.pending || deletion?.pending || Object.values(stages).some(row => row.pending)
      const attention = tasks.filter(task => task.stage !== 'done' && ['approval', 'question', 'error'].includes(runtimeOf(task, statuses)))
      const search = query.trim().toLocaleLowerCase()
      const sorted = [...tasks].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
      const filtered = !!search || !!workspaceFilter
      const matching = sorted.filter(task => (!search
        || (task.title + '\n' + (task.brief || '')).toLocaleLowerCase().includes(search))
        && (!workspaceFilter || (workspaceFilter === 'ungrouped' ? !task.workspaceId : task.workspaceId === workspaceFilter)))
      const message = status === 'loading' ? t('loading') : status === 'error'
        ? failureText(t, errorCode, 'loadFailed')
        : tasks.length ? t(filtered ? 'matched' : 'total') + ': ' + matching.length : t('loaded')
      const empty = key => t(ready ? filtered ? 'noMatches' : key
        : status === 'loading' ? 'loading' : 'listUnavailable')
      return h(
        'div',
        { className: 'dsh-tasks-root', 'aria-busy': status === 'loading' },
        h(Styles, null),
        h(
          'header',
          { className: 'dsh-tasks-toolbar' },
          h(
            'div',
            { className: 'dsh-tasks-heading' },
            h('span', { className: 'dsh-tasks-icon dsh-tasks-logo' }, h(Icon, { name: 'board', size: 16 })),
            h('h1', { className: 'dsh-tasks-title' }, h('span', { className: 'dsh-tasks-host-title' }, t('title')), h('span', { className: 'dsh-tasks-paper-title' }, t('paperTitle'))),
          ),
          h('span', { className: 'dsh-tasks-divider', 'aria-hidden': true }),
          h('div', { className: 'dsh-tasks-search-wrap' }, h(Icon, { name: 'search' }),
          h('input', {
            className: 'dsh-tasks-search',
            type: 'search',
            placeholder: t('search'),
            'aria-label': t('search'),
            value: query, onChange: event => actions.setQuery(event.target.value),
          })),
          h(Dropdown, { className: 'dsh-tasks-filter',
            onToggle: event => { if (event.currentTarget.open && options.status !== 'ready') void actions.loadOptions() } },
            h('summary', { className: 'dsh-tasks-secondary' }, h(Icon, { name: 'filter' }), t('filter')),
            h('div', { className: 'dsh-tasks-menu', style: { right: 'auto', left: 0 } },
              h('label', null, h('div', { className: 'dsh-tasks-menu-label' }, t('workspace')),
                h(PaperSelect, { className: 'dsh-tasks-stage', 'aria-label': t('filter') + ': ' + t('workspace'),
                  value: workspaceFilter, onChange: event => actions.setWorkspaceFilter(event.target.value) },
                  h('option', { value: '' }, t('allWorkspaces')), h('option', { value: 'ungrouped' }, t('ungrouped')),
                  options.workspaces.map(row => h('option', { key: row.id, value: row.id }, row.title)),
                  workspaceFilter && workspaceFilter !== 'ungrouped' && !options.workspaces.some(row => row.id === workspaceFilter)
                    ? h('option', { value: workspaceFilter }, t('workspaceMissing')) : null)),
            )),
          h('span', { className: 'dsh-tasks-spacer' }),
          h(TaskButton, {
            className: 'dsh-tasks-icon-button', type: 'button', onClick: actions.refresh,
            'aria-label': t('refresh'), title: t('refresh'),
            disabled: status === 'loading' || writing,
          }, h(Icon, { name: 'refresh' })),
          h(TaskButton, {
            className: 'dsh-tasks-primary', type: 'button', onClick: () => actions.openForm(),
            disabled: form.open,
          }, h(Icon, { name: 'plus' }), t(form.retryInput || form.pending ? 'resumeCreate' : 'newTask')),
        ),
        h('p', { className: 'dsh-tasks-paper-note' }, t('paperNote')),
        form.open ? h(CreateForm, { t, form, actions, writable, options }) : null,
        navigationError ? h('p', { className: 'dsh-tasks-feedback', role: 'alert' }, failureText(t, navigationError, 'navigationFailed')) : null,
        launchForm?.open && tasks.some(task => task.id === launchForm.taskId)
          ? h(LaunchForm, { t, form: launchForm, task: tasks.find(task => task.id === launchForm.taskId), options, actions, writable,
            runtime: runtimeOf(tasks.find(task => task.id === launchForm.taskId), statuses) }) : null,
        attention.length ? h('details', { className: 'dsh-tasks-feedback dsh-tasks-attention', style: { margin: '0 24px 12px' } },
          h('summary', null, attention.length + ' ' + t('attention')),
          attention.map(task => h('p', { key: task.id }, task.title + ' · ' + t(runtimeOf(task, statuses)) + ' ',
            h(TaskButton, { className: 'dsh-tasks-retry', type: 'button', onClick: () => actions.openSession(task.activeSessionId) }, t('openSession'))))) : null,
        detailId && tasks.some(task => task.id === detailId)
          ? h(TaskDetails, { t, task: tasks.find(task => task.id === detailId), options, actions, writable, writing }) : null,
        deletion ? h(DeleteDialog, { t, deletion, actions, writable }) : null,
        h(
          'div',
          { className: 'dsh-tasks-board' },
          Object.entries(STAGES).map(([stage, key]) => h(Column, {
            key: stage, t, stage, name: t(key), empty: empty({ todo: 'emptyTodo', doing: 'emptyDoing', done: 'emptyDone' }[stage]),
            ready, tasks: matching.filter(task => task.stage === stage),
            total: tasks.filter(task => task.stage === stage).length, filtered,
            stages, actions, writable, writing, options, collapsed: collapsed[stage], showAllDone, statuses,
          })),
        ),
        h('div', { className: 'dsh-tasks-footnote', role: status === 'error' ? 'alert' : 'status' },
          h('span', null, message),
          h('span', { 'data-task-sync': sync }, t(sync === 'live' ? 'syncLive' : sync === 'offline' ? 'syncOffline' : 'syncConnecting')),
          status === 'error' ? h(TaskButton, {
            className: 'dsh-tasks-retry', type: 'button', onClick: actions.refresh, disabled: writing,
          }, t('retry')) : null,
          status === 'error' && hasLoaded ? h('span', null, t('stale')) : null,
        ),
      )
    }

    return {
      inject: ['slots', 'locale', 'connection'],

      /**
       * Register the panel and its sidebar entry.
       * @param ctx - client plugin context.
       */
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'tavlo-tasks: en dictionary')
        ctx.effect(() => ctx.locale.register(NS, 'zh', ZH), 'tavlo-tasks: zh dictionary')

        const t = ctx.locale.bind(NS)
        const tasks = createTaskList(ctx.connection, sessionId => {
          const workspace = ctx.get('uiWorkspace')
          if (!workspace) throw new Error('Workspace navigation unavailable')
          workspace.openSession(sessionId)
        })
        ctx.effect(() => {
          void tasks.refresh()
          tasks.startSync()
          return () => { tasks.dispose() }
        }, 'tavlo-tasks: task list request')

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => t('title') },
            PanelIcon,
          ),
        )

        ctx.slots.inject('main', () =>
          ctx.slots.register({
            name: 'main', key: PANEL_ID,
            inject: () => ({ t, hooks: { tasks }, actions: tasks }),
          }, TaskBoard),
        )
      },
    }
  },
})
