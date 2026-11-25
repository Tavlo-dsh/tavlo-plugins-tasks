/**
 * Task board Client half.
 *
 * One lifecycle-owned Connection data source, consumed by the slot hook.
 * Components receive state/actions and never access a Cordis context.
 */

window.__ModuleLoader__.load({
  id: '@tavlo-dsh/dsh-plugin-tasks',
  factory(require) {
    const React = require('react')
    const { TaskDatePicker, TaskPaperInk = () => null } = require('./calendar/task-date-picker.jsx')
    const Dnd = require('@dnd-kit/core')
    const { createPortal } = require('react-dom')
    const { useModalLayer, MarkdownDelegateProvider, MarkdownText, Button, Input, Checkbox, Tag, ImageLightbox } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    const PANEL_ID = 'tasks'
    const NS = 'tavlo-tasks'
    const APPEARANCE_SLOT = 'tavlo-tasks.appearance'
    const STAGES = { todo: 'colTodo', doing: 'colDoing', done: 'colDone' }
    const defaults = Object.keys(STAGES).map(stage => ({ id: 'stage:' + stage, stage }))
    const taskColumn = task => task.columnId || 'stage:' + task.stage
    const linksSession = (task, sessionId) => task.activeSessionId === sessionId || task.previousSessionIds?.includes(sessionId)
    const boardWritePending = state => !!(state.form.pending || state.quickCreating || state.launchForm?.pending
      || state.deletion?.pending || state.deliveryMutation?.pending || Object.values(state.stages).some(row => row.pending))
    const taskWritePending = state => !!state.editor?.pending || boardWritePending(state)
    const checklistKeys = ['acceptanceCriteria', 'dependencyIds']
    const DETAIL_VIEWS = ['detailTab', 'activity', 'deliveryTab']
    const dependencyIds = task => task?.dependencyIds || []
    const taskIndex = tasks => new Map(tasks.map(task => [task.id, task]))
    const blockersOf = (task, byId) => dependencyIds(task).filter(id => byId.get(id)?.stage !== 'done')
    const dependentsOf = (taskId, byId) => taskId && byId ? [...byId.values()]
      .filter(row => row.id !== taskId && dependencyIds(row).includes(taskId))
      .sort((a, b) => (a.stage === 'done') - (b.stage === 'done') || b.updatedAt.localeCompare(a.updatedAt)) : []
    function newlyUnlockedTasks(wasDone, nextTasks, completedTask) {
      if (wasDone || !completedTask || completedTask.stage !== 'done') return []
      const nextById = taskIndex(nextTasks)
      return nextTasks.filter(row => row.id !== completedTask.id && row.stage !== 'done' && !row.activeSessionId
        && dependencyIds(row).includes(completedTask.id) && blockersOf(row, nextById).length === 0)
    }
    const deliveryOpen = task => ['pending', 'returned'].includes(task.delivery?.status)
    const attentionKinds = ['approval', 'question', 'reviewPending', 'error', 'reviewReturned']
    function attentionOf(task, statuses) {
      if (task.stage === 'done') return
      const runtime = runtimeOf(task, statuses)
      if (runtime === 'approval' || runtime === 'question') return runtime
      if (task.delivery?.status === 'pending') return 'reviewPending'
      if (runtime === 'error') return runtime
      if (task.delivery?.status === 'returned' && !task.delivery.continuedAt) return 'reviewReturned'
    }
    const isReadyToStart = (task, byId) => task.stage !== 'done' && !task.activeSessionId && !unfinishedLaunch(task)
      && !blockersOf(task, byId).length
    const fallbackPriorities = ['P0', 'P1', 'P2'].map(key => ({ key, name: key }))
    const priorityLabel = (priorities, key) => priorities.get(key) ?? key
    const metaKeys = ['labelId', 'priority', 'dueDate']
    const preferenceKeys = ['workspaceId', 'model']
    function detailPatch(values, task) {
      return {
        ...Object.fromEntries([...metaKeys, ...preferenceKeys].filter(key => key === 'model'
          ? modelKey(values.model) !== modelKey(task.model) || values.model?.reasoningEffort !== task.model?.reasoningEffort
          : (values[key] || null) !== (task[key] || null)).map(key => [key, values[key] || null])),
        ...((values.acceptanceCriteria || '').trim() !== (task.acceptanceCriteria || '') ? { acceptanceCriteria: (values.acceptanceCriteria || '').trim() } : {}),
        ...(JSON.stringify(dependencyIds(values)) !== JSON.stringify(dependencyIds(task)) ? { dependencyIds: dependencyIds(values) } : {}),
      }
    }
    const metadata = task => Object.fromEntries(metaKeys.filter(key => task?.[key]).map(key => [key, task[key]]))
    const deliveryFields = (values = {}) => ({ ...(values.acceptanceCriteria?.trim() ? { acceptanceCriteria: values.acceptanceCriteria.trim() } : {}),
      ...(dependencyIds(values).length ? { dependencyIds: dependencyIds(values) } : {}) })
    const validDependencies = value => value === undefined || Array.isArray(value) && value.length <= 20
      && new Set(value).size === value.length && value.every(id => typeof id === 'string' && id.length <= 36 && isSessionId(id))
    const validCriteria = value => value === undefined || typeof value === 'string' && value.length <= 4000
    function editableValues(task) {
      return { title: task.title, brief: task.brief || '', ...metadata(task), acceptanceCriteria: task.acceptanceCriteria || '', dependencyIds: dependencyIds(task), workspaceId: task.workspaceId || undefined,
        model: task.model ? { provider: task.model.provider, model: task.model.model,
          ...(task.model.reasoningEffort ? { reasoningEffort: task.model.reasoningEffort } : {}) } : undefined }
    }
    const sameEditable = (left, right) => JSON.stringify(editableValues(left)) === JSON.stringify(editableValues(right))
    const validEditable = value => value && typeof value.title === 'string' && typeof value.brief === 'string'
      && [...metaKeys, 'workspaceId'].every(key => value[key] === undefined || typeof value[key] === 'string')
      && validCriteria(value.acceptanceCriteria) && validDependencies(value.dependencyIds)
      && (value.model === undefined || isModel(value.model))
    const todayLocal = () => new Date().toLocaleDateString('sv-SE')
    const dueIcons = { overdue: 'clock', today: 'sun', tomorrow: 'sunrise', nextWeek: 'calendar' }
    function dueBucket(task, today) {
      if (!task.dueDate || task.stage === 'done') return undefined
      const days = (Date.parse(task.dueDate) - Date.parse(today)) / 86400000
      return days < 0 ? 'overdue' : days === 0 ? 'today' : days === 1 ? 'tomorrow' : days <= 7 ? 'nextWeek' : undefined
    }
    function useLocalDay() {
      const [day, setDay] = React.useState(todayLocal)
      React.useEffect(() => {
        let timer
        const update = () => {
          clearTimeout(timer)
          setDay(todayLocal())
          const midnight = new Date()
          midnight.setHours(24, 0, 0, 0)
          timer = setTimeout(update, Math.max(1, midnight.getTime() - Date.now()))
        }
        update()
        window.addEventListener('focus', update)
        return () => { clearTimeout(timer); window.removeEventListener('focus', update) }
      }, [])
      return day
    }
    function weekStartLocal(today) {
      const date = new Date(today + 'T12:00:00')
      const day = date.getDay()
      date.setDate(date.getDate() - (day === 0 ? 6 : day - 1))
      return date.toLocaleDateString('sv-SE')
    }
    function doneTimeBucket(task, today, weekStart) {
      const ts = Date.parse(task.completedAt ?? task.updatedAt)
      if (!Number.isFinite(ts)) return 'earlier'
      const day = new Date(ts).toLocaleDateString('sv-SE')
      if (day >= today) return 'today'
      if (day >= weekStart) return 'thisWeek'
      return 'earlier'
    }
    function formatElapsed(t, sinceIso, nowMs) {
      const started = Date.parse(sinceIso)
      if (!Number.isFinite(started)) return ''
      const minutes = Math.floor(Math.max(0, nowMs - started) / 60000)
      if (minutes < 1) return t('elapsedUnderMinute')
      if (minutes < 60) return minutes + 'm'
      const hours = Math.floor(minutes / 60)
      const rem = minutes % 60
      return hours + 'h' + (rem ? ' ' + rem + 'm' : '')
    }
    function useNowTick(active) {
      const [now, setNow] = React.useState(() => Date.now())
      React.useEffect(() => {
        if (!active) return
        setNow(Date.now())
        const id = setInterval(() => setNow(Date.now()), 15000)
        return () => clearInterval(id)
      }, [active])
      return now
    }
    const SORT_MODES = ['manual', 'priority', 'dueDate', 'updated']
    const SORT_LABELS = { manual: 'sortManual', priority: 'sortPriority', dueDate: 'sortDueDate', updated: 'sortUpdated' }
    function priorityRank(key, priorities) {
      if (!key) return 999
      if (key === 'P0') return 0
      if (key === 'P1') return 1
      if (key === 'P2') return 2
      const keys = priorities ? [...priorities.keys()] : []
      const idx = keys.indexOf(key)
      return idx >= 0 ? idx : 100
    }
    function sortColumnTasks(rows, sortBy, priorities) {
      if (!sortBy || sortBy === 'manual') return rows
      const copy = [...rows]
      if (sortBy === 'priority') {
        return copy.sort((a, b) => (priorityRank(a.priority, priorities) - priorityRank(b.priority, priorities))
          || ((a.dueDate || '9999-99-99').localeCompare(b.dueDate || '9999-99-99'))
          || (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0))
      }
      if (sortBy === 'dueDate') {
        return copy.sort((a, b) => ((a.dueDate || '9999-99-99').localeCompare(b.dueDate || '9999-99-99'))
          || (priorityRank(a.priority, priorities) - priorityRank(b.priority, priorities))
          || (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0))
      }
      if (sortBy === 'updated') {
        return copy.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
      }
      return copy
    }
    const newRequestId = () => Array.from(window.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
    const columnLabel = (t, column) => column.name || t(STAGES[column.stage])
    const DRAFT_KEY = 'dsh-plugin-tasks:create-v1'
    const LAUNCH_KEY = 'dsh-plugin-tasks:launch-v1'
    const DETAIL_KEY = 'dsh-plugin-tasks:details-v1:'
    const BOARD_VIEW_KEY = 'dsh-plugin-tasks:board-view-v1'
    const DONE_PREVIEW = 4
    const RUNTIME = ['running', 'approval', 'question', 'error', 'idle', 'missing', 'archived', 'unknown']

    const EN = {
      needsMyAction: 'Needs my attention', reviewPending: 'Awaiting review', reviewReturned: 'Changes requested', reviewAccepted: 'Accepted',
      viewProgress: 'View progress', reviewDelivery: 'Review delivery', inspectDependencies: 'View prerequisites',
      unlinkedConversation: 'No linked conversation', createConversation: 'New conversation',
      createConversationNote: 'This task is already in progress but has no linked conversation. Confirm to create one and send the first message.',
      deliveryTab: 'Agent delivery',
      acceptanceCriteria: 'Acceptance criteria', criteriaPlaceholder: 'What must be true before this task can be accepted?',
      addCriteria: 'Add acceptance criteria', editCriteria: 'Edit criteria', addPrerequisites: 'Add prerequisites',
      dependentTasks: 'Dependent tasks', blockingCount: 'Blocks {count}', unlockedNotice: 'Unlocked {count} dependent task(s)',
      quickAddPlaceholder: 'Task title… (Enter to add)', quickAddSubmit: 'Add', quickAddAdding: 'Adding…', expandCreateForm: 'Full form',
      attentionPillFilter: 'Filter by reason', attentionPillShowAll: 'Show all reasons', attentionShowAll: 'Show all ({count})',
      sectionProperties: 'Properties & execution', createColumn: 'Target column', changeColumn: 'Change column',
      discardEdits: 'Discard changes', unsavedBadge: 'Unsaved', commentShortcut: 'Ctrl/⌘ + Enter',
      showMore: 'Expand', showLess: 'Collapse', viewDelivery: 'View delivery', sessionChip: 'Session',
      deliveryCriteriaRef: 'Task acceptance criteria', deliverySubmittedAt: 'Submitted', deliveryReviewedAt: 'Reviewed',
      deliveryLinksHeading: 'Evidence links',
      criteriaLaunchHint: 'The Agent will receive these criteria and be asked to submit its evidence to this task.',
      dependencyIds: 'Prerequisites', addDependency: 'Add a prerequisite', removeDependency: 'Remove prerequisite',
      dependencyMissing: 'Deleted or unavailable task', dependencyReady: 'Ready to start', dependencyBlocked: 'Waiting for prerequisites',
      dependencyCycle: 'These prerequisites would create a cycle.', dependencyUnavailable: 'A prerequisite is no longer available.',
      deliveryHeading: 'Agent delivery', deliveryRuntime: 'Current run', deliveryEvidence: 'Evidence submitted by the Agent',
      deliveryVerification: 'Verification', deliveryUnverified: 'Not verified or still open', deliveryCriteriaSnapshot: 'Criteria sent for this run',
      deliveryNotSubmitted: 'No delivery submitted. An idle conversation is not a completed task.',
      deliveryWait: 'Ask the Agent in the original conversation to submit its delivery evidence.',
      deliveryFeedback: 'Review feedback', deliveryFeedbackHint: 'Explain what the Agent should change before resubmitting.',
      acceptDelivery: 'Accept and complete', returnDelivery: 'Return for changes', sendReviewFeedback: 'Send feedback to Agent',
      feedbackSent: 'Feedback sent to the original conversation.', deliveryMutationFailed: 'The change was not confirmed. Check the current delivery before trying again.',
      deliveryActionRequired: 'Review the submitted work or resolve the requested changes first.',
      eventDeliverySubmitted: 'Submitted delivery', eventDeliveryAccepted: 'Accepted delivery', eventDeliveryReturned: 'Returned delivery',
      eventDeliveryContinued: 'Sent review feedback',
      insights: 'Notebook overview', delivery: 'Completion rate', openTasks: 'Open', metrics: 'Key metrics', needsAction: 'Needs attention', closedToday: 'Completed today', cycle: 'Average turnaround', dayUnit: 'd', mix: 'Priority breakdown', bindingsMix: 'Workspaces & models', weekly: 'Completions · last 7 days',
      dueOverview: 'Due dates', dueScope: 'Open tasks · overdue and next 7 days', tomorrow: 'Due tomorrow', nextWeek: 'In 2–7 days', noOpenTasks: 'No open tasks in this view.', noDueDates: 'None of these open tasks has a due date.', noNearDates: 'Nothing overdue or due in the next 7 days.', removeDue: 'Clear due date filter', removeFilter: 'Remove filter',
      doneGroupToday: 'Today', doneGroupWeek: 'This week', doneGroupEarlier: 'Earlier', elapsedUnderMinute: '<1m',
      sortBy: 'Sort', sortManual: 'Manual order', sortPriority: 'Priority (P0 first)', sortDueDate: 'Due date (earliest)', sortUpdated: 'Recently updated', removeSort: 'Reset sort',
      shortcuts: 'Keyboard shortcuts', shortcutsIntro: 'Available when no dialog or text field is active.', shortcutSearch: 'Focus search', shortcutNew: 'New task', shortcutRefresh: 'Refresh board', shortcutInsights: 'Toggle overview', shortcutHelp: 'Show shortcuts',
      batchSelect: 'Batch actions', batchExit: 'Done', batchSelected: '{count} selected', batchSelectAll: 'Select visible', batchClear: 'Clear', batchMarkDone: 'Mark complete', batchMoveTo: 'Move to…', batchDelete: 'Delete', batchConfirmDelete: 'Delete {count} tasks?', batchDeleteMore: 'and {count} more…', batchSelectCard: 'Select task',
      boardSettings: 'Board settings', workspaceFilter: 'Filter by workspace', loadingWorkspaces: 'Loading workspaces…',
      dragColumn: 'Reorder column', dragColumnHint: 'Drag between columns, click to manage, or use the arrow keys.',
      columnDragPrompt: 'Drag between columns to reorder', columnDropBefore: 'Release to place before {column}', columnDropAfter: 'Release to place after {column}',
      byColumn: 'Tasks by column', otherColumns: 'Other columns', recentCompletions: 'Total completed', breakdown: 'Task breakdown',
      attentionQueue: 'Needs attention', recentDone: 'Recently completed', noAttentionQueue: 'No tasks need attention in this view.',
      noRecentDone: 'No tasks with a recorded completion date.', highPriority: 'High priority',
      mcpAccess: 'MCP access', mcpIntro: 'Connect a local MCP client to this task board. The key is not a DSH login token and survives DSH restarts.',
      mcpDisabled: 'Local MCP access is unavailable. Check that task MCP is enabled and credential storage is available.',
      mcpNotConfigured: 'No key is active.', mcpConfigured: 'A key is active.', mcpHidden: 'A key is active. It cannot be shown again.', mcpEndpoint: 'Local address',
      mcpGenerate: 'Generate key', mcpRotate: 'Regenerate key', mcpRevoke: 'Revoke key', mcpConfirmRotate: 'The old key will stop working. Update every client with the new configuration.', mcpConfirmRevoke: 'Clients using this key will lose access to the task board.',
      mcpOneTime: 'Copy this configuration now. It contains the key and will not be shown again after you close this dialog. Do not share it.',
      mcpConfig: 'MCP client configuration', mcpCopyConfig: 'Copy MCP configuration', mcpCopyDone: 'Configuration copied.', mcpCopyFailed: 'Could not copy automatically. Select and copy the configuration manually.',
      mcpBusy: 'Working…', mcpRetry: 'Reload status', mcpFailed: 'Unable to confirm the change. Reload status before trying again.',
      mcpListenFailed: 'The local MCP port is unavailable. Free the port or change mcpLocalPort in the plugin settings, then reload status.',
      localeCode: 'en', addValue: 'Create', findOption: 'Type to search', findOrCreate: 'Search or create…', emptyOptions: 'No matches', markDone: 'Mark complete', clearDate: 'Clear date',
      pickDate: 'Select date', pickMonth: 'Choose month', prevMonth: 'Previous month', nextMonth: 'Next month', prevYear: 'Previous year', nextYear: 'Next year', dateToday: 'Today', dateTomorrow: 'Tomorrow',
      preset_standard: 'Standard mode', preset_ptc: 'PTC mode', preset_minimal: 'Minimal mode', preset_cordis: 'Creator mode',
      boardColumns: 'Board columns', boardLabels: 'Board labels', columnsIntro: 'Arrange columns in the order tasks move through your board.', labelsIntro: 'Use color labels to group tasks across the board.', noLabels: 'No labels yet', noLabelsHint: 'Add your first label to use it on task cards.', resetFilters: 'Clear filters', filterCount: 'Active filters', taskCount: 'tasks', reorder: 'Reorder', moveGroup: 'Move to column',
      images: 'Task images', chooseImages: 'Add images', imageHint: 'Paste or drop images here.', imageLocalHint: 'Refreshing discards pending files.', imageUnavailable: 'Image storage is unavailable. You can still edit and save text.', imageInvalid: 'This file is empty, too large or not a supported image.', imageLimit: 'Image limit reached. Remove an image first.', imageFailed: 'Image change not confirmed.', imageQueued: 'Waiting to upload', imageSending: 'Uploading…', removeImage: 'Remove image', imageAdded: 'Attached image', imageRemoved: 'Removed image', launchImages: 'Send task images with the first message',
      launchFiles: 'Send task attachments with the first message',
      launchUploadPending: 'Some attachments are not ready. Wait for uploads, return to task details to retry, or uncheck the box to send text only.',
      promptFileUnavailable: 'A saved task file could not be attached to the conversation. Restore file access and retry this launch.',
      promptFileRejected: 'The conversation rejected a task file. Retry the launch, or end it and start again without the attachment.',
      noLaunchFiles: 'No attachments are saved for this launch.',
      promptImageUnavailable: 'Could not read the saved images. Restore attachment access and retry.', promptImageRejected: 'The model or session cannot accept these images. End this launch and choose a vision model, fewer images, or text only.',
      labelId: 'Label', labels: 'Manage labels', labelName: 'Label name', color: 'Color', addLabel: 'Add label', removeLabel: 'Remove label', labelProtected: 'Unassign this label from every task before deleting it.', priority: 'Priority', dueDate: 'Due date', today: 'Due today', overdue: 'Overdue', any: 'Any', none: 'None', preview: 'Markdown preview', copyCode: 'Copy code', copiedCode: 'Copied', footnotes: 'Footnotes', completedAt: 'Completed at', unknownTime: 'Unknown', activity: 'Activity', comment: 'Comment', post: 'Post comment', commentFailed: 'Comment not confirmed. Retry with the same text.', historyFailed: 'Could not load activity.', searchFailed: 'Comment search unavailable.', older: 'Older activity', eventCreated: 'Created', eventUpdated: 'Edited', eventMoved: 'Moved', eventCompleted: 'Completed', eventReopened: 'Reopened', eventBound: 'Linked conversation', sourceRpc: 'Host RPC', sourceService: 'Service', sourceAgent: 'MCP agent',
      columns: 'Manage columns', addColumn: 'Add column', rename: 'Rename', removeColumn: 'Delete empty column', columnName: 'Column name', columnColor: 'Column color', columnColorDefault: 'Stage default', columnColorCustom: 'Custom', applyColor: 'Apply', drag: 'Drag task', boardConflict: 'The board changed. Review the latest columns and try again.', boardFailed: 'Change not confirmed. Refresh before retrying.', columnProtected: 'Only empty custom columns can be deleted.', earlier: 'Move earlier', later: 'Move later',
      saveDetails: 'Save changes', discardDetails: 'Your edits will be lost. The saved task will not change.',
      unsavedDetails: 'Discard unsaved changes?', discardClose: 'Discard and close',
      savingDetails: 'Saving…', existingSessionNote: 'This task already has a conversation. Open it to continue.',
      launchNote: 'Review the first message before starting this task.', newSessionNote: 'When the new conversation starts, the previous conversation stays in task history.',
      newSessionAction: 'Create and start', resumeNote: 'Continue the same launch request without starting again.',
      conversationType: 'Conversation history', blankSession: 'Blank conversation', forkSession: 'Fork the previous conversation',
      forkModel: 'Keep the branch’s model',
      forkHint: 'The branch uses the previous conversation’s directory and preset. It inherits history through the last completed turn, not work in progress.',
      forkUnavailable: 'Cannot fork this conversation. The host must support forking and the source must have a completed turn.', forkChanged: 'The linked conversation changed. Close this form and review the task before starting again.',
      forkUnknown: 'A branch may have been created. No first message was sent. Ending this launch leaves the original conversation linked.', checkLaunch: 'Check launch status', checkLaunchNote: 'Check the saved launch before continuing. Checking does not create a branch or send a message.',
      restoreTitle: 'Restore the archived conversation?', restoreNote: 'This opens the original conversation and removes it from the archive. It does not create a branch.', restoreOpen: 'Restore and open', restoreFailed: 'Could not restore the conversation. It has not been opened.',
      editConflict: 'Task content changed elsewhere. Your draft is preserved; discard it only if you want to load the saved version.',
      editUnknown: 'The save result is unknown. Retry the same update to confirm it.', editFailed: 'Could not save changes.',
      reloadDetails: 'Discard edits and load saved version', drawerWidth: 'Drawer width', taskId: 'Task ID',
      discardReload: 'Discard your local edits and load the latest saved task?', keepEditing: 'Keep editing',
      editSourceChanged: 'The task data source changed. Your draft is preserved; return to the original source to resolve the save.',
      defaultEffort: 'Use model default effort', defaultEffortHint: 'Changing effort selects the current default model explicitly.',
      launchWorkspaceSync: 'Starting synchronizes the task’s workspace with this selection.',
      imageDraft: 'Upload after task creation', imagePreviewFailed: 'Image preview could not be loaded.', noImages: 'No images',
      imageNumber: 'Image {number}', imageUploaded: 'Uploaded', imagePendingCount: 'Pending: {count}',
      launchFileSnapshot: 'Attachments saved for this launch; later task changes do not affect them.',
      launchPreviewPending: 'Waiting to confirm the saved attachments. Refresh task data to check again.',
      launchWithoutFiles: 'Attachments will not be sent with this message.',
      detailTab: 'Details', detailViews: 'Task views', copyTaskId: 'Copy task ID', taskIdCopied: 'Task ID copied',
      historyLoading: 'Loading activity…', historyEmpty: 'No activity recorded yet.', historyMoreFailed: 'Could not load older activity.',
      historyRefreshFailed: 'Could not refresh activity.', unknownColumn: 'Unavailable column', commentPlaceholder: 'Add a comment…',
      activityRpc: 'App interface', activityService: 'Service', activityAgent: 'Agent',
      files: 'Task files', chooseFiles: 'Add files', fileHint: 'Drop or paste files here', filesUnavailable: 'File storage is unavailable. You can still edit and save text.', fileInvalid: 'This file is empty, exceeds the size limit, or cannot be uploaded.', fileLimit: 'File limit reached. Remove a file first.', fileFailed: 'File change not confirmed.', fileListFailed: 'Could not load task files.', downloadFile: 'Download file', removeFile: 'Remove file', fileAdded: 'Attached file', fileRemoved: 'Removed file', filePendingCount: 'Pending: {count}',
      activityHeading: 'Task timeline', activityAll: 'All activity', activityComments: 'Comments only', noActivityComments: 'No comments in the loaded activity.', activityToday: 'Today', activityYesterday: 'Yesterday',
      paperTitle: 'Task notebook', paperNote: 'Write it down. One thing at a time.',
      deleteTask: 'Delete task', confirmDelete: 'Delete this task?', deleting: 'Deleting…', cancelDelete: 'Cancel',
      deleteNotice: 'This removes the task card. Linked conversations are kept and will continue running.',
      deleteFailed: 'Deletion failed. The task is still here; please retry.', deleteUnknown: 'Deletion result is unknown. Retry to confirm the same deletion.',
      deleteConflict: 'This task changed. Close this dialog, refresh, and review it before deleting.',
      taskDeleted: 'This task was deleted.', deletePendingLaunch: 'Resolve or end the pending launch before deleting this task.',
      launch: 'Start task', start: 'Start', starting: 'Starting…', openSession: 'Open conversation',
      openLinkedTask: 'Open linked task', openNamedLinkedTask: 'Open linked task: {title}',
      openLinkedTaskFailed: 'Could not open the linked task. Reopen the conversation menu and try again.',
      resumeLaunch: 'Resume launch', newSession: 'Start a new conversation', firstMessage: 'First message',
      preset: 'Agent preset', defaultPreset: 'Default preset', modelDefaultNotice: 'Selecting a model also updates the DSH default model.',
      launchFailed: 'Launch is incomplete. Resume this request or open the saved conversation to inspect it.',
      launchUnknown: 'Launch result is unknown. Retry the same request to recover it.',
      sessionBusy: 'The existing conversation is active. Open it to continue.',
      sessionStatusUnknown: 'The previous conversation’s status is unavailable. It will be checked again before creating a new one.',
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
      search: 'Search ID, title, description or comments…', searchPlaceholder: 'Search tasks…',
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
      taskBrief: 'Description',
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
      model: 'Model',
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
      briefPlaceholder: 'Add background, context, or implementation notes…',
      descriptionMode: 'Description mode', descriptionEdit: 'Edit', descriptionPreview: 'Preview',
      editDescription: 'Edit description', noDescription: 'No description yet',
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
      needsMyAction: '需要我处理', reviewPending: '待验收', reviewReturned: '待返工', reviewAccepted: '已验收',
      viewProgress: '查看进度', reviewDelivery: '验收成果', inspectDependencies: '查看前置任务',
      unlinkedConversation: '未关联对话', createConversation: '新建对话',
      createConversationNote: '此任务已在进行中，但尚未关联对话。确认后才会新建对话并发送首条消息。',
      deliveryTab: 'Agent 交付',
      acceptanceCriteria: '验收标准', criteriaPlaceholder: '写下完成这张卡必须满足的条件。',
      addCriteria: '添加验收标准', editCriteria: '编辑标准', addPrerequisites: '添加前置任务',
      dependentTasks: '下游任务', blockingCount: '待解锁 {count}', unlockedNotice: '已解锁 {count} 项下游任务',
      quickAddPlaceholder: '输入任务标题，回车直接创建…', quickAddSubmit: '添加', quickAddAdding: '创建中…', expandCreateForm: '完整表单',
      attentionPillFilter: '仅看此类待处理', attentionPillShowAll: '显示全部待处理', attentionShowAll: '查看全部 ({count})',
      sectionProperties: '属性与执行', createColumn: '所属列', changeColumn: '切换列',
      discardEdits: '取消修改', unsavedBadge: '未保存', commentShortcut: 'Ctrl/⌘ + Enter',
      showMore: '展开', showLess: '收起', viewDelivery: '查看交付详情', sessionChip: '会话',
      deliveryCriteriaRef: '对照任务验收标准', deliverySubmittedAt: '提交于', deliveryReviewedAt: '验收于',
      deliveryLinksHeading: '参考链接',
      criteriaLaunchHint: '这些标准会发给 Agent，并请它把交付证据提交回任务卡。',
      dependencyIds: '前置任务', addDependency: '添加前置任务', removeDependency: '移除前置任务',
      dependencyMissing: '任务已删除或不可用', dependencyReady: '可开始', dependencyBlocked: '等待前置任务',
      dependencyCycle: '这些前置任务会形成循环依赖。', dependencyUnavailable: '一项前置任务已不可用。',
      deliveryHeading: 'Agent 交付', deliveryRuntime: '本次执行', deliveryEvidence: 'Agent 提交的交付证据',
      deliveryVerification: '验证结果', deliveryUnverified: '未验证或仍待解决', deliveryCriteriaSnapshot: '本次发给 Agent 的验收标准',
      deliveryNotSubmitted: '尚未提交交付成果。会话空闲不等于任务完成。',
      deliveryWait: '可在原会话请 Agent 把交付证据提交到这张卡。',
      deliveryFeedback: '验收意见', deliveryFeedbackHint: '写明需要修改什么，再请 Agent 重新提交。',
      acceptDelivery: '接受并完成', returnDelivery: '退回修改', sendReviewFeedback: '把意见发给 Agent',
      feedbackSent: '验收意见已发到原会话。', deliveryMutationFailed: '未能确认操作。请查看最新交付状态后再试。',
      deliveryActionRequired: '请先验收交付成果，或处理已退回的修改。',
      eventDeliverySubmitted: '提交了交付成果', eventDeliveryAccepted: '接受了交付成果', eventDeliveryReturned: '退回了交付成果',
      eventDeliveryContinued: '发送了验收意见',
      insights: '手记概览', delivery: '整体交付完成率', openTasks: '未完成', metrics: '核心度量指标', needsAction: '阻断 / 待推进', closedToday: '今日已闭环', cycle: '平均周转周期', dayUnit: '天', mix: '优先级分布', bindingsMix: '工作区与模型分布', weekly: '处理速率 · 近 7 天完成数',
      dueOverview: '到期分布', dueScope: '未完成任务 · 逾期与未来 7 天', tomorrow: '明天到期', nextWeek: '后 2–7 天', noOpenTasks: '当前范围内没有未完成任务。', noDueDates: '当前未完成任务均未设截止日期。', noNearDates: '没有逾期或未来 7 天内到期的任务。', removeDue: '取消截止日期筛选', removeFilter: '移除筛选',
      doneGroupToday: '今天', doneGroupWeek: '本周', doneGroupEarlier: '更早', elapsedUnderMinute: '<1m',
      sortBy: '排序', sortManual: '默认手动排序', sortPriority: '按优先级（P0 优先）', sortDueDate: '按截止日期（最近优先）', sortUpdated: '按最近更新', removeSort: '恢复默认排序',
      shortcuts: '快捷键', shortcutsIntro: '在未打开弹窗且未聚焦输入框时可用。', shortcutSearch: '聚焦搜索框', shortcutNew: '新建任务', shortcutRefresh: '刷新看板', shortcutInsights: '切换概览面板', shortcutHelp: '打开快捷键说明',
      batchSelect: '批量操作', batchExit: '退出批量', batchSelected: '已选 {count} 项', batchSelectAll: '全选可见', batchClear: '清空', batchMarkDone: '标记完成', batchMoveTo: '移到列…', batchDelete: '删除', batchConfirmDelete: '确认删除已选的 {count} 项任务？', batchDeleteMore: '以及其余 {count} 项…', batchSelectCard: '选中任务',
      boardSettings: '看板设置', workspaceFilter: '按工作区筛选', loadingWorkspaces: '正在加载工作区…',
      dragColumn: '调整列顺序', dragColumnHint: '拖到两列之间调整顺序；单击打开管理，也可用左右键移动。',
      columnDragPrompt: '拖到两列之间调整顺序', columnDropBefore: '松手放在「{column}」前', columnDropAfter: '松手放在「{column}」后',
      byColumn: '任务列分布', otherColumns: '其余列', recentCompletions: '完成合计', breakdown: '任务分布',
      attentionQueue: '待处理清单', recentDone: '最近完成', noAttentionQueue: '当前没有需要处理的任务。',
      noRecentDone: '暂无带完成时间的任务。', highPriority: '高优先级',
      mcpAccess: 'MCP 接入', mcpIntro: '让本机的 MCP 客户端连接任务看板。密钥不能登录 DSH，DSH 重启后仍可使用。',
      mcpDisabled: '本机 MCP 接入不可用。请检查任务 MCP 是否启用、凭据存储是否可用。',
      mcpNotConfigured: '尚未启用密钥。', mcpConfigured: '密钥已启用。', mcpHidden: '密钥已启用，无法再次查看。', mcpEndpoint: '本机连接地址',
      mcpGenerate: '生成密钥', mcpRotate: '重新生成密钥', mcpRevoke: '撤销密钥', mcpConfirmRotate: '旧密钥将立即失效，所有客户端都要更新配置。', mcpConfirmRevoke: '使用此密钥的客户端将失去任务看板的访问权限。',
      mcpOneTime: '请现在复制配置。配置包含密钥，关闭窗口后不再显示，请勿分享。',
      mcpConfig: 'MCP 客户端配置', mcpCopyConfig: '复制 MCP 配置', mcpCopyDone: '已复制配置。', mcpCopyFailed: '未能自动复制，请选中配置后手动复制。',
      mcpBusy: '处理中…', mcpRetry: '重新读取状态', mcpFailed: '未能确认操作结果，请重新读取状态后再试。',
      mcpListenFailed: '本机 MCP 端口不可用。请释放端口，或修改插件的 mcpLocalPort，再重新读取状态。',
      localeCode: 'zh', addValue: '新建', findOption: '输入关键词检索', findOrCreate: '输入以检索或新建', emptyOptions: '无匹配项', markDone: '标记完成', clearDate: '清除日期',
      pickDate: '选择日期', pickMonth: '选择月份', prevMonth: '上个月', nextMonth: '下个月', prevYear: '上一年', nextYear: '下一年', dateToday: '今天', dateTomorrow: '明天',
      preset_standard: '标准模式', preset_ptc: 'PTC 模式', preset_minimal: '极简模式', preset_cordis: '创造模式',
      boardColumns: '看板列', boardLabels: '已有标签', columnsIntro: '按工作流程排列各列，拖动把手或使用箭头调整顺序。', labelsIntro: '用颜色标记同一类任务，标签在整个看板中共用。', noLabels: '还没有标签', noLabelsHint: '添加第一个标签后，就能在任务卡上使用。', resetFilters: '清除筛选', filterCount: '已启用筛选', taskCount: '张任务', reorder: '列内排序', moveGroup: '移到列',
      images: '任务图片', chooseImages: '添加图片', imageHint: '可粘贴或拖入图片。', imageLocalHint: '刷新页面会丢失待上传文件。', imageUnavailable: '宿主图片服务不可用，仍可编辑和保存文字。', imageInvalid: '文件为空、超过大小限制，或不是支持的图片格式。', imageLimit: '图片数量已达上限，请先移除图片。', imageFailed: '未确认图片操作成功。', imageQueued: '等待上传', imageSending: '上传中…', removeImage: '移除图片', imageAdded: '添加图片', imageRemoved: '移除图片', launchImages: '随首条消息发送任务图片',
      launchFiles: '随首条消息发送任务附件',
      launchUploadPending: '还有附件未上传成功。请等待上传、回到详情重试，或取消勾选以仅发送文字。',
      promptFileUnavailable: '无法把已保存的文件附加到会话，请恢复文件访问后重试本次启动。',
      promptFileRejected: '会话未接收某个任务文件。请重试本次启动，或结束后调整附件再重新启动。',
      noLaunchFiles: '本次启动没有已保存的附件。',
      promptImageUnavailable: '无法读取已保存的图片，请恢复附件访问后重试。', promptImageRejected: '当前模型或会话无法接收这些图片。请结束本次启动，再选择支持图片的模型、减少图片或仅发送文字。',
      labelId: '标签', labels: '管理标签', labelName: '标签名', color: '颜色', addLabel: '添加标签', removeLabel: '删除标签', labelProtected: '请先解除所有任务对该标签的引用。', priority: '优先级', dueDate: '截止日期', today: '今天到期', overdue: '已逾期', any: '全部', none: '无', preview: 'Markdown 预览', copyCode: '复制代码', copiedCode: '已复制', footnotes: '脚注', completedAt: '完成时间', unknownTime: '未知', activity: '动态', comment: '评论', post: '发布评论', commentFailed: '评论未确认，可用原内容重试。', historyFailed: '动态读取失败。', searchFailed: '暂时无法搜索评论。', older: '更早的动态', eventCreated: '创建任务', eventUpdated: '修改字段', eventMoved: '移列', eventCompleted: '完成任务', eventReopened: '重开任务', eventBound: '绑定会话', sourceRpc: '宿主 RPC', sourceService: '服务调用', sourceAgent: 'MCP Agent',
      columns: '管理列', addColumn: '添加列', rename: '改名', removeColumn: '删除空列', columnName: '列名称', columnColor: '列颜色', columnColorDefault: '跟随阶段默认', columnColorCustom: '自定义', applyColor: '应用', drag: '拖动任务', boardConflict: '看板已变化，请核对最新列和卡片后再操作。', boardFailed: '变更未确认，请刷新后再操作。', columnProtected: '只能删除没有任务的自定义列。', earlier: '向前移动', later: '向后移动',
      saveDetails: '保存修改', discardDetails: '本次编辑的内容将丢失，已保存的任务不会改变。',
      unsavedDetails: '放弃未保存的修改？', discardClose: '放弃并关闭',
      savingDetails: '正在保存…', existingSessionNote: '此任务已有对话，打开即可继续。',
      launchNote: '请在启动任务前确认要发送的首条消息。', newSessionNote: '新对话启动后，仍可从任务历史打开原对话。',
      newSessionAction: '新建并启动', resumeNote: '继续同一次启动请求，不会重新发起启动。',
      conversationType: '对话历史', blankSession: '空白对话', forkSession: '从上一对话 Fork',
      forkModel: '沿用分支的模型',
      forkHint: '分支沿用上一对话的目录和预设，只继承截至最近一个已完成轮次的有效历史，不复制正在进行的工作。',
      forkUnavailable: '无法从此对话创建分支。宿主需支持 Fork，且原对话至少要有一个已完成轮次。', forkChanged: '任务绑定的对话已变化。请关闭弹框并核对任务后再启动。',
      forkUnknown: '可能已创建分支，尚未发送首条消息。结束本次启动不会改变原对话绑定。', checkLaunch: '查询启动状态', checkLaunchNote: '请先查询已保存的启动记录。查询不会创建分支或发送消息。',
      restoreTitle: '恢复已归档的对话？', restoreNote: '此操作会将原对话移出归档并打开，不会创建分支。', restoreOpen: '恢复并打开', restoreFailed: '未能恢复对话，未打开原对话。',
      editConflict: '任务内容已在其他地方修改，你的草稿已保留。仅在确认放弃本地修改后载入最新版本。',
      editUnknown: '保存结果未知，请重试同一次更新以确认结果。', editFailed: '未能保存修改。',
      reloadDetails: '放弃本地修改并载入', drawerWidth: '抽屉宽度', taskId: '任务 ID',
      discardReload: '放弃本地修改，并载入最新保存的任务？', keepEditing: '继续编辑',
      editSourceChanged: '任务数据源已变化，草稿已保留。请返回原任务数据源处理待确认的保存。',
      defaultEffort: '使用模型默认强度', defaultEffortHint: '调整思考强度时，会选定当前的默认模型。',
      launchWorkspaceSync: '启动后同步更新任务所属工作区。',
      imageDraft: '创建任务后上传', imagePreviewFailed: '无法加载图片预览。', noImages: '暂无图片',
      imageNumber: '图片 {number}', imageUploaded: '已上传', imagePendingCount: '{count} 张待上传',
      launchFileSnapshot: '本次启动已保存的附件，不受后续任务修改影响。',
      launchPreviewPending: '正在确认本次启动保存的附件，可刷新任务数据后重试。',
      launchWithoutFiles: '本条消息不会发送附件。',
      detailTab: '详情', detailViews: '任务视图', copyTaskId: '复制任务 ID', taskIdCopied: '已复制任务 ID',
      historyLoading: '正在加载动态…', historyEmpty: '暂无动态记录。', historyMoreFailed: '未能加载更早的动态。',
      historyRefreshFailed: '未能刷新动态。', unknownColumn: '不可用的列', commentPlaceholder: '写条评论…',
      activityRpc: '应用接口', activityService: '服务调用', activityAgent: 'Agent',
      files: '任务文件', chooseFiles: '添加文件', fileHint: '可拖入或粘贴文件', filesUnavailable: '宿主文件服务不可用，仍可编辑和保存文字。', fileInvalid: '文件为空、超过大小限制或无法上传。', fileLimit: '文件数量已达上限，请先移除文件。', fileFailed: '未确认文件操作成功。', fileListFailed: '无法加载任务文件。', downloadFile: '下载文件', removeFile: '移除文件', fileAdded: '添加文件', fileRemoved: '移除文件', filePendingCount: '{count} 个待上传',
      activityHeading: '任务时间线', activityAll: '全部动态', activityComments: '仅评论', noActivityComments: '已加载的动态中暂无评论。', activityToday: '今天', activityYesterday: '昨天',
      paperTitle: '任务手记', paperNote: '记下计划，专注眼前。',
      deleteTask: '删除任务', confirmDelete: '确认删除任务？', deleting: '正在删除…', cancelDelete: '取消',
      deleteNotice: '删除后，任务卡片将移除。关联对话会保留，正在执行的对话会继续运行。',
      deleteFailed: '删除失败，任务仍保留，请重试。', deleteUnknown: '删除结果尚未确认，请重试确认同一次删除。',
      deleteConflict: '任务已有更新，请关闭弹框并刷新，确认内容后再删除。',
      taskDeleted: '该任务已被删除。', deletePendingLaunch: '请先恢复或结束尚未完成的启动，再删除任务。',
      launch: '开始任务', start: '开始', starting: '正在启动…', openSession: '打开对话',
      openLinkedTask: '打开关联任务', openNamedLinkedTask: '打开关联任务：{title}',
      openLinkedTaskFailed: '无法打开关联任务。请重新打开对话菜单后再试。',
      resumeLaunch: '恢复启动', newSession: '新开一个对话', firstMessage: '首条消息',
      preset: '智能体预设', defaultPreset: '默认预设', modelDefaultNotice: '选择具体模型也会更新 DSH 的全局默认模型。',
      launchFailed: '启动尚未完成。可恢复本次启动，或打开已保存的对话查看。',
      launchUnknown: '启动结果尚未确认。重试同一请求可恢复进度。',
      sessionBusy: '已有对话正在执行或等待输入，请打开对话继续。',
      sessionStatusUnknown: '原对话状态暂不可用，创建前会重新检查。',
      sessionExists: '可接着使用已有对话，也可明确选择新开一个对话。',
      navigationFailed: '暂时无法打开对话，请返回看板重试。',
      sessionUnavailable: '会话服务暂不可用。', presetUnavailable: '所选预设不可用。',
      launchPending: '请先恢复尚未完成的启动。', launchSaved: '启动请求和会话引用已保存，恢复时会复用同一次请求。',
      running: '执行中', approval: '待审批', question: '待回答', error: '出错', idle: '空闲',
      missing: '对话不存在', archived: '对话已归档', unknown: '状态暂不可用',
      attention: '件事在等你处理', history: '历史对话', session: '对话',
      abandonLaunch: '结束本次启动', abandonHint: '尚未投递消息。结束本次启动后，会话引用保留在任务历史中。',
      launchAbandoned: '本次启动已结束，可从卡片重新启动。', reasoningEffort: '思考强度',
      title: '任务',
      subtitle: '按三列整理任务，修改会自动保存。',
      newTask: '新建任务',
      search: '搜索 ID、标题、描述或评论…', searchPlaceholder: '搜索任务…',
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
      taskBrief: '描述',
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
      model: '模型',
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
      briefPlaceholder: '补充背景、上下文或实现思路…',
      descriptionMode: '描述模式', descriptionEdit: '编辑', descriptionPreview: '预览',
      editDescription: '编辑描述', noDescription: '暂无描述',
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
.dsh-tasks-heading { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dsh-tasks-title { font-size: 18px; font-weight: 700; letter-spacing: -0.02em; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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
.dsh-tasks-col[data-column-color] {
  border-top: 3px solid color-mix(in srgb, var(--dsh-tasks-col-color) 75%, transparent);
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
}
.dsh-tasks-card:hover { border-color: var(--dsw-alias-border-l2); box-shadow: 0 2px 4px rgb(0 0 0 / 6%); }
.dsh-tasks-card[data-stage="done"] .dsh-tasks-card-title { display: flex; align-items: flex-start; gap: 5px; color: var(--dsw-alias-label-secondary); font-weight: 500; text-decoration: none; }
.dsh-tasks-done-check { display: inline-flex; align-items: center; margin-top: 4px; flex: none; color: var(--dsh-paper-success, var(--dsw-alias-state-success-primary)); opacity: .78; }
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
  white-space: normal;
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
  background: var(--dsh-tasks-dot-fill, transparent);
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
.dsh-tasks-history-choice { display: grid; gap: 6px; margin: 0; padding: 0; border: 0; }
.dsh-tasks-history-choice label { display: flex; align-items: center; gap: 6px; }
.dsh-tasks-fields input:not([type=checkbox], [type=radio]), .dsh-tasks-fields textarea, .dsh-tasks-stage {
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
.dsh-tasks-mcp-body { overflow-wrap: anywhere; }
.dsh-tasks-mcp-body textarea { font-family: ui-monospace, monospace; }
.dsh-tasks-mcp-actions { flex-wrap: wrap; }
.dsh-tasks-fields { gap: 18px; }
.dsh-tasks-form-actions { display: flex; align-items: center; gap: 8px; padding: 16px 24px; border-top: 1px solid var(--dsw-alias-border-l1); }
.dsh-tasks-feedback { margin: 8px 0 0; font-size: 12px; overflow-wrap: anywhere; }
.dsh-tasks-stage-label { display: grid; gap: 4px; margin-top: 10px; font-size: 11px; }
.dsh-tasks-hint { flex-basis: 100%; }
.dsh-tasks-icon { display: inline-flex; align-items: center; justify-content: center; flex: none; }
.dsh-tasks-logo { width: 26px; height: 26px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); }
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
.dsh-tasks-card-title { display: block; flex: 1; min-width: 0; min-height: 28px; height: auto; border: 0; padding: 2px 0; margin: 0;
  text-align: start; background: transparent; color: inherit; font-family: inherit; cursor: pointer; line-height: 1.55; }
@media (pointer: coarse) { .dsh-tasks-card-title { min-height: 44px; } }
.dsh-tasks-card-actions { flex: none; position: relative; }
.dsh-tasks-card-actions > summary { list-style: none; width: 20px; height: 20px; padding: 0; opacity: .32; transition: opacity .15s ease; }
.dsh-tasks-card-actions > summary::-webkit-details-marker { display: none; }
.dsh-tasks-card:hover .dsh-tasks-card-actions > summary, .dsh-tasks-card:focus-within .dsh-tasks-card-actions > summary, .dsh-tasks-card-actions[open] > summary { opacity: 1; }
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
.dsh-tasks-dialog-head > .dsh-tasks-icon-button { margin-left: auto; }
.dsh-tasks-dialog-head .dsh-tasks-logo { width: 36px; height: 36px; border-radius: 9px; }
.dsh-tasks-dialog-body { padding: 0 24px 24px; }
.dsh-tasks-grip { cursor: grab; touch-action: none; border: 0; background: none; color: inherit; font-size: 18px; padding: 2px 6px; }
.dsh-tasks-grip:disabled { cursor: default; touch-action: auto; }
.dsh-tasks-card[data-dragging] { opacity: .45; }
.dsh-tasks-root [data-drop="true"] { outline: 2px dashed var(--dsh-tasks-focus); outline-offset: -2px; }
.dsh-tasks-drag-preview { pointer-events: none; padding: 12px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); border-radius: 8px; box-shadow: 0 4px 18px #0003; }
.dsh-tasks-column-form { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px; border: 1px solid var(--dsh-tasks-line); border-radius: var(--dsw-radius-md, 10px); background: var(--dsh-tasks-paper); }
.dsh-tasks-column-form .dsh-tasks-input { flex: 1 1 150px; min-width: 0; }
.dsh-tasks-column-form .dsh-tasks-input:has([type=color]) { flex: 0 0 52px; }
.dsh-tasks-column-form small { color: var(--dsh-tasks-muted); }
.dsh-tasks-column-form .dsh-tasks-select { flex: 0 1 120px; }
.dsh-tasks-manage-actions { flex: 1 0 100%; display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; align-items: center; }
.dsh-tasks-manage-actions small { margin-right: auto; }
.dsh-tasks-images { display: grid; gap: 8px; margin-block: 12px 0; }
.dsh-tasks-images h3, .dsh-tasks-images p { margin: 0; }
.dsh-tasks-image-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 4px 12px; }
.dsh-tasks-image-head h3 { display: inline-flex; align-items: center; gap: 6px; font-size: 14px; font-weight: 650; }
.dsh-tasks-image-head h3 > .dsh-tasks-icon { color: var(--dsh-tasks-focus); }
.dsh-tasks-file-icon { display: grid; place-items: center; width: 40px; height: 36px; border-radius: 6px; background: var(--dsh-tasks-highlight); color: var(--dsh-tasks-focus); }
.dsh-tasks-root .dsh-tasks-file-download { min-width: 32px; text-decoration: none; }
.dsh-tasks-image-add:not([data-empty]) { padding-inline: 2px; }
.dsh-tasks-image-head > div { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; min-width: 0; }
.dsh-tasks-image-head .dsh-tasks-image-count { font-variant-numeric: tabular-nums; }
.dsh-tasks-image-add[data-empty] { padding: 8px 10px; border: 1px dashed var(--dsh-tasks-line); border-radius: var(--dsw-radius-sm, 8px); }
.dsh-tasks-root .dsh-tasks-images .dsh-tasks-image-action {
  box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  min-height: 32px; height: auto; padding: 4px 7px; border: 1px solid transparent; border-radius: 6px;
  background: transparent; color: var(--dsh-tasks-muted); box-shadow: none; white-space: nowrap;
}
.dsh-tasks-root .dsh-tasks-images .dsh-tasks-image-add-button { color: var(--dsh-tasks-focus); font-weight: 650; border-color: color-mix(in srgb, var(--dsh-tasks-focus) 30%, var(--dsh-tasks-rule)); background: color-mix(in srgb, var(--dsh-tasks-focus) 6%, var(--dsh-tasks-paper)); }
.dsh-tasks-root .dsh-tasks-images .dsh-tasks-image-remove { min-width: 32px; }
.dsh-tasks-root .dsh-tasks-images .dsh-tasks-image-action:hover:not(:disabled) { background: var(--dsh-tasks-highlight); opacity: 1; }
.dsh-tasks-root .dsh-tasks-images .dsh-tasks-image-remove:hover:not(:disabled) { color: var(--dsw-alias-state-error-primary, var(--dsh-tasks-ink)); }
.dsh-tasks-root .dsh-tasks-images .dsh-tasks-image-action:focus-visible { outline: 2px solid var(--dsh-tasks-focus); outline-offset: -2px; }
@media (pointer: coarse) { .dsh-tasks-root .dsh-tasks-images .dsh-tasks-image-action { min-width: 44px; min-height: 44px; } }
@media (forced-colors: active) { .dsh-tasks-root .dsh-tasks-images .dsh-tasks-image-action:focus-visible { outline-color: Highlight; } }
.dsh-tasks-image-grid { display: grid; gap: 6px; list-style: none; padding: 0; margin: 0; }
.dsh-tasks-attachment-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 5px 8px; border: 1px solid var(--dsh-tasks-rule); border-radius: var(--dsw-radius-sm, 8px); }
.dsh-tasks-attachment-info { grid-column: 2; min-width: 0; overflow-wrap: anywhere; }
.dsh-tasks-attachment-info > span { display: block; }
.dsh-tasks-attachment-actions { grid-column: 3; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; }
.dsh-tasks-thumb { display: block; height: auto; padding: 2px; }
.dsh-tasks-thumb img { display: block; width: 48px; height: 40px; object-fit: contain; }
@container task-detail (max-width: 360px) { .dsh-tasks-attachment-actions { flex-direction: column; align-items: flex-end; } }
/* Task confirmation and launch sheets; no decoration on generic dialogs or the drawer. */
.dsh-tasks-root .dsh-tasks-confirm-dialog { max-width: 28rem; }
.dsh-tasks-dialog-sticker { flex: none; pointer-events: none; }
.dsh-tasks-root .dsh-tasks-dialog-note { margin: 0 0 14px; color: var(--dsh-tasks-muted); line-height: 1.5; }
.dsh-tasks-confirm-dialog .dsh-tasks-dialog-note { margin: 0; }
.dsh-tasks-root :is(.dsh-tasks-confirm-dialog, .dsh-tasks-launch-dialog) .dsh-tasks-dialog-head > div { min-width: 0; overflow-wrap: anywhere; }
body[data-dsh-paper-theme="paper"] .dsh-tasks-root dialog:is(.dsh-tasks-confirm-dialog, .dsh-tasks-launch-dialog) {
  border-radius: 6px 11px 7px 9px; box-shadow: 1px 3px 0 var(--dsh-tasks-line), 0 16px 44px -12px var(--dsh-tasks-shadow);
  & .dsh-tasks-dialog-head { background-color: var(--dsh-tasks-sheet); background-image: linear-gradient(var(--dsh-paper-sheetWash,transparent),var(--dsh-paper-sheetWash,transparent)), var(--dsh-tasks-slip); background-size: auto, 128px 128px; border-bottom: 1px dashed var(--dsh-tasks-line); margin-bottom: 16px; }
  & .dsh-tasks-form-actions { flex-wrap: wrap; border-top: 1px solid var(--dsh-tasks-rule); }
}
body[data-dsh-paper-theme="paper"] .dsh-tasks-root .dsh-tasks-confirm-dialog .dsh-tasks-dialog-head { border-top: 4px solid var(--dsh-paper-warning); }
.dsh-tasks-launch-dialog[open] { display: flex; flex-direction: column; overflow: hidden; }
.dsh-tasks-launch-dialog > .dsh-tasks-form { display: flex; flex-direction: column; min-height: 0; }
.dsh-tasks-launch-dialog .dsh-tasks-dialog-body { overflow-y: auto; min-height: 0; }
.dsh-tasks-launch-dialog .dsh-tasks-form-actions { flex-shrink: 0; }
.dsh-tasks-image-dialog { width: fit-content; min-width: min(320px, calc(100vw - 32px)); max-width: min(960px, calc(100vw - 32px)); }
.dsh-tasks-image-dialog img { display: block; max-width: 100%; max-height: calc(100dvh - 170px); object-fit: contain; margin: auto; }
.dsh-tasks-root .dsh-tasks-card-title { justify-content: flex-start; }
.dsh-tasks-root .dsh-tasks-input { box-sizing: border-box; color: var(--dsh-tasks-ink); background: var(--dsh-tasks-paper); border: 1px solid var(--dsh-tasks-line); }
.dsh-tasks-root .dsh-tasks-input:focus-within { border-color: var(--dsh-tasks-focus); }
.dsh-tasks-root .dsh-tasks-input > input { box-sizing: border-box; width: 100%; min-width: 0; height: 100%; border: none; box-shadow: none; padding: 0; color: inherit; background: transparent; font: inherit; }
.dsh-tasks-root.dsh-tasks-drawer-layer { position: fixed; inset: 0; z-index: 1000; height: auto; align-items: flex-end; }
.dsh-tasks-root .dsh-tasks-drawer { display: flex; flex-direction: column; box-sizing: border-box; width: min(var(--drawer-width), calc(100vw - 48px)); height: 100%; max-height: none; overflow: hidden; border-radius: 0; }
.dsh-tasks-drawer .dsh-tasks-form { display: flex; flex: 1; flex-direction: column; min-height: 0; }
.dsh-tasks-drawer .dsh-tasks-dialog-body { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; }
.dsh-tasks-drawer .dsh-tasks-form-actions { flex: none; flex-wrap: wrap; justify-content: flex-end; min-height: 56px; box-sizing: border-box; padding-block: 10px; }
.dsh-tasks-root .dsh-tasks-detail-head { flex: none; align-items: flex-start; gap: 10px; padding: 18px 24px 12px; }
.dsh-tasks-drawer .dsh-tasks-dialog-head > div { flex: 1; min-width: 0; }
.dsh-tasks-detail-heading { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.dsh-tasks-root .dsh-tasks-detail-heading h2 { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; line-height: 1.5; }
.dsh-tasks-detail-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; margin-top: 6px; color: var(--dsh-tasks-muted); font-size: 12px; }
.dsh-tasks-detail-meta .dsh-tasks-card-state { margin: 0; }
.dsh-tasks-root .dsh-tasks-copy-id { display: inline-flex; align-items: center; justify-content: center; flex: none; gap: 4px; min-width: 44px; min-height: 28px; height: auto; padding: 2px 6px; border: 1px solid transparent; border-radius: var(--dsw-radius-sm, 6px); background: none; color: inherit; font: inherit; white-space: nowrap; cursor: pointer; }
.dsh-tasks-root .dsh-tasks-copy-id:hover { color: var(--dsh-tasks-ink); background: var(--dsh-tasks-paper); border-color: var(--dsh-tasks-line); }
.dsh-tasks-detail-copy[role="status"] { user-select: all; }
.dsh-tasks-detail-menu { flex: none; position: relative; z-index: 5; }
.dsh-tasks-detail-menu > summary { list-style: none; }
.dsh-tasks-detail-menu > summary::-webkit-details-marker { display: none; }
.dsh-tasks-detail-menu .dsh-tasks-menu { top: calc(100% + 4px); }
.dsh-tasks-detail-tabs { flex: none; display: flex; gap: 14px; margin: 0 24px 12px; border-block-end: 1px solid var(--dsh-tasks-rule); }
.dsh-tasks-detail-tabs button { position: relative; padding: 6px 4px; min-height: 36px; color: var(--dsh-tasks-muted); background: none; border: 0; font: inherit; cursor: pointer; }
.dsh-tasks-detail-tabs button:hover, .dsh-tasks-detail-tabs button[aria-selected="true"] { color: var(--dsh-tasks-ink); }
.dsh-tasks-detail-tabs button[aria-selected="true"] { font-weight: 650; }
.dsh-tasks-detail-tabs button[aria-selected="true"]::after { content: ''; position: absolute; inset: auto 0 -1px; border-block-end: 2px solid var(--dsh-tasks-focus); pointer-events: none; }
.dsh-tasks-detail-tabs button:focus-visible, .dsh-tasks-detail-menu summary:focus-visible { outline: 2px solid var(--dsh-tasks-focus); outline-offset: -3px; }
@media (forced-colors: active) { .dsh-tasks-detail-tabs button[aria-selected="true"]::after { border-color: Highlight; } }
.dsh-tasks-detail-panel { container: task-detail / inline-size; }
.dsh-tasks-task-fields { min-inline-size: 0; gap: 12px; }
.dsh-tasks-attachment-fieldset { min-inline-size: 0; border: 0; padding: 0; margin: 0; }
.dsh-tasks-task-fields :is(.dsh-tasks-properties, .dsh-tasks-bindings) { gap: 12px; }
.dsh-tasks-description { display: grid; min-inline-size: 0; gap: 6px; }
.dsh-tasks-description-head { display: flex; align-items: center; justify-content: space-between; gap: 4px 12px; flex-wrap: wrap; }
.dsh-tasks-description-actions { display: inline-flex; gap: 4px; }
.dsh-tasks-description-action { min-block-size: 28px; padding: 2px 8px; border: 1px solid transparent; border-radius: var(--dsw-radius-xs, 6px); background: transparent; color: var(--dsh-tasks-muted); font: inherit; font-size: 12px; cursor: pointer; }
.dsh-tasks-description-action:hover:not(:disabled) { color: var(--dsh-tasks-ink); border-color: var(--dsh-tasks-rule); background: color-mix(in srgb, var(--dsh-tasks-muted) 8%, transparent); }
.dsh-tasks-description-action:disabled { opacity: .55; cursor: default; }
@media (pointer: coarse) { .dsh-tasks-description-action { min-block-size: 44px; } }
.dsh-tasks-description-body { min-inline-size: 0; }
.dsh-tasks-task-fields .dsh-tasks-description-input { display: block; field-sizing: content; min-block-size: 60px; min-block-size: calc(2lh + 18px); resize: none; overflow-y: hidden; }
.dsh-tasks-description-markdown { min-inline-size: 0; overflow-wrap: anywhere; overflow-x: auto; }
.dsh-tasks-description-markdown pre { max-inline-size: 100%; overflow-x: auto; }
.dsh-tasks-description-markdown > pre { white-space: pre-wrap; margin: 0; font: inherit; }
.dsh-tasks-description-markdown :is(.task-list-item, li:has(> input[type=checkbox], > p:first-child > input[type=checkbox])) { list-style: none; position: relative; padding-inline-start: 1.4em; }
.dsh-tasks-description-markdown li > input[type=checkbox], .dsh-tasks-description-markdown li > p:first-child > input[type=checkbox] { position: absolute; inset-inline-start: 0; inset-block-start: .3em; inline-size: 1em; block-size: 1em; margin: 0; }
.dsh-tasks-description-empty { margin: 0; color: var(--dsh-tasks-muted); }
.dsh-tasks-task-fields :is(.dsh-tasks-input, .dsh-tasks-select-trigger) { min-height: 36px; }
.dsh-tasks-task-fields :is(.dsh-tasks-properties, .dsh-tasks-bindings) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.dsh-tasks-task-fields .dsh-tasks-date-field { grid-column: auto; grid-template-columns: minmax(0, 1fr); }
@container task-detail (min-width: 460px) {
  .dsh-tasks-task-fields .dsh-tasks-properties { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@container task-detail (min-width: 361px) and (max-width: 459px) {
  .dsh-tasks-task-fields .dsh-tasks-date-field { grid-column: 1 / -1; }
}
@container task-detail (max-width: 360px) { .dsh-tasks-task-fields :is(.dsh-tasks-properties, .dsh-tasks-bindings) { grid-template-columns: minmax(0, 1fr); } }
.dsh-tasks-detail-actions { justify-content: flex-end; }
.dsh-tasks-detail-activity { overflow-wrap: anywhere; }
.dsh-tasks-comment-form { display: grid; gap: 10px; padding: 12px 14px; margin-block-end: 20px; border: 1px solid var(--dsh-tasks-rule); border-radius: var(--dsw-radius-md, 10px); background: color-mix(in srgb, var(--dsh-tasks-focus) 4%, var(--dsh-tasks-paper)); }
.dsh-tasks-comment-form :is(.dsh-tasks-field-title, button) { font-weight: 650; }
.dsh-tasks-comment-form textarea { min-height: 60px; }
.dsh-tasks-comment-form button { justify-self: end; }
.dsh-tasks-comment-form p, .dsh-tasks-activity-message { margin: 0; }
.dsh-tasks-activity-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
.dsh-tasks-activity-header h3 { display: flex; align-items: center; gap: 7px; font-size: 15px; margin: 0; }
.dsh-tasks-activity-header h3 .dsh-tasks-icon { color: var(--dsh-tasks-focus); }
.dsh-tasks-activity-filters { display: flex; gap: 4px; padding: 3px; border: 1px solid var(--dsh-tasks-rule); border-radius: 8px; }
.dsh-tasks-activity-filters button { padding: 4px 8px; min-height: 28px; border: 1px solid transparent; border-radius: 5px; background: transparent; color: var(--dsh-tasks-muted); font: inherit; font-size: 12px; cursor: pointer; }
.dsh-tasks-activity-filters button:hover { color: var(--dsh-tasks-ink); }
.dsh-tasks-activity-filters button[aria-pressed=true] { border-color: var(--dsh-tasks-line); background: color-mix(in srgb, var(--dsh-tasks-focus) 9%, var(--dsh-tasks-paper)); color: var(--dsh-tasks-ink); font-weight: 650; }
.dsh-tasks-activity-filters button:focus-visible { outline: 2px solid var(--dsh-tasks-focus); outline-offset: 1px; }
@media (pointer: coarse) { .dsh-tasks-activity-filters button { min-height: 44px; } }
.dsh-tasks-activity-controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-block: 12px; }
.dsh-tasks-activity-empty { margin: 12px 0; padding: 16px 12px; border: 1px dashed var(--dsh-tasks-line); border-radius: 8px; color: var(--dsh-tasks-muted); text-align: center; }
.dsh-tasks-activity-day { display: flex; align-items: center; gap: 8px; margin: 16px 0 9px; font-size: 12px; font-weight: 650; color: var(--dsh-tasks-ink); }
.dsh-tasks-activity-day time { color: var(--dsh-tasks-muted); font-weight: 500; }
.dsh-tasks-activity-day::after { content: ''; flex: 1; border-block-start: 1px solid var(--dsh-tasks-rule); }
.dsh-tasks-activity { list-style: none; margin: 0; padding: 0; }
.dsh-tasks-activity > li { position: relative; display: grid; grid-template-columns: 30px minmax(0, 1fr); align-items: start; gap: 10px; padding-block-end: 9px; }
.dsh-tasks-activity > li:not(:last-child)::before { content: ''; position: absolute; inset-block: 28px 0; inset-inline-start: 14px; border-inline-start: 1px solid var(--dsh-tasks-line); }
.dsh-tasks-activity-marker { position: relative; display: grid; place-items: center; height: 30px; border: 1px solid var(--dsh-tasks-line); border-radius: 50%; background: var(--dsh-tasks-paper); color: var(--dsh-tasks-muted); }
.dsh-tasks-activity > :is([data-kind=created], [data-kind=completed], [data-kind=bound], [data-kind=comment]) .dsh-tasks-activity-marker { color: var(--dsh-tasks-focus); background: color-mix(in srgb, var(--dsh-tasks-focus) 13%, var(--dsh-tasks-paper)); }
.dsh-tasks-activity-entry { min-width: 0; padding: 7px 10px; border: 1px solid var(--dsh-tasks-rule); border-radius: 8px; background: color-mix(in srgb, var(--dsh-tasks-muted) 3%, var(--dsh-tasks-paper)); }
.dsh-tasks-activity > [data-kind=comment] .dsh-tasks-activity-entry { border-color: color-mix(in srgb, var(--dsh-tasks-focus) 35%, var(--dsh-tasks-rule)); background: color-mix(in srgb, var(--dsh-tasks-focus) 6%, var(--dsh-tasks-paper)); }
.dsh-tasks-activity-event { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 3px 10px; align-items: baseline; }
.dsh-tasks-activity-event strong { font-weight: 650; }
.dsh-tasks-activity-meta { display: flex; flex-wrap: wrap; gap: 0 6px; color: var(--dsh-tasks-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.dsh-tasks-activity-event-detail, .dsh-tasks-activity-comment { margin: 5px 0 0; }
.dsh-tasks-activity-event-detail { color: var(--dsh-tasks-muted); }
.dsh-tasks-activity-fields { display: flex; flex-wrap: wrap; gap: 4px; list-style: none; padding: 0; }
.dsh-tasks-activity-fields li { padding: 1px 6px; border: 1px solid var(--dsh-tasks-rule); border-radius: 5px; background: var(--dsh-tasks-paper); font-size: 12px; }
.dsh-tasks-activity-comment { white-space: pre-wrap; line-height: 1.6; }
@media (max-width: 600px) {
  .dsh-tasks-root .dsh-tasks-detail-head, .dsh-tasks-drawer .dsh-tasks-detail-panel, .dsh-tasks-drawer .dsh-tasks-form-actions { padding-inline: 16px; }
  .dsh-tasks-detail-tabs { margin-inline: 16px; }
}
@media (pointer: coarse) { .dsh-tasks-detail-tabs button, .dsh-tasks-detail-head .dsh-tasks-icon-button, .dsh-tasks-root .dsh-tasks-copy-id { min-height: 44px; } .dsh-tasks-detail-head .dsh-tasks-icon-button { min-width: 44px; } }
.dsh-tasks-root .dsh-tasks-drawer { position: relative; }
.dsh-tasks-drawer-width { position: absolute; top: 0; left: 0; bottom: 0; z-index: 1; width: 12px; cursor: ew-resize; touch-action: none; user-select: none; }
.dsh-tasks-drawer-width::after { content: ''; position: absolute; inset: 42% auto 42% 2px; width: 3px; border-radius: 2px; background: var(--dsh-tasks-line); }
.dsh-tasks-drawer-width:is(:hover,:focus-visible,:active)::after { inset-block: 0; background: var(--dsh-tasks-focus); }
@media (prefers-reduced-motion: no-preference) { .dsh-tasks-root [data-arc-press]:active:not(:disabled) { scale: var(--task-press-scale, .97); } }
@media (max-width: 600px) { .dsh-tasks-root .dsh-tasks-drawer { width: 100%; } .dsh-tasks-drawer-width { display: none; } }
@media (prefers-reduced-motion: no-preference) { .dsh-tasks-drawer { animation: dsh-tasks-slide-in 160ms ease-out; } }
@keyframes dsh-tasks-slide-in { from { transform: translateX(100%); } }
.dsh-tasks-field-title { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 550; }
.dsh-tasks-field-title > .dsh-tasks-icon { color: var(--dsh-tasks-focus); }
.dsh-tasks-optional { font-size: 10px; color: var(--dsw-alias-label-secondary); font-weight: 400; }
.dsh-tasks-fields input:not([type=checkbox], [type=radio]), .dsh-tasks-fields textarea, .dsh-tasks-fields select { padding: 9px 11px; background: color-mix(in srgb, var(--dsw-alias-label-secondary) 3%, var(--dsw-alias-bg-base)); }
.dsh-tasks-fields input:not([type=checkbox], [type=radio])[name="title"] { font-size: 14px; }
.dsh-tasks-fields input:not([type=checkbox], [type=radio])::placeholder, .dsh-tasks-fields textarea::placeholder { color: var(--dsw-alias-label-secondary); }
.dsh-tasks-bindings { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; align-items: start; }
.dsh-tasks-field-hint { margin: 0; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsh-tasks-draft-hint { flex: 1 1 140px; margin-inline-end: auto; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dsh-tasks-detail-brief { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.7; margin: 0 0 24px; }
.dsh-tasks-detail-grid { display: grid; grid-template-columns: minmax(64px, 80px) minmax(0, 1fr); gap: 8px 12px; margin: 14px 0 0; padding-block-start: 10px; border-block-start: 1px solid var(--dsh-tasks-rule); font-size: 12px; }
.dsh-tasks-detail-grid dt { color: var(--dsw-alias-label-secondary); }
.dsh-tasks-detail-grid dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.dsh-tasks-footnote { padding: 4px 16px 10px; }
.dsh-tasks-filter { position: relative; }
.dsh-tasks-filter > summary { list-style: none; display: flex; gap: 5px; align-items: center; cursor: pointer; }
.dsh-tasks-filter > summary::-webkit-details-marker { display: none; }
.dsh-tasks-filter select { max-width: 230px; }
@media (hover: none), (pointer: coarse) { .dsh-tasks-card-actions > summary { opacity: .85; } .dsh-tasks-card-actions[open] > summary { opacity: 1; } }
@media (max-width: 620px) { .dsh-tasks-bindings { grid-template-columns: 1fr; } }
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
.dsh-tasks-root :is(input, textarea, .dsh-tasks-select-trigger):focus { outline: none; box-shadow: none; border-color: var(--dsh-tasks-focus); }
.dsh-tasks-root summary:focus-visible { outline: 2px solid var(--dsh-tasks-focus); outline-offset: 2px; }
.dsh-tasks-root .dsh-tasks-danger { color: var(--dsw-alias-state-error-primary); }
.dsh-tasks-root .dsh-tasks-danger.dsh-tasks-primary { background: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-label-primary-foreground); }
.dsh-tasks-root .dsh-tasks-delete-title { font-weight: 600; overflow-wrap: anywhere; }
.dsh-tasks-root .dsh-tasks-filter .dsh-tasks-menu { min-width: 220px; max-width: calc(100vw - 40px); }
.dsh-tasks-root .dsh-tasks-select { display: block; min-width: 0; width: 100%; }
.dsh-tasks-root .dsh-tasks-select-trigger { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; min-height: 40px; padding: 9px 11px; border: 1px solid var(--dsh-tasks-line); border-radius: 3px 5px 2px 4px; background: var(--dsh-tasks-paper); color: var(--dsh-tasks-ink); font: inherit; text-align: left; cursor: pointer; }
.dsh-tasks-root button.dsh-tasks-select-trigger:focus-visible { outline: 2px solid var(--dsh-tasks-focus); outline-offset: 1px; }
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
:is(body[data-dsh-task-appearance="paper"], body[data-dsh-paper-theme="paper"]:not([data-dsh-task-appearance="ios"])) .dsh-tasks-root {
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
  --dsh-tasks-board-gutter: 24px;
  --dsh-tasks-toolbar-search: var(--dsh-tasks-paper);
  --dsh-tasks-slip: url("${PAPER_SLIP}");
  --dsh-tasks-fibre: url("${PAPER_FIBRE}");
  color: var(--dsh-tasks-ink);
  background-color: var(--dsh-tasks-desk);
  background-image: none;
  font-family: inherit; min-width: 0; isolation: isolate;
  & .dsh-tasks-host-title { display: none; }
  & .dsh-tasks-paper-title { display: inline; }
  & .dsh-tasks-paper-note { display: block; flex: none; margin: 16px 28px 0; font-size: 12px; letter-spacing: .12em; color: var(--dsh-paper-muted); }
  & .dsh-tasks-board { gap: 23px; padding: 23px var(--dsh-tasks-board-gutter) 18px; }
  & .dsh-tasks-col {
    position: relative; overflow: visible; border-radius: var(--dsw-radius-xl, 20px);
    border: 1px solid color-mix(in srgb, var(--dsh-tasks-line) 65%, transparent);
    background-color: var(--dsh-tasks-sheet);
    background-image: repeating-linear-gradient(0deg, transparent 0 27px, var(--dsh-tasks-rule) 27px 28px), linear-gradient(var(--dsh-paper-sheetWash, transparent), var(--dsh-paper-sheetWash, transparent)), var(--dsh-tasks-slip);
    background-size: 100% 28px, auto, 128px 128px;
    box-shadow: 0 3px 0 -1px var(--dsh-paper-edge, var(--dsh-tasks-line)), 0 4px 0 -1px var(--dsh-tasks-line), 0 8px 16px -8px var(--dsh-tasks-shadow);
    min-width: 270px; max-width: none;
  }
  & .dsh-tasks-col::before {
    content: ''; position: absolute; z-index: 2; width: 72px; height: 24px; top: -13px; left: calc(50% - 36px);
    background: var(--dsh-tasks-fibre), var(--dsh-tasks-tape); background-size: 160px 160px; transform: rotate(-4deg); pointer-events: none;
    clip-path: polygon(2% 0, 99% 3%, 97% 20%, 100% 40%, 98% 65%, 100% 99%, 1% 96%, 3% 75%, 0 54%, 2% 28%);
  }
  & .dsh-tasks-col[data-stage="todo"]:not([data-column-id="stage:todo"])::before { transform: rotate(-3deg); }
  & .dsh-tasks-col[data-stage="todo"]:not([data-column-id="stage:todo"]):not([data-column-color])::before {
    background-color: color-mix(in srgb, color-mix(in srgb, var(--dsh-paper-syntaxFunction, #8451b4) 42%, var(--dsh-paper-sheet, #fffef8)) 78%, transparent);
  }
  & .dsh-tasks-col[data-stage="todo"][data-column-id="stage:todo"]::before { transform: rotate(1.5deg); }
  & .dsh-tasks-col[data-stage="doing"]::before { transform: rotate(3deg); }
  & .dsh-tasks-col[data-stage="doing"]:not([data-column-color])::before { background-color: var(--dsh-paper-tapeInfo, var(--dsh-tasks-tape)); }
  & .dsh-tasks-col[data-stage="done"]::before { transform: rotate(-2deg); }
  & .dsh-tasks-col[data-stage="done"]:not([data-column-color])::before { background-color: var(--dsh-paper-tapeSuccess, var(--dsh-tasks-tape)); }
  & .dsh-tasks-col[data-column-color]::before {
    background-color: color-mix(in srgb, color-mix(in srgb, var(--dsh-tasks-col-color) 46%, var(--dsh-paper-sheet, #fffef8)) 82%, transparent);
  }
  & .dsh-tasks-colhead { padding: 22px 16px 13px; }
  & .dsh-tasks-coltitle { min-height: 28px; gap: 10px; }
  & .dsh-tasks-colname { font-size: 16px; letter-spacing: .05em; position: relative; isolation: isolate; }
  & .dsh-tasks-colname::before { content: ''; position: absolute; z-index: -1; inset: 35% -5px 0 -3px; background: var(--dsh-tasks-highlight); border-radius: 35% 12% 20% 8% / 22% 30% 35% 38%; transform: rotate(-2deg); pointer-events: none; }
  & .dsh-tasks-col[data-stage="todo"]:not([data-column-id="stage:todo"]):not([data-column-color]) .dsh-tasks-colname::before { background: color-mix(in srgb, var(--dsh-paper-syntaxFunction, #8451b4) 24%, var(--dsh-paper-sheet, #fffef8)); }
  & .dsh-tasks-col[data-stage="doing"]:not([data-column-color]) .dsh-tasks-colname::before { background: var(--dsh-paper-markerInfo, var(--dsh-paper-infoSoft)); }
  & .dsh-tasks-col[data-stage="done"]:not([data-column-color]) .dsh-tasks-colname::before { background: var(--dsh-paper-markerSuccess, var(--dsh-paper-successSoft)); }
  & .dsh-tasks-col[data-column-color] .dsh-tasks-colname::before { background: color-mix(in srgb, var(--dsh-tasks-col-color) 24%, var(--dsh-paper-sheet, #fffef8)); }
  & .dsh-tasks-count { color: var(--dsh-tasks-muted); background: transparent; border: 0; padding: 0; font-size: 12px; }
  & .dsh-tasks-collist { padding: 4px 12px 8px; }
  & .dsh-tasks-card {
    position: relative; padding: 12px 13px; margin-bottom: 11px; color: var(--dsh-tasks-ink);
    border: 1px solid color-mix(in srgb, var(--dsh-tasks-line) 55%, transparent); border-radius: 12px;
    background-color: var(--dsh-paper-card, var(--dsh-tasks-paper));
    background-image: linear-gradient(var(--dsh-paper-cardWash, transparent), var(--dsh-paper-cardWash, transparent)), var(--dsh-tasks-fibre), var(--dsh-tasks-slip);
    background-size: auto, 240px 240px, 128px 128px; background-position: var(--dsh-tasks-paper-x) var(--dsh-tasks-paper-y);
    box-shadow: 0 1px 0 color-mix(in srgb, var(--dsh-tasks-line) 42%, transparent), 0 4px 10px -6px var(--dsh-tasks-shadow);
  }
  & .dsh-tasks-card:hover {
    border-color: color-mix(in srgb, var(--dsh-tasks-focus) 55%, var(--dsh-tasks-line));
    box-shadow: 0 1px 0 color-mix(in srgb, var(--dsh-tasks-focus) 28%, var(--dsh-tasks-line)), 0 6px 14px -6px var(--dsh-tasks-shadow);
  }
  & .dsh-tasks-card-title { font-size: 14px; line-height: 24px; letter-spacing: .01em; }
  & .dsh-tasks-card[data-stage="done"] { background-color: color-mix(in srgb, var(--dsh-paper-card, var(--dsh-tasks-paper)) 78%, var(--dsh-tasks-sheet)); border-color: color-mix(in srgb, var(--dsh-tasks-line) 42%, transparent); box-shadow: 0 1px 2px color-mix(in srgb, var(--dsh-tasks-shadow) 45%, transparent); }
  & .dsh-tasks-card[data-stage="done"]:hover { border-color: var(--dsh-tasks-line); }
  & .dsh-tasks-card[data-stage="done"] .dsh-tasks-card-title { color: color-mix(in srgb, var(--dsh-tasks-ink) 66%, var(--dsh-tasks-muted)); font-weight: 500; text-decoration: none; }
  & :is(.dsh-tasks-card-brief, .dsh-tasks-card-meta, .dsh-tasks-card-state, .dsh-tasks-menu-label, .dsh-tasks-field-hint, .dsh-tasks-draft-hint, .dsh-tasks-optional, .dsh-tasks-detail-grid dt) { color: var(--dsh-tasks-muted); }
  & .dsh-tasks-card-brief { margin-top: 7px; line-height: 1.75; }
  & .dsh-tasks-card-meta { font-family: inherit; font-size: 11px; padding-top: 4px; }
  & .dsh-tasks-card-state { margin: 10px 0 5px; gap: 7px; flex-wrap: wrap; }
  & :is(.dsh-tasks-primary, .dsh-tasks-secondary, .dsh-tasks-retry) { min-height: 30px; height: auto; box-sizing: border-box; padding: 4px 10px; border: 1px solid var(--dsh-tasks-line); color: var(--dsh-tasks-ink); background: var(--dsh-tasks-paper); box-shadow: 1px 1px 0 color-mix(in srgb, var(--dsh-tasks-line) 55%, transparent); }
  & .dsh-tasks-primary { background: var(--dsh-paper-accent); color: var(--dsh-paper-onAccent); border-color: var(--dsh-paper-accent); font-weight: 600; box-shadow: none; }
  & :is(.dsh-tasks-secondary, .dsh-tasks-retry):hover:not(:disabled) { background: var(--dsh-paper-accentSoft); border-color: var(--dsh-tasks-focus); opacity: 1; }
  & .dsh-tasks-primary:hover:not(:disabled) { background: var(--dsh-paper-accentHover); border-color: var(--dsh-paper-accentHover); opacity: 1; }
  & .dsh-tasks-card-buttons { display: flex; justify-content: flex-end; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 0; border-top: none; padding-top: 0; }
  & .dsh-tasks-icon-button { color: var(--dsh-tasks-muted); min-width: 26px; min-height: 26px; }
  & .dsh-tasks-icon-button:hover { color: var(--dsh-tasks-ink); background: color-mix(in srgb, var(--dsh-tasks-highlight) 35%, transparent); }
  & .dsh-tasks-card-actions > summary { opacity: .32; width: 24px; height: 24px; transition: opacity .15s ease; }
  & .dsh-tasks-card:hover .dsh-tasks-card-actions > summary, & .dsh-tasks-card:focus-within .dsh-tasks-card-actions > summary, & .dsh-tasks-card-actions[open] > summary { opacity: 1; }
  & .dsh-tasks-search { color: var(--dsh-tasks-ink); background: var(--dsh-tasks-paper); border-color: var(--dsh-tasks-line); }
  & :is(.dsh-tasks-search, .dsh-tasks-fields input:not([type=checkbox], [type=radio]), .dsh-tasks-fields textarea)::placeholder { color: var(--dsh-tasks-muted); opacity: 1; }
  & .dsh-tasks-colfoot {
    border-top: 0;
    padding: 6px 12px 10px;
    border-radius: 0 0 var(--dsw-radius-xl, 20px) var(--dsw-radius-xl, 20px);
    background: linear-gradient(to bottom, transparent, color-mix(in srgb, var(--dsh-tasks-sheet) 82%, transparent) 32%, var(--dsh-tasks-sheet) 100%);
  }
  & .dsh-tasks-add { color: var(--dsh-tasks-muted); border: 1px dashed var(--dsh-tasks-line); min-height: 30px; }
  & .dsh-tasks-add:hover { color: var(--dsh-tasks-ink); background: var(--dsh-tasks-paper); }
  & .dsh-tasks-empty { padding: 38px 4px; line-height: 1.8; color: var(--dsh-tasks-muted); }
  & .dsh-tasks-empty::before { content: ''; display: block; width: 42px; height: 55px; margin: 0 auto 20px; border: 1px solid var(--dsh-tasks-line); border-radius: var(--dsw-radius-xs, 6px); transform: rotate(-5deg); background: repeating-linear-gradient(0deg, transparent 0 10px, var(--dsh-tasks-rule) 10px 11px), var(--dsh-tasks-paper); box-shadow: 3px 3px 0 color-mix(in srgb, var(--dsh-tasks-line) 20%, transparent); }
  &.dsh-tasks-board-view:has(> :is(.dsh-tasks-attention, .dsh-tasks-active-filters)) { --dsh-tasks-board-top: 24px; }
  & .dsh-tasks-footnote { padding: 0 var(--dsh-tasks-board-gutter) 13px; color: var(--dsh-paper-muted); }
  & .dsh-tasks-menu { color: var(--dsh-tasks-ink); background: var(--dsh-tasks-paper); border-color: var(--dsh-tasks-line); }
  & .dsh-tasks-menu button:hover { background: var(--dsh-tasks-highlight); }
  & .dsh-tasks-dialog { background: var(--dsh-tasks-paper); color: var(--dsh-tasks-ink); border: 1px solid var(--dsh-tasks-line); border-radius: var(--dsw-radius-xl, 20px); }
  & .dsh-tasks-drawer { border-radius: var(--dsw-radius-xl, 20px) 0 0 var(--dsw-radius-xl, 20px); }
  & .dsh-tasks-select-list { background-image: none; }
  & .dsh-tasks-dialog::backdrop { background: rgb(24 23 21 / 22%); }
  & .dsh-tasks-dialog-head h2 { background: linear-gradient(transparent 55%, var(--dsh-tasks-highlight) 55% 90%, transparent 90%); width: fit-content; }
  & .dsh-tasks-dialog-head p { color: var(--dsh-tasks-muted); }
  & .dsh-tasks-form-actions { border-color: var(--dsh-tasks-rule); }
  & :is(.dsh-tasks-fields input:not([type=checkbox], [type=radio]), .dsh-tasks-fields textarea, .dsh-tasks-stage) { color: var(--dsh-tasks-ink); background: var(--dsh-tasks-paper); border-color: var(--dsh-tasks-line); }
  & :is(.dsh-tasks-search, .dsh-tasks-primary, .dsh-tasks-secondary, .dsh-tasks-retry, .dsh-tasks-add, .dsh-tasks-done-range, .dsh-tasks-icon-button, .dsh-tasks-fields input:not([type=checkbox], [type=radio]), .dsh-tasks-fields textarea, .dsh-tasks-select-trigger) { border-radius: var(--dsw-radius-sm, 10px); }
  & :is(.dsh-tasks-menu, .dsh-tasks-select-list) { border-radius: var(--dsw-radius-md, 14px); }
  & :is(.dsh-tasks-menu button, .dsh-tasks-select-option) { border-radius: var(--dsw-radius-xs, 6px); }
  & :is(input, textarea, select, button, summary):focus-visible { outline: 2px solid var(--dsh-tasks-focus); outline-offset: 3px; }
  & :is(input, textarea, .dsh-tasks-select-trigger):focus { outline: none; box-shadow: none; border-color: var(--dsh-tasks-focus); }
  & .dsh-tasks-menu .dsh-tasks-danger, & .dsh-tasks-danger { color: var(--dsh-paper-danger); }
  & .dsh-tasks-menu .dsh-tasks-danger { border-top: 1px dashed var(--dsh-tasks-rule); margin-top: 5px; padding-top: 10px; }
  & .dsh-tasks-danger.dsh-tasks-primary { background: var(--dsh-paper-dangerSoft); border-color: var(--dsh-paper-danger); color: var(--dsh-paper-danger); }
  & .dsh-tasks-danger.dsh-tasks-primary:hover:not(:disabled) { background: var(--dsh-paper-dangerSoft); border-color: var(--dsh-paper-danger); }
  & .dsh-tasks-delete-title { font-weight: 600; overflow-wrap: anywhere; }
  & .dsh-tasks-filter .dsh-tasks-menu { min-width: 220px; max-width: calc(100vw - 40px); }
  & button:disabled { opacity: .55; box-shadow: none; cursor: default; }
  @media (max-width: 620px) {
    & { --dsh-tasks-board-gutter: 12px; }
    & .dsh-tasks-board { padding-bottom: 14px; gap: 18px; }
    & .dsh-tasks-paper-note { margin: 12px 16px 0; }
    & .dsh-tasks-footnote { padding-bottom: 12px; }
  }
  @media (max-width: 600px) { & .dsh-tasks-drawer { border-radius: 0; } }
  @media (pointer: coarse) { & :is(button, summary, select, .dsh-tasks-search) { min-height: 44px; } & .dsh-tasks-card-actions > summary { min-width: 44px; } }
  @media (hover: none), (pointer: coarse) { & .dsh-tasks-card-actions > summary { opacity: .85; } & .dsh-tasks-card-actions[open] > summary { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { & * { transition: none; } }
  @media (forced-colors: active) { & { background: Canvas; color: CanvasText; } & :is(.dsh-tasks-board-toolbar, .dsh-tasks-col, .dsh-tasks-card, .dsh-tasks-dialog, .dsh-tasks-status-label, .dsh-tasks-attention) { background: Canvas; color: CanvasText; border: 1px solid CanvasText; box-shadow: none; } & :is(.dsh-tasks-col, .dsh-tasks-colname)::before { display: none; } & :is(button, input, textarea, select, summary):focus-visible { outline-color: Highlight; } }
}
`

    const boardLayout = { columnMin: 280, collapsed: 48, maxGutter: 24, maxGap: 20, insightsMin: 250, insightsMax: 420, wide: 1100 }
    const BOARD_CONTROLS_CSS = `
.dsh-tasks-board-view {
  position: relative;
  min-width: 0;
  --dsh-tasks-panel-gutter: clamp(12px, 1.6cqw, ${boardLayout.maxGutter}px);
  --dsh-tasks-panel-gap: clamp(12px, 1.4cqw, ${boardLayout.maxGap}px);
  --dsh-tasks-board-top: 22px;
  --dsh-tasks-board-bottom: 14px;
}
.dsh-tasks-board-view :is(.dsh-tasks-board-toolbar, .dsh-tasks-workspace, .dsh-tasks-footnote) {
  box-sizing: border-box; width: 100%;
}
.dsh-tasks-board-toolbar {
  flex: none; display: grid; align-items: center; gap: 10px 16px;
  grid-template: 'title filters actions' / auto minmax(0, 1fr) auto;
  padding: 12px var(--dsh-tasks-panel-gutter) 0;
  --dsh-tasks-control-size: 36px;
}
.dsh-tasks-board-toolbar .dsh-tasks-heading { grid-area: title; }
.dsh-tasks-board-toolbar .dsh-tasks-logo { width: 30px; height: 30px; border-radius: 9px; color: var(--dsh-tasks-focus); background: color-mix(in srgb, var(--dsh-tasks-focus) 9%, var(--dsh-tasks-paper)); }
.dsh-tasks-toolbar-filters { grid-area: filters; }
.dsh-tasks-toolbar-actions { grid-area: actions; justify-self: end; }
.dsh-tasks-toolbar-filters, .dsh-tasks-toolbar-actions { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dsh-tasks-workspace-picker { position: relative; flex: 0 1 172px; min-width: 0; }
.dsh-tasks-workspace-picker > .dsh-tasks-icon { position: absolute; inset-inline-start: 10px; top: 50%; transform: translateY(-50%); color: var(--dsh-tasks-focus); pointer-events: none; }
.dsh-tasks-workspace-picker > .dsh-tasks-icon:last-child { inset-inline: auto 8px; color: var(--dsh-tasks-muted); }
.dsh-tasks-board-toolbar .dsh-tasks-search-wrap { flex: 1 1 180px; min-width: 0; max-width: 280px; }
.dsh-tasks-board-toolbar .dsh-tasks-search-wrap > .dsh-tasks-icon { top: 50%; transform: translateY(-50%); }
.dsh-tasks-root.dsh-tasks-board-view .dsh-tasks-board-toolbar :is(.dsh-tasks-toolbar-filters, .dsh-tasks-toolbar-actions) :is(.dsh-tasks-search, .dsh-tasks-select-trigger, .dsh-tasks-toolbar-button) {
  box-sizing: border-box; min-height: var(--dsh-tasks-control-size); height: auto; border-radius: var(--dsw-radius-sm, 8px);
}
.dsh-tasks-root .dsh-tasks-board-toolbar :is(.dsh-tasks-search, .dsh-tasks-select-trigger) {
  width: 100%; min-width: 0; background: var(--dsh-tasks-paper); border: 1px solid var(--dsh-tasks-rule); color: var(--dsh-tasks-ink);
}
.dsh-tasks-root .dsh-tasks-board-toolbar .dsh-tasks-search { padding-inline: 30px 8px; }
.dsh-tasks-root .dsh-tasks-board-toolbar .dsh-tasks-select-trigger { padding: 0 26px 0 31px; text-overflow: ellipsis; }
.dsh-tasks-root .dsh-tasks-board-toolbar :is(.dsh-tasks-search > input, .dsh-tasks-select-trigger)::placeholder { color: var(--dsh-tasks-muted); opacity: 1; }
.dsh-tasks-root .dsh-tasks-board-toolbar :is(.dsh-tasks-input:focus-within, .dsh-tasks-select-trigger:focus, .dsh-tasks-select-trigger[aria-expanded=true], [data-scoped] .dsh-tasks-select-trigger) { border-color: var(--dsh-tasks-focus); }
.dsh-tasks-root .dsh-tasks-board-toolbar .dsh-tasks-toolbar-button { flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 0 10px; white-space: nowrap; font: inherit; }
.dsh-tasks-root .dsh-tasks-board-toolbar .dsh-tasks-toolbar-button:not(.dsh-tasks-primary) { color: var(--dsh-tasks-muted); border: 1px solid var(--dsh-tasks-rule); background: var(--dsh-tasks-paper); box-shadow: none; }
.dsh-tasks-root .dsh-tasks-board-toolbar :is(.dsh-tasks-toolbar-button:not(.dsh-tasks-primary):hover:not(:disabled), details[open] > summary) { color: var(--dsh-tasks-ink); border-color: var(--dsh-tasks-focus); }
.dsh-tasks-root .dsh-tasks-board-toolbar .dsh-tasks-toolbar-icon { width: var(--dsh-tasks-control-size); padding: 0; }
.dsh-tasks-root .dsh-tasks-board-toolbar .dsh-tasks-primary { font-weight: 600; }
.dsh-tasks-board-toolbar summary { list-style: none; cursor: pointer; }
.dsh-tasks-board-toolbar summary::-webkit-details-marker { display: none; }
.dsh-tasks-root .dsh-tasks-board-settings { width: 224px; }
.dsh-tasks-board-settings .dsh-tasks-appearance { margin: 4px 0 0; padding: 8px 9px 4px; border-top: 1px solid var(--dsh-tasks-rule); }
.dsh-tasks-board-settings .dsh-tasks-appearance label { flex-wrap: wrap; }
.dsh-tasks-workspace {
  display: flex; flex: 1; min-width: 0; min-height: 0;
  --dsh-tasks-board-min: calc(var(--dsh-tasks-expanded) * ${boardLayout.columnMin}px + var(--dsh-tasks-collapsed) * ${boardLayout.collapsed}px + var(--dsh-tasks-gaps) * var(--dsh-tasks-panel-gap) + 3 * var(--dsh-tasks-panel-gutter));
  --dsh-tasks-insight-min: ${boardLayout.insightsMin}px;
}
.dsh-tasks-root.dsh-tasks-board-view .dsh-tasks-workspace > .dsh-tasks-board.dsh-tasks-board-strip {
  box-sizing: border-box; min-width: 0; gap: var(--dsh-tasks-panel-gap);
  padding: var(--dsh-tasks-board-top) var(--dsh-tasks-panel-gutter) var(--dsh-tasks-board-bottom);
  overscroll-behavior-inline: contain;
}
.dsh-tasks-root.dsh-tasks-board-view .dsh-tasks-workspace > .dsh-tasks-board > .dsh-tasks-col {
  box-sizing: border-box; flex: 1 1 0; min-width: min(${boardLayout.columnMin}px, calc(100cqw - 2 * var(--dsh-tasks-panel-gutter))); max-width: none;
}
.dsh-tasks-workspace[data-show-insights] > .dsh-tasks-insights {
  flex: 0 0 min(clamp(var(--dsh-tasks-insight-min), 23%, ${boardLayout.insightsMax}px), max(var(--dsh-tasks-insight-min), 100% - var(--dsh-tasks-board-min)));
}
@media (hover: hover) and (pointer: fine) and (forced-colors: none) {
  @supports selector(::-webkit-scrollbar) {
    .dsh-tasks-board-view :is(.dsh-tasks-board-strip, .dsh-tasks-collist, .dsh-tasks-insight-body) {
      scrollbar-width: auto; scrollbar-color: auto;
      &::-webkit-scrollbar { width: 8px; height: 8px; background: transparent; }
      /* Keep the hit area fixed so hovering does not resize the cards or panels. */
      &::-webkit-scrollbar-thumb {
        border: 3px solid transparent; border-radius: 999px;
        background: color-mix(in srgb, var(--dsh-tasks-ink) 20%, transparent); background-clip: content-box;
      }
      &::-webkit-scrollbar-thumb:hover {
        border-width: 0; background-color: color-mix(in srgb, var(--dsh-tasks-ink) 55%, transparent);
      }
      &::-webkit-scrollbar-thumb:active {
        border-width: 0; background-color: color-mix(in srgb, var(--dsh-tasks-ink) 72%, transparent);
      }
    }
  }
  @supports not selector(::-webkit-scrollbar) {
    .dsh-tasks-board-view :is(.dsh-tasks-board-strip, .dsh-tasks-collist, .dsh-tasks-insight-body) {
      scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--dsh-tasks-ink) 20%, transparent) transparent;
    }
  }
}
.dsh-tasks-root .dsh-tasks-workspace .dsh-tasks-colhead { justify-content: flex-start; flex-wrap: wrap; gap: 4px; padding-inline: 12px; }
.dsh-tasks-root .dsh-tasks-workspace .dsh-tasks-col:not([data-collapsed]) .dsh-tasks-colhead { flex-wrap: nowrap; }
.dsh-tasks-root .dsh-tasks-workspace .dsh-tasks-coltitle { flex: 1 1 60px; gap: 6px; justify-content: flex-start; height: auto; }
.dsh-tasks-workspace .dsh-tasks-coltitle .dsh-tasks-count { flex: none; white-space: nowrap; }
.dsh-tasks-workspace .dsh-tasks-colhead > .dsh-tasks-icon-button { flex: none; }
.dsh-tasks-workspace .dsh-tasks-colhead > .dsh-tasks-col-rename { opacity: 0; pointer-events: none; transition: opacity .15s ease; }
.dsh-tasks-workspace .dsh-tasks-colhead:is(:hover, :focus-within) > .dsh-tasks-col-rename,
.dsh-tasks-workspace .dsh-tasks-colhead > .dsh-tasks-col-rename:focus-visible { opacity: 1; pointer-events: auto; }
@media (hover: none), (pointer: coarse) {
  .dsh-tasks-workspace .dsh-tasks-colhead > .dsh-tasks-col-rename { opacity: 1; pointer-events: auto; }
}
.dsh-tasks-root .dsh-tasks-colhead .dsh-tasks-column-grip { flex: none; cursor: grab; touch-action: none; padding: 0; color: var(--dsh-tasks-muted); }
.dsh-tasks-root .dsh-tasks-colhead .dsh-tasks-column-grip:is(:hover, :focus-visible) { color: var(--dsh-tasks-focus); background: color-mix(in srgb, var(--dsh-tasks-focus) 9%, transparent); }
.dsh-tasks-root .dsh-tasks-colhead .dsh-tasks-column-grip:active { cursor: grabbing; }
.dsh-tasks-root .dsh-tasks-colhead .dsh-tasks-column-grip:disabled { cursor: default; }
.dsh-tasks-root .dsh-tasks-col[data-collapsed] .dsh-tasks-column-grip { display: flex; margin: 0 auto 4px; }
.dsh-tasks-root .dsh-tasks-col[data-column-dragging] { opacity: .78; }
.dsh-tasks-root .dsh-tasks-board-strip > .dsh-tasks-col[data-column-insert] { position: relative; overflow: visible; }
.dsh-tasks-root .dsh-tasks-col[data-column-insert]::after {
  content: ''; position: absolute; z-index: 3; inset-block: 8px; width: 3px; pointer-events: none;
  border-radius: 3px; background: var(--dsh-tasks-focus); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsh-tasks-focus) 12%, transparent);
}
.dsh-tasks-root .dsh-tasks-col[data-column-insert=before]::after { inset-inline-start: calc(var(--dsh-tasks-panel-gap) / -2 - 2px); }
.dsh-tasks-root .dsh-tasks-col[data-column-insert=after]::after { inset-inline-end: calc(var(--dsh-tasks-panel-gap) / -2 - 2px); }
.dsh-tasks-column-preview {
  display: flex; align-items: center; gap: 8px; width: max-content; max-width: min(244px, calc(100vw - 16px)); min-height: 44px;
  box-sizing: border-box; padding: 6px 10px; border: 1px solid var(--dsh-tasks-rule); border-radius: 10px;
  color: var(--dsh-tasks-ink); background: var(--dsh-tasks-paper); box-shadow: 0 5px 18px var(--dsh-tasks-shadow);
  font-size: 12px; line-height: 16px; pointer-events: none;
}
.dsh-tasks-column-preview > .dsh-tasks-icon { flex: none; color: var(--dsh-tasks-focus); }
.dsh-tasks-column-preview > div { min-width: 0; }
.dsh-tasks-column-preview :is(strong, small) { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-tasks-column-preview small { font-size: 11px; color: var(--dsh-tasks-muted); }
.dsh-tasks-column-preview[data-can-drop] small { color: var(--dsh-tasks-focus); }
.dsh-tasks-root .dsh-tasks-board-view-footer { padding-inline: var(--dsh-tasks-panel-gutter); }
.dsh-tasks-board-view-footer > span { display: inline-flex; align-items: center; gap: 5px; }
.dsh-tasks-board-view-footer [data-task-sync]::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.dsh-tasks-board-view-footer [data-task-sync=live]::before { background: var(--dsw-alias-state-success-primary); }
@container task-panel (max-width: 800px) {
  .dsh-tasks-board-toolbar { grid-template: 'title actions' 'filters filters' / minmax(0, 1fr) auto; }
  .dsh-tasks-board-toolbar .dsh-tasks-search-wrap { max-width: none; }
}
@container task-panel (max-width: 480px) {
  .dsh-tasks-board-toolbar { column-gap: 6px; }
  .dsh-tasks-toolbar-filters, .dsh-tasks-toolbar-actions { gap: 5px; }
  .dsh-tasks-workspace-picker { flex-basis: 46%; }
  .dsh-tasks-board-toolbar .dsh-tasks-search-wrap { flex-basis: 54%; }
  .dsh-tasks-board-toolbar .dsh-tasks-filter-label { display: none; }
}
@container task-panel (max-width: 340px) {
  .dsh-tasks-board-toolbar .dsh-tasks-logo, .dsh-tasks-board-toolbar .dsh-tasks-create-label { display: none; }
  .dsh-tasks-root.dsh-tasks-board-view .dsh-tasks-board-toolbar .dsh-tasks-toolbar-actions .dsh-tasks-primary { width: var(--dsh-tasks-control-size); padding: 0; }
}
@media (pointer: coarse) { .dsh-tasks-board-toolbar { --dsh-tasks-control-size: 44px; } }
.dsh-tasks-root .dsh-tasks-workspace .dsh-tasks-board > .dsh-tasks-col[data-collapsed] { flex: 0 0 ${boardLayout.collapsed}px; width: ${boardLayout.collapsed}px; min-width: ${boardLayout.collapsed}px; max-width: ${boardLayout.collapsed}px; }
.dsh-tasks-root .dsh-tasks-col[data-collapsed]::before { width: 32px; left: calc(50% - 16px); }
.dsh-tasks-root .dsh-tasks-board .dsh-tasks-col[data-collapsed] .dsh-tasks-colhead { padding: 14px 0; display: block; }
.dsh-tasks-root .dsh-tasks-board .dsh-tasks-col[data-collapsed] .dsh-tasks-coltitle { display: flex; flex-direction: column; align-items: center; width: 100%; height: auto; gap: 8px; padding: 4px; }
.dsh-tasks-root .dsh-tasks-col[data-collapsed] .dsh-tasks-colname { writing-mode: vertical-rl; max-height: 12em; overflow: hidden; }
.dsh-tasks-root .dsh-tasks-coltitle { min-width: 0; }
.dsh-tasks-root .dsh-tasks-colname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-tasks-root .dsh-tasks-colfoot[data-has-range] { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.dsh-tasks-root .dsh-tasks-colfoot[data-has-range] .dsh-tasks-done-range {
  flex: 1 1 auto; min-width: 0; justify-content: center; gap: 4px; min-height: 30px; padding: 4px 10px;
  border: 1px solid color-mix(in srgb, var(--dsh-tasks-line) 75%, transparent); border-radius: var(--dsw-radius-sm, 8px);
  background: color-mix(in srgb, var(--dsh-tasks-paper) 72%, transparent); color: var(--dsh-tasks-muted);
  font-size: 12px; text-decoration: none; white-space: nowrap; transition: background-color .15s ease, border-color .15s ease, color .15s ease;
}
.dsh-tasks-root .dsh-tasks-colfoot[data-has-range] .dsh-tasks-done-range:is(:hover, :focus-visible) {
  color: var(--dsh-tasks-ink); background: var(--dsh-tasks-paper); border-color: var(--dsh-tasks-line);
}
.dsh-tasks-root .dsh-tasks-colfoot[data-has-range] .dsh-tasks-add { flex: 0 0 auto; width: auto; padding: 4px 11px; white-space: nowrap; }
@media (pointer: coarse) {
  .dsh-tasks-root .dsh-tasks-colfoot[data-has-range] :is(.dsh-tasks-done-range, .dsh-tasks-add) { min-height: 44px; }
}
.dsh-tasks-insights {
  display: none; flex-direction: column; flex: 1 0 var(--dsh-tasks-insight-min); min-width: 0; min-height: 0; box-sizing: border-box;
  align-self: flex-start; max-height: calc(100% - var(--dsh-tasks-board-top) - var(--dsh-tasks-board-bottom));
  margin-block: var(--dsh-tasks-board-top) var(--dsh-tasks-board-bottom); margin-inline-start: var(--dsh-tasks-panel-gutter);
  border: 1px solid var(--dsh-tasks-rule); border-radius: 14px; background: var(--dsh-tasks-paper); color: var(--dsh-tasks-ink);
  box-shadow: 0 2px 8px color-mix(in srgb,var(--dsh-tasks-shadow) 45%,transparent); overflow: hidden;
  container: task-insights / inline-size; font-size: 12px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere;
}
.dsh-tasks-workspace[data-show-insights] > .dsh-tasks-insights { display: flex; }
.dsh-tasks-insight-body { flex: 0 1 auto; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 15px; }
.dsh-tasks-insight-sections { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; margin-top: 12px; }
@container task-insights (min-width: 500px) {
  .dsh-tasks-insight-sections { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@container task-insights (min-width: 860px) {
  .dsh-tasks-insight-sections { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
.dsh-tasks-insights header { border-bottom: 1px dashed var(--dsh-tasks-line); padding-bottom: 12px; }
.dsh-tasks-insights h2, .dsh-tasks-insights h3 { display: flex; align-items: center; gap: 7px; margin: 0; }
.dsh-tasks-insights header h2 { font-size: 16px; }
.dsh-tasks-insight-header-actions { display: flex; align-items: center; gap: 6px; }
.dsh-tasks-insight-close { width: 22px; height: 22px; padding: 2px; }
.dsh-tasks-insight-sync { color: var(--dsh-tasks-muted); border: 1px dashed currentColor; border-radius: 5px; padding: 2px 6px; font-size: 11px; }
.dsh-tasks-insight-sync[data-live=true] { color: var(--dsw-alias-state-success-primary); }
.dsh-tasks-insights header h2 > .dsh-tasks-icon { color: var(--dsh-tasks-focus); }
.dsh-tasks-insights small { color: var(--dsh-tasks-muted); font-size: 11px; }
.dsh-tasks-insight-sections > section { min-width: 0; }
.dsh-tasks-insights section h3 { margin-bottom: 10px; font-size: 13px; }
.dsh-tasks-insight-sections h3 > .dsh-tasks-icon { color: var(--dsh-tasks-focus); }
.dsh-tasks-insight-sections > section, .dsh-tasks-metric { padding: 10px 12px; border: 1px solid var(--dsh-tasks-rule); border-radius: 9px; }
.dsh-tasks-insight-sections > .dsh-tasks-insight-delivery { background: color-mix(in srgb, var(--dsh-tasks-focus) 6%, var(--dsh-tasks-paper)); }
.dsh-tasks-insight-line { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.dsh-tasks-rate { font-size: 30px; line-height: 1.1; letter-spacing: -.04em; }
.dsh-tasks-insights progress { appearance: none; width: 100%; height: 7px; margin: 10px 0 8px; display: block; accent-color: var(--dsh-tasks-focus); }
.dsh-tasks-insights progress::-webkit-progress-bar { border-radius: 999px; background: var(--dsh-tasks-rule); }
.dsh-tasks-insights progress::-webkit-progress-value { border-radius: 999px; background: var(--dsh-tasks-focus); }
.dsh-tasks-column-mix { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.dsh-tasks-column-mix li { display: grid; grid-template-columns: minmax(0, 1fr) minmax(32px, .65fr) auto; gap: 8px; align-items: center; }
.dsh-tasks-column-mix li > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-tasks-column-mix li > strong { min-width: 2.4ch; text-align: end; }
.dsh-tasks-column-meter { height: 5px; overflow: hidden; border-radius: 999px; background: var(--dsh-tasks-rule); }
.dsh-tasks-column-meter b { display: block; height: 100%; border-radius: inherit; background: var(--dsh-tasks-focus); }
.dsh-tasks-column-mix [data-stage=doing] b { background: var(--dsw-alias-state-business-primary); }
.dsh-tasks-column-mix [data-stage=done] b { background: var(--dsw-alias-state-success-primary); }
.dsh-tasks-insights h4 { margin: 10px 0 5px; font-size: 11px; color: var(--dsh-tasks-muted); }
.dsh-tasks-metrics { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 8px; }
.dsh-tasks-metric { background: color-mix(in srgb,var(--tone,var(--dsh-tasks-muted)) 6%,var(--dsh-tasks-paper)); border-color: color-mix(in srgb,var(--tone,var(--dsh-tasks-muted)) 24%,var(--dsh-tasks-paper)); }
.dsh-tasks-metric strong { display: block; margin-top: 5px; font-size: 20px; }
.dsh-tasks-metric:nth-child(1) { --tone: var(--dsw-alias-state-error-primary); }
.dsh-tasks-metric:nth-child(2) { --tone: var(--dsw-alias-state-business-primary); }
.dsh-tasks-metric:nth-child(3) { --tone: var(--dsw-alias-state-success-primary); }
.dsh-tasks-mix-track, .dsh-tasks-mix-tags, .dsh-tasks-week { display: flex; gap: 5px; }
.dsh-tasks-mix-track { height: 8px; gap: 1px; overflow: hidden; border-radius: 4px; background: var(--dsh-tasks-rule); }
.dsh-tasks-mix-tags { flex-wrap: wrap; margin-top: 6px; }
.dsh-tasks-mix-tags span { padding: 2px 6px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2); }
.dsh-tasks-week { gap: 3px; margin-top: 8px; }
.dsh-tasks-week > span { flex: 1; min-width: 0; text-align: center; }
.dsh-tasks-week small { white-space: nowrap; font-size: 10px; }
.dsh-tasks-week i { display: flex; height: 46px; align-items: end; margin: 3px 0; border-radius: 4px; background: color-mix(in srgb, var(--dsh-tasks-focus) 7%, var(--dsh-tasks-paper)); }
.dsh-tasks-week b { width: 100%; background: var(--dsh-tasks-focus); border-radius: 3px; }
.dsh-tasks-insight-lists { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; margin-top: 12px; }
@container task-insights (min-width: 560px) {
  .dsh-tasks-insight-lists { grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); }
}
.dsh-tasks-insight-list { min-width: 0; border: 1px solid var(--dsh-tasks-rule); border-radius: 9px; padding: 10px 12px; }
.dsh-tasks-insight-list[data-list=attention] { border-top: 2px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 62%, var(--dsh-tasks-rule)); }
.dsh-tasks-insight-list[data-list=recent] { border-top: 2px solid color-mix(in srgb, var(--dsw-alias-state-success-primary) 62%, var(--dsh-tasks-rule)); }
.dsh-tasks-insight-list h3 > .dsh-tasks-icon { color: var(--dsh-tasks-focus); }
.dsh-tasks-insight-list p { margin: 0; color: var(--dsh-tasks-muted); }
.dsh-tasks-insight-list ul { display: grid; gap: 2px; list-style: none; padding: 0; margin: 0; }
.dsh-tasks-insight-list li { min-width: 0; }
.dsh-tasks-root .dsh-tasks-insight-list .dsh-tasks-insight-row {
  display: grid; grid-template-columns: 26px minmax(0, 1fr) auto; gap: 8px; align-items: center; width: 100%; min-height: 44px; height: auto;
  padding: 5px 6px; border: 0; border-radius: 6px; background: transparent; color: var(--dsh-tasks-ink); text-align: start; font: inherit;
}
.dsh-tasks-root .dsh-tasks-insight-list .dsh-tasks-insight-row:hover { background: var(--dsw-alias-bg-layer-2); }
.dsh-tasks-insight-row > .dsh-tasks-icon:first-child { width: 24px; height: 24px; border-radius: 6px; color: var(--row-tone, var(--dsh-tasks-focus)); background: color-mix(in srgb, currentColor 9%, transparent); }
.dsh-tasks-insight-row[data-tone=urgent] { --row-tone: var(--dsw-alias-state-error-primary); }
.dsh-tasks-insight-row[data-tone=soon] { --row-tone: var(--dsw-alias-state-warn-primary); }
.dsh-tasks-insight-row[data-tone=done] { --row-tone: var(--dsw-alias-state-success-primary); }
.dsh-tasks-insight-row > .dsh-tasks-icon:last-child, .dsh-tasks-insight-row :is(time, small) { color: var(--dsh-tasks-muted); }
.dsh-tasks-insight-row :is(strong, small, time) { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-tasks-insight-row strong { line-height: 1.35; }
.dsh-tasks-insight-row time { font-size: 11px; }
.dsh-tasks-due-overview h2 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 15px; }
.dsh-tasks-due-overview p { margin: 5px 0 12px; color: var(--dsh-tasks-muted); font-size: 12px; }
.dsh-tasks-due-overview p:last-child { margin-bottom: 0; }
.dsh-tasks-due-overview .dsh-tasks-empty-hint { margin: 6px 0 0; font-size: 11px; color: var(--dsh-tasks-muted); }
.dsh-tasks-due-overview button { display: grid; grid-template-columns: 16px 1fr auto; align-items: center; gap: 4px 8px; width: 100%; padding: 7px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: inherit; text-align: start; font: inherit; cursor: pointer; }
.dsh-tasks-due-overview button:disabled { color: var(--dsh-tasks-muted); cursor: default; }
.dsh-tasks-due-overview button:not(:disabled):hover, .dsh-tasks-due-overview button[aria-pressed=true] { background: var(--dsw-alias-bg-layer-2); }
.dsh-tasks-due-overview button[aria-pressed=true] { border-color: var(--dsh-tasks-focus); }
.dsh-tasks-due-track { display: block; grid-column: 2 / -1; height: 4px; border-radius: 2px; background: var(--dsh-tasks-rule); }
.dsh-tasks-due-track > span { display: block; height: 100%; border-radius: inherit; background: var(--dsh-tasks-focus); }
.dsh-tasks-due-overview [data-period=overdue] .dsh-tasks-due-track > span { background: var(--dsw-alias-state-error-primary); }
.dsh-tasks-due-count { font-variant-numeric: tabular-nums; }
.dsh-tasks-active-filters {
  flex: none; min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px;
  margin: 10px var(--dsh-tasks-panel-gutter) 0;
}
.dsh-tasks-root :is(.dsh-tasks-filter-chip, .dsh-tasks-due-chip) {
  --chip-tone: var(--dsh-tasks-focus);
  box-sizing: border-box; display: inline-flex; align-items: center; gap: 5px;
  min-height: 26px; max-width: 100%; padding: 2px 8px 2px 9px;
  border: 1px solid color-mix(in srgb, var(--chip-tone) 28%, var(--dsh-tasks-rule));
  border-radius: 999px;
  background: color-mix(in srgb, var(--chip-tone) 8%, var(--dsh-tasks-paper));
  color: var(--dsh-tasks-ink); font: inherit; font-size: 12px; line-height: 18px;
  cursor: pointer; transition: border-color .15s ease, background-color .15s ease;
}
.dsh-tasks-root :is(.dsh-tasks-filter-chip, .dsh-tasks-due-chip):is(:hover, :focus-visible) {
  border-color: color-mix(in srgb, var(--chip-tone) 58%, var(--dsh-tasks-line));
  background: color-mix(in srgb, var(--chip-tone) 13%, var(--dsh-tasks-paper));
}
.dsh-tasks-root :is(.dsh-tasks-filter-chip, .dsh-tasks-due-chip) > .dsh-tasks-icon:first-child { color: var(--chip-tone); flex: none; }
.dsh-tasks-root :is(.dsh-tasks-filter-chip, .dsh-tasks-due-chip) > .dsh-tasks-icon:last-child { flex: none; color: var(--dsh-tasks-muted); opacity: .65; transition: opacity .15s ease, color .15s ease; }
.dsh-tasks-root :is(.dsh-tasks-filter-chip, .dsh-tasks-due-chip):is(:hover, :focus-visible) > .dsh-tasks-icon:last-child { opacity: 1; color: var(--dsh-tasks-ink); }
.dsh-tasks-filter-chip-swatch {
  width: 8px; height: 8px; border-radius: 50%; flex: none;
  border: 1px solid color-mix(in srgb, var(--dsh-tasks-ink) 20%, transparent);
}
.dsh-tasks-filter-chip-key { flex: none; font-size: 11px; color: var(--dsh-tasks-muted); }
.dsh-tasks-filter-chip-value { min-width: 0; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 550; }
.dsh-tasks-root .dsh-tasks-due-chip[data-overdue],
.dsh-tasks-root .dsh-tasks-filter-chip[data-priority="P0" i] { --chip-tone: var(--dsh-paper-danger, var(--dsh-ios-danger, var(--dsw-alias-state-error-primary, #ba3548))); }
.dsh-tasks-root .dsh-tasks-filter-chip[data-priority="P1" i] { --chip-tone: var(--dsh-paper-warning, var(--dsh-ios-warning, var(--dsw-alias-state-warn-primary, #865a05))); }
.dsh-tasks-root .dsh-tasks-filter-chip[data-priority="P2" i] { --chip-tone: var(--dsh-paper-info, var(--dsh-ios-info, var(--dsw-alias-state-business-primary, #176da0))); }
.dsh-tasks-root .dsh-tasks-filter-chip[data-filter-key="ready"] { --chip-tone: var(--dsh-paper-success, var(--dsh-ios-success, var(--dsw-alias-state-success-primary))); }
.dsh-tasks-root button.dsh-tasks-filter-clear {
  box-sizing: border-box; min-height: 26px; padding: 2px 8px;
  border: 1px solid transparent; border-radius: 999px;
  background: transparent; color: var(--dsh-tasks-focus); font: inherit; font-size: 12px; font-weight: 550;
  cursor: pointer; transition: background-color .15s ease, color .15s ease;
}
.dsh-tasks-root button.dsh-tasks-filter-clear:is(:hover, :focus-visible) {
  background: color-mix(in srgb, var(--dsh-tasks-focus) 10%, transparent);
}
@media (pointer: coarse) {
  .dsh-tasks-root :is(.dsh-tasks-filter-chip, .dsh-tasks-due-chip, button.dsh-tasks-filter-clear) { min-height: 44px; }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-tasks-root :is(.dsh-tasks-filter-chip, .dsh-tasks-due-chip, .dsh-tasks-filter-chip > .dsh-tasks-icon:last-child, .dsh-tasks-due-chip > .dsh-tasks-icon:last-child, button.dsh-tasks-filter-clear) { transition: none; }
}
@media (forced-colors: active) {
  .dsh-tasks-root :is(.dsh-tasks-filter-chip, .dsh-tasks-due-chip) { background: Canvas; color: CanvasText; border-color: CanvasText; }
}
.dsh-tasks-root .dsh-tasks-menu[popover] { position: fixed; inset: auto; margin: 0; box-sizing: border-box; max-width: calc(100vw - 16px); overflow: auto; overscroll-behavior: contain; color: var(--dsh-tasks-ink); background: var(--dsh-tasks-paper); border: 1px solid var(--dsh-tasks-line); border-radius: 12px; box-shadow: 0 8px 26px -8px var(--dsh-tasks-shadow); }
.dsh-tasks-filter-panel { width: 304px; padding: 14px; }
.dsh-tasks-filter-panel:popover-open { display: grid; gap: 12px; }
.dsh-tasks-filter-head, .dsh-tasks-manage-title { display: flex; align-items: center; gap: 8px; }
.dsh-tasks-filter-head { justify-content: space-between; }
.dsh-tasks-root .dsh-tasks-filter-head .dsh-tasks-text-action { width: auto; color: var(--dsh-tasks-focus); padding: 4px 6px; font-size: 12px; }
.dsh-tasks-filter-panel label, .dsh-tasks-manage-create label { display: grid; gap: 5px; min-width: 0; font-size: 12px; color: var(--dsh-tasks-muted); }
.dsh-tasks-filter-panel .dsh-tasks-menu-label { padding: 0; font: inherit; }
.dsh-tasks-filter-panel .dsh-tasks-properties { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.dsh-tasks-filter-panel .dsh-tasks-properties label:last-child { grid-column: 1 / -1; }
.dsh-tasks-root :is(.dsh-tasks-filter-panel, .dsh-tasks-management) .dsh-tasks-select-trigger { justify-content: space-between; min-height: 36px; padding: 6px 10px; color: var(--dsh-tasks-ink); background: var(--dsh-tasks-paper); border: 1px solid var(--dsh-tasks-line); border-radius: 7px; box-shadow: none; }
.dsh-tasks-counter { display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 4px; box-sizing: border-box; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsh-tasks-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.dsh-tasks-command-list { width: 192px; padding: 5px; }
.dsh-tasks-command-list .dsh-tasks-menu-label { padding: 6px 9px 3px; color: var(--dsh-tasks-muted); font-size: 11px; }
.dsh-tasks-root .dsh-tasks-command-list .dsh-tasks-command { justify-content: flex-start; height: auto; min-height: 31px; padding: 5px 9px; text-align: start; white-space: normal; overflow-wrap: anywhere; border: 0; border-radius: 6px; box-shadow: none; background: transparent; }
.dsh-tasks-root .dsh-tasks-command-list .dsh-tasks-command[data-current] { opacity: 1; color: var(--dsh-tasks-muted); background: var(--dsw-alias-bg-layer-2); }
.dsh-tasks-command-group { border-top: 1px solid var(--dsh-tasks-rule); margin-top: 4px; }
.dsh-tasks-root .dsh-tasks-command-list .dsh-tasks-danger { margin-top: 4px; border-top: 1px solid var(--dsh-tasks-rule); border-radius: 0 0 6px 6px; }
.dsh-tasks-root .dsh-tasks-command-list .dsh-tasks-command:not(:disabled):is(:hover,:focus-visible), .dsh-tasks-root .dsh-tasks-row-action:not(:disabled):hover { background: var(--dsw-alias-bg-layer-2); }
.dsh-tasks-root .dsh-tasks-management-dialog {
  position: fixed; inset: 0; margin: auto; box-sizing: border-box;
  inline-size: min(31rem, calc(100% - 24px)); max-inline-size: none; block-size: fit-content;
  max-block-size: min(34rem, calc(100dvh - 24px)); overflow: hidden;
  background-color: var(--dsh-tasks-paper); color: var(--dsh-tasks-ink); border-color: var(--dsh-tasks-line);
}
.dsh-tasks-management-dialog[open] { display: flex; flex-direction: column; }
.dsh-tasks-management-dialog .dsh-tasks-dialog-head { flex: none; align-items: flex-start; gap: 10px; padding: 14px 16px 12px; border-bottom: 1px solid var(--dsh-tasks-rule); }
.dsh-tasks-management-dialog .dsh-tasks-dialog-head > div { min-inline-size: 0; overflow-wrap: anywhere; }
.dsh-tasks-management-dialog .dsh-tasks-dialog-head > :is(.dsh-tasks-logo, .dsh-tasks-icon-button) { flex: none; }
.dsh-tasks-management-dialog .dsh-tasks-dialog-head h2 { font-size: 16px; }
.dsh-tasks-management-dialog .dsh-tasks-dialog-head p { color: var(--dsh-tasks-muted); }
.dsh-tasks-management-dialog .dsh-tasks-dialog-head > .dsh-tasks-logo { width: 30px; height: 30px; }
.dsh-tasks-management { container: task-management / inline-size; min-block-size: 0; overflow: auto; overscroll-behavior: contain; padding: 14px 16px 16px; }
.dsh-tasks-management > .dsh-tasks-feedback { overflow-wrap: anywhere; }
.dsh-tasks-manage-layout { display: grid; gap: 16px; min-width: 0; margin: 0; padding: 0; border: 0; }
.dsh-tasks-manage-title { margin: 0 0 9px; font-size: 13px; font-weight: 650; }
.dsh-tasks-manage-list { padding: 0 10px; background: var(--dsh-tasks-paper); border: 1px solid var(--dsh-tasks-rule); border-radius: 10px; }
.dsh-tasks-management .dsh-tasks-manage-list form { display: grid; grid-template-columns: auto minmax(0,1fr) auto; align-items: center; gap: 6px; margin: 0; padding: 9px 0; background: transparent; border: 0; border-radius: 0; }
.dsh-tasks-root .dsh-tasks-column-manager .dsh-tasks-manage-list form { grid-template-columns: auto auto minmax(0,1fr) auto; }
.dsh-tasks-manage-list form + form { border-top: 1px solid var(--dsh-tasks-rule) !important; }
.dsh-tasks-row-name { min-width: 0; }
.dsh-tasks-row-name small { display: block; margin-inline-start: 7px; font-size: 11px; color: var(--dsh-tasks-muted); overflow-wrap: anywhere; }
.dsh-tasks-root .dsh-tasks-row-name .dsh-tasks-input { width: 100%; padding-inline: 6px; border: 1px solid transparent; background: transparent; font-weight: 550; }
.dsh-tasks-root .dsh-tasks-row-name .dsh-tasks-input:is(:hover,:focus-within) { border-color: var(--dsh-tasks-line); background: var(--dsh-tasks-paper); }
.dsh-tasks-row-tools { display: flex; gap: 2px; align-items: center; }
.dsh-tasks-root .dsh-tasks-row-action { display: inline-grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 6px; background: none; box-shadow: none; color: var(--dsh-tasks-muted); cursor: pointer; }
.dsh-tasks-root .dsh-tasks-row-action.dsh-tasks-danger:not(:disabled) { color: var(--dsw-alias-state-error-primary); }
.dsh-tasks-root .dsh-tasks-row-action:disabled { cursor: default; }
.dsh-tasks-management .dsh-tasks-manage-create { display: grid; align-items: end; gap: 10px; padding: 14px; border: 1px solid var(--dsh-tasks-rule); border-radius: 10px; background: var(--dsw-alias-bg-layer-2); }
.dsh-tasks-management .dsh-tasks-new-label { grid-template-columns: auto minmax(0,1fr) auto; }
.dsh-tasks-management .dsh-tasks-manage-create :is(.dsh-tasks-input, .dsh-tasks-primary) { min-height: 36px; }
.dsh-tasks-root .dsh-tasks-column-manager .dsh-tasks-manage-create {
  --dsh-tasks-add-column-control: 36px;
  grid-template-columns: auto minmax(0, 1.15fr) minmax(0, .85fr) auto;
}
.dsh-tasks-root .dsh-tasks-column-manager .dsh-tasks-manage-create :is(.dsh-tasks-input, .dsh-tasks-select-trigger) {
  box-sizing: border-box; inline-size: 100%; min-inline-size: 0; margin: 0;
  block-size: var(--dsh-tasks-add-column-control); min-block-size: var(--dsh-tasks-add-column-control);
  padding: 0 10px; border-radius: var(--dsw-radius-sm, 8px); font: inherit;
}
.dsh-tasks-root .dsh-tasks-column-manager .dsh-tasks-manage-create > button.dsh-tasks-primary[type="submit"] {
  box-sizing: border-box; height: var(--dsh-tasks-add-column-control);
  min-height: var(--dsh-tasks-add-column-control); max-inline-size: 100%;
}
@media (pointer: coarse) { .dsh-tasks-root .dsh-tasks-column-manager .dsh-tasks-manage-create { --dsh-tasks-add-column-control: 44px; } }
.dsh-tasks-col-color-field { display: grid; gap: 5px; min-width: 0; font-size: 12px; color: var(--dsh-tasks-muted); }
.dsh-tasks-col-color-picker { position: relative; display: inline-flex; }
.dsh-tasks-col-color-picker > summary { list-style: none; }
.dsh-tasks-col-color-picker > summary::-webkit-details-marker { display: none; }
.dsh-tasks-col-color-trigger {
  box-sizing: border-box; display: inline-grid; place-items: center;
  width: 32px; height: 32px; padding: 0;
  border: 1px solid var(--dsh-tasks-rule); border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsh-tasks-paper); cursor: pointer;
  transition: border-color .15s ease, background-color .15s ease;
}
.dsh-tasks-column-manager .dsh-tasks-manage-create .dsh-tasks-col-color-trigger {
  width: var(--dsh-tasks-add-column-control, 36px); height: var(--dsh-tasks-add-column-control, 36px);
}
.dsh-tasks-col-color-trigger:not([aria-disabled=true]):hover,
.dsh-tasks-col-color-picker[open] > .dsh-tasks-col-color-trigger {
  border-color: var(--dsh-tasks-focus);
  background: color-mix(in srgb, var(--dsh-tasks-focus) 6%, var(--dsh-tasks-paper));
}
.dsh-tasks-col-color-trigger[aria-disabled=true] { opacity: .55; cursor: default; }
.dsh-tasks-col-color-dot {
  box-sizing: border-box; width: 18px; height: 18px; border-radius: 50%; forced-color-adjust: none;
  background: color-mix(in srgb, var(--dsh-tasks-swatch) 48%, var(--dsh-tasks-paper));
  border: 1.5px dashed color-mix(in srgb, var(--dsh-tasks-swatch) 85%, var(--dsh-tasks-ink));
}
.dsh-tasks-col-color-trigger[data-custom] .dsh-tasks-col-color-dot {
  background: var(--dsh-tasks-swatch);
  border: 1.5px solid color-mix(in srgb, var(--dsh-tasks-ink) 22%, transparent);
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / 22%);
}
.dsh-tasks-root .dsh-tasks-menu.dsh-tasks-col-color-menu { width: 228px; padding: 10px; }
.dsh-tasks-root .dsh-tasks-menu.dsh-tasks-col-color-menu:popover-open { display: grid; gap: 10px; }
.dsh-tasks-col-color-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dsh-tasks-col-color-head .dsh-tasks-menu-label { padding: 0; font-size: 11px; color: var(--dsh-tasks-muted); }
.dsh-tasks-root .dsh-tasks-menu.dsh-tasks-col-color-menu button.dsh-tasks-col-color-reset {
  width: auto; min-height: 24px; padding: 2px 8px; border-radius: 6px;
  border: 1px solid var(--dsh-tasks-rule); background: transparent;
  color: var(--dsh-tasks-muted); font-size: 11px; line-height: 1.4;
}
.dsh-tasks-root .dsh-tasks-menu.dsh-tasks-col-color-menu button.dsh-tasks-col-color-reset:not(:disabled):hover {
  border-color: var(--dsh-tasks-focus); color: var(--dsh-tasks-ink);
  background: color-mix(in srgb, var(--dsh-tasks-focus) 9%, var(--dsh-tasks-paper));
}
.dsh-tasks-root .dsh-tasks-menu.dsh-tasks-col-color-menu button.dsh-tasks-col-color-reset[aria-pressed=true] {
  opacity: 1; border-color: var(--dsh-tasks-focus); color: var(--dsh-tasks-focus);
  background: color-mix(in srgb, var(--dsh-tasks-focus) 10%, var(--dsh-tasks-paper));
}
.dsh-tasks-col-color-swatches { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; justify-items: center; }
.dsh-tasks-root .dsh-tasks-menu.dsh-tasks-col-color-menu .dsh-tasks-col-color-swatches button.dsh-tasks-col-color-swatch {
  box-sizing: border-box; display: inline-grid; place-items: center;
  width: 28px; height: 28px; padding: 0; border-radius: 50%; forced-color-adjust: none;
  background: var(--dsh-tasks-swatch);
  border: 2px solid color-mix(in srgb, var(--dsh-tasks-ink) 16%, transparent);
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / 24%);
  transition: transform .12s ease, border-color .12s ease, box-shadow .12s ease;
}
.dsh-tasks-root .dsh-tasks-menu.dsh-tasks-col-color-menu .dsh-tasks-col-color-swatches button.dsh-tasks-col-color-swatch:hover:not(:disabled) {
  background: var(--dsh-tasks-swatch); transform: scale(1.08); border-color: var(--dsh-tasks-ink);
}
.dsh-tasks-root .dsh-tasks-menu.dsh-tasks-col-color-menu .dsh-tasks-col-color-swatches button.dsh-tasks-col-color-swatch[aria-pressed=true] {
  background: var(--dsh-tasks-swatch); border-color: var(--dsh-tasks-ink);
  box-shadow: 0 0 0 2px var(--dsh-tasks-paper), 0 0 0 4px var(--dsh-tasks-focus);
}
.dsh-tasks-col-color-custom { display: flex; align-items: center; gap: 8px; padding-top: 8px; border-top: 1px dashed var(--dsh-tasks-rule); }
.dsh-tasks-col-color-custom .dsh-tasks-swatch-field { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--dsh-tasks-muted); cursor: pointer; }
.dsh-tasks-col-color-custom .dsh-tasks-swatch-field input { width: 26px; height: 26px; padding: 3px; border-radius: 6px; }
.dsh-tasks-col-color-hex { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--dsh-tasks-muted); margin-inline-end: auto; }
.dsh-tasks-root .dsh-tasks-menu.dsh-tasks-col-color-menu button.dsh-tasks-col-color-apply {
  width: auto; min-height: 26px; padding: 2px 9px; font-size: 11px;
  border: 1px solid var(--dsh-tasks-line); border-radius: 6px; background: var(--dsh-tasks-paper); color: var(--dsh-tasks-ink);
}
.dsh-tasks-root .dsh-tasks-menu.dsh-tasks-col-color-menu button.dsh-tasks-col-color-apply:hover:not(:disabled) {
  border-color: var(--dsh-tasks-focus); background: color-mix(in srgb, var(--dsh-tasks-focus) 10%, var(--dsh-tasks-paper));
}
@media (pointer: coarse) {
  .dsh-tasks-col-color-trigger { width: 44px; height: 44px; }
  .dsh-tasks-root .dsh-tasks-menu.dsh-tasks-col-color-menu .dsh-tasks-col-color-swatches button.dsh-tasks-col-color-swatch { width: 38px; height: 38px; }
  .dsh-tasks-root .dsh-tasks-menu.dsh-tasks-col-color-menu button:is(.dsh-tasks-col-color-reset, .dsh-tasks-col-color-apply) { min-height: 36px; }
}
.dsh-tasks-swatch-field input { appearance: none; box-sizing: border-box; width: 36px; height: 36px; padding: 6px; border: 1px solid var(--dsh-tasks-line); border-radius: 8px; background: var(--dsh-tasks-paper); cursor: pointer; }
.dsh-tasks-swatch-field input::-webkit-color-swatch-wrapper { padding: 0; }
.dsh-tasks-swatch-field input::-webkit-color-swatch { border: 0; border-radius: 50%; }
.dsh-tasks-empty-labels { display: flex; align-items: center; gap: 12px; padding: 16px; border-block: 1px solid var(--dsh-tasks-rule); color: var(--dsh-tasks-muted); }
.dsh-tasks-empty-labels strong { color: var(--dsh-tasks-ink); } .dsh-tasks-empty-labels p { margin: 3px 0 0; }
.dsh-tasks-card-buttons { display: flex; gap: 8px; margin-top: 10px; }
.dsh-tasks-board .dsh-tasks-card-title > .dsh-tasks-card-title-text {
  display: -webkit-box; min-width: 0; overflow: hidden; overflow-wrap: anywhere; white-space: normal;
  text-align: start; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-height: 1.55;
}
.dsh-tasks-card-blockers {
  display: flex; align-items: center; gap: 5px; flex-wrap: nowrap; min-width: 0; margin-top: 7px; padding: 3px 7px; border-radius: 6px;
  border: 1px solid color-mix(in srgb, var(--dsh-paper-warning, var(--dsw-alias-state-warn-primary, #b45309)) 22%, var(--dsh-tasks-line));
  background: color-mix(in srgb, var(--dsh-paper-warningSoft, var(--dsw-alias-state-warn-tertiary, #fef3c7)) 55%, var(--dsh-tasks-paper));
  color: color-mix(in srgb, var(--dsh-paper-warning, var(--dsw-alias-state-warn-primary, #92400e)) 85%, var(--dsh-tasks-muted));
  font-size: 11px; line-height: 1.4;
}
.dsh-tasks-card-blockers > .dsh-tasks-icon { flex: none; color: var(--dsh-paper-warning, var(--dsw-alias-state-warn-primary, #b45309)); opacity: .85; }
.dsh-tasks-card-blockers .dsh-tasks-blocker-more { flex: none; font-variant-numeric: tabular-nums; opacity: .8; }
.dsh-tasks-root button.dsh-tasks-dependency-link { justify-content: flex-start; max-width: 100%; min-height: 20px; padding: 0 2px; border: 0; box-shadow: none; background: transparent; font: inherit; color: var(--dsh-tasks-focus); text-align: start; text-decoration: underline; text-underline-offset: 2px; }
.dsh-tasks-root button.dsh-tasks-dependency-link:hover { color: var(--dsh-tasks-ink); }
.dsh-tasks-root .dsh-tasks-card-blockers button.dsh-tasks-dependency-link {
  display: inline-flex; align-items: center; flex: 0 1 auto; min-width: 0; max-width: 100%; min-height: 18px; height: auto;
  padding: 0; border: 0; box-shadow: none; background: transparent; color: inherit; font: inherit; text-align: start; text-decoration: none; overflow: hidden;
}
.dsh-tasks-card-blockers .dsh-tasks-dependency-title { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-tasks-root .dsh-tasks-card-blockers button.dsh-tasks-dependency-link:is(:hover, :focus-visible) {
  color: var(--dsh-paper-warning, var(--dsw-alias-state-warn-primary, var(--dsh-tasks-ink))); text-decoration: underline; text-underline-offset: 2px;
}
.dsh-tasks-card-blockers button.dsh-tasks-dependency-link + button.dsh-tasks-dependency-link::before { content: '·'; margin-inline-end: 5px; opacity: .55; flex: none; }
.dsh-tasks-prerequisites, .dsh-tasks-dependents { display: grid; gap: 6px; min-width: 0; }
.dsh-tasks-prerequisites ul, .dsh-tasks-dependents ul, .dsh-tasks-attention-list ul, .dsh-tasks-evidence-links { list-style: none; margin: 0; padding: 0; }
.dsh-tasks-prerequisites li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 8px; font-size: 13px; overflow-wrap: anywhere; }
.dsh-tasks-dependents li { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px; font-size: 13px; overflow-wrap: anywhere; }
.dsh-tasks-prerequisites li > small, .dsh-tasks-dependents li > small { color: var(--dsh-tasks-muted); font-size: 12px; white-space: nowrap; }
.dsh-tasks-dependents-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dsh-tasks-dependents-badge {
  display: inline-flex; align-items: center; padding: 1px 7px; border-radius: 999px;
  font-size: 11px; font-weight: 550; font-variant-numeric: tabular-nums;
  color: var(--dsh-paper-warning, var(--dsw-alias-state-warn-primary));
  background: color-mix(in srgb, var(--dsh-paper-warning, var(--dsw-alias-state-warn-primary)) 10%, var(--dsh-tasks-paper));
  border: 1px solid color-mix(in srgb, var(--dsh-paper-warning, var(--dsw-alias-state-warn-primary)) 26%, transparent);
}
.dsh-tasks-dependency-chooser { display: grid; gap: 6px; }
.dsh-tasks-ready-filter { margin-top: 8px; }
.dsh-tasks-ready-filter[aria-pressed=true] { color: var(--dsh-tasks-focus); border-color: var(--dsh-tasks-focus); }
.dsh-tasks-board-view:has(> :is(.dsh-tasks-attention, .dsh-tasks-active-filters)) { --dsh-tasks-board-top: 14px; }
.dsh-tasks-root.dsh-tasks-board-view > .dsh-tasks-attention {
  --attention-tone: var(--dsh-tasks-focus);
  flex: none; min-width: 0; margin: 12px var(--dsh-tasks-panel-gutter) 0; padding: 0; overflow: hidden;
  background: color-mix(in srgb, var(--attention-tone) 6%, var(--dsh-tasks-paper));
  border: 1px solid color-mix(in srgb, var(--attention-tone) 26%, var(--dsh-tasks-rule));
  border-radius: var(--dsw-radius-md, 10px);
  color: var(--dsh-tasks-ink);
  box-shadow: 0 1px 2px color-mix(in srgb, var(--dsh-tasks-shadow) 32%, transparent);
  transition: border-color .15s ease, box-shadow .15s ease;
}
.dsh-tasks-root.dsh-tasks-board-view > .dsh-tasks-attention[data-attention-tone="warn"] {
  --attention-tone: var(--dsh-paper-warning, var(--dsw-alias-state-warn-primary));
}
.dsh-tasks-root.dsh-tasks-board-view > .dsh-tasks-attention[data-attention-tone="danger"] {
  --attention-tone: var(--dsh-paper-danger, var(--dsw-alias-state-error-primary));
}
.dsh-tasks-root.dsh-tasks-board-view > .dsh-tasks-attention[open] {
  border-color: color-mix(in srgb, var(--attention-tone) 38%, var(--dsh-tasks-rule));
  box-shadow: 0 4px 12px -4px color-mix(in srgb, var(--dsh-tasks-shadow) 55%, transparent);
}
.dsh-tasks-attention > .dsh-tasks-attention-summary {
  display: flex; flex-wrap: nowrap; align-items: center; gap: 8px 10px;
  min-height: 40px; box-sizing: border-box; padding: 7px 12px;
  list-style: none; cursor: pointer; user-select: none;
  transition: background-color .15s ease;
}
.dsh-tasks-attention > .dsh-tasks-attention-summary:hover {
  background: color-mix(in srgb, var(--attention-tone) 6%, transparent);
}
.dsh-tasks-attention-summary::-webkit-details-marker { display: none; }
.dsh-tasks-attention-badge {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 24px; height: 24px; border-radius: var(--dsw-radius-xs, 6px);
  background: color-mix(in srgb, var(--attention-tone) 14%, var(--dsh-tasks-paper));
  color: var(--attention-tone);
}
.dsh-tasks-attention-summary > strong {
  flex: none; font-size: 13px; font-weight: 650;
  font-variant-numeric: tabular-nums; white-space: nowrap; color: var(--dsh-tasks-ink);
}
.dsh-tasks-attention [data-reason] { --pill-tone: var(--dsh-tasks-focus); }
.dsh-tasks-attention :is([data-reason="approval"], [data-reason="question"], [data-reason="reviewReturned"]) {
  --pill-tone: var(--dsh-paper-warning, var(--dsw-alias-state-warn-primary));
}
.dsh-tasks-attention [data-reason="error"] {
  --pill-tone: var(--dsh-paper-danger, var(--dsw-alias-state-error-primary));
}
.dsh-tasks-delivery-section h3 > .dsh-tasks-icon { color: var(--dsh-tasks-focus); }
.dsh-tasks-attention-counts, .dsh-tasks-delivery-actions, .dsh-tasks-delivery-meta, .dsh-tasks-run-status { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }
.dsh-tasks-attention-counts { flex: none; }
.dsh-tasks-attention-counts > small { display: inline-flex; font: inherit; }
.dsh-tasks-root .dsh-tasks-attention-counts button.dsh-tasks-attention-pill {
  box-sizing: border-box; display: inline-flex; align-items: center; gap: 5px;
  min-height: 22px; height: auto; padding: 2px 8px; border-radius: 999px;
  font: inherit; font-size: 11px; font-weight: 550; line-height: 16px;
  font-variant-numeric: tabular-nums; white-space: nowrap;
  color: var(--pill-tone);
  background: color-mix(in srgb, var(--pill-tone) 11%, var(--dsh-tasks-paper));
  border: 1px solid color-mix(in srgb, var(--pill-tone) 26%, transparent);
  box-shadow: none; cursor: pointer;
  transition: background-color .15s ease, border-color .15s ease, box-shadow .15s ease;
}
.dsh-tasks-root .dsh-tasks-attention-counts button.dsh-tasks-attention-pill:is(:hover, :focus-visible) {
  background: color-mix(in srgb, var(--pill-tone) 17%, var(--dsh-tasks-paper));
  border-color: color-mix(in srgb, var(--pill-tone) 48%, transparent);
}
.dsh-tasks-root .dsh-tasks-attention-counts button.dsh-tasks-attention-pill[data-active] {
  background: color-mix(in srgb, var(--pill-tone) 22%, var(--dsh-tasks-paper));
  border-color: var(--pill-tone);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--pill-tone) 28%, transparent);
  font-weight: 650;
}
.dsh-tasks-root .dsh-tasks-attention-counts button.dsh-tasks-attention-pill::before {
  content: ''; width: 5px; height: 5px; border-radius: 50%; background: currentColor; flex: none;
}
.dsh-tasks-root button.dsh-tasks-attention-show-all {
  margin-inline-start: auto; box-sizing: border-box; min-height: 20px; height: auto; padding: 1px 8px;
  border-radius: 999px; border: 1px solid color-mix(in srgb, var(--attention-tone) 28%, var(--dsh-tasks-rule));
  background: var(--dsh-tasks-paper); color: var(--dsh-tasks-focus);
  font: inherit; font-size: 11px; font-weight: 550; box-shadow: none; cursor: pointer;
  transition: background-color .15s ease, border-color .15s ease;
}
.dsh-tasks-root button.dsh-tasks-attention-show-all:is(:hover, :focus-visible) {
  background: color-mix(in srgb, var(--dsh-tasks-focus) 10%, var(--dsh-tasks-paper));
  border-color: var(--dsh-tasks-focus);
}
.dsh-tasks-attention-preview {
  display: flex; align-items: center; gap: 6px; flex: 1 1 140px; min-width: 0;
  padding-inline-start: 10px;
  border-inline-start: 1px solid color-mix(in srgb, var(--attention-tone) 20%, var(--dsh-tasks-rule));
  color: var(--dsh-tasks-muted); font-size: 12px;
}
.dsh-tasks-attention-preview > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-tasks-attention-preview-more { flex: none; font-size: 11px; opacity: .82; font-variant-numeric: tabular-nums; }
.dsh-tasks-attention[open] .dsh-tasks-attention-preview { display: none; }
.dsh-tasks-attention-toggle {
  margin-inline-start: auto; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; border-radius: var(--dsw-radius-xs, 6px);
  color: var(--dsh-tasks-muted);
  transition: transform .18s ease, background-color .15s ease, color .15s ease;
}
.dsh-tasks-attention-summary:hover .dsh-tasks-attention-toggle {
  color: var(--dsh-tasks-ink);
  background: color-mix(in srgb, var(--attention-tone) 12%, transparent);
}
.dsh-tasks-attention[open] > .dsh-tasks-attention-summary .dsh-tasks-attention-toggle {
  transform: rotate(180deg); color: var(--attention-tone);
}
.dsh-tasks-attention-list {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr));
  gap: 10px 14px; max-height: 32vh; overflow: auto; padding: 10px 12px 12px;
  border-top: 1px dashed color-mix(in srgb, var(--attention-tone) 24%, var(--dsh-tasks-rule));
  background: color-mix(in srgb, var(--dsh-tasks-paper) 55%, transparent);
}
.dsh-tasks-attention-list section { min-width: 0; }
.dsh-tasks-attention-group-head {
  display: flex; align-items: center; gap: 6px; margin-bottom: 6px;
  color: var(--pill-tone); font-size: 11px;
}
.dsh-tasks-attention-group-head strong { color: inherit; font-size: 11px; font-weight: 650; }
.dsh-tasks-attention-group-head small {
  padding: 0 5px; border-radius: 999px;
  background: color-mix(in srgb, var(--pill-tone) 12%, var(--dsh-tasks-paper));
  color: var(--pill-tone); font-size: 10px; font-weight: 600; line-height: 16px;
  font-variant-numeric: tabular-nums;
}
.dsh-tasks-attention-list ul { display: grid; gap: 5px; }
.dsh-tasks-root button.dsh-tasks-attention-item {
  display: flex; align-items: center; width: 100%; min-width: 0; min-height: 36px; height: auto;
  box-sizing: border-box; gap: 8px; padding: 6px 10px;
  border: 1px solid color-mix(in srgb, var(--dsh-tasks-line) 55%, transparent);
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsh-tasks-paper); color: var(--dsh-tasks-ink);
  font-size: 12.5px; text-align: start; box-shadow: none; cursor: pointer;
  transition: border-color .15s ease, background-color .15s ease;
}
.dsh-tasks-root button.dsh-tasks-attention-item:is(:hover, :focus-visible) {
  border-color: color-mix(in srgb, var(--pill-tone) 55%, var(--dsh-tasks-line));
  background: color-mix(in srgb, var(--pill-tone) 7%, var(--dsh-tasks-paper));
}
.dsh-tasks-attention-item-title {
  flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 550;
}
.dsh-tasks-attention-item-meta {
  display: inline-flex; align-items: center; gap: 8px; flex: none; margin-inline-start: auto; max-width: 48%;
}
.dsh-tasks-attention-item-ws {
  display: inline-flex; align-items: center; gap: 4px; min-width: 0; max-width: 130px;
  font-size: 11px; color: var(--dsh-tasks-muted);
}
.dsh-tasks-attention-item-ws > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-tasks-attention-item-action {
  display: inline-flex; align-items: center; gap: 2px; flex: none;
  font-size: 11px; font-weight: 600; color: var(--pill-tone); white-space: nowrap;
  transition: transform .15s ease;
}
.dsh-tasks-root button.dsh-tasks-attention-item:hover .dsh-tasks-attention-item-action { transform: translateX(1px); }
@container task-panel (max-width: 680px) {
  .dsh-tasks-attention > .dsh-tasks-attention-summary { flex-wrap: wrap; }
  .dsh-tasks-attention-preview { display: none; }
}
@container task-panel (max-width: 520px) {
  .dsh-tasks-attention-item-ws { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-tasks-attention, .dsh-tasks-attention-summary, .dsh-tasks-attention-toggle,
  .dsh-tasks-root button.dsh-tasks-attention-item, .dsh-tasks-attention-item-action,
  .dsh-tasks-root .dsh-tasks-attention-counts button.dsh-tasks-attention-pill,
  .dsh-tasks-root button.dsh-tasks-attention-show-all,
  .dsh-tasks-unlock-toast { transition: none; }
}
.dsh-tasks-workspace { position: relative; }
.dsh-tasks-workspace[data-overlay-insights] > .dsh-tasks-insights { display: flex; position: absolute; z-index: 5; inset-block-start: 0; inset-inline-start: 0; width: min(420px, calc(100% - 2 * var(--dsh-tasks-panel-gutter))); box-shadow: 0 8px 24px var(--dsh-tasks-shadow); }
.dsh-tasks-launch-criteria { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--dsh-tasks-rule); border-radius: 10px; background: color-mix(in srgb, var(--dsh-tasks-focus) 4%, var(--dsh-tasks-paper)); }
.dsh-tasks-delivery-section { display: grid; gap: 12px; margin: 4px 0 12px; overflow-wrap: anywhere; }
.dsh-tasks-delivery-section :is(h3,h4,p), .dsh-tasks-launch-criteria :is(p,small) { margin: 0; }
.dsh-tasks-delivery-section h3, .dsh-tasks-evidence-links a { display: flex; align-items: center; gap: 6px; }
.dsh-tasks-evidence-links a { width: fit-content; color: var(--dsh-tasks-focus); }
.dsh-tasks-evidence-item p, .dsh-tasks-launch-criteria p { white-space: pre-wrap; overflow-wrap: anywhere; }
.dsh-tasks-launch-criteria summary { cursor: pointer; }
.dsh-tasks-delivery-meta time, .dsh-tasks-delivery-section small, .dsh-tasks-launch-criteria small { color: var(--dsh-tasks-muted); }
.dsh-tasks-delivery-actions { justify-content: flex-end; }
.dsh-tasks-review-input { display: grid; gap: 5px; }
@media (pointer: coarse) { .dsh-tasks-root :is(button.dsh-tasks-dependency-link, button.dsh-tasks-attention-item), .dsh-tasks-root .dsh-tasks-card-blockers button.dsh-tasks-dependency-link, .dsh-tasks-attention-summary { min-height: 44px; } }
.dsh-tasks-root .dsh-tasks-board .dsh-tasks-card[data-task-id] {
  min-width: 0; padding: 12px 13px; margin-bottom: 10px; border-radius: 10px;
  & .dsh-tasks-card-heading { position: relative; gap: 6px; }
  & .dsh-tasks-card-heading > .dsh-tasks-grip {
    position: absolute; inset-inline-start: -12px; top: 2px; width: 12px; min-width: 12px; height: 22px; min-height: 22px;
    padding: 0; display: inline-flex; align-items: center; justify-content: center;
    color: var(--dsh-tasks-muted); opacity: 0; pointer-events: none; transition: opacity .15s ease, color .15s ease;
  }
  &:is(:hover, :focus-within, [data-dragging]) .dsh-tasks-card-heading > .dsh-tasks-grip,
  & .dsh-tasks-card-heading > .dsh-tasks-grip:focus-visible { opacity: .72; pointer-events: auto; }
  & .dsh-tasks-card-heading > .dsh-tasks-grip:is(:hover, :focus-visible) { opacity: 1; color: var(--dsh-tasks-focus); }
  @media (hover: none), (pointer: coarse) {
    & .dsh-tasks-card-heading > .dsh-tasks-grip {
      position: static; width: 28px; min-width: 28px; min-height: 44px; margin-inline-start: -6px; opacity: .55; pointer-events: auto;
    }
  }
  & .dsh-tasks-card-brief { margin: 4px 0 0; line-height: 1.5; }
  &[data-stage="done"] .dsh-tasks-card-brief { -webkit-line-clamp: 1; opacity: .82; }
  &[data-stage="done"] :is(.dsh-tasks-card-properties, .dsh-tasks-card-footer) { opacity: .84; }
  & .dsh-tasks-card-properties { flex-wrap: wrap; gap: 4px 6px; margin-top: 6px; }
  & .dsh-tasks-card-properties > * { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
  & .dsh-tasks-card-properties > :is(.dsh-tasks-priority-tag, .dsh-tasks-label-tag, :has(> [data-priority]), :has(> [data-label-chip])) {
    box-sizing: border-box; display: inline-flex; align-items: center; height: 20px; min-height: 20px; padding: 0 6px;
    border-radius: 5px; font-size: 11px; line-height: 18px; font-weight: 500;
    border: 1px solid color-mix(in srgb, var(--dsh-tasks-line) 72%, transparent);
    background: color-mix(in srgb, var(--dsh-tasks-muted) 8%, var(--dsh-tasks-paper));
    color: var(--dsh-tasks-muted);
  }
  & .dsh-tasks-card-properties > :is([data-priority="P0" i], :has(> [data-priority="P0" i])) {
    color: var(--dsh-paper-danger, var(--dsw-alias-state-error-primary, #ba3548));
    background: var(--dsh-paper-dangerSoft, color-mix(in srgb, var(--dsw-alias-state-error-primary, #ba3548) 10%, var(--dsh-tasks-paper)));
    border-color: color-mix(in srgb, var(--dsh-paper-danger, var(--dsw-alias-state-error-primary, #ba3548)) 32%, transparent);
    font-weight: 600;
  }
  & .dsh-tasks-card-properties > :is([data-priority="P1" i], :has(> [data-priority="P1" i])) {
    color: var(--dsh-paper-warning, var(--dsw-alias-state-warn-primary, #865a05));
    background: var(--dsh-paper-warningSoft, color-mix(in srgb, var(--dsw-alias-state-warn-primary, #865a05) 12%, var(--dsh-tasks-paper)));
    border-color: color-mix(in srgb, var(--dsh-paper-warning, var(--dsw-alias-state-warn-primary, #865a05)) 32%, transparent);
    font-weight: 600;
  }
  & .dsh-tasks-card-properties > :is([data-priority="P2" i], :has(> [data-priority="P2" i])) {
    color: var(--dsh-paper-info, var(--dsw-alias-state-business-primary, #176da0));
    background: var(--dsh-paper-infoSoft, color-mix(in srgb, var(--dsw-alias-state-business-primary, #176da0) 10%, var(--dsh-tasks-paper)));
    border-color: color-mix(in srgb, var(--dsh-paper-info, var(--dsw-alias-state-business-primary, #176da0)) 28%, transparent);
    font-weight: 500;
  }
  & .dsh-tasks-card-due { display: inline-flex; align-items: center; gap: 4px; min-height: 20px; font-size: 11px; line-height: 18px; white-space: normal; overflow-wrap: anywhere; }
  & .dsh-tasks-card-due[data-overdue] { color: var(--dsh-paper-danger, var(--dsw-alias-state-error-primary)); }
  & .dsh-tasks-card-footer {
    display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 8px;
    margin-top: 9px; padding-top: 8px; border-top: 1px dashed color-mix(in srgb, var(--dsh-tasks-line) 48%, transparent);
  }
  &[data-stage="done"] .dsh-tasks-card-footer { border-top-color: color-mix(in srgb, var(--dsh-tasks-line) 32%, transparent); }
  & .dsh-tasks-card-context { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; flex: 1 1 130px; min-width: 0; margin-top: 0; }
  & .dsh-tasks-card-state { margin: 0; max-width: 100%; overflow-wrap: anywhere; }
  & .dsh-tasks-card-context > .dsh-tasks-card-meta { flex: 0 1 auto; min-width: 0; max-width: 100%; }
  & .dsh-tasks-card-counts { display: inline-flex; align-items: center; gap: 6px; flex: none; color: var(--dsh-tasks-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  & .dsh-tasks-meta-count { display: inline-flex; align-items: center; gap: 3px; line-height: 1; color: var(--dsh-tasks-muted); }
  & .dsh-tasks-meta-count > .dsh-tasks-icon { opacity: .78; }
  & .dsh-tasks-card-meta { min-width: 0; padding-top: 0; font-family: inherit; }
  & .dsh-tasks-status-time { display: none; }
  & .dsh-tasks-card-buttons { display: flex; justify-content: flex-end; align-items: center; flex: 0 0 auto; flex-wrap: wrap; gap: 5px; margin-top: 0; margin-inline-start: auto; border: 0 !important; padding: 0 !important; }
  & .dsh-tasks-card-buttons button { min-width: 0; max-width: 100%; height: auto; white-space: normal; }
  & .dsh-tasks-card-buttons button.dsh-tasks-card-action-btn {
    min-height: 24px;
    height: auto;
    padding: 0 9px;
    font-size: 11px;
    font-weight: 550;
    line-height: 22px;
    border-radius: 5px;
    box-shadow: none;
    border-color: color-mix(in srgb, var(--dsh-tasks-focus) 42%, var(--dsh-tasks-line));
    background: color-mix(in srgb, var(--dsh-tasks-focus) 10%, var(--dsh-tasks-paper));
    color: var(--dsh-tasks-focus);
    transition: background-color .15s ease, border-color .15s ease, color .15s ease;
  }
  & .dsh-tasks-card-buttons button.dsh-tasks-card-action-btn[data-action-tone="promote"]:hover:not(:disabled) {
    background: color-mix(in srgb, var(--dsh-tasks-focus) 18%, var(--dsh-tasks-paper));
    border-color: var(--dsh-tasks-focus);
  }
  & .dsh-tasks-card-buttons button.dsh-tasks-card-action-btn[data-action-tone="neutral"] {
    border-color: color-mix(in srgb, var(--dsh-tasks-line) 78%, transparent);
    background: transparent;
    color: var(--dsh-tasks-muted);
    font-weight: 500;
  }
  & .dsh-tasks-card-buttons button.dsh-tasks-card-action-btn[data-action-tone="neutral"]:hover:not(:disabled) {
    background: color-mix(in srgb, var(--dsh-tasks-muted) 10%, var(--dsh-tasks-paper));
    border-color: var(--dsh-tasks-line);
    color: var(--dsh-tasks-ink);
  }
  & :is(.dsh-tasks-card-properties, .dsh-tasks-card-buttons):empty { display: none; }
  @media (pointer: coarse) { & .dsh-tasks-card-buttons button.dsh-tasks-card-action-btn { min-height: 44px; padding: 0 12px; } }
}
body .dsh-tasks-root .dsh-tasks-card-state[data-task-status] > span.dsh-tasks-status-label[data-status-tone] {
  --status-tone: var(--dsh-tasks-muted);
  --status-dot-tone: currentColor;
  --status-bg: color-mix(in srgb, var(--dsh-tasks-muted) 7%, var(--dsh-tasks-paper));
  --status-border: color-mix(in srgb, var(--dsh-tasks-line) 62%, transparent);
  display: inline-flex; align-items: center; gap: 5px; box-sizing: border-box;
  min-height: 20px; padding: 1px 7px; border: 1px solid var(--status-border); border-radius: 999px;
  background: var(--status-bg); color: var(--status-tone);
  font-size: 11px; font-weight: 500; line-height: 16px; white-space: nowrap;
}
body .dsh-tasks-root .dsh-tasks-card-state[data-task-status] > span.dsh-tasks-status-label[data-status-tone] > .dsh-tasks-dot {
  box-sizing: border-box; width: 6px; height: 6px; border-radius: 50%; flex: none;
  border: 0; background: var(--status-dot-tone);
}
body .dsh-tasks-root .dsh-tasks-card-state[data-task-status] > span.dsh-tasks-status-label[data-status-tone="muted"] > .dsh-tasks-dot {
  border: 1.5px solid color-mix(in srgb, currentColor 72%, transparent); background: transparent;
}
body .dsh-tasks-root .dsh-tasks-card-state[data-task-status] > span.dsh-tasks-status-label[data-status-tone="ready"] {
  --status-dot-tone: var(--dsh-paper-success, var(--dsh-ios-success, var(--dsw-alias-state-success-primary)));
  --status-tone: color-mix(in srgb, var(--status-dot-tone) 78%, var(--dsh-tasks-ink));
  --status-bg: color-mix(in srgb, var(--status-dot-tone) 7%, var(--dsh-tasks-paper));
  --status-border: color-mix(in srgb, var(--status-dot-tone) 22%, transparent);
}
body .dsh-tasks-root .dsh-tasks-card-state[data-task-status] > span.dsh-tasks-status-label[data-status-tone="success"] {
  --status-tone: var(--dsh-paper-success, var(--dsh-ios-success, var(--dsw-alias-state-success-primary)));
  --status-bg: color-mix(in srgb, var(--status-tone) 10%, var(--dsh-tasks-paper));
  --status-border: color-mix(in srgb, var(--status-tone) 28%, transparent);
  font-weight: 550;
}
body .dsh-tasks-root .dsh-tasks-card-state[data-task-status] > span.dsh-tasks-status-label[data-status-tone="info"] {
  --status-tone: var(--dsh-paper-info, var(--dsh-ios-info, var(--dsw-alias-state-business-primary)));
  --status-bg: color-mix(in srgb, var(--status-tone) 11%, var(--dsh-tasks-paper));
  --status-border: color-mix(in srgb, var(--status-tone) 28%, transparent);
  font-weight: 550;
}
body .dsh-tasks-root .dsh-tasks-card-state[data-task-status] > span.dsh-tasks-status-label[data-status-tone="action"] {
  --status-tone: var(--dsh-tasks-focus);
  --status-bg: color-mix(in srgb, var(--status-tone) 12%, var(--dsh-tasks-paper));
  --status-border: color-mix(in srgb, var(--status-tone) 32%, transparent);
  font-weight: 600;
}
body .dsh-tasks-root .dsh-tasks-card-state[data-task-status] > span.dsh-tasks-status-label[data-status-tone="blocked"] {
  --status-tone: var(--dsh-paper-warning, var(--dsh-ios-warning, var(--dsw-alias-state-warn-primary)));
  --status-bg: color-mix(in srgb, var(--status-tone) 9%, var(--dsh-tasks-paper));
  --status-border: color-mix(in srgb, var(--status-tone) 26%, transparent);
  font-weight: 550;
}
body .dsh-tasks-root .dsh-tasks-card-state[data-task-status] > span.dsh-tasks-status-label[data-status-tone="warn"] {
  --status-tone: var(--dsh-paper-warning, var(--dsh-ios-warning, var(--dsw-alias-state-warn-primary)));
  --status-bg: color-mix(in srgb, var(--status-tone) 13%, var(--dsh-tasks-paper));
  --status-border: color-mix(in srgb, var(--status-tone) 34%, transparent);
  font-weight: 600;
}
body .dsh-tasks-root .dsh-tasks-card-state[data-task-status] > span.dsh-tasks-status-label[data-status-tone="danger"] {
  --status-tone: var(--dsh-paper-danger, var(--dsh-ios-danger, var(--dsw-alias-state-error-primary)));
  --status-bg: color-mix(in srgb, var(--status-tone) 13%, var(--dsh-tasks-paper));
  --status-border: color-mix(in srgb, var(--status-tone) 34%, transparent);
  font-weight: 600;
}
body .dsh-tasks-root .dsh-tasks-editor-drawer .dsh-tasks-card-state[data-task-status] > span.dsh-tasks-status-label[data-status-tone]:has(> [data-task-ink-ready]) {
  border-color: transparent;
}
body .dsh-tasks-root .dsh-tasks-board .dsh-tasks-card[data-task-id][data-card-tone] {
  --card-accent: var(--dsh-tasks-focus);
  border-color: color-mix(in srgb, var(--card-accent) 34%, var(--dsh-tasks-line));
}
body .dsh-tasks-root .dsh-tasks-board .dsh-tasks-card[data-task-id][data-card-tone]::before {
  content: ''; position: absolute; inset-block: 8px; inset-inline-start: 0; width: 3px;
  border-radius: 0 3px 3px 0; background: var(--card-accent); pointer-events: none;
}
body .dsh-tasks-root .dsh-tasks-board .dsh-tasks-card[data-task-id][data-card-tone="danger"] {
  --card-accent: var(--dsh-paper-danger, var(--dsh-ios-danger, var(--dsw-alias-state-error-primary)));
}
body .dsh-tasks-root .dsh-tasks-board .dsh-tasks-card[data-task-id][data-card-tone="warn"] {
  --card-accent: var(--dsh-paper-warning, var(--dsh-ios-warning, var(--dsw-alias-state-warn-primary)));
}
body .dsh-tasks-root .dsh-tasks-board .dsh-tasks-card[data-task-id][data-card-tone="action"] {
  --card-accent: var(--dsh-tasks-focus);
}
body .dsh-tasks-root .dsh-tasks-board .dsh-tasks-card[data-task-id][data-card-tone="blocked"] {
  --card-accent: color-mix(in srgb, var(--dsh-paper-warning, var(--dsh-ios-warning, var(--dsw-alias-state-warn-primary))) 72%, var(--dsh-tasks-line));
  border-color: color-mix(in srgb, var(--card-accent) 24%, var(--dsh-tasks-line));
}
body .dsh-tasks-root .dsh-tasks-board .dsh-tasks-card[data-task-id][data-card-tone]:not([data-card-tone="blocked"]) {
  background-color: color-mix(in srgb, var(--card-accent) 4%, var(--dsh-paper-card, var(--dsh-tasks-paper)));
}
body .dsh-tasks-root .dsh-tasks-board .dsh-tasks-card[data-task-id][data-card-tone]:hover {
  border-color: color-mix(in srgb, var(--card-accent) 56%, var(--dsh-tasks-line));
}
body .dsh-tasks-root .dsh-tasks-board .dsh-tasks-card[data-task-id][data-card-tone="blocked"]:hover {
  border-color: color-mix(in srgb, var(--card-accent) 40%, var(--dsh-tasks-line));
}
@media (forced-colors: active) {
  body .dsh-tasks-root .dsh-tasks-card-state[data-task-status] > span.dsh-tasks-status-label[data-status-tone] {
    background: Canvas; color: CanvasText; border-color: CanvasText;
  }
  body .dsh-tasks-root .dsh-tasks-card-state[data-task-status] > span.dsh-tasks-status-label[data-status-tone] > .dsh-tasks-dot {
    background: CanvasText; border-color: CanvasText;
  }
  body .dsh-tasks-root .dsh-tasks-board .dsh-tasks-card[data-task-id][data-card-tone]::before {
    background: Highlight;
  }
  .dsh-tasks-root .dsh-tasks-attention-counts button.dsh-tasks-attention-pill {
    background: Canvas; color: CanvasText; border-color: CanvasText;
  }
  .dsh-tasks-root .dsh-tasks-attention-counts button.dsh-tasks-attention-pill[data-active] {
    border-color: Highlight; outline: 1px solid Highlight;
  }
  .dsh-tasks-unlock-toast {
    background: Canvas; color: CanvasText; border-color: CanvasText;
  }
}
.dsh-tasks-colfoot[data-has-range] .dsh-tasks-quick-create {
  flex: 1 0 100%; width: 100%;
}
.dsh-tasks-quick-create {
  display: grid; gap: 7px; padding: 8px; box-sizing: border-box;
  border: 1px solid color-mix(in srgb, var(--dsh-tasks-focus) 36%, var(--dsh-tasks-line));
  border-radius: var(--dsw-radius-sm, 9px);
  background: var(--dsh-paper-card, var(--dsh-tasks-paper));
  box-shadow: 0 2px 8px color-mix(in srgb, var(--dsh-tasks-shadow) 38%, transparent);
}
.dsh-tasks-quick-input {
  box-sizing: border-box; width: 100%; min-width: 0; min-height: 32px; padding: 5px 8px;
  border: 1px solid var(--dsh-tasks-line); border-radius: var(--dsw-radius-xs, 6px);
  background: var(--dsh-tasks-paper); color: var(--dsh-tasks-ink);
  font: inherit; font-size: 13px; line-height: 1.4;
}
.dsh-tasks-quick-input::placeholder { color: var(--dsh-tasks-muted); opacity: 1; }
.dsh-tasks-quick-input:focus {
  outline: none; border-color: var(--dsh-tasks-focus);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsh-tasks-focus) 18%, transparent);
}
.dsh-tasks-quick-scope {
  display: inline-flex; align-items: center; gap: 4px; min-width: 0;
  font-size: 11px; color: var(--dsh-tasks-muted);
}
.dsh-tasks-quick-scope > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-tasks-quick-error { margin: 0; font-size: 11px; color: var(--dsh-paper-danger, var(--dsw-alias-state-error-primary)); }
.dsh-tasks-quick-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dsh-tasks-root .dsh-tasks-quick-actions :is(button.dsh-tasks-quick-submit, button.dsh-tasks-quick-cancel) {
  min-height: 26px; height: auto; padding: 2px 10px; font-size: 12px; box-shadow: none;
}
.dsh-tasks-root .dsh-tasks-quick-actions button.dsh-tasks-quick-expand {
  margin-inline-start: auto; min-height: 26px; height: auto; padding: 2px 6px;
  border: 0; border-radius: var(--dsw-radius-xs, 6px); background: transparent;
  color: var(--dsh-tasks-focus); font: inherit; font-size: 11.5px; font-weight: 550; box-shadow: none; cursor: pointer;
}
.dsh-tasks-root .dsh-tasks-quick-actions button.dsh-tasks-quick-expand:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsh-tasks-focus) 10%, transparent);
}
.dsh-tasks-unlock-toast {
  position: absolute; inset-inline-end: var(--dsh-tasks-panel-gutter); inset-block-end: 42px; z-index: 6;
  display: flex; align-items: flex-start; gap: 9px; max-width: min(400px, calc(100% - 2 * var(--dsh-tasks-panel-gutter)));
  box-sizing: border-box; padding: 10px 10px 10px 12px;
  border: 1px solid color-mix(in srgb, var(--dsh-paper-success, var(--dsw-alias-state-success-primary)) 34%, var(--dsh-tasks-line));
  border-inline-start: 3px solid var(--dsh-paper-success, var(--dsw-alias-state-success-primary));
  border-radius: var(--dsw-radius-md, 10px);
  background: var(--dsh-tasks-paper); color: var(--dsh-tasks-ink);
  box-shadow: 0 8px 24px -6px color-mix(in srgb, var(--dsh-tasks-shadow) 65%, transparent);
  transition: opacity .15s ease, transform .15s ease;
}
.dsh-tasks-unlock-icon {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 22px; height: 22px; border-radius: 50%; margin-top: 1px;
  background: color-mix(in srgb, var(--dsh-paper-success, var(--dsw-alias-state-success-primary)) 14%, var(--dsh-tasks-paper));
  color: var(--dsh-paper-success, var(--dsw-alias-state-success-primary));
}
.dsh-tasks-unlock-body { display: grid; gap: 4px; min-width: 0; font-size: 12px; }
.dsh-tasks-unlock-body strong { font-size: 12.5px; font-weight: 650; }
.dsh-tasks-unlock-links { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.dsh-tasks-root button.dsh-tasks-unlock-link {
  min-height: 20px; height: auto; max-width: 100%; padding: 0; border: 0; box-shadow: none; background: transparent;
  color: var(--dsh-tasks-focus); font: inherit; font-size: 12px; font-weight: 550; text-align: start;
  text-decoration: underline; text-underline-offset: 2px; cursor: pointer;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dsh-tasks-root button.dsh-tasks-unlock-link:hover { color: var(--dsh-tasks-ink); }
.dsh-tasks-unlock-more { font-size: 11px; color: var(--dsh-tasks-muted); font-variant-numeric: tabular-nums; }
.dsh-tasks-unlock-toast > .dsh-tasks-icon-button { flex: none; width: 22px; height: 22px; min-width: 22px; min-height: 22px; }
@media (pointer: coarse) {
  .dsh-tasks-quick-input { min-height: 40px; }
  .dsh-tasks-root .dsh-tasks-quick-actions button { min-height: 36px; }
  .dsh-tasks-unlock-toast > .dsh-tasks-icon-button { width: 36px; height: 36px; min-width: 36px; min-height: 36px; }
}
.dsh-tasks-done-group-head {
  display: flex; align-items: center; gap: 6px; margin: 10px 2px 6px;
  font-size: 11px; font-weight: 600; color: var(--dsh-tasks-muted);
}
.dsh-tasks-done-group-head:first-child { margin-top: 2px; }
.dsh-tasks-done-group-head > small {
  padding: 0 5px; border-radius: 999px; font-size: 10px; font-weight: 600; line-height: 16px;
  font-variant-numeric: tabular-nums;
  background: color-mix(in srgb, var(--dsh-tasks-muted) 10%, var(--dsh-tasks-paper));
  color: var(--dsh-tasks-muted);
}
.dsh-tasks-done-group-head::after {
  content: ''; flex: 1; border-top: 1px dashed color-mix(in srgb, var(--dsh-tasks-line) 55%, transparent);
}
.dsh-tasks-running-elapsed { font-variant-numeric: tabular-nums; opacity: .88; font-weight: 500; }
@keyframes dsh-tasks-pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, currentColor 38%, transparent); }
  50% { box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 0%, transparent); }
}
body .dsh-tasks-root .dsh-tasks-card-state[data-task-status="running"] > span.dsh-tasks-status-label[data-status-tone="info"] > .dsh-tasks-dot {
  animation: dsh-tasks-pulse 2.2s ease-in-out infinite;
}
.dsh-tasks-shortcuts-list {
  display: grid; gap: 8px; list-style: none; margin: 12px 0 0; padding: 0;
}
.dsh-tasks-shortcuts-list li {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 7px 10px; border: 1px solid var(--dsh-tasks-rule); border-radius: var(--dsw-radius-sm, 8px);
  background: color-mix(in srgb, var(--dsh-tasks-muted) 4%, var(--dsh-tasks-paper));
  font-size: 13px;
}
.dsh-tasks-shortcuts-list kbd {
  display: inline-flex; align-items: center; justify-content: center; min-width: 24px; height: 24px;
  padding: 0 7px; border: 1px solid var(--dsh-tasks-line); border-radius: 6px;
  background: var(--dsh-tasks-paper); color: var(--dsh-tasks-ink);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; font-weight: 600;
  box-shadow: 0 1px 0 color-mix(in srgb, var(--dsh-tasks-line) 65%, transparent);
}
.dsh-tasks-card-select {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 18px; height: 18px; margin-top: 3px; border-radius: 5px;
  border: 1.5px solid var(--dsh-tasks-line); background: var(--dsh-tasks-paper); color: transparent;
  transition: background-color .14s ease, border-color .14s ease, color .14s ease;
}
.dsh-tasks-root .dsh-tasks-card[data-select-mode] { cursor: pointer; }
.dsh-tasks-root .dsh-tasks-card[data-selected] {
  border-color: var(--dsh-tasks-focus);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--dsh-tasks-focus) 36%, transparent);
}
.dsh-tasks-root .dsh-tasks-card[data-selected] .dsh-tasks-card-select {
  border-color: var(--dsh-tasks-focus); background: var(--dsh-tasks-focus);
  color: var(--dsh-paper-onAccent, var(--dsw-alias-label-primary-foreground, #fff));
}
.dsh-tasks-batch-bar {
  position: sticky; bottom: 8px; z-index: 7; align-self: center;
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px;
  max-width: calc(100% - 2 * var(--dsh-tasks-panel-gutter)); margin: 0 var(--dsh-tasks-panel-gutter) 8px;
  padding: 8px 12px; box-sizing: border-box;
  border: 1px solid color-mix(in srgb, var(--dsh-tasks-focus) 38%, var(--dsh-tasks-line));
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsh-tasks-paper); color: var(--dsh-tasks-ink);
  box-shadow: 0 10px 28px -6px color-mix(in srgb, var(--dsh-tasks-shadow) 72%, transparent);
}
.dsh-tasks-batch-count { font-size: 12.5px; font-weight: 650; font-variant-numeric: tabular-nums; white-space: nowrap; }
.dsh-tasks-batch-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.dsh-tasks-root .dsh-tasks-batch-actions > button,
.dsh-tasks-batch-move > summary {
  box-sizing: border-box; min-height: 32px; height: 32px; padding: 0 12px;
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  line-height: 1; white-space: nowrap;
}
.dsh-tasks-batch-move { position: relative; display: inline-flex; }
.dsh-tasks-batch-move > summary { list-style: none; cursor: pointer; }
.dsh-tasks-batch-move > summary::-webkit-details-marker { display: none; }
@media (prefers-reduced-motion: reduce) {
  body .dsh-tasks-root .dsh-tasks-card-state[data-task-status="running"] > span.dsh-tasks-status-label[data-status-tone="info"] > .dsh-tasks-dot {
    animation: none;
  }
}
@media (forced-colors: active) {
  .dsh-tasks-batch-bar { background: Canvas; color: CanvasText; border-color: Highlight; }
}
.dsh-tasks-card-extlink {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  box-sizing: border-box;
  height: 20px;
  max-width: 130px;
  padding: 0 6px;
  border-radius: 5px;
  font-size: 11px;
  font-weight: 500;
  line-height: 18px;
  text-decoration: none;
  background: color-mix(in srgb, var(--dsh-tasks-muted) 8%, var(--dsh-tasks-paper));
  color: var(--dsh-tasks-muted);
  border: 1px solid color-mix(in srgb, var(--dsh-tasks-line) 75%, transparent);
  cursor: pointer;
  white-space: nowrap;
  transition: background-color .15s ease, border-color .15s ease, color .15s ease;
}
.dsh-tasks-card-extlink:is(:hover, :focus-visible) {
  background: color-mix(in srgb, var(--dsh-tasks-focus) 11%, var(--dsh-tasks-paper));
  color: var(--dsh-tasks-focus);
  border-color: color-mix(in srgb, var(--dsh-tasks-focus) 45%, var(--dsh-tasks-line));
}
.dsh-tasks-card-extlink > span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-tasks-extlink-arrow {
  flex: none;
  font-size: 10px;
  opacity: .75;
}
.dsh-tasks-root .dsh-tasks-card[data-draggable], .dsh-tasks-card[data-draggable] .dsh-tasks-card-title { cursor: grab; }
.dsh-tasks-root .dsh-tasks-card[data-dragging] { opacity: .35; }
.dsh-tasks-drag-preview { display: flex; align-items: start; gap: 8px; padding: 12px 14px; background: var(--dsh-tasks-paper); color: var(--dsh-tasks-ink); border: 1px solid var(--dsh-tasks-focus); border-radius: var(--dsw-radius-lg, 12px); box-shadow: 0 8px 24px var(--dsh-tasks-shadow); cursor: grabbing; overflow: hidden; }
.dsh-tasks-drag-preview > div { min-width: 0; } .dsh-tasks-drag-preview :is(strong,p) { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .dsh-tasks-drag-preview p { margin: 4px 0 0; color: var(--dsh-tasks-muted); font-size: 12px; }
@container task-management (max-width: 390px) {
  .dsh-tasks-root .dsh-tasks-column-manager .dsh-tasks-manage-create { grid-template-columns: auto repeat(2, minmax(0, 1fr)); }
  .dsh-tasks-root .dsh-tasks-column-manager .dsh-tasks-manage-create > button { grid-column: 1 / -1; justify-self: end; }
}
@container task-management (max-width: 280px) {
  .dsh-tasks-root .dsh-tasks-column-manager .dsh-tasks-manage-create { grid-template-columns: minmax(0, 1fr); }
}
@container task-management (max-width: 340px) {
  .dsh-tasks-column-manager .dsh-tasks-manage-list .dsh-tasks-column-form { grid-template-columns: auto auto minmax(0, 1fr); }
  .dsh-tasks-column-manager .dsh-tasks-row-tools { grid-column: 2 / -1; justify-self: end; flex-wrap: wrap; justify-content: flex-end; }
}
@media (max-width: 400px) {
  .dsh-tasks-management-dialog .dsh-tasks-dialog-head { padding-inline: 12px; }
  .dsh-tasks-management { padding-inline: 12px; }
}
@media (pointer: coarse) { .dsh-tasks-management-dialog .dsh-tasks-dialog-head > .dsh-tasks-icon-button { min-width: 44px; min-height: 44px; } }
@media (pointer: coarse) { .dsh-tasks-root .dsh-tasks-row-action, .dsh-tasks-root .dsh-tasks-command-list .dsh-tasks-command { min-height: 44px; } .dsh-tasks-root .dsh-tasks-row-action { min-width: 38px; } }

/* The real controls stay mounted; only a noninteractive Looseleaf layer is shown in Paper. */
.dsh-tasks-editor-drawer .dsh-tasks-ink-field { display: contents; }
.dsh-tasks-root [data-task-ink-layer] { display: none; }
:is(body[data-dsh-task-appearance="paper"], body[data-dsh-paper-theme="paper"]:not([data-dsh-task-appearance="ios"])) .dsh-tasks-editor-drawer {
  /* The page itself is the field surface; let the pencil line define the control. */
  --task-ink-fill: var(--dsh-tasks-paper);
  --task-ink-line: var(--dsh-looseleaf-control-line, var(--dsh-tasks-line));
  --task-ink-text: var(--dsh-looseleaf-control-ink, var(--dsh-tasks-ink));
  --task-ink-muted: var(--dsh-looseleaf-muted, var(--dsh-tasks-muted));
  --task-ink-focus: var(--dsh-looseleaf-focus, var(--dsh-tasks-focus));
  --task-ink-hover: var(--dsh-looseleaf-hover, var(--dsh-tasks-highlight));
  --task-ink-press: var(--dsh-looseleaf-pressed, var(--task-ink-hover));
  --task-ink-radius: var(--dsh-looseleaf-radius, 10px);
  --task-ink-small: var(--dsh-looseleaf-radius-sm, 6px);
  --ll-ink: var(--task-ink-text);
  --ll-pencil: var(--task-ink-line);
  --ll-pencil-mark: var(--task-ink-line);
  --ll-hi: var(--task-ink-hover);
  --ll-marker: var(--dsh-looseleaf-primary-fill, var(--task-ink-focus));
  --ll-ink-you: var(--task-ink-focus);
  --ll-focus: var(--task-ink-focus);
  --ll-slip: var(--task-ink-fill);
  --ll-paper-shade: var(--task-ink-hover);
  & [data-task-ink-layer] { display: block; position: absolute; inset: 0; pointer-events: none; z-index: -1; }
  & [data-task-ink-layer] > svg { max-width: none; }
  & [data-task-ink-layer] [data-layer]:not(:is([data-layer=rest], [data-layer=disabled])) { opacity: 0; }
  & [data-task-ink=tabs][aria-selected=true] [data-layer=checked] { opacity: 1; }
  & :is([data-task-ink=field], [data-task-ink=button], [data-task-ink=badge], [data-task-ink=tabs], [data-task-ink=empty]) {
    position: relative; isolation: isolate;
  }
  & [data-task-ink=field] {
    box-sizing: border-box; display: block; min-width: 0; color: var(--task-ink-text);
    background: var(--task-ink-fill); border: 1px solid var(--task-ink-line); border-radius: var(--task-ink-small);
  }
  & [data-task-ink=field] > :is(.dsh-tasks-input, textarea, .dsh-tasks-select-trigger, [data-slot=date-picker]) {
    display: flex; width: 100%; margin: 0; color: inherit; background: transparent; border: 0; border-radius: inherit;
    box-shadow: none; outline: none; padding: 8px 11px;
  }
  & [data-task-ink=field] > :is(.dsh-tasks-input, .dsh-tasks-select-trigger, [data-slot=date-picker]) { min-height: 38px; }
  & [data-task-ink=field] .dsh-tasks-input > input { color: inherit; background: transparent; }
  & [data-task-ink=field] > [data-task-ink-layer] { overflow: clip; }
  & [data-task-ink=field] :is(input,textarea)::placeholder { color: var(--task-ink-muted); }
  & [data-task-ink=field] > :is([data-slot=date-picker], :focus, :focus-visible) { box-shadow: none; outline: none; }
  & [data-task-ink=field]:focus-within { outline: 2px solid var(--task-ink-focus); outline-offset: 1px; }
  & [data-task-ink=field]:has(:disabled) { opacity: .72; }
  & .dsh-tasks-date-control {
    overflow: clip;
    --ll-pencil: var(--task-ink-line); --ll-pencil-mark: var(--task-ink-line); --ll-slip: var(--task-ink-fill);
    --ll-ink: var(--task-ink-text); --ll-hi: var(--task-ink-hover);
  }
  & .dsh-tasks-date-control > [data-slot=date-picker] { isolation: auto; }
  & .dsh-tasks-date-control > [data-slot=date-picker] > svg[data-ink] { display: block; }
  & .dsh-tasks-detail-title-field { border-radius: var(--task-ink-small); }
  & .dsh-tasks-detail-title-field:hover:not(:disabled):not(:focus) { background: var(--task-ink-hover); border-color: color-mix(in srgb, var(--task-ink-line) 70%, transparent); }
  & .dsh-tasks-meta-card {
    border-style: dashed;
    border-color: color-mix(in srgb, var(--task-ink-line) 75%, transparent);
    background: color-mix(in srgb, var(--dsh-tasks-sheet, var(--task-ink-fill)) 55%, var(--task-ink-fill));
  }
  & .dsh-tasks-stage-pill { border-radius: var(--task-ink-small); }
  & :is(.dsh-tasks-delivery-banner, .dsh-tasks-evidence-card, .dsh-tasks-delivery-criteria) { border-radius: var(--task-ink-radius); }
  & .dsh-tasks-evidence-card { background: var(--task-ink-fill); border-color: color-mix(in srgb, var(--task-ink-line) 75%, transparent); }
  & .dsh-tasks-image-add[data-empty]:hover { background: var(--task-ink-hover); }
  & [data-task-ink=button] { border-radius: var(--task-ink-small); box-shadow: none; }
  & :is(.dsh-tasks-secondary, .dsh-tasks-retry)[data-task-ink=button] { border: 1px solid var(--task-ink-line); background: var(--task-ink-fill); color: var(--task-ink-text); }
  & .dsh-tasks-primary[data-task-ink=button] { background: var(--dsh-looseleaf-primary-fill, var(--task-ink-focus)); color: var(--dsh-looseleaf-primary-ink, var(--dsh-paper-onAccent)); }
  & [data-task-ink=button]:not(.dsh-tasks-primary):hover:not(:disabled) { background: var(--task-ink-hover); }
  & [data-task-ink=button]:not(.dsh-tasks-primary):active:not(:disabled) { background: var(--task-ink-press); }
  & :is([data-task-ink=button], [data-task-ink=tabs], .dsh-tasks-date-clear):focus-visible { outline: 2px solid var(--task-ink-focus); outline-offset: 1px; }
  & [data-task-ink=badge] { --ll-pencil: currentColor; }
  & [data-task-ink=tabs]:has(> [data-task-ink-ready])::after { content: none; }
  & [data-task-ink=empty] { background: var(--task-ink-fill); border-radius: var(--task-ink-radius); }
  & :is([data-task-ink=button], [data-task-ink=badge], [data-task-ink=empty]):has(> [data-task-ink-ready]) { border-color: transparent; }
  & [data-task-ink=overlay] {
    color: var(--task-ink-text); background: var(--dsh-looseleaf-overlay-fill, var(--task-ink-fill));
    border: 1px solid var(--task-ink-line); border-radius: var(--task-ink-radius);
    box-shadow: var(--dsh-looseleaf-overlay-shadow, 0 5px 16px var(--dsh-tasks-shadow));
  }
  & [data-task-ink=overlay] :is(.dsh-tasks-select-option, .dsh-tasks-menu button, button) { border-radius: var(--task-ink-small); }
  & [data-task-ink=overlay] :is([data-active=true], button:hover:not(:disabled)) { background: var(--task-ink-hover); }
  & [data-task-ink=overlay] button:focus-visible { outline: 2px solid var(--task-ink-focus); outline-offset: -2px; }
  @media (forced-colors: active) {
    & [data-task-ink-layer], & .dsh-tasks-date-control > [data-slot=date-picker] > svg[data-ink], & .dsh-tasks-date-control [data-ink] { display: none; }
    & :is([data-task-ink=field], [data-task-ink=badge], [data-task-ink=empty]):is([data-task-ink], :has(> [data-task-ink-ready])) { border-color: CanvasText; }
    & [data-task-ink=tabs][aria-selected=true]:has(> [data-task-ink-ready])::after { content: ''; border-color: Highlight; }
    & [data-task-ink=field]:focus-within, & :is(button, [data-task-ink=button]):focus-visible { outline-color: Highlight; }
  }
}
`

    const DETAIL_CONTROLS_CSS = `
.dsh-tasks-root .dsh-tasks-editor-drawer {
  --task-field-fill: color-mix(in srgb, var(--dsh-tasks-muted) 5%, var(--dsh-tasks-paper));
  --task-field-border: color-mix(in srgb, var(--dsh-tasks-muted) 58%, var(--dsh-tasks-paper));
  --task-field-hover: color-mix(in srgb, var(--dsh-tasks-focus) 66%, var(--dsh-tasks-muted));
}
.dsh-tasks-root .dsh-tasks-editor-drawer [data-task-ink=field] {
  display: block; position: relative; box-sizing: border-box; min-width: 0; border: 1px solid var(--task-field-border);
  border-radius: var(--task-ink-small, var(--dsw-radius-sm, 8px)); color: var(--dsh-tasks-ink); background: var(--task-field-fill);
}
.dsh-tasks-root .dsh-tasks-editor-drawer [data-task-ink=field] > :is(.dsh-tasks-input, textarea, .dsh-tasks-select-trigger, [data-slot=date-picker]) {
  box-sizing: border-box; width: 100%; min-height: 40px; padding: 8px 11px; color: inherit; border: 0; border-radius: inherit; background: transparent; box-shadow: none;
}
.dsh-tasks-root .dsh-tasks-editor-drawer [data-task-ink=field] > textarea { display: block; }
.dsh-tasks-root .dsh-tasks-editor-drawer [data-task-ink=field] > textarea.dsh-tasks-description-input {
  min-height: 60px; min-height: calc(2lh + 18px);
}
.dsh-tasks-root .dsh-tasks-editor-drawer [data-task-ink=field] > .dsh-tasks-select-trigger { padding-inline-end: 44px; }
.dsh-tasks-editor-drawer .dsh-tasks-select-arrow { position: absolute; inset-block: 7px; inset-inline-end: 1px; display: grid; place-items: center; width: 33px; border-inline-start: 1px solid var(--dsh-tasks-line); color: var(--dsh-tasks-muted); pointer-events: none; }
.dsh-tasks-editor-drawer .dsh-tasks-select-trigger[aria-expanded=true] + .dsh-tasks-select-arrow { color: var(--dsh-tasks-focus); }
.dsh-tasks-editor-drawer .dsh-tasks-select-trigger[aria-expanded=true] + .dsh-tasks-select-arrow svg { transform: rotate(180deg); }
.dsh-tasks-root .dsh-tasks-editor-drawer [data-task-ink=field]:hover:not(:has(:disabled)) { border-color: var(--task-field-hover); }
.dsh-tasks-root .dsh-tasks-editor-drawer [data-task-ink=field]:is(:focus-within, :has(> [aria-expanded=true])) {
  border-color: var(--dsh-tasks-focus); outline: 2px solid var(--dsh-tasks-focus); outline-offset: 1px;
}
.dsh-tasks-root .dsh-tasks-editor-drawer [data-task-ink=field]:has(:disabled) { opacity: .72; }
@media (pointer: coarse) { .dsh-tasks-root .dsh-tasks-editor-drawer [data-task-ink=field] > :is(.dsh-tasks-input, .dsh-tasks-select-trigger, [data-slot=date-picker]) { min-height: 44px; } }
@media (forced-colors: active) {
  .dsh-tasks-root .dsh-tasks-editor-drawer [data-task-ink=field] { border-color: CanvasText; }
  .dsh-tasks-root .dsh-tasks-editor-drawer [data-task-ink=field]:is(:focus-within, :has(> [aria-expanded=true])) { outline-color: Highlight; }
}

.dsh-tasks-sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
}

.dsh-tasks-detail-title-wrap { position: relative; min-width: 0; }
.dsh-tasks-root .dsh-tasks-detail-title-field {
  box-sizing: border-box; display: block; width: 100%; min-width: 0;
  min-height: 30px; min-block-size: calc(1.42em + 6px);
  padding: 3px 26px 3px 6px; margin-inline-start: -6px;
  border: 1px solid transparent; border-radius: var(--dsw-radius-sm, 7px);
  background: transparent; color: var(--dsh-tasks-ink);
  font: inherit; font-size: 17px; font-weight: 650; letter-spacing: -.015em; line-height: 1.42;
  field-sizing: content; resize: none; overflow: hidden; overflow-wrap: anywhere;
  transition: background-color .15s ease, border-color .15s ease, box-shadow .15s ease;
}
.dsh-tasks-root .dsh-tasks-detail-title-field::placeholder { color: var(--dsh-tasks-muted); font-weight: 500; }
.dsh-tasks-root .dsh-tasks-detail-title-field:hover:not(:disabled):not(:focus) {
  background: color-mix(in srgb, var(--dsh-tasks-muted) 6%, transparent);
  border-color: color-mix(in srgb, var(--dsh-tasks-line) 55%, transparent);
}
.dsh-tasks-root .dsh-tasks-detail-title-field:focus {
  outline: none; background: var(--dsh-tasks-paper); border-color: var(--dsh-tasks-focus);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsh-tasks-focus) 22%, transparent);
}
.dsh-tasks-detail-title-affordance {
  position: absolute; inset-inline-end: 10px; top: 8px; display: inline-flex;
  color: var(--dsh-tasks-muted); opacity: 0; pointer-events: none; transition: opacity .15s ease;
}
.dsh-tasks-detail-title-wrap:is(:hover, :focus-within) .dsh-tasks-detail-title-affordance { opacity: .82; }
.dsh-tasks-detail-title-wrap:focus-within .dsh-tasks-detail-title-affordance { opacity: 0; }
@media (hover: none), (pointer: coarse) {
  .dsh-tasks-detail-title-affordance { opacity: .65; }
}
.dsh-tasks-required { color: var(--dsw-alias-state-error-primary, #c2410c); font-weight: 600; }

.dsh-tasks-create-meta { gap: 6px 10px; }
.dsh-tasks-create-intro { color: var(--dsh-tasks-muted); font-size: 12px; }
.dsh-tasks-stage-dropdown { position: relative; display: inline-flex; }
.dsh-tasks-stage-dropdown > summary { list-style: none; }
.dsh-tasks-stage-dropdown > summary::-webkit-details-marker { display: none; }
.dsh-tasks-stage-pill {
  --stage-tone: var(--dsh-tasks-muted);
  box-sizing: border-box; display: inline-flex; align-items: center; gap: 6px;
  min-height: 26px; max-width: 220px; padding: 2px 9px;
  border: 1px solid color-mix(in srgb, var(--dsh-tasks-col-color, var(--stage-tone)) 32%, var(--dsh-tasks-rule));
  border-radius: 999px;
  background: color-mix(in srgb, var(--dsh-tasks-col-color, var(--stage-tone)) 9%, var(--dsh-tasks-paper));
  color: var(--dsh-tasks-ink); font-size: 12px; font-weight: 550; line-height: 1.3; cursor: pointer;
  transition: border-color .15s ease, background-color .15s ease;
}
.dsh-tasks-stage-pill[data-stage="doing"] { --stage-tone: var(--dsw-alias-state-business-primary); }
.dsh-tasks-stage-pill[data-stage="done"] { --stage-tone: var(--dsw-alias-state-success-primary); }
.dsh-tasks-stage-dropdown.is-disabled .dsh-tasks-stage-pill { opacity: .68; cursor: default; }
.dsh-tasks-stage-dropdown > summary.dsh-tasks-stage-pill:hover {
  border-color: var(--dsh-tasks-col-color, var(--dsh-tasks-focus));
  background: color-mix(in srgb, var(--dsh-tasks-col-color, var(--stage-tone)) 14%, var(--dsh-tasks-paper));
}
.dsh-tasks-stage-pill-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-tasks-stage-dot {
  width: 7px; height: 7px; border-radius: 50%; flex: none;
  background: var(--dsh-tasks-col-color, var(--dsh-tasks-muted));
}
.dsh-tasks-stage-pill[data-stage="doing"] .dsh-tasks-stage-dot,
.dsh-tasks-stage-dot[data-stage="doing"] { background: var(--dsh-tasks-col-color, var(--dsw-alias-state-business-primary)); }
.dsh-tasks-stage-pill[data-stage="done"] .dsh-tasks-stage-dot,
.dsh-tasks-stage-dot[data-stage="done"] { background: var(--dsh-tasks-col-color, var(--dsw-alias-state-success-primary)); }
.dsh-tasks-command-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.dsh-tasks-unsaved-pill {
  display: inline-flex; align-items: center; gap: 5px;
  min-height: 22px; padding: 0 8px; border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--dsh-paper-warning, var(--dsw-alias-state-warn-primary)) 38%, transparent);
  background: color-mix(in srgb, var(--dsh-paper-warning, var(--dsw-alias-state-warn-primary)) 11%, var(--dsh-tasks-paper));
  color: var(--dsh-paper-warning, var(--dsw-alias-state-warn-primary));
  font-size: 11px; font-weight: 600;
}
.dsh-tasks-unsaved-pill .dsh-tasks-dot { border-color: currentColor; background: currentColor; width: 6px; height: 6px; }

.dsh-tasks-detail-tabs { gap: 18px; overflow-x: auto; scrollbar-width: none; }
.dsh-tasks-detail-tabs::-webkit-scrollbar { display: none; }
.dsh-tasks-detail-tabs button {
  display: inline-flex; align-items: center; gap: 6px; flex: none; white-space: nowrap;
  padding: 6px 4px 8px;
}
.dsh-tasks-tab-count {
  display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 5px; box-sizing: border-box;
  border-radius: 999px; background: color-mix(in srgb, var(--dsh-tasks-muted) 11%, var(--dsh-tasks-paper));
  color: var(--dsh-tasks-muted); font-size: 11px; font-weight: 550; font-variant-numeric: tabular-nums;
}
.dsh-tasks-detail-tabs button[aria-selected="true"] .dsh-tasks-tab-count {
  background: color-mix(in srgb, var(--dsh-tasks-focus) 14%, var(--dsh-tasks-paper));
  color: var(--dsh-tasks-focus);
}
.dsh-tasks-tab-badge {
  display: inline-flex; align-items: center; gap: 4px; height: 18px; padding: 0 6px; border-radius: 999px;
  font-size: 10px; font-weight: 600; white-space: nowrap;
  border: 1px solid color-mix(in srgb, currentColor 28%, transparent);
  background: color-mix(in srgb, currentColor 9%, var(--dsh-tasks-paper));
}
.dsh-tasks-tab-badge[data-tone="pending"] { color: var(--dsh-paper-info, var(--dsw-alias-state-business-primary)); }
.dsh-tasks-tab-badge[data-tone="returned"] { color: var(--dsh-paper-warning, var(--dsw-alias-state-warn-primary)); }
.dsh-tasks-tab-badge[data-tone="accepted"] { color: var(--dsh-paper-success, var(--dsw-alias-state-success-primary)); }
.dsh-tasks-tab-badge .dsh-tasks-dot { width: 5px; height: 5px; border-color: currentColor; background: currentColor; }

.dsh-tasks-root .dsh-tasks-segmented {
  display: inline-flex; align-items: center; gap: 2px; padding: 2px;
  border: 1px solid var(--dsh-tasks-rule); border-radius: 8px;
  background: color-mix(in srgb, var(--dsh-tasks-muted) 6%, var(--dsh-tasks-paper));
}
.dsh-tasks-root .dsh-tasks-segmented > button {
  min-height: 26px; padding: 2px 9px; border: 1px solid transparent; border-radius: 6px;
  background: transparent; color: var(--dsh-tasks-muted); font: inherit; font-size: 12px; cursor: pointer;
  transition: background-color .14s ease, color .14s ease, border-color .14s ease;
}
.dsh-tasks-root .dsh-tasks-segmented > button:hover:not(:disabled) {
  color: var(--dsh-tasks-ink); border-color: transparent; background: color-mix(in srgb, var(--dsh-tasks-muted) 8%, transparent);
}
.dsh-tasks-root .dsh-tasks-segmented > button[aria-pressed="true"] {
  background: var(--dsh-tasks-paper); color: var(--dsh-tasks-ink);
  border-color: var(--dsh-tasks-line); font-weight: 600;
  box-shadow: 0 1px 2px color-mix(in srgb, var(--dsh-tasks-shadow) 35%, transparent);
}
@media (pointer: coarse) {
  .dsh-tasks-root .dsh-tasks-segmented > button { min-height: 40px; }
}

.dsh-tasks-description-markdown > :first-child,
.dsh-tasks-description-markdown > div > :first-child { margin-block-start: 0; }
.dsh-tasks-description-markdown > :last-child,
.dsh-tasks-description-markdown > div > :last-child { margin-block-end: 0; }
.dsh-tasks-description-markdown > div > :is(p, ul, ol) { margin-block: 6px; }
.dsh-tasks-markdown-fallback { margin: 0; white-space: pre-wrap; font: inherit; overflow-wrap: anywhere; }
.dsh-tasks-description-markdown.is-editable {
  padding: 6px 8px; margin: -6px -8px; border-radius: var(--dsw-radius-sm, 8px); cursor: text;
  transition: background-color .14s ease;
}
.dsh-tasks-description-markdown.is-editable:hover { background: color-mix(in srgb, var(--dsh-tasks-muted) 5%, transparent); }

.dsh-tasks-criteria { display: grid; gap: 6px; min-inline-size: 0; }
.dsh-tasks-criteria-read {
  padding: 8px 12px; margin: 0;
  border: 1px solid color-mix(in srgb, var(--dsh-tasks-focus) 22%, var(--dsh-tasks-rule));
  border-inline-start: 3px solid color-mix(in srgb, var(--dsh-tasks-focus) 72%, var(--dsh-tasks-rule));
  border-radius: var(--dsw-radius-sm, 8px);
  background: color-mix(in srgb, var(--dsh-tasks-focus) 4%, var(--dsh-tasks-paper));
}
.dsh-tasks-criteria-read.is-editable:hover {
  background: color-mix(in srgb, var(--dsh-tasks-focus) 7%, var(--dsh-tasks-paper));
}

.dsh-tasks-disclosure-row { display: flex; }
.dsh-tasks-root .dsh-tasks-disclosure-trigger {
  width: 100%; justify-content: flex-start; gap: 7px; min-height: 34px; padding: 6px 10px;
  border: 1px dashed var(--dsh-tasks-rule); border-radius: var(--dsw-radius-sm, 8px);
  background: transparent; color: var(--dsh-tasks-muted); font-weight: 500; box-shadow: none;
  transition: border-color .15s ease, background-color .15s ease, color .15s ease;
}
.dsh-tasks-root .dsh-tasks-disclosure-trigger:hover:not(:disabled) {
  border-color: var(--dsh-tasks-line); color: var(--dsh-tasks-ink);
  background: color-mix(in srgb, var(--dsh-tasks-muted) 5%, var(--dsh-tasks-paper));
}
.dsh-tasks-root .dsh-tasks-disclosure-trigger > :last-child { margin-inline-start: auto; opacity: .75; }

.dsh-tasks-meta-card {
  display: grid; gap: 12px; min-width: 0; padding: 12px 14px;
  border: 1px solid var(--dsh-tasks-rule); border-radius: var(--dsw-radius-md, 10px);
  background: color-mix(in srgb, var(--dsh-tasks-muted) 4%, var(--dsh-tasks-paper));
}
.dsh-tasks-meta-card-head {
  font-size: 11px; font-weight: 600; letter-spacing: .04em; color: var(--dsh-tasks-muted);
}
.dsh-tasks-meta-card > .dsh-tasks-bindings {
  padding-top: 12px; border-top: 1px dashed var(--dsh-tasks-rule);
}
.dsh-tasks-workspace-path {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.dsh-tasks-prerequisites ul { display: grid; gap: 5px; }
.dsh-tasks-prerequisites li {
  padding: 5px 8px; border: 1px solid var(--dsh-tasks-rule); border-radius: var(--dsw-radius-sm, 7px);
  background: color-mix(in srgb, var(--dsh-tasks-muted) 3%, var(--dsh-tasks-paper));
}
.dsh-tasks-image-add[data-empty] {
  padding: 12px 14px; text-align: center; cursor: pointer;
}
.dsh-tasks-root .dsh-tasks-editor-drawer .dsh-tasks-date-control > [data-slot=date-picker] > svg[data-ink] { display: none; }
.dsh-tasks-image-add[data-empty]:hover {
  border-color: var(--dsh-tasks-focus);
  background: color-mix(in srgb, var(--dsh-tasks-focus) 4%, var(--dsh-tasks-paper));
}

.dsh-tasks-detail-sessions { display: flex; flex-wrap: wrap; gap: 6px; }
.dsh-tasks-root .dsh-tasks-session-chip {
  display: inline-flex; align-items: center; gap: 5px; height: auto; min-height: 24px; padding: 2px 8px;
  border: 1px solid var(--dsh-tasks-rule); border-radius: 999px;
  background: color-mix(in srgb, var(--dsh-tasks-muted) 6%, var(--dsh-tasks-paper));
  color: var(--dsh-tasks-ink); font-size: 11px; font-weight: 500;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; box-shadow: none;
}
.dsh-tasks-root .dsh-tasks-session-chip:hover:not(:disabled) {
  border-color: var(--dsh-tasks-focus); color: var(--dsh-tasks-focus);
  background: color-mix(in srgb, var(--dsh-tasks-focus) 8%, var(--dsh-tasks-paper));
}

.dsh-tasks-comment-form[data-collapsed] {
  gap: 0; padding: 0; border: 0; background: transparent; margin-block-end: 16px;
}
.dsh-tasks-comment-form[data-collapsed] [data-task-ink=field] > textarea {
  min-height: 38px; min-block-size: 38px; padding: 7px 11px; resize: none; overflow: hidden; line-height: 1.45;
}
.dsh-tasks-comment-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.dsh-tasks-comment-actions > .dsh-tasks-field-hint { margin-inline-end: auto; }
.dsh-tasks-comment-form button.dsh-tasks-comment-cancel { font-weight: 500; }

.dsh-tasks-activity > li[data-tier="system"] { padding-block-end: 6px; }
.dsh-tasks-activity > li[data-tier="system"]:not(:last-child)::before { inset-block: 24px 0; }
.dsh-tasks-activity > li[data-tier="system"] .dsh-tasks-activity-marker {
  width: 24px; height: 24px; margin-inline: auto; margin-top: 1px;
  border-color: var(--dsh-tasks-rule); background: var(--dsh-tasks-paper); color: var(--dsh-tasks-muted);
}
.dsh-tasks-activity-row {
  display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 3px 10px;
  min-height: 24px; padding-block: 2px; font-size: 12px;
}
.dsh-tasks-activity-row-main { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 6px; min-width: 0; flex: 1 1 180px; }
.dsh-tasks-activity-inline { color: var(--dsh-tasks-muted); }
.dsh-tasks-activity > li[data-tier="system"] .dsh-tasks-activity-meta { font-size: 11px; flex: none; }

.dsh-tasks-activity > li[data-tier="content"] { padding-block: 2px 12px; }
.dsh-tasks-activity > li[data-tier="content"] .dsh-tasks-activity-entry {
  padding: 10px 12px; border: 1px solid var(--dsh-tasks-rule);
  border-inline-start: 3px solid var(--dsh-tasks-line);
  border-radius: var(--dsw-radius-md, 10px); background: var(--dsh-tasks-paper);
}
.dsh-tasks-activity > li[data-kind=comment] .dsh-tasks-activity-entry {
  border-inline-start-color: var(--dsh-tasks-focus);
  background: color-mix(in srgb, var(--dsh-tasks-focus) 4%, var(--dsh-tasks-paper));
}
.dsh-tasks-activity > li[data-kind=delivery-accepted] .dsh-tasks-activity-marker {
  color: var(--dsh-paper-success, var(--dsw-alias-state-success-primary));
  background: color-mix(in srgb, var(--dsh-paper-success, var(--dsw-alias-state-success-primary)) 12%, var(--dsh-tasks-paper));
}
.dsh-tasks-activity > li[data-kind=delivery-accepted] .dsh-tasks-activity-entry {
  border-inline-start-color: var(--dsh-paper-success, var(--dsw-alias-state-success-primary));
}
.dsh-tasks-activity > li[data-kind=delivery-returned] .dsh-tasks-activity-marker {
  color: var(--dsh-paper-warning, var(--dsw-alias-state-warn-primary));
  background: color-mix(in srgb, var(--dsh-paper-warning, var(--dsw-alias-state-warn-primary)) 12%, var(--dsh-tasks-paper));
}
.dsh-tasks-activity > li[data-kind=delivery-returned] .dsh-tasks-activity-entry {
  border-inline-start-color: var(--dsh-paper-warning, var(--dsw-alias-state-warn-primary));
}
.dsh-tasks-activity > li[data-kind=delivery-submitted] .dsh-tasks-activity-marker {
  color: var(--dsh-paper-info, var(--dsw-alias-state-business-primary));
  background: color-mix(in srgb, var(--dsh-paper-info, var(--dsw-alias-state-business-primary)) 12%, var(--dsh-tasks-paper));
}
.dsh-tasks-activity > li[data-kind=delivery-submitted] .dsh-tasks-activity-entry {
  border-inline-start-color: var(--dsh-paper-info, var(--dsw-alias-state-business-primary));
}
.dsh-tasks-activity > li[data-kind=delivery-continued] .dsh-tasks-activity-entry {
  border-inline-start-color: var(--dsh-tasks-focus);
}
.dsh-tasks-activity-event-title { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; }
.dsh-tasks-root .dsh-tasks-activity-comment { margin: 6px 0 0; white-space: normal; line-height: 1.55; }
.dsh-tasks-root .dsh-tasks-activity-comment.is-clamped {
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3;
  max-height: calc(3 * 1.55em + 2px); overflow: hidden;
}
.dsh-tasks-activity-card-actions { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
.dsh-tasks-root .dsh-tasks-activity-link {
  padding: 2px 4px; min-height: 24px; height: auto; border: 0; box-shadow: none; background: transparent;
  color: var(--dsh-tasks-focus); font-size: 12px; font-weight: 550;
}
.dsh-tasks-root .dsh-tasks-activity-link:hover:not(:disabled) { text-decoration: underline; background: transparent; }

.dsh-tasks-delivery-banner {
  --banner-tone: var(--dsh-tasks-muted);
  display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px 14px;
  padding: 12px 14px; border: 1px solid color-mix(in srgb, var(--banner-tone) 30%, var(--dsh-tasks-rule));
  border-radius: var(--dsw-radius-md, 10px);
  background: color-mix(in srgb, var(--banner-tone) 8%, var(--dsh-tasks-paper));
}
.dsh-tasks-delivery-banner[data-tone="pending"] { --banner-tone: var(--dsh-paper-info, var(--dsw-alias-state-business-primary)); }
.dsh-tasks-delivery-banner[data-tone="returned"] { --banner-tone: var(--dsh-paper-warning, var(--dsw-alias-state-warn-primary)); }
.dsh-tasks-delivery-banner[data-tone="accepted"] { --banner-tone: var(--dsh-paper-success, var(--dsw-alias-state-success-primary)); }
.dsh-tasks-delivery-banner-info { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; min-width: 0; }
.dsh-tasks-delivery-banner-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-inline-start: auto; }
.dsh-tasks-delivery-times { display: flex; flex-wrap: wrap; gap: 2px 6px; font-size: 12px; color: var(--dsh-tasks-muted); font-variant-numeric: tabular-nums; }
.dsh-tasks-delivery-runtime-label { font-size: 12px; font-weight: 600; color: var(--dsh-tasks-ink); }

.dsh-tasks-delivery-criteria {
  border: 1px solid var(--dsh-tasks-rule); border-radius: var(--dsw-radius-md, 10px);
  background: color-mix(in srgb, var(--dsh-tasks-muted) 3%, var(--dsh-tasks-paper));
}
.dsh-tasks-delivery-criteria > summary {
  display: flex; align-items: center; gap: 7px; padding: 9px 12px; list-style: none;
  font-size: 12px; font-weight: 600; color: var(--dsh-tasks-ink); cursor: pointer;
}
.dsh-tasks-delivery-criteria > summary::-webkit-details-marker { display: none; }
.dsh-tasks-delivery-criteria > summary > .dsh-tasks-icon:first-child { color: var(--dsh-tasks-focus); }
.dsh-tasks-delivery-criteria > summary > :last-child { margin-inline-start: auto; color: var(--dsh-tasks-muted); transition: transform .15s ease; }
.dsh-tasks-delivery-criteria[open] > summary > :last-child { transform: rotate(180deg); }
.dsh-tasks-delivery-criteria-body {
  padding: 0 12px 10px; border-top: 1px dashed var(--dsh-tasks-rule); padding-top: 9px;
}

.dsh-tasks-evidence-card {
  display: grid; gap: 7px; padding: 12px 14px;
  border: 1px solid var(--dsh-tasks-rule); border-radius: var(--dsw-radius-md, 10px);
  background: var(--dsh-tasks-paper);
}
.dsh-tasks-evidence-card h4 {
  display: flex; align-items: center; gap: 6px; margin: 0; font-size: 13px; font-weight: 650; color: var(--dsh-tasks-ink);
}
.dsh-tasks-evidence-card h4 > .dsh-tasks-icon { color: var(--dsh-tasks-focus); }
.dsh-tasks-evidence-callout {
  border-color: color-mix(in srgb, var(--dsh-paper-warning, var(--dsw-alias-state-warn-primary)) 36%, var(--dsh-tasks-rule));
  border-inline-start: 3px solid var(--dsh-paper-warning, var(--dsw-alias-state-warn-primary));
  background: color-mix(in srgb, var(--dsh-paper-warning, var(--dsw-alias-state-warn-primary)) 7%, var(--dsh-tasks-paper));
}
.dsh-tasks-evidence-callout h4 > .dsh-tasks-icon { color: var(--dsh-paper-warning, var(--dsw-alias-state-warn-primary)); }

.dsh-tasks-evidence-links { display: flex; flex-wrap: wrap; gap: 6px; }
.dsh-tasks-evidence-links a {
  display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px;
  border: 1px solid var(--dsh-tasks-rule); border-radius: 999px;
  background: color-mix(in srgb, var(--dsh-tasks-focus) 5%, var(--dsh-tasks-paper));
  color: var(--dsh-tasks-focus); font-size: 12px; font-weight: 500; text-decoration: none;
}
.dsh-tasks-evidence-links a:hover {
  border-color: var(--dsh-tasks-focus);
  background: color-mix(in srgb, var(--dsh-tasks-focus) 11%, var(--dsh-tasks-paper));
}

.dsh-tasks-delivery-status {
  display: inline-flex; align-items: center; gap: 6px; margin: 0;
  color: var(--dsh-paper-success, var(--dsw-alias-state-success-primary)); font-size: 12px; font-weight: 600;
}
.dsh-tasks-delivery-empty {
  padding: 18px 14px; border: 1px dashed var(--dsh-tasks-line); border-radius: var(--dsw-radius-md, 10px);
  text-align: center;
}

.dsh-tasks-root .dsh-tasks-editor-drawer .dsh-tasks-primary:disabled {
  opacity: .5; box-shadow: none; cursor: default;
}

@media (pointer: coarse) {
  .dsh-tasks-stage-pill { min-height: 36px; }
  .dsh-tasks-root .dsh-tasks-disclosure-trigger { min-height: 44px; }
  .dsh-tasks-root .dsh-tasks-session-chip { min-height: 36px; padding-inline: 10px; }
  .dsh-tasks-root .dsh-tasks-activity-link { min-height: 40px; }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-tasks-root .dsh-tasks-editor-drawer * { transition: none; }
}
@media (forced-colors: active) {
  .dsh-tasks-meta-card, .dsh-tasks-delivery-banner, .dsh-tasks-delivery-criteria, .dsh-tasks-evidence-card, .dsh-tasks-stage-pill {
    border-color: CanvasText;
  }
  .dsh-tasks-root .dsh-tasks-detail-title-field:focus { border-color: Highlight; outline: 2px solid Highlight; }
}
`

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
    function PaperFrame({ seed, style, children, elementRef, ...props }) {
      const value = paperSeed(seed + ':paper')
      return h('article', { ...props, ref: elementRef, style: {
        '--dsh-tasks-paper-x': -(value % 240) + 'px',
        '--dsh-tasks-paper-y': -((value >>> 11) % 240) + 'px', ...style,
      } }, children)
    }

    const TaskEditorInkContext = React.createContext(false)
    const taskInk = (kind, props) => h(TaskPaperInk, { kind, ...props })
    const inkField = (node, props) => h('span', { className: 'dsh-tasks-ink-field', 'data-task-ink': 'field' }, taskInk('field', props), node)

    function TaskButton({ type = 'button', children, className = 'dsh-tasks-secondary', elementRef, loading, onClick, onPointerDown, ink = true, ...props }) {
      const variant = className.includes('primary') ? 'primary' : /secondary|retry/.test(className) ? 'outline' : 'ghost'
      const paperInk = React.useContext(TaskEditorInkContext) && ink && !className.includes('thumb')
      const anchored = props['aria-haspopup'] || props.role === 'combobox' || props['data-state'] !== undefined || className.includes('grip')
      const press = !anchored && !props.disabled && !loading && !props['aria-disabled']
      return h(Button, { type, variant, size: 'sm', className, ...props, ref: elementRef, 'data-arc-press': press || undefined,
        'aria-disabled': loading || props['aria-disabled'], 'aria-busy': loading || props['aria-busy'], onClick: loading ? event => event.preventDefault() : onClick,
        onPointerDown(event) { if (press) { const width = event.currentTarget.offsetWidth
          event.currentTarget.style.setProperty('--task-press-scale', width > 220 ? '.985' : width && width <= 48 ? '.96' : '.97') }
          onPointerDown?.(event) }, 'data-task-ink': paperInk ? 'button' : undefined },
        ...(paperInk ? [taskInk('button', { variant: variant === 'primary' ? 'default' : variant, disabled: props.disabled || loading }), children] : [children]))
    }
    const TaskInput = ({ className = '', paperInk, ...props }) => {
      const input = h(Input, { ...props, className: 'dsh-tasks-input ' + className })
      return paperInk ? inkField(input, { disabled: props.disabled }) : input
    }
    const TaskTextArea = ({ paperInk, inputRef, ...props }) => {
      const input = h('textarea', { ...props, ref: inputRef })
      return paperInk ? inkField(input, { multiline: true, disabled: props.disabled }) : input
    }

    /** Existing menu semantics, with outside-pointer/focus dismissal while open. */
    class Dropdown extends React.Component {
      position = () => {
        if (!this.panel?.matches(':popover-open')) return
        const rect = this.node.querySelector('summary').getBoundingClientRect()
        const below = window.innerHeight - rect.bottom - 14, above = rect.top - 14
        const up = below < this.panel.scrollHeight && above > below
        const left = this.node.classList.contains('dsh-tasks-filter')
          || this.node.classList.contains('dsh-tasks-col-color-picker')
          || this.node.classList.contains('dsh-tasks-stage-dropdown')
          ? rect.left : rect.right - this.panel.offsetWidth
        Object.assign(this.panel.style, { left: Math.max(8, Math.min(left, window.innerWidth - this.panel.offsetWidth - 8)) + 'px',
          right: 'auto', top: up ? 'auto' : rect.bottom + 5 + 'px', bottom: up ? window.innerHeight - rect.top + 5 + 'px' : 'auto',
          maxHeight: Math.max(48, up ? above : below) + 'px' })
      }
      detach = () => {
        window.document.removeEventListener('pointerdown', this.outside, true)
        window.document.removeEventListener('focusin', this.outside, true)
        window.removeEventListener('blur', this.onWindowBlur)
        window.removeEventListener('resize', this.position)
        window.document.removeEventListener('scroll', this.position, true)
      }
      onWindowBlur = () => {
        if (this.node?.contains(window.document.activeElement) && window.document.activeElement?.type === 'color') return
        this.close()
      }
      close = () => { if (this.node) this.node.open = false; this.detach() }
      outside = event => { if (!this.node.contains(event.target)) this.close() }
      componentWillUnmount() { this.detach() }
      render() {
        const { children, onToggle, onKeyDown, ...props } = this.props
        return h('details', { ...props, ref: node => { this.node = node },
          onToggle: event => {
            if (event.target !== event.currentTarget) return
            this.detach()
            this.panel = this.node.querySelector(':scope > [popover]')
            if (event.currentTarget.open) {
              for (const other of this.node.closest('.dsh-tasks-root').querySelectorAll('details[data-dismiss-menu][open]')) {
                if (other !== this.node) other.open = false
              }
              window.document.addEventListener('pointerdown', this.outside, true)
              window.document.addEventListener('focusin', this.outside, true)
              window.addEventListener('blur', this.onWindowBlur)
              if (this.panel) {
                this.panel.showPopover()
                this.position()
                window.addEventListener('resize', this.position)
                window.document.addEventListener('scroll', this.position, true)
              }
            } else if (this.panel?.matches(':popover-open')) this.panel.hidePopover()
            onToggle?.(event)
          },
          'data-dismiss-menu': '',
          onBlur: event => {
            if (!event.currentTarget.contains(event.relatedTarget) && !(event.currentTarget.contains(window.document.activeElement) && window.document.activeElement?.type === 'color')) this.close()
          },
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
        this.state = { open: false, active: -1, query: '' }
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
      matches(query) {
        const value = query.trim(), term = value.toLocaleLowerCase(), rows = this.options()
        const filtered = rows.filter(row => [row.label, row.value, row.group].some(text => String(text ?? '').toLocaleLowerCase().includes(term)))
        const matches = this.props.maxVisible > 0 ? filtered.slice(0, this.props.maxVisible) : filtered
        if (term && this.props.onCreate && value.length <= this.props.maxLength
          && !rows.some(row => String(this.props.createByValue ? row.value : row.label).toLocaleLowerCase() === term)) {
          matches.push({ create: true, value, label: this.props.t('addValue') + '「' + value + '」' })
        }
        return matches
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
        this.setState(open ? { open } : { open, query: '' })
        this.detach()
        if (open) {
          window.addEventListener('resize', this.close)
          window.addEventListener('blur', this.close)
          window.document.addEventListener('scroll', this.scrolled, true)
        }
      }
      // Editing a long option name can scroll the input itself without moving the popover anchor.
      scrolled = event => { if (event.target !== this.trigger && !this.panel.contains(event.target)) this.close() }
      close = () => { this.panel?.hidePopover(); this.detach(); this.setState({ open: false, query: '' }) }
      open = (last = false, query = '') => {
        if (this.trigger.matches(':disabled')) return
        const rows = this.matches(query)
        const selected = rows.findIndex(row => row.value === String(this.props.value ?? ''))
        const active = selected >= 0 ? selected : last ? rows.findLastIndex(row => !row.disabled) : rows.findIndex(row => !row.disabled)
        const rect = this.trigger.getBoundingClientRect()
        const below = window.innerHeight - rect.bottom - 12, above = rect.top - 12
        const upward = below < 180 && above > below
        const width = Math.min(Math.max(rect.width, this.props.minPopoverWidth || 0), window.innerWidth - 24)
        Object.assign(this.panel.style, { width: width + 'px',
          left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)) + 'px',
          top: upward ? 'auto' : rect.bottom + 5 + 'px', bottom: upward ? window.innerHeight - rect.top + 5 + 'px' : 'auto',
          maxHeight: Math.max(60, Math.min(280, upward ? above : below)) + 'px' })
        this.panel.showPopover()
        this.setState({ open: true, active, query }, this.reveal)
        this.props.onOpen?.()
      }
      reveal = () => { this.panel.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }) }
      choose = index => {
        const row = this.matches(this.state.query)[index]
        if (!row || row.disabled || this.trigger.matches(':disabled')) return
        if (row.create) this.props.onCreate(row.value)
        else this.props.onChange?.({ target: { value: row.value } })
        this.close()
        this.trigger.focus()
      }
      keyDown = event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return
        const rows = this.matches(this.state.query), key = event.key
        if (key === 'Escape' && this.state.open) { event.preventDefault(); event.stopPropagation(); this.close(); return }
        if (key === 'Tab') { this.close(); return }
        const confirm = key === 'Enter' || (this.props.selectOnly && key === ' ')
        if (confirm || key === 'ArrowDown' || key === 'ArrowUp') {
          event.preventDefault()
          if (!this.state.open) { this.open(key === 'ArrowUp'); return }
          if (confirm) { this.choose(this.state.active); return }
          const enabled = rows.map((row, index) => row.disabled ? -1 : index).filter(index => index >= 0)
          const position = enabled.indexOf(this.state.active)
          const active = enabled[(position + (key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length] ?? -1
          this.setState({ active }, this.reveal)
        }
      }
      render() {
        const { value = '', name, disabled, onChange, paperInk, selectOnly, 'aria-label': label } = this.props
        const selected = this.options().find(row => row.value === String(value)), rows = this.matches(this.state.query)
        const triggerProps = { className: 'dsh-tasks-select-trigger', role: 'combobox', 'aria-label': label,
          'aria-haspopup': 'listbox', 'aria-expanded': this.state.open, 'aria-controls': this.id,
          'aria-activedescendant': this.state.open && this.state.active >= 0 ? this.id + '-' + this.state.active : undefined,
          disabled, ref: node => { this.trigger = node }, onKeyDown: this.keyDown,
          onClick: () => { if (!this.state.open) this.open(); else if (selectOnly) this.close() },
        }
        return h('div', { className: 'dsh-tasks-select', 'data-task-ink': paperInk ? 'field' : undefined, onBlur: event => {
          if (!event.currentTarget.contains(event.relatedTarget)) this.close()
        } },
        paperInk ? taskInk('field', { disabled }) : null,
        name ? h('input', { type: 'hidden', name, value, onChange }) : null,
        selectOnly ? h('button', { ...triggerProps, type: 'button', title: selected?.label },
          h('span', null, selected?.label), h(Icon, { name: 'chevronDown', size: 14 }))
        : h('input', { ...triggerProps, type: 'text', autoComplete: 'off', 'aria-autocomplete': 'list', title: this.state.open ? undefined : selected?.label,
          placeholder: this.props.placeholder ?? this.props.t(this.props.onCreate ? 'findOrCreate' : 'findOption'), value: this.state.open ? this.state.query : selected?.label ?? '',
          onFocus: event => event.target.select(),
          onChange: event => { const query = event.target.value; if (!this.state.open) this.open(false, query)
            else this.setState({ query, active: this.matches(query).findIndex(row => !row.disabled) }, this.reveal) },
        }),
        paperInk ? h('span', { className: 'dsh-tasks-select-arrow', 'aria-hidden': true }, h(Icon, { name: 'chevronDown', size: 17 })) : null,
        h('div', { id: this.id, className: 'dsh-tasks-select-list', role: 'listbox', 'aria-label': label,
          popover: 'auto', 'data-task-ink': paperInk ? 'overlay' : undefined, ref: node => { this.panel = node } },
          !rows.length && !this.props.statusText ? h('div', { role: 'status' }, this.props.t('emptyOptions')) : null,
          this.props.statusText ? h('div', { role: 'status', className: 'dsh-tasks-select-group' }, this.props.statusText) : null,
          rows.map((row, index) => h(React.Fragment, { key: row.create ? 'create:' + row.value : row.value },
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

    const STATUS_TONES = {
      error: 'danger',
      approval: 'warn',
      question: 'warn',
      reviewReturned: 'warn',
      launchPending: 'warn',
      dependencyBlocked: 'blocked',
      reviewPending: 'action',
      running: 'info',
      dependencyReady: 'ready',
      reviewAccepted: 'success',
    }
    const statusToneOf = status => STATUS_TONES[status] || 'muted'

    function StatusBadge({ status, label, time, elapsed, paperInk }) {
      return h('div', { className: 'dsh-tasks-card-state', 'data-task-status': status },
        h('span', { className: 'dsh-tasks-status-label', 'data-status-tone': statusToneOf(status), 'data-task-ink': paperInk ? 'badge' : undefined },
          paperInk ? taskInk('badge') : null,
          h('span', { className: 'dsh-tasks-dot', 'aria-hidden': true }), label,
          elapsed ? h('span', { className: 'dsh-tasks-running-elapsed' }, '· ' + elapsed) : null),
        time ? h('span', { className: 'dsh-tasks-status-time' }, '· ' + time) : null)
    }

    /** Validate the public fields needed for rendering and revision updates. */
    function isModel(model) {
      return model && typeof model === 'object' && typeof model.provider === 'string'
        && typeof model.model === 'string' && (model.reasoningEffort === undefined
          || typeof model.reasoningEffort === 'string')
    }
    const isSessionId = id => typeof id === 'string' && /^(?:session-)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
    const isStatus = value => value && isSessionId(value.sessionId) && RUNTIME.includes(value.status) && (value.since === undefined || typeof value.since === 'string')
    const unknownFork = receipt => receipt?.phase === 'forking' && !receipt.sessionId
    const receiptFor = (task, form) => task.launch?.input.requestId === form.retryInput?.requestId ? task.launch : undefined
    const busySource = runtime => ['running', 'approval', 'question'].includes(runtime)
    const forkBlock = (options, runtime) => runtime === 'missing' ? 'missing' : runtime === 'unknown' ? 'sessionStatusUnknown' : busySource(runtime) ? 'sessionBusy' : options.status !== 'ready' || options.canFork !== true ? 'forkUnavailable' : undefined
    const unfinishedLaunch = task => task.launch && !['complete', 'abandoned'].includes(task.launch.phase)
    const inProgressUnlinked = task => task.stage === 'doing' && !task.activeSessionId
    const canStartNewConversation = task => !!task.activeSessionId && !unfinishedLaunch(task) && task.delivery?.status !== 'pending'
    function evidenceUrl(value) {
      if (typeof value !== 'string' || !/^https?:\/\/[^/\\?#\s@]+(?:[/?#]|$)/i.test(value) || /[\\\s\u0000-\u001f\u007f]/u.test(value)) return undefined
      return value
    }
    const optionalText = value => value === undefined || typeof value === 'string'
    function isDelivery(delivery) {
      return delivery && typeof delivery.id === 'string' && isSessionId(delivery.sessionId)
        && ['pending', 'accepted', 'returned'].includes(delivery.status)
        && typeof delivery.summary === 'string' && typeof delivery.submittedAt === 'string'
        && ['verification', 'remaining', 'feedback', 'reviewedAt', 'continuedAt', 'criteria'].every(key => optionalText(delivery[key]))
        && (delivery.links === undefined || Array.isArray(delivery.links) && delivery.links.every(link => link && typeof link.label === 'string' && typeof link.url === 'string'))
    }
    const runtimeOf = (task, statuses) => task.activeSessionId
      ? statuses[task.id]?.sessionId === task.activeSessionId ? statuses[task.id].status : 'unknown'
      : 'notStarted'
    function isTask(task) {
      return task !== null && typeof task === 'object'
        && typeof task.id === 'string' && task.id.length > 0
        && Number.isSafeInteger(task.revision) && task.revision > 0
        && typeof task.title === 'string' && task.title.trim().length > 0
        && (task.brief === undefined || typeof task.brief === 'string')
        && validCriteria(task.acceptanceCriteria) && validDependencies(task.dependencyIds)
        && (task.delivery === undefined || isDelivery(task.delivery))
        && (task.workspaceId === undefined || typeof task.workspaceId === 'string')
        && (task.model === undefined || isModel(task.model))
        && (task.activeSessionId === undefined || isSessionId(task.activeSessionId))
        && (task.previousSessionIds === undefined || (Array.isArray(task.previousSessionIds) && task.previousSessionIds.every(isSessionId)))
        && (task.launch === undefined || (task.launch && (isSessionId(task.launch.sessionId) || (task.launch.sessionId === undefined
          && isSessionId(task.launch.input?.forkFromSessionId) && ['prepared', 'forking', 'abandoned'].includes(task.launch.phase)))
          && (task.launch.input?.forkFromSessionId === undefined || isSessionId(task.launch.input.forkFromSessionId))
          && ['prepared', 'forking', 'created', 'sending', 'complete', 'abandoned'].includes(task.launch.phase)
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
        if (!draft || typeof draft.title !== 'string' || typeof draft.brief !== 'string'
          || !validCriteria(draft.acceptanceCriteria) || !validDependencies(draft.dependencyIds)) return
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
          || metaKeys.some(key => input[key] !== (draft[key] || undefined))
          || input.acceptanceCriteria !== deliveryFields(draft).acceptanceCriteria || JSON.stringify(dependencyIds(input)) !== JSON.stringify(dependencyIds(draft))
          || input.columnId !== draft.columnId || (input.stage ?? 'todo') !== (draft.stage ?? 'todo'))) return
        return {
          ...metadata(draft), acceptanceCriteria: draft.acceptanceCriteria, dependencyIds: draft.dependencyIds,
          title: draft.title, brief: draft.brief, stage: draft.stage || 'todo', columnId: draft.columnId,
          workspaceId: draft.workspaceId || '', model: draft.model, retryInput: input || undefined,
        }
      } catch { /* Session storage may be unavailable; in-memory retry still works. */ }
    }

    function readBoardView() {
      try {
        const value = JSON.parse(window.localStorage?.getItem(BOARD_VIEW_KEY))
        const toggles = group => Object.fromEntries(Object.entries(group || {}).filter(([key, on]) =>
          (defaults.some(column => column.id === key) || key.length <= 36 && isSessionId(key)) && typeof on === 'boolean').slice(0, 100))
        return { collapsed: toggles(value?.collapsed), showAllDone: toggles(value?.showAllDone), overview: value?.overview === true }
      } catch { return { collapsed: {}, showAllDone: {}, overview: false } }
    }

    /**
     * Own all RPCs, one SSE connection, and the stable slot source. Refresh and
     * writes never overlap; list responses cannot replace newer stream events.
     * Draft/pending state lives here so leaving the panel cannot lose a retry.
     */
    function createTaskList(connection, navigation) {
      const draft = readDraft()
      let savedLaunch
      try {
        const value = JSON.parse(window.sessionStorage?.getItem(LAUNCH_KEY) || 'null')
        if (value && typeof value.taskId === 'string' && typeof value.retryInput?.requestId === 'string'
          && typeof value.retryInput.content === 'string') savedLaunch = { ...value, open: true, pending: false, checkReceipt: !!value.retryInput.forkFromSessionId, errorCode: value.errorCode === 'tasks/fork-unknown' ? value.errorCode : 'tasks/launch-unknown' }
      } catch { /* Storage may be disabled or an old draft malformed. */ }
      let snapshot = {
        deletion: undefined,
        status: 'loading', tasks: [], errorCode: undefined, hasLoaded: false, sync: 'connecting',
        query: '', stages: {}, workspaceFilter: '', ...readBoardView(), detailId: undefined,
        statuses: {}, launchForm: savedLaunch, quickCreating: false, unlockNotice: undefined, sortBy: 'manual',
        options: { status: 'idle', workspaces: [], groups: [], workspaceStatus: 'unavailable', modelStatus: 'unavailable', modelFailures: 0 },
        form: {
          ...metadata(draft), acceptanceCriteria: draft?.acceptanceCriteria, dependencyIds: draft?.dependencyIds,
          open: !!draft, title: draft?.title || '', brief: draft?.brief || '', pending: false,
          stage: draft?.stage || 'todo', columnId: draft?.columnId, workspaceId: draft?.workspaceId || '', model: draft?.model,
          retryInput: draft?.retryInput,
          errorCode: draft?.retryInput ? 'tasks/create-unknown' : undefined,
        },
      }
      let request
      let optionsRequest
      let disposed = false
      let streamController
      let reconnectTimer
      let unlockTimer
      let syncStarted = false
      let streamVersion = 0
      let retryDelay = 1000
      let currentStreamId
      let searchTimer, searchVersion = 0, historyVersion = 0, historyQueued = false
      let streamSequence = -1
      const pendingCommits = new Map()
      let suspended = false
      const listeners = new Set()
      const controllers = new Set()

      function changeBoardView(changes) {
        if (disposed) return
        const { collapsed, showAllDone, overview } = snapshot
        const next = { collapsed, showAllDone, overview, ...changes }
        try { window.localStorage?.setItem(BOARD_VIEW_KEY, JSON.stringify(next)) } catch { /* Preferences are optional. */ }
        publish({ ...snapshot, ...next })
      }

      function changeLaunch(changes) {
        const launchForm = { ...snapshot.launchForm, ...changes }
        try {
          if (launchForm.retryInput) window.sessionStorage?.setItem(LAUNCH_KEY, JSON.stringify(launchForm))
          else window.sessionStorage?.removeItem(LAUNCH_KEY)
        } catch { /* Host receipts remain recoverable when tab storage is unavailable. */ }
        publish({ ...snapshot, ...(launchForm.open ? { detailId: undefined, editor: undefined } : {}), launchForm })
      }

      function openLaunch(taskId, { newConversation = false } = {}) {
        if (snapshot.launchForm?.pending || snapshot.launchForm?.retryInput) {
          changeLaunch({ open: true })
          return
        }
        const task = snapshot.tasks.find(row => row.id === taskId)
        if (!task) return
        const mode = newConversation && canStartNewConversation(task)
        const draft = snapshot.launchForm
        const unfinished = unfinishedLaunch(task) ? task.launch : undefined
        if (!unfinished && draft?.suspended && draft.taskId === taskId && draft.newConversation === mode) {
          changeLaunch({ open: true, suspended: undefined })
          void loadOptions()
          return
        }
        publish({ ...snapshot, detailId: undefined, launchForm: {
          taskId, open: true, pending: false, replaceActive: false,
          newConversation: mode,
          includeFiles: unfinished ? !!unfinished.input.includeFiles : true,
          content: task.title + (task.brief ? '\n\n' + task.brief : ''),
          workspaceId: unfinished ? '' : task.workspaceId || '', model: unfinished ? undefined : task.model, agentPreset: '',
          ...(unfinished ? { ...unfinished.input, retryInput: unfinished.input, resume: true } : {}),
        } })
        void loadOptions()
      }

      function navigateToSession(sessionId) {
        navigation.open(sessionId)
        publish({ ...snapshot, detailId: undefined, restore: undefined, navigationError: undefined })
        if (snapshot.launchForm?.open) changeLaunch({ open: false })
      }
      function openSession(sessionId) {
        if (disposed || !isSessionId(sessionId) || snapshot.restore) return
        try {
          if (navigation.archived(sessionId) || Object.values(snapshot.statuses).some(row => row.sessionId === sessionId && row.status === 'archived')) {
            publish({ ...snapshot, restore: { sessionId }, navigationError: undefined })
          } else navigateToSession(sessionId)
        } catch { publish({ ...snapshot, navigationError: 'tasks/navigation-failed' }) }
      }
      async function restoreSession() {
        const restore = snapshot.restore
        if (disposed || !restore || restore.pending) return
        publish({ ...snapshot, restore: { ...restore, pending: true, error: undefined } })
        let restored = false
        try {
          await navigation.restore(restore.sessionId)
          restored = true
          if (!disposed) navigateToSession(restore.sessionId)
        } catch {
          if (!disposed) publish({ ...snapshot, restore: { ...restore, error: restored ? 'navigationFailed' : 'restoreFailed' } })
        }
      }

      async function abandonLaunch() {
        const task = snapshot.tasks.find(row => row.id === snapshot.launchForm?.taskId)
        if (!task?.launch || !receiptFor(task, snapshot.launchForm) || snapshot.launchForm.pending || !writable()) return
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

      // A lost browser reply is not evidence of a lost host Fork. Read first;
      // never infer the child from the active binding, recent sessions or an error detail.
      async function checkForkReceipt() {
        const form = snapshot.launchForm, input = form?.retryInput
        if (!input?.forkFromSessionId || form.pending || !writable()) return
        changeLaunch({ pending: true })
        const host = currentStreamId
        try {
          const result = await call('get', { taskId: input.taskId })
          if (disposed) return
          if (host && host !== currentStreamId) throw new Error('Host changed')
          if (!result.ok || !isTask(result.value?.task) || result.value.task.id !== input.taskId) throw new Error('No authoritative task')
          publish({ ...snapshot, tasks: upsert(result.value.task, result) })
          const task = snapshot.tasks.find(row => row.id === input.taskId)
          const receipt = task && receiptFor(task, form)
          if (receipt && !unfinishedLaunch(task)) {
            changeLaunch({ pending: false, checkReceipt: false, retryInput: undefined, open: false })
          } else if (receipt && !(form.errorCode === 'tasks/fork-unknown' && receipt.phase === 'prepared' && !receipt.sessionId)) {
            changeLaunch({ ...receipt.input, includeFiles: !!receipt.input.includeFiles, retryInput: receipt.input, resume: true, pending: false, checkReceipt: false,
              errorCode: unknownFork(receipt) ? 'tasks/fork-unknown' : undefined })
          } else if (form.errorCode === 'tasks/fork-unknown') {
            // A known-unknown Fork must not become replayable when the receipt is absent.
            changeLaunch({ pending: false, checkReceipt: true })
          } else if (task?.revision === input.expectedRevision && task.activeSessionId === input.forkFromSessionId) {
            changeLaunch({ pending: false, checkReceipt: false, resume: false, errorCode: undefined })
          } else {
            changeLaunch({ pending: false, retryInput: undefined, checkReceipt: false, open: false })
          }
        } catch { if (!disposed) changeLaunch({ pending: false, checkReceipt: true }) }
      }

      async function launchTask() {
        const form = snapshot.launchForm
        if (!form || form.pending || !writable()) return
        if (!form.retryInput && form.includeFiles && imageJobs(form.taskId).length) return
        const task = snapshot.tasks.find(row => row.id === form.taskId)
        if (!task || form.checkReceipt || form.errorCode === 'tasks/fork-unknown' || unknownFork(receiptFor(task, form))) return
        const source = form.forkFromSessionId
        const replacing = !!(form.newConversation || form.replaceActive)
        const runtime = runtimeOf(task, snapshot.statuses)
        if (!form.retryInput && task.activeSessionId && (!replacing || busySource(runtime))) return
        if (!form.retryInput && source && (!replacing || source !== task.activeSessionId || forkBlock(snapshot.options, runtime))) return
        const input = form.retryInput || {
          taskId: task.id, expectedRevision: task.revision,
          requestId: Array.from(window.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''),
          content: form.content, replaceActive: replacing,
          ...(form.includeFiles && (task.fileCount || task.imageCount) ? { includeFiles: true } : {}),
          ...(source ? { forkFromSessionId: source } : form.workspaceId ? { workspaceId: form.workspaceId } : {}),
          ...(form.model ? { model: form.model } : {}),
          ...(!source && form.agentPreset ? { agentPreset: form.agentPreset } : {}),
        }
        changeLaunch({ pending: true, retryInput: input, errorCode: undefined })
        const host = currentStreamId
        try {
          const resume = form.resume || !!receiptFor(task, form)
          const result = await call(resume ? 'resume-launch' : 'launch', resume ? { taskId: task.id, requestId: input.requestId } : input)
          if (disposed) return
          if (host && host !== currentStreamId) throw new Error('Host changed')
          if (!result.ok) {
            if (result.error.code === 'tasks/launch-abandoned') {
              changeLaunch({ pending: false, retryInput: undefined, open: false })
              return
            }
            const knownRejection = ['tasks/revision-conflict', 'tasks/workspace-unavailable', 'tasks/model-unavailable', 'tasks/preset-unavailable', 'tasks/session-busy', 'tasks/session-exists', 'tasks/bad-request', 'tasks/dependencies-blocked', 'tasks/delivery-pending'].includes(result.error.code)
            const saved = snapshot.tasks.find(row => row.id === task.id)?.launch
            const persisted = saved?.input.requestId === input.requestId
            const forkRejected = ['tasks/fork-unavailable', 'tasks/fork-source-changed'].includes(result.error.code)
            const retryInput = forkRejected || knownRejection && !persisted ? undefined : input
            changeLaunch({ pending: false, resume: !!retryInput && form.resume, errorCode: result.error.code, retryInput,
              checkReceipt: !!retryInput?.forkFromSessionId && (!persisted || result.error.code === 'tasks/fork-unknown' && !unknownFork(saved)) })
            blockUncertain(result.error.code)
            return
          }
          if (!isTask(result.value?.task) || !isSessionId(result.value.sessionId)) throw new TypeError('Invalid launch result')
          publish({ ...snapshot, tasks: upsert(result.value.task, result) })
          changeLaunch({ pending: false, retryInput: undefined, open: false })
        } catch {
          if (!disposed) changeLaunch({ pending: false, checkReceipt: !!input.forkFromSessionId, errorCode: 'tasks/launch-unknown' })
        }
      }

      function saveDraft(form) {
        try {
          if (!form.title && !form.brief && !form.retryInput && !form.workspaceId && !form.model
            && !metaKeys.some(key => form[key]) && !form.acceptanceCriteria && !dependencyIds(form).length) {
            window.sessionStorage.removeItem(DRAFT_KEY)
          } else {
            window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
              ...metadata(form), acceptanceCriteria: form.acceptanceCriteria, dependencyIds: form.dependencyIds,
              title: form.title, brief: form.brief, retryInput: form.retryInput,
              stage: form.stage, columnId: form.columnId, workspaceId: form.workspaceId, model: form.model,
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

      function storeDetail(taskId, editor) {
        try {
          if (!editor) window.sessionStorage?.removeItem(DETAIL_KEY + taskId)
          else {
            const data = JSON.stringify({ taskId, ...editableValues(editor), baseEditable: editor.baseEditable,
              revision: editor.revision, createdAt: editor.createdAt, storeId: editor.storeId, retryInput: editor.retryInput })
            if (data.length <= 262144) window.sessionStorage?.setItem(DETAIL_KEY + taskId, data)
            else window.sessionStorage?.removeItem(DETAIL_KEY + taskId)
          }
        } catch { /* In-memory editing and retries remain available without tab storage. */ }
      }
      function readDetail(taskId) {
        try {
          const raw = window.sessionStorage?.getItem(DETAIL_KEY + taskId)
          if (!raw || raw.length > 262144) return
          const saved = JSON.parse(raw)
          if (saved.taskId !== taskId || !validEditable(saved) || !validEditable(saved.baseEditable)
            || !Number.isSafeInteger(saved.revision) || saved.revision < 1 || typeof saved.createdAt !== 'string'
            || saved.storeId !== undefined && typeof saved.storeId !== 'string') return
          const input = saved.retryInput
          if (input && (input.taskId !== taskId || input.expectedRevision !== saved.revision
            || typeof input.requestId !== 'string' || !/^[A-Za-z0-9._~-]{1,128}$/.test(input.requestId)
            || Object.keys(input).some(key => !['taskId', 'expectedRevision', 'requestId', 'patch'].includes(key))
            || JSON.stringify(input.patch) !== JSON.stringify({ title: saved.title.trim(), brief: saved.brief, ...detailPatch(saved, saved.baseEditable) }))) return
          return { ...editableValues(saved), baseEditable: editableValues(saved.baseEditable), revision: saved.revision,
            createdAt: saved.createdAt, storeId: saved.storeId, retryInput: input, pending: false,
            ...(input ? { errorCode: 'tasks/edit-unknown' } : {}) }
        } catch { /* Ignore malformed or unavailable local storage. */ }
      }
      function sameDetailSource(editor, task, storeId = snapshot.storeId) {
        return task && editor.createdAt === task.createdAt && (!editor.storeId || !storeId || editor.storeId === storeId)
      }
      function reconcileEditor(editor, task, storeId) {
        if (!editor || editor.pending || editor.retryInput || !task) return editor
        if (!sameDetailSource(editor, task, storeId) || task.revision < editor.revision) {
          return editor.errorCode === 'tasks/edit-source-changed' ? editor : { ...editor, errorCode: 'tasks/edit-source-changed' }
        }
        if (editor.errorCode === 'tasks/edit-source-changed' || !editor.baseEditable || !sameEditable(editor.baseEditable, task)) return editor
        if (editor.revision === task.revision) return editor
        return { ...editor, revision: task.revision, storeId: storeId ?? editor.storeId, errorCode: undefined }
      }
      function publish(next) {
        const previous = snapshot
        if (next.detailId && next.editor) next = { ...next,
          editor: reconcileEditor(next.editor, next.tasks.find(task => task.id === next.detailId), next.storeId) }
        if (previous.detailId && previous.editor && previous.detailId !== next.detailId) storeDetail(previous.detailId, previous.editor)
        if (next.detailId && (previous.editor !== next.editor || previous.detailId !== next.detailId)) storeDetail(next.detailId, next.editor)
        snapshot = next
        const changedTasks = previous.tasks !== next.tasks
        const resetSearch = previous.query !== next.query || previous.storeId !== next.storeId
        if (resetSearch || changedTasks && next.query) scheduleSearch(resetSearch)
        if (next.detailId !== previous.detailId) {
          historyVersion++
          historyQueued = false
          snapshot = { ...snapshot, activity: undefined }
        } else if (next.detailId && next.activity && changedTasks) {
          const revision = next.tasks.find(task => task.id === next.detailId)?.revision
          const oldRevision = previous.tasks.find(task => task.id === next.detailId)?.revision
          if (revision < oldRevision) {
            historyVersion++
            historyQueued = false
            snapshot = { ...snapshot, activity: undefined }
          }
          if (revision !== undefined && revision !== oldRevision) void loadHistory()
        }
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch (error) {
            console.error('[tavlo-tasks] task list listener threw:', error)
          }
        }
      }

      function scheduleSearch(reset = false) {
        clearTimeout(searchTimer)
        const version = ++searchVersion, query = snapshot.query.trim()
        const hasComments = !!query && snapshot.tasks.some(task => task.commentCount)
        // A same-query refresh must not hide existing comment-only results while it waits.
        if (reset || !hasComments || snapshot.searchError) snapshot = { ...snapshot, matches: reset || !hasComments ? undefined : snapshot.matches, searchError: false }
        if (!hasComments) return
        searchTimer = setTimeout(async () => {
          try {
            const result = await call('comment-matches', { query })
            if (!result.ok) throw new Error('Search failed')
            if (!disposed && version === searchVersion) {
              const matches = result.value.matches, previous = snapshot.matches
              if (!previous || Object.keys(previous).length !== Object.keys(matches).length
                || Object.entries(matches).some(([id, snippet]) => previous[id] !== snippet)) publish({ ...snapshot, matches })
            }
          } catch { if (!disposed && version === searchVersion) publish({ ...snapshot, searchError: true }) }
        }, 180)
      }

      async function loadHistory(older = false) {
        const taskId = snapshot.detailId, version = historyVersion
        if (disposed || !taskId || !snapshot.board) return
        const prior = snapshot.activity ?? { events: [] }
        if (prior.loading) {
          if (!older) historyQueued = true
          return
        }
        if (older && !prior.before) return
        const mode = older ? 'older' : 'latest'
        const current = () => !disposed && version === historyVersion
        publish({ ...snapshot, activity: { ...prior, loading: mode, error: undefined } })
        try {
          const head = older ? undefined : prior.events[0]?.id
          const events = []
          let before = older ? prior.before : undefined
          do {
            const result = await call('history', { taskId, ...(before ? { before } : {}) })
            if (!current()) return
            if (!result.ok) throw new Error('History failed')
            events.push(...result.value.events.filter(event => head === undefined || event.id > head))
            before = result.value.before
          } while (head !== undefined && before > head)
          const merged = older ? [...prior.events, ...events] : [...events, ...prior.events]
          publish({ ...snapshot, activity: { events: merged, before: head === undefined ? before : prior.before } })
        } catch {
          if (current()) publish({ ...snapshot, activity: { ...prior, error: mode } })
        } finally {
          if (current() && historyQueued) {
            historyQueued = false
            void loadHistory()
          }
        }
      }

      function changeComment(taskId, draft) {
        publish({ ...snapshot, comments: { ...snapshot.comments, [taskId]: draft } })
      }
      async function postComment(taskId) {
        const draft = snapshot.comments?.[taskId]
        if (!writable() || !draft?.text.trim() || draft.pending) return
        const requestId = draft.requestId || newRequestId()
        changeComment(taskId, { ...draft, requestId, pending: true })
        try {
          const result = await call('comment', { taskId, requestId, text: draft.text })
          if (disposed) return
          if (!result.ok) {
            changeComment(taskId, { text: draft.text, error: true, requestId: ['tasks/persistence-unknown', 'gateway/cancelled'].includes(result.error.code) ? requestId : undefined })
            blockUncertain(result.error.code)
            return
          }
          if (!isTask(result.value.task) || result.value.task.id !== taskId) throw new Error('Invalid comment response')
          publish({ ...snapshot, comments: { ...snapshot.comments, [taskId]: undefined }, tasks: upsert(result.value.task, result) })
        } catch { if (!disposed) changeComment(taskId, { text: draft.text, requestId, error: true }) }
      }

      function changeForm(changes) {
        if (disposed) return
        const form = { ...snapshot.form, ...changes }
        saveDraft(form)
        publish({ ...snapshot, form })
      }

      function imageJobs(key) { return snapshot.imageJobs?.[key] ?? [] }
      function setJobs(key, jobs) { publish({ ...snapshot, imageJobs: { ...snapshot.imageJobs, [key]: jobs } }) }
      const uploadWorkers = new Set()
      async function runUploads(taskId) {
        if (uploadWorkers.has(taskId) || disposed) return
        uploadWorkers.add(taskId)
        try {
          for (;;) {
            const item = imageJobs(taskId).find(row => row.state === 'queued')
            if (!item || disposed || !writable()) break
            const host = currentStreamId, controller = new AbortController()
            controllers.add(controller)
            const timer = setTimeout(() => controller.abort(), 45000)
            setJobs(taskId, imageJobs(taskId).map(row => row === item ? { ...item, state: 'sending' } : row))
            try {
              const path = item.legacy ? 'image' : 'file'
              const response = await window.fetch('api/dsh-plugin-tasks/' + path + '/upload?' + new URLSearchParams({ taskId, requestId: item.id,
                ...(item.legacy ? {} : { name: item.file.name }) }), {
                method: 'POST', credentials: 'same-origin', redirect: 'error', headers: { 'Content-Type': item.file.type || 'application/octet-stream' }, body: item.file, signal: controller.signal })
              const result = await response.json()
              if (disposed) return
              if (host && host !== currentStreamId) throw new Error('Task store changed')
              if (!result.ok) { blockUncertain(result.error?.code); throw Object.assign(new Error('Upload failed'), { code: result.error?.code }) }
              if (!isTask(result.value?.task) || result.value.task.id !== taskId) throw new Error('Invalid upload result')
              publish({ ...snapshot, tasks: upsert(result.value.task, result), imageJobs: { ...snapshot.imageJobs, [taskId]: imageJobs(taskId).filter(row => row.id !== item.id) } })
            } catch (error) {
              if (!disposed) setJobs(taskId, imageJobs(taskId).map(row => row.id === item.id ? { ...row, state: 'failed', error: error.code } : row))
            } finally { clearTimeout(timer); controllers.delete(controller) }
          }
        } finally { uploadWorkers.delete(taskId) }
      }
      function queueFiles(key, files, limits) {
        if (disposed || !limits || key === 'draft' && (snapshot.form.pending || snapshot.form.retryInput)) return
        const jobs = [...imageJobs(key)], task = snapshot.tasks.find(row => row.id === key)
        const count = task?.fileCount ?? task?.imageCount ?? 0
        const legacy = limits.maxFiles === undefined
        let warning
        for (const file of files) {
          const image = limits.mediaTypes.includes(file.type)
          const maxBytes = image ? limits.maxImageBytes : limits.maxFileBytes
          if (!maxBytes || (image && !file.size) || file.size > maxBytes) { warning = 'fileInvalid'; continue }
          if (count + jobs.length >= (limits.maxFiles ?? limits.maxImages)) { warning = 'fileLimit'; break }
          jobs.push({ id: newRequestId(), file, image, legacy, state: 'queued' })
        }
        setJobs(key, jobs)
        if (key !== 'draft') void runUploads(key)
        return warning
      }

      const writing = () => taskWritePending(snapshot)
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
        if (current && current.revision >= task.revision) return snapshot.tasks
        if (!snapshot.hasLoaded) return snapshot.tasks
        return current ? snapshot.tasks.map(previous => previous === current ? task : previous) : [...snapshot.tasks, task]
      }

      function removeTask(taskId, result) {
        rememberCommit(result, taskId, null)
        const stages = { ...snapshot.stages }, statuses = { ...snapshot.statuses }
        delete stages[taskId]; delete statuses[taskId]
        const jobs = { ...snapshot.imageJobs }; delete jobs[taskId]
        if (snapshot.launchForm?.taskId === taskId) {
          try { window.sessionStorage?.removeItem(LAUNCH_KEY) } catch { /* Keep removal usable without storage. */ }
        }
        publish({ ...snapshot, tasks: snapshot.tasks.filter(task => task.id !== taskId), stages, statuses, imageJobs: jobs,
          detailId: snapshot.detailId === taskId ? undefined : snapshot.detailId,
          editor: snapshot.detailId === taskId ? undefined : snapshot.editor,
          deletion: snapshot.deletion?.taskId === taskId ? undefined : snapshot.deletion,
          launchForm: snapshot.launchForm?.taskId === taskId ? undefined : snapshot.launchForm })
        storeDetail(taskId)
      }

      function blockUncertain(code) {
        if (code !== 'tasks/persistence-unknown') return
        publish({ ...snapshot, status: 'error', tasks: [], hasLoaded: false, errorCode: code })
      }

      function normalizeStatus(taskId, nextStatus, prevStatuses) {
        if (!nextStatus || nextStatus.status !== 'running') return nextStatus
        const prev = prevStatuses?.[taskId]
        const since = nextStatus.since ?? (prev?.sessionId === nextStatus.sessionId && prev?.status === 'running' ? prev.since : undefined) ?? new Date().toISOString()
        return since === nextStatus.since ? nextStatus : { ...nextStatus, since }
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
          const board = snapshot.board && currentStreamId === event.streamId && snapshot.board.revision > event.board?.revision ? snapshot.board : event.board
          currentStreamId = event.streamId
          const rawStatuses = event.statuses ?? {}
          if (!rawStatuses || typeof rawStatuses !== 'object' || Array.isArray(rawStatuses) || !Object.values(rawStatuses).every(isStatus)) throw new TypeError('Invalid task statuses')
          const statuses = Object.fromEntries(Object.entries(rawStatuses).map(([id, value]) => [id, normalizeStatus(id, value, snapshot.statuses)]))
          publish({ ...snapshot, board, storeId: event.streamId, tasks: [...tasks.values()], statuses, hasLoaded: true, status: 'ready', errorCode: undefined, sync: 'live' })
          if (snapshot.detailId && !tasks.has(snapshot.detailId)) removeTask(snapshot.detailId)
          if (snapshot.launchForm && !tasks.has(snapshot.launchForm.taskId)) removeTask(snapshot.launchForm.taskId)
          if (snapshot.deletion && !tasks.has(snapshot.deletion.taskId)) removeTask(snapshot.deletion.taskId)
          if (event.tasks.some(task => task.workspaceId || task.model)) void loadOptions()
        } else {
          if (event.type === 'board' && event.streamId === currentStreamId && event.sequence === sequence && Array.isArray(event.board?.columns)) {
            if (!snapshot.board || event.board.revision > snapshot.board.revision) publish({ ...snapshot, board: event.board })
            return sequence
          }
          if (event.streamId !== currentStreamId || event.sequence !== sequence + 1) throw new TypeError('Task event gap')
          if (event.type === 'upsert' && isTask(event.task)) {
            streamVersion++
            const pending = pendingCommits.get(event.task.id)
            if (!pending || pending.streamId !== event.streamId || pending.sequence <= event.sequence) {
              const tasks = upsert(event.task)
              if (tasks !== snapshot.tasks || snapshot.sync !== 'live') publish({ ...snapshot, tasks, sync: 'live' })
            }
            if ((event.task.workspaceId || event.task.model) && snapshot.options.status !== 'ready') void loadOptions()
          } else if (event.type === 'remove' && typeof event.taskId === 'string' && Number.isSafeInteger(event.revision)) {
            streamVersion++
            removeTask(event.taskId)
          } else if (event.type === 'status' && typeof event.taskId === 'string' && isStatus(event.status)) {
            const nextStatus = normalizeStatus(event.taskId, event.status, snapshot.statuses)
            publish({ ...snapshot, statuses: { ...snapshot.statuses, [event.taskId]: nextStatus } })
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
            headers: { accept: 'text/event-stream', 'x-tavlo-board': '1' }, signal: controller.signal,
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
          let tasks = result.value?.tasks
          if (!Array.isArray(tasks) || !tasks.every(isTask)
            || new Set(tasks.map(task => task.id)).size !== tasks.length) {
            throw new TypeError('Invalid task list')
          }
          if (!snapshot.storeId || !result.streamId || snapshot.storeId === result.streamId) {
            const merged = new Map(tasks.map(task => [task.id, task]))
            for (const task of snapshot.tasks) if (merged.has(task.id) && merged.get(task.id).revision < task.revision) merged.set(task.id, task)
            for (const [id, commit] of pendingCommits) if (commit.streamId === result.streamId && commit.sequence > result.sequence) {
              if (commit.task) merged.set(id, commit.task)
              else merged.delete(id)
            }
            tasks = [...merged.values()]
          }
          publish({ ...snapshot, status: 'ready', storeId: result.streamId ?? snapshot.storeId, tasks, hasLoaded: true, stages: {}, errorCode: undefined })
          if (snapshot.detailId && !tasks.some(task => task.id === snapshot.detailId)) removeTask(snapshot.detailId)
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
        if (!writable() || snapshot.form.pending || snapshot.boardBusy) return
        const form = snapshot.form
        if (!form.title.trim()) {
          changeForm({ errorCode: 'tasks/title-required' })
          return
        }
        const input = form.retryInput || {
          // getRandomValues also works in an HTTP GUI without a secure context.
          requestId: Array.from(window.crypto.getRandomValues(new Uint8Array(16)),
            byte => byte.toString(16).padStart(2, '0')).join(''),
          ...metadata(form), ...deliveryFields(form), title: form.title.trim(), brief: form.brief,
          stage: form.stage,
          ...(form.columnId && (!snapshot.board || snapshot.board.columns.some(column => column.id === form.columnId)) ? { columnId: form.columnId } : {}),
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
          const queued = imageJobs('draft')
          publish({ ...snapshot, tasks: upsert(task, result), form: nextForm, ...(queued.length ? {
            detailId: task.id, detailView: 'detailTab', editor: undefined, imageJobs: { ...snapshot.imageJobs, draft: [], [task.id]: queued } } : {}) })
          if (queued.length) void runUploads(task.id)
        } catch {
          if (!disposed) changeForm({ pending: false, retryInput: input, errorCode: 'tasks/create-unknown' })
        }
      }

      function activeWorkspaceScope() {
        return snapshot.workspaceFilter && snapshot.workspaceFilter !== 'ungrouped'
          && (snapshot.options.workspaceStatus !== 'ready' || snapshot.options.workspaces.some(row => row.id === snapshot.workspaceFilter))
          ? snapshot.workspaceFilter : ''
      }

      function notifyUnlocked(wasDone, nextTasks, updated) {
        const unlocked = newlyUnlockedTasks(wasDone, nextTasks, updated)
        if (!unlocked.length) return undefined
        clearTimeout(unlockTimer)
        const notice = { id: newRequestId(), sourceTitle: updated.title, tasks: unlocked.map(row => ({ id: row.id, title: row.title })) }
        unlockTimer = setTimeout(() => {
          if (!disposed && snapshot.unlockNotice?.id === notice.id) publish({ ...snapshot, unlockNotice: undefined })
        }, 8000)
        return notice
      }

      function dismissUnlockNotice() {
        clearTimeout(unlockTimer)
        if (!disposed && snapshot.unlockNotice) publish({ ...snapshot, unlockNotice: undefined })
      }

      async function quickCreate({ title, stage = 'todo', columnId } = {}) {
        const trimmed = typeof title === 'string' ? title.trim() : ''
        if (!trimmed) return { ok: false, errorCode: 'tasks/title-required' }
        if (!writable() || snapshot.quickCreating || snapshot.boardBusy) return { ok: false, errorCode: 'tasks/create-failed' }
        const scopedWorkspace = activeWorkspaceScope()
        const input = {
          requestId: newRequestId(),
          title: trimmed,
          brief: '',
          stage,
          ...(columnId && (!snapshot.board || snapshot.board.columns.some(column => column.id === columnId)) ? { columnId } : {}),
          ...(scopedWorkspace ? { workspaceId: scopedWorkspace } : {}),
        }
        publish({ ...snapshot, quickCreating: true })
        const streamAtRequest = currentStreamId
        try {
          const result = await call('create', input)
          if (disposed) return { ok: false, errorCode: 'tasks/create-failed' }
          if (streamAtRequest && currentStreamId !== streamAtRequest) throw new Error('Task store changed during creation')
          if (!result.ok) {
            const code = result.error.code
            publish({ ...snapshot, quickCreating: false })
            blockUncertain(code)
            return { ok: false, errorCode: code }
          }
          const task = result.value?.task
          if (!isTask(task)) throw new TypeError('Invalid created task')
          publish({ ...snapshot, tasks: upsert(task, result), quickCreating: false })
          return { ok: true, task }
        } catch {
          if (!disposed) publish({ ...snapshot, quickCreating: false })
          return { ok: false, errorCode: 'tasks/create-unknown' }
        }
      }

      async function boardWrite(operation, input) {
        if (!snapshot.board || snapshot.boardBusy || !writable() || snapshot.sync !== 'live') return
        const host = currentStreamId
        const wasDone = operation === 'move' && snapshot.tasks.find(row => row.id === input?.taskId)?.stage === 'done'
        publish({ ...snapshot, boardBusy: true, boardError: undefined })
        try {
          const result = await call(operation, input)
          if (disposed || host !== currentStreamId) return
          if (!result.ok) {
            publish({ ...snapshot, boardError: result.error.code })
            blockUncertain(result.error.code)
          } else if (operation === 'move' && isTask(result.value?.task)) {
            const nextTasks = upsert(result.value.task, result)
            const unlockNotice = notifyUnlocked(wasDone, nextTasks, result.value.task)
            publish({ ...snapshot, tasks: nextTasks, ...(unlockNotice ? { unlockNotice } : {}) })
          } else if (result.value?.board?.revision >= snapshot.board.revision) publish({ ...snapshot, board: result.value.board })
          return result
        } catch { if (!disposed) { publish({ ...snapshot, boardError: 'tasks/unknown' }); streamController?.abort() } }
        finally { if (!disposed) publish({ ...snapshot, boardBusy: false }) }
      }

      async function setStage(taskId, stage) {
        if (!writable() || !Object.hasOwn(STAGES, stage) || snapshot.stages[taskId]) return
        const task = snapshot.tasks.find(task => task.id === taskId)
        if (!task || task.stage === stage) return
        const wasDone = task.stage === 'done'
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
          const nextTasks = upsert(updated, result)
          const unlockNotice = notifyUnlocked(wasDone, nextTasks, updated)
          publish({ ...snapshot, tasks: nextTasks, stages, ...(unlockNotice ? { unlockNotice } : {}) })
        } catch {
          if (!disposed) updateRow({ pending: false, errorCode: 'tasks/stage-unknown' })
        }
      }

      function editDetails(field, value) {
        const task = snapshot.tasks.find(row => row.id === snapshot.detailId)
        if (!task || disposed || !['title', 'brief', ...metaKeys, ...preferenceKeys, ...checklistKeys].includes(field) || snapshot.editor?.retryInput) return
        const base = snapshot.editor || { ...editableValues(task), baseEditable: editableValues(task), revision: task.revision,
          createdAt: task.createdAt, storeId: snapshot.storeId }
        const editor = { ...base, [field]: value, errorCode: undefined }
        publish({ ...snapshot, editor: editor.title === task.title && editor.brief === (task.brief || '') && !Object.keys(detailPatch(editor, task)).length ? undefined : editor })
      }

      async function saveDetails() {
        const editor = snapshot.editor
        const task = snapshot.tasks.find(row => row.id === snapshot.detailId)
        if (!task || !editor || !editor.title.trim() || writing() || !writable()) return
        if (!sameDetailSource(editor, task) || editor.errorCode === 'tasks/edit-source-changed') {
          publish({ ...snapshot, editor: { ...editor, errorCode: 'tasks/edit-source-changed' } })
          return
        }
        if (!editor.retryInput && task.revision !== editor.revision) return
        const input = editor.retryInput || { taskId: task.id, expectedRevision: editor.revision,
          requestId: Array.from(window.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''),
          patch: { title: editor.title.trim(), brief: editor.brief, ...detailPatch(editor, task) } }
        const host = currentStreamId
        publish({ ...snapshot, editor: { ...editor, pending: true, retryInput: input, errorCode: undefined } })
        try {
          const result = await call('update', input)
          if (disposed || snapshot.editor?.retryInput !== input) return
          if (host && host !== currentStreamId) throw new Error('Task store changed')
          if (!result.ok) {
            const code = result.error.code
            const uncertain = code === 'tasks/persistence-unknown' || code === 'gateway/cancelled'
            publish({ ...snapshot, editor: { ...editor, pending: false, retryInput: uncertain ? input : undefined, errorCode: code } })
            blockUncertain(code)
            return
          }
          const updated = result.value?.task
          if (!isTask(updated) || updated.id !== task.id || result.value.mutation?.requestId !== input.requestId) throw new Error('Invalid update receipt')
          publish({ ...snapshot, tasks: upsert(updated, result), editor: undefined })
        } catch {
          if (!disposed && snapshot.editor?.retryInput === input) publish({ ...snapshot, editor: { ...editor, pending: false, retryInput: input, errorCode: 'tasks/edit-unknown' } })
        }
      }

      async function mutateDelivery(taskId, operation, decision, feedback) {
        const task = snapshot.tasks.find(row => row.id === taskId)
        const review = operation === 'review-delivery'
        if (!task?.delivery || !writable() || writing() || snapshot.editor
          || (review ? task.delivery.status !== 'pending' : task.delivery.status !== 'returned' || task.delivery.continuedAt)) return
        const wasDone = task.stage === 'done'
        const text = feedback?.trim()
        if (decision === 'return' && !text) return
        const previous = snapshot.deliveryMutation
        const replay = previous?.uncertain && previous.operation === operation && previous.input.taskId === taskId
          && previous.input.deliveryId === task.delivery.id && previous.input.decision === decision && previous.input.feedback === text
        const input = replay ? previous.input : { taskId, deliveryId: task.delivery.id, expectedRevision: task.revision,
          ...(review ? { requestId: newRequestId(), decision, ...(text ? { feedback: text } : {}) } : {}) }
        const host = currentStreamId
        const progress = { operation, input }
        const publishProgress = changes => publish({ ...snapshot, deliveryMutation: { ...progress, ...changes } })
        publishProgress({ pending: true })
        try {
          const result = await call(operation, input)
          if (disposed) return
          if (host && host !== currentStreamId) throw new Error('Task store changed')
          if (!result.ok) {
            const errorCode = result.error.code
            publishProgress({ errorCode, uncertain: ['tasks/persistence-unknown', 'gateway/cancelled'].includes(errorCode) })
            blockUncertain(errorCode)
            return
          }
          const updated = result.value?.task
          if (!isTask(updated) || updated.id !== taskId) throw new TypeError('Invalid delivery result')
          const nextTasks = upsert(updated, result)
          const unlockNotice = notifyUnlocked(wasDone, nextTasks, updated)
          publish({ ...snapshot, tasks: nextTasks, deliveryMutation: undefined, ...(unlockNotice ? { unlockNotice } : {}) })
        } catch { if (!disposed) publishProgress({ errorCode: 'tasks/delivery-unknown', uncertain: true }) }
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

      async function deleteTaskById(taskId, expectedRevision) {
        if (!writable()) return { ok: false, code: 'tasks/not-writable' }
        const task = snapshot.tasks.find(row => row.id === taskId)
        const rev = Number.isSafeInteger(expectedRevision) ? expectedRevision : task?.revision
        if (!Number.isSafeInteger(rev)) return { ok: false, code: 'tasks/not-found' }
        const host = currentStreamId
        try {
          const result = await call('delete', { taskId, expectedRevision: rev })
          if (disposed) return { ok: false, code: 'tasks/disposed' }
          if (host && host !== currentStreamId) return { ok: false, code: 'tasks/delete-unknown' }
          if (!result.ok) {
            if (result.error.code === 'tasks/not-found') { removeTask(taskId); return { ok: true } }
            blockUncertain(result.error.code)
            return { ok: false, code: result.error.code }
          }
          if (result.value?.taskId !== taskId || !Number.isSafeInteger(result.value.revision)) return { ok: false, code: 'tasks/delete-unknown' }
          removeTask(taskId, result)
          return { ok: true }
        } catch {
          return { ok: false, code: 'tasks/delete-unknown' }
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
        quickCreate,
        dismissUnlockNotice,
        setStage,
        move(input) { return boardWrite('move', input) },
        editColumns(input) { return boardWrite('edit-columns', input) },
        editLabels(input) { return boardWrite('edit-labels', input) },
        loadHistory, postComment,
        queueFiles, queueImages: queueFiles,
        getFiles(taskId, launchRequestId) { return call('files', { ...(taskId ? { taskId } : {}), ...(launchRequestId !== undefined ? { launchRequestId } : {}) }) },
        retryImage(key, id) { setJobs(key, imageJobs(key).map(row => row.id === id && row.state !== 'sending' ? { ...row, state: 'queued' } : row)); void runUploads(key) },
        discardImage(key, id) { setJobs(key, imageJobs(key).filter(row => row.id !== id || row.state === 'sending')) },
        async removeFile(input) {
          const host = currentStreamId, result = await call('remove-file', input)
          if (disposed || host && host !== currentStreamId) throw new Error('Store changed')
          if (!result.ok) { blockUncertain(result.error?.code); throw Object.assign(new Error('Remove failed'), { code: result.error?.code }) }
          if (!isTask(result.value?.task) || result.value.task.id !== input.taskId) throw new Error('Invalid removal receipt')
          publish({ ...snapshot, tasks: upsert(result.value.task, result) })
        },
        editComment(taskId, text) { if (!snapshot.comments?.[taskId]?.requestId) changeComment(taskId, { text }) },
        setFilter(key, value) { publish({ ...snapshot, filters: { ...snapshot.filters, [key]: value } }) },
        clearFilters() { publish({ ...snapshot, filters: {}, sortBy: 'manual' }) },
        setSortBy(sortBy) { if (!disposed && SORT_MODES.includes(sortBy)) publish({ ...snapshot, sortBy }) },
        retrySearch() { scheduleSearch(); publish(snapshot) },
        showColumns(managing) { publish({ ...snapshot, managing, boardError: undefined }) },
        mcpAccess(action) { return call('mcp-access', { action }) },
        deleteTask,
        deleteTaskById,
        openDelete(taskId) {
          if (disposed || writing()) return
          const task = snapshot.tasks.find(row => row.id === taskId)
          if (task) publish({ ...snapshot, detailId: undefined, deletion: { taskId, title: task.title, expectedRevision: task.revision, pending: false } })
        },
        closeDelete() { if (!disposed && !snapshot.deletion?.pending) publish({ ...snapshot, deletion: undefined }) },
        openLaunch, launchTask, openSession, abandonLaunch, checkForkReceipt, restoreSession,
        cancelRestore() { if (snapshot.restore && !snapshot.restore.pending) publish({ ...snapshot, restore: undefined }) },
        closeLaunch() { changeLaunch({ open: false }) },
        editLaunch(field, value) {
          if (!snapshot.launchForm?.pending && !snapshot.launchForm?.retryInput) changeLaunch({ [field]: value,
            ...(field === 'replaceActive' && !value ? { forkFromSessionId: undefined } : {}) })
        },
        loadOptions,
        setQuery(query) { if (!disposed) publish({ ...snapshot, query }) },
        setWorkspaceFilter(workspaceFilter) { if (!disposed) publish({ ...snapshot, workspaceFilter }) },
        toggleColumn(columnId, next) {
          const key = Object.hasOwn(STAGES, columnId) ? 'stage:' + columnId : columnId
          changeBoardView({ collapsed: { ...snapshot.collapsed, [key]: next ?? !snapshot.collapsed[key] } })
        },
        toggleDone(columnId = 'stage:done') { changeBoardView({ showAllDone: { ...snapshot.showAllDone, [columnId]: !snapshot.showAllDone[columnId] } }) },
        toggleOverview() { changeBoardView({ overview: !snapshot.overview }) },
        editDetails, saveDetails,
        discardDetails() {
          if (disposed || !snapshot.detailId || !snapshot.editor || snapshot.editor.pending || snapshot.editor.retryInput) return
          const taskId = snapshot.detailId
          publish({ ...snapshot, editor: undefined })
          storeDetail(taskId)
        },
        reviewDelivery(taskId, decision, feedback) { return mutateDelivery(taskId, 'review-delivery', decision, feedback) },
        continueDelivery(taskId) { return mutateDelivery(taskId, 'continue-delivery') },
        async reloadDetails() {
          const editor = snapshot.editor, taskId = snapshot.detailId
          if (!editor || editor.pending || editor.retryInput) return
          await refresh()
          if (!disposed && snapshot.status === 'ready' && snapshot.detailId === taskId && snapshot.editor
            && !snapshot.editor.retryInput && sameEditable(snapshot.editor, editor)) publish({ ...snapshot, editor: undefined })
        },
        openDetails(detailId, view = 'detailTab') {
          if (disposed || snapshot.editor?.pending || snapshot.deliveryMutation?.pending || !DETAIL_VIEWS.includes(view)) return
          const same = detailId === snapshot.detailId
          if (same && view === snapshot.detailView) return
          publish({ ...snapshot, detailId, detailView: view, editor: same ? snapshot.editor : readDetail(detailId) })
          if (view === 'activity' && !snapshot.activity) void loadHistory()
          if (snapshot.options.status !== 'ready') void loadOptions()
        },
        setDetailView(view) {
          if (disposed || !snapshot.detailId || !DETAIL_VIEWS.includes(view) || view === snapshot.detailView) return
          publish({ ...snapshot, detailView: view })
          if (view === 'activity' && !snapshot.activity) void loadHistory()
        },
        openLinkedTask(sessionId, detailId, selectPanel) {
          if (disposed || writing() || snapshot.restore?.pending || !isSessionId(sessionId)
            || !snapshot.tasks.some(task => task.id === detailId && linksSession(task, sessionId))) return false
          try { selectPanel() } catch { return false } // The panel may be unloading.
          // Hide other task dialogs without losing their drafts or retry receipts.
          publish({ ...snapshot, detailId, detailView: 'detailTab', editor: detailId === snapshot.detailId ? snapshot.editor : readDetail(detailId),
            deletion: undefined, restore: undefined, managing: undefined, navigationError: undefined,
            form: { ...snapshot.form, open: false },
            launchForm: snapshot.launchForm?.open ? { ...snapshot.launchForm, open: false, suspended: true } : snapshot.launchForm,
          })
          if (snapshot.options.status !== 'ready') void loadOptions()
          return true
        },
        closeDetails() {
          if (disposed || snapshot.editor?.pending) return
          const taskId = snapshot.detailId, retain = !!snapshot.editor?.retryInput
          publish({ ...snapshot, detailId: undefined, editor: undefined })
          if (taskId && !retain) storeDetail(taskId)
        },
        openForm(stage = 'todo', columnId, initialTitle) {
          const emptyDraft = !snapshot.form.title && !snapshot.form.retryInput
          const scopedWorkspace = activeWorkspaceScope()
          const prefillTitle = typeof initialTitle === 'string' ? initialTitle.trim() : ''
          changeForm({ open: true, ...(emptyDraft ? { stage, columnId, ...(prefillTitle ? { title: prefillTitle } : {}), ...(!snapshot.form.workspaceId && scopedWorkspace ? { workspaceId: scopedWorkspace } : {}) } : {}) })
          if (snapshot.options.status !== 'ready') void loadOptions()
        },
        closeForm() { changeForm({ open: false }) },
        editForm(field, value) {
          if (field === 'columnId' && !snapshot.form.pending && !snapshot.form.retryInput) {
            const column = snapshot.board?.columns.find(row => row.id === value)
            if (column) changeForm({ columnId: value, stage: column.stage, errorCode: undefined })
            return
          }
          if (!snapshot.form.pending && !snapshot.form.retryInput && ['title', 'brief', 'workspaceId', 'model', 'stage', ...metaKeys, ...checklistKeys].includes(field)) {
            changeForm({ [field]: value, errorCode: undefined })
          }
        },
        dispose() {
          disposed = true
          pendingCommits.clear()
          clearTimeout(reconnectTimer)
          clearTimeout(searchTimer)
          clearTimeout(unlockTimer)
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
      return h('style', { 'data-dsh-tasks': '' }, CSS + CONTROLS_CSS + PAPER_CSS + BOARD_CONTROLS_CSS + DETAIL_CONTROLS_CSS)
    }

    const LINKED_TASK_MENU = 'tavlo-tasks.open-linked-task'

    function registerSessionTaskMenu(ctx, tasks, t) {
      ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({
        name: 'contextMenu.icon', key: LINKED_TASK_MENU,
      }, () => h(PanelIcon, { size: 14 })))

      ctx.effect(() => ctx.contextMenus.register({
        id: LINKED_TASK_MENU, target: 'session', order: 550,
        observe: () => [tasks, ctx.locale],
        resolve({ sessionId }, signal) {
          if (signal.aborted || !isSessionId(sessionId)) return []
          const state = tasks.getSnapshot()
          const disabled = taskWritePending(state) || !!state.restore?.pending
          const matches = state.tasks.filter(task => linksSession(task, sessionId))
            .sort((left, right) => Number(right.activeSessionId === sessionId) - Number(left.activeSessionId === sessionId))
          return matches.map(task => ({
            id: task.id, icon: { key: LINKED_TASK_MENU }, disabled,
            label: matches.length === 1 ? t('openLinkedTask') : t('openNamedLinkedTask').replace('{title}', () => task.title),
            failureLabel: t('openLinkedTaskFailed'),
            run() {
              if (!tasks.openLinkedTask(sessionId, task.id, () => ctx.layout.selectPanel(PANEL_ID))) {
                throw new Error('Linked task navigation is no longer available')
              }
            },
          }))
        },
      }), 'tavlo-tasks: linked task menu')
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
        'tasks/prompt-image-unavailable': 'promptImageUnavailable', 'tasks/prompt-image-rejected': 'promptImageRejected',
        'tasks/prompt-file-unavailable': 'promptFileUnavailable', 'tasks/prompt-file-rejected': 'promptFileRejected',
        'tasks/launch-failed': 'launchFailed', 'tasks/launch-unknown': 'launchUnknown',
        'tasks/session-unavailable': 'sessionUnavailable', 'tasks/session-busy': 'sessionBusy',
        'tasks/session-exists': 'sessionExists', 'tasks/launch-pending': 'launchPending',
        'tasks/preset-unavailable': 'presetUnavailable', 'tasks/navigation-failed': 'navigationFailed',
        'tasks/session-archived': 'archived', 'tasks/fork-unavailable': 'forkUnavailable',
        'tasks/fork-source-changed': 'forkChanged', 'tasks/fork-unknown': 'forkUnknown',
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
        'tasks/dependencies-blocked': 'dependencyBlocked', 'tasks/dependency-cycle': 'dependencyCycle',
        'tasks/dependency-unavailable': 'dependencyUnavailable', 'tasks/dependency-missing': 'dependencyUnavailable',
        'tasks/delivery-pending': 'deliveryActionRequired', 'tasks/delivery-review-required': 'deliveryActionRequired',
        'tasks/delivery-not-pending': 'deliveryMutationFailed', 'tasks/delivery-not-returned': 'deliveryMutationFailed',
      }
      return t(keys[code] || fallback)
    }

    function Icon({ name, size = 15 }) {
      const paths = {
        plus: 'M12 5v14M5 12h14',
        chart: 'M4 3v18h17M8 7h10M8 12h6M8 17h13', clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 1 1 18 0ZM12 7v5l3 2',
        sun: 'M16 12a4 4 0 1 1-8 0 4 4 0 1 1 8 0ZM12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2',
        sunrise: 'M2 17h20M5 21h14M7 17a5 5 0 0 1 10 0M12 3v5m-3-2 3-3 3 3M3 10l2 2m14 0 2-2', calendar: 'M3 5h18v16H3ZM3 10h18M8 3v4m8-4v4M7 14h3m3 0h4',
        close: 'm6 6 12 12M18 6 6 18',
        search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
        refresh: 'M20 7v5h-5M4 17v-5h5M5 8a7 7 0 0 1 12-3l3 3M19 16a7 7 0 0 1-12 3l-3-3',
        link: 'M10 13a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-2 2m2 6a4 4 0 0 0-6 0l-4 4a4 4 0 0 0 6 6l2-2',
        filter: 'M4 6h16M7 12h10M10 18h4',
        folder: 'M3 7V5h7l2 2h9v13H3V7Z',
        spark: 'm13 3 2.3 6.7L22 12l-6.7 2.3L13 21l-2.3-6.7L4 12l6.7-2.3ZM4 2v4M2 4h4',
        chevron: 'm9 5 7 7-7 7',
        chevronDown: 'm6 9 6 6 6-6',
        up: 'm6 14 6-6 6 6', down: 'm6 10 6 6 6-6', edit: 'm4 16 11-11 4 4L8 20H4Zm9-9 4 4',
        tag: 'M3 4h8l10 10-7 7L3 10Zm4 3h.01', grip: 'M9 5h.5M14 5h.5M9 12h.5M14 12h.5M9 19h.5M14 19h.5',
        copy: 'M8 8h12v12H8zM16 8V4H4v12h4',
        file: 'M6 3h8l4 4v14H6zM14 3v5h4M9 13h6m-6 4h6',
        download: 'M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4',
        paperclip: 'm8 13 6-6a3 3 0 0 1 4 4l-8 8a4 4 0 0 1-6-6l8-8a5 5 0 0 1 7 7l-6 6',
        comment: 'M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-1-2V6a2 2 0 0 1 2-2Zm2 5h10m-10 4h7',
        move: 'M3 8h17l-3-3m3 3-3 3M21 16H4l3-3m-3 3 3 3',
        trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
        check: 'm5 12 4 4L19 6',
        more: 'M5 12h.01M12 12h.01M19 12h.01',
        alert: 'M21 12a9 9 0 1 1-18 0 9 9 0 1 1 18 0ZM12 7v6m0 4h.01',
        question: 'M21 12a9 9 0 1 1-18 0 9 9 0 1 1 18 0ZM9 9a3 3 0 1 1 4.6 2.5c-1 .6-1.6 1.2-1.6 2.5m0 3h.01',
        flag: 'M5 4v17M5 4h11l-2.5 4.5L16 13H5',
        externalLink: 'M14 4h6v6M10 14 20 4M18 13v6H5V6h6',
        columns: 'M4 5h16v14H4zM9 5v14M15 5v14',
      }
      return h('span', { className: 'dsh-tasks-icon', 'aria-hidden': true },
        name === 'board' ? h(PanelIcon, { size }) : h('svg', {
          width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
          strokeWidth: name === 'more' ? 4 : 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        }, h('path', { d: paths[name] })))
    }

    // Looseleaf notebook.small (MIT); source and static SVG adaptation in docs/looseleaf-source-map.md.
    function DialogSticker() {
      return h('svg', { className: 'dsh-tasks-dialog-sticker', width: 42, height: 42, viewBox: '0 0 64 64', 'aria-hidden': true, focusable: false,
        fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { stroke: 'none', fill: 'var(--dsh-tasks-highlight)', d: 'M13.8 17.8 L47.6 16 Q50.2 16 50.2 18.6 L50.6 54.8 Q50.6 56.8 48.2 56.9 L16.4 57.2 Q13.6 57.2 13.4 54.8 L13.4 20.4 Q13.4 18 13.8 17.8 Z' }),
        h('path', { stroke: 'none', fill: 'currentColor', opacity: .25, d: 'M40.4 16 L46.8 15.6 L47.4 58 L41 58.2 Z' }),
        h('path', { d: 'M14.4 17.2 L47.4 15.4 Q50.6 15.3 50.8 18.4 L51.1 54.4 Q51.1 57.3 48.2 57.4 L16.2 57.8 Q13 57.8 12.9 55.2 L12.7 19.8 Q12.7 17.5 14.4 17.2 Z' }),
        h('path', { d: 'M17.1 17.7 C16.0 7.0 24.3 6.5 23.7 17.5 M26.1 17.2 C25.0 6.5 33.3 6.0 32.7 17.0 M34.9 16.7 C33.8 6.0 42.1 5.6 41.5 16.5' }),
        h('path', { d: 'M19.4 30.2 L35 29.8 M19 40.2 L34.8 39.8' }))
    }

    /** Native top-layer dialog provides background inertness and a focus trap. */
    class Modal extends React.Component {
      componentDidMount() {
        this.opener = window.document.activeElement
        this.dialog.showModal()
        const initial = this.dialog.querySelector('[data-dsh-initial-focus]:not(:disabled)')
          || this.dialog.querySelector(this.props.focusClose ? '.dsh-tasks-dialog-head button:not(:disabled)' : 'button[type="submit"]:not(:disabled)')
        initial?.focus()
      }
      componentWillUnmount() {
        this.dialog.close()
        const opener = this.opener
        const restore = this.props.restoreFocus
        queueMicrotask(() => {
          if ([...window.document.querySelectorAll('dialog[open]')].some(dialog => !dialog.contains(opener))) return
          if (restore) restore(opener)
          else if (opener?.isConnected) opener.focus()
          else window.document.querySelector('.dsh-tasks-board-toolbar .dsh-tasks-primary')?.focus()
        })
      }
      render() {
        const { t, title, intro, onClose, children, dismissDisabled, className = '', paper, alertId } = this.props
        return h('dialog', {
          className: 'dsh-tasks-dialog' + (className ? ' ' + className : ''), 'aria-label': title,
          ref: element => { if (element) this.dialog = element },
          ...(alertId ? { role: 'alertdialog', 'aria-modal': true, 'aria-labelledby': alertId, 'aria-describedby': alertId + '-description' } : {}),
          onCancel(event) { event.preventDefault(); event.stopPropagation(); if (!dismissDisabled) onClose() },
          onKeyDown(event) {
            if (event.target.closest('dialog') !== event.currentTarget) return
            if (alertId && event.key === 'Escape') {
              event.stopPropagation(); event.preventDefault()
              if (!dismissDisabled && !event.repeat && !event.nativeEvent.isComposing) onClose()
              return
            }
            if (event.key !== 'Tab') return
            if (alertId) event.stopPropagation() // The drawer's document listener must not take focus back.
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
            if (alertId || dismissDisabled || event.target !== event.currentTarget) return
            const bounds = event.currentTarget.getBoundingClientRect()
            if (event.clientX < bounds.left || event.clientX > bounds.right
              || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose()
          },
        }, h('header', { className: 'dsh-tasks-dialog-head' },
          paper ? h(DialogSticker) : h('span', { className: 'dsh-tasks-icon dsh-tasks-logo' }, h(Icon, { name: 'board', size: 19 })),
          h('div', null, h('h2', { id: alertId }, title), intro ? h('p', null, intro) : null),
          alertId ? null : h(TaskButton, { className: 'dsh-tasks-icon-button', type: 'button', 'aria-label': t('close'), disabled: dismissDisabled, onClick: onClose }, h(Icon, { name: 'close' })),
        ), children)
      }
    }

    function useAutoGrowTextArea(ref, active, value) {
      const nativeSizing = window.CSS?.supports('field-sizing', 'content')
      const resize = node => {
        if (!node?.clientWidth) return
        node.style.height = '0px'
        node.style.height = (node.scrollHeight + node.offsetHeight - node.clientHeight) + 'px'
      }
      React.useLayoutEffect(() => {
        if (!nativeSizing && active) resize(ref.current)
      }, [nativeSizing, active, value])
      React.useLayoutEffect(() => {
        const node = ref.current
        if (nativeSizing || !active || !node || !window.ResizeObserver) return
        // In the fallback, remeasure on line-wrap changes, not on our own height changes.
        let width = node.clientWidth
        const observer = new window.ResizeObserver(() => {
          if (node.clientWidth === width) return
          width = node.clientWidth
          resize(node)
        })
        observer.observe(node)
        return () => observer.disconnect()
      }, [nativeSizing, active])
    }

    function TaskMarkdown({ t, text, className = '' }) {
      if (!text || !text.trim()) return null
      const rendered = MarkdownText ? h(MarkdownText, {
        text,
        labels: { code: { copyLabel: t('copyCode'), copiedLabel: t('copiedCode') }, footnotes: t('footnotes') },
      }) : null
      const content = rendered
        ? (MarkdownDelegateProvider ? h(MarkdownDelegateProvider, taskMarkdownDelegate, rendered) : rendered)
        : h('pre', { className: 'dsh-tasks-markdown-fallback' }, text)
      return h('div', { className: ('dsh-tasks-description-markdown ' + className).trim() }, content)
    }

    const shortSessionId = id => id.replace(/^session-/i, '').slice(0, 8)
    function SessionChip({ t, sessionId, disabled, onOpen }) {
      return h(TaskButton, {
        type: 'button', ink: false, className: 'dsh-tasks-session-chip',
        disabled, title: t('openSession') + ': ' + sessionId,
        'aria-label': t('openSession') + ': ' + sessionId,
        onClick: () => onOpen(sessionId),
      }, h(Icon, { name: 'link', size: 12 }), h('span', null, t('sessionChip') + ' #' + shortSessionId(sessionId)), h(Icon, { name: 'externalLink', size: 11 }))
    }

    function ColumnPillSelect({ t, columns, current, disabled, blockDone = false, labelPrefix, onSelect }) {
      const label = current ? columnLabel(t, current) : t('unknownColumn')
      const style = current?.color ? { '--dsh-tasks-col-color': current.color } : undefined
      const pill = h('span', { className: 'dsh-tasks-stage-pill', 'data-stage': current?.stage || 'todo', style },
        h('span', { className: 'dsh-tasks-stage-dot', 'aria-hidden': true }),
        h('span', { className: 'dsh-tasks-stage-pill-label' }, label))
      if (disabled) return h('span', { className: 'dsh-tasks-stage-dropdown is-disabled', title: label }, pill)
      return h(Dropdown, { className: 'dsh-tasks-stage-dropdown' },
        h('summary', { className: 'dsh-tasks-stage-pill', 'data-stage': current?.stage || 'todo', style, 'aria-label': labelPrefix + ': ' + label, title: labelPrefix },
          h('span', { className: 'dsh-tasks-stage-dot', 'aria-hidden': true }),
          h('span', { className: 'dsh-tasks-stage-pill-label' }, label),
          h(Icon, { name: 'chevronDown', size: 12 })),
        h('div', { className: 'dsh-tasks-menu dsh-tasks-command-list', popover: 'manual', 'data-task-ink': 'overlay' },
          h('div', { className: 'dsh-tasks-menu-label' }, labelPrefix),
          columns.map(col => {
            const active = col.id === current?.id
            const lockedDone = blockDone && col.stage === 'done'
            return h(TaskButton, {
              key: col.id, type: 'button', ink: false, className: 'dsh-tasks-command',
              disabled: active || lockedDone, 'data-current': active || undefined,
              onClick(event) {
                const details = event.currentTarget.closest('details')
                if (details) { details.open = false; details.querySelector('summary')?.focus() }
                onSelect(col)
              },
            },
              h('span', { className: 'dsh-tasks-stage-dot', 'data-stage': col.stage, style: col.color ? { '--dsh-tasks-col-color': col.color } : undefined, 'aria-hidden': true }),
              h('span', { className: 'dsh-tasks-command-label' }, columnLabel(t, col)),
              active ? h(Icon, { name: 'check', size: 12 }) : null)
          })))
    }

    function DetailHeaderTitle({ t, value, disabled, onChange }) {
      const ref = React.useRef(null)
      useAutoGrowTextArea(ref, true, value)
      return h('div', { className: 'dsh-tasks-detail-title-wrap' },
        h('textarea', {
          ref, name: 'title', rows: 1, maxLength: 200, disabled, value, required: true,
          className: 'dsh-tasks-detail-title-field',
          'aria-label': t('taskTitle'),
          placeholder: t('titlePlaceholder'),
          onChange: event => onChange(event.target.value.replace(/[\r\n]+/g, ' ')),
          onKeyDown(event) {
            if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              event.currentTarget.blur()
            }
          },
        }),
        !disabled ? h('span', { className: 'dsh-tasks-detail-title-affordance', 'aria-hidden': true }, h(Icon, { name: 'edit', size: 13 })) : null)
    }

    function TaskDrawer({ t, title, intro, heading, headingNode, meta, menu, onClose, onKeyDown, children, editorInk = false }) {
      const panel = React.useRef(null)
      const drag = React.useRef(null)
      const [viewport, setViewport] = React.useState(() => window.innerWidth || 1280)
      React.useEffect(() => {
        const update = () => setViewport(window.innerWidth)
        window.addEventListener('resize', update)
        return () => window.removeEventListener('resize', update)
      }, [])
      useModalLayer(panel, true, onClose)
      const widthKey = 'dsh-plugin-tasks:drawer-width'
      const [width, setWidth] = React.useState(() => {
        try {
          const saved = Number(window.localStorage?.getItem(widthKey))
          if (saved >= 420 && saved <= 1000) return saved
        } catch {}
        return 640
      })
      const maxWidth = Math.max(420, Math.min(1000, viewport - 48))
      const resize = (value, persist) => {
        const next = Math.min(maxWidth, Math.max(420, Math.round(value)))
        setWidth(next)
        if (persist) try { window.localStorage.setItem(widthKey, String(next)) } catch {}
      }
      const isDetail = !!(heading || headingNode)
      return createPortal(h('div', { className: 'dsh-tasks-root dsh-tasks-drawer-layer', style: { background: 'rgb(24 23 21 / 22%)' },
        onClick: event => { if (event.target === event.currentTarget) onClose() } },
        h('section', { ref: panel, role: 'dialog', 'aria-modal': true, 'aria-label': title, tabIndex: -1, onKeyDown,
          className: 'dsh-tasks-dialog dsh-tasks-drawer' + (editorInk ? ' dsh-tasks-editor-drawer' : ''), style: { '--drawer-width': width + 'px' } },
          viewport > 600 ? h('div', { className: 'dsh-tasks-drawer-width', role: 'separator', tabIndex: 0, 'aria-orientation': 'vertical',
            'aria-valuemin': 420, 'aria-valuemax': maxWidth, 'aria-valuenow': Math.min(width, maxWidth), title: t('drawerWidth'), 'aria-label': t('drawerWidth'),
            onPointerDown(event) { if (event.button !== 0 || !event.isPrimary) return
              drag.current = { start: event.clientX, width: panel.current.getBoundingClientRect().width, id: event.pointerId }
              event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault() },
            onPointerMove(event) { if (drag.current?.id === event.pointerId) resize(drag.current.width + drag.current.start - event.clientX, false) },
            onPointerUp(event) { if (drag.current?.id === event.pointerId) { resize(drag.current.width + drag.current.start - event.clientX, true); drag.current = null } },
            onLostPointerCapture() { if (drag.current) { setWidth(drag.current.width); drag.current = null } },
            onKeyDown(event) { const next = { ArrowLeft: Math.min(maxWidth, width) + 20, ArrowRight: Math.min(maxWidth, width) - 20, Home: 420, End: maxWidth }[event.key]
              if (next !== undefined) { event.preventDefault(); resize(next, true) } } }) : null,
           h(TaskEditorInkContext.Provider, { value: editorInk }, h('header', { className: 'dsh-tasks-dialog-head' + (isDetail ? ' dsh-tasks-detail-head' : '') },
            h('span', { className: 'dsh-tasks-icon dsh-tasks-logo' }, h(Icon, { name: 'board', size: 19 })),
             h('div', { className: isDetail ? 'dsh-tasks-detail-heading' : undefined }, headingNode || h('h2', { title: heading }, heading || title), meta || (intro ? h('p', null, intro) : null)),
             menu,
            h(TaskButton, { className: 'dsh-tasks-icon-button', 'aria-label': t('close'), onClick: onClose }, h(Icon, { name: 'close' }))), children))), window.document.body)
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

    function SelectField({ t, icon, title, name, value, choices, empty, change, onCreate, maxLength, paperInk }) {
      return h('label', null, icon ? fieldTitle(icon, title) : title, h(PaperSelect, { t, onCreate, createByValue: name === 'priority', maxLength, paperInk, className: 'dsh-tasks-stage', name, 'aria-label': title, value: value || '', onChange: event => change(event.target.value) },
        h('option', { value: '' }, empty), choices.map(([id, label]) => h('option', { key: id, value: id }, label))))
    }
    function Properties({ t, board, values, change, priorities, createLabel, filter = false, paperInk = false }) {
      const [labelError, setLabelError] = React.useState('')
      const addLabel = createLabel && (async name => {
        setLabelError('')
        const result = await createLabel({ action: 'add', expectedRevision: board.revision, name, color: '#4879bc' })
        const added = result?.value?.board?.labels?.at(-1)
        if (added) change('labelId', added.id)
        else setLabelError(result?.error?.code === 'tasks/revision-conflict' ? 'boardConflict' : 'boardFailed')
      })
      const select = (key, icon, choices, onCreate, maxLength) => h(SelectField, {
        t, icon: filter ? undefined : icon, onCreate, maxLength, paperInk, title: t(key), name: key, value: values[key], choices,
        empty: t(filter ? 'any' : 'none'), change: value => change(key, value),
      })
      const priorityChoices = [...priorities]
      if (values.priority && !priorities.has(values.priority)) priorityChoices.push([values.priority, values.priority])
      return h('div', { className: 'dsh-tasks-fields dsh-tasks-properties' },
        select('labelId', 'tag', (board?.labels ?? []).map(row => [row.id, row.name]), addLabel, 80),
        select('priority', 'flag', priorityChoices, filter ? undefined : value => change('priority', value), 32),
        filter ? select('dueDate', undefined, Object.keys(dueIcons).map(key => [key, t(key)]))
          : h(TaskDatePicker, { t, value: values.dueDate, change, paperInk, label: fieldTitle('calendar', t('dueDate')) }),
        labelError ? h('span', { role: 'alert' }, t(labelError)) : null)
    }
    const taskMarkdownDelegate = {
      openExternalLink(value) {
        const href = evidenceUrl(value), url = href && URL.parse(href)
        if (!url) return
        // Tavlo's desktop shell cancels top-level off-loopback navigation and opens
        // it in the system browser. Use that path instead of relying on a WebView popup.
        const localHost = /^(localhost|127\..+|\[::1\])$/i
        const webview = window.__TAURI_INTERNALS__?.metadata?.currentWebview
        if (window.isTauri === true && webview?.label === 'main' && localHost.test(window.location.hostname)
          && !localHost.test(url.hostname) && url.hostname !== 'tauri.localhost') window.location.assign(href)
        else window.open(href, '_blank', 'noopener,noreferrer')
      },
    }

    function parseCardBrief(rawBrief) {
      if (!rawBrief || typeof rawBrief !== 'string') return { brief: '', externalLink: null }
      let text = rawBrief.trim()
      let externalLink = null

      const linkMatch = text.match(/^(?:\[([^\]]+)\]\((?:<([^>]+)>|([^)]+))\)|<([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^>]+)>)/)
      if (linkMatch) {
        const rawLabel = (linkMatch[1] || '').trim()
        const url = (linkMatch[2] || linkMatch[3] || linkMatch[4] || '').trim()
        if (/^https?:\/\//i.test(url)) {
          let label = rawLabel
          if (/tapd\.cn/i.test(url) || /tapd/i.test(rawLabel)) {
            label = 'TAPD'
          } else if (/github\.com/i.test(url) || /github/i.test(rawLabel)) {
            label = 'GitHub'
          } else if (/jira/i.test(url) || /jira/i.test(rawLabel)) {
            label = 'Jira'
          } else if (!label || /^https?:\/\//i.test(label)) {
            label = 'Link'
          }
          externalLink = { label, url }
          text = text.slice(linkMatch[0].length).trim()
        }
      }

      text = text.replace(/^[ ]{4}/gm, '').trim()
      return { brief: text, externalLink }
    }

    function TaskDescription({ t, brief, change, draft, locked, revision, resetSignal = 0, dirty }) {
      const [editing, setEditing] = React.useState(!!draft)
      const id = React.useId()
      const input = React.useRef(null), lastSelection = React.useRef(null), restoreFocus = React.useRef(false)
      const lastRevision = React.useRef(revision), lastReset = React.useRef(resetSignal)
      const hasDescription = !!brief.trim()

      React.useLayoutEffect(() => {
        // A saved/reloaded/discarded revision returns detail to reading, but typing back to base does not.
        if (!draft && !dirty && (revision !== lastRevision.current || resetSignal !== lastReset.current)) {
          lastRevision.current = revision
          lastReset.current = resetSignal
          lastSelection.current = null
          restoreFocus.current = false
          setEditing(false)
        }
      }, [draft, dirty, revision, resetSignal])
      React.useLayoutEffect(() => {
        if (editing && restoreFocus.current && input.current) {
          restoreFocus.current = false
          input.current.focus({ preventScroll: true })
          if (lastSelection.current) input.current.setSelectionRange(...lastSelection.current)
        }
      }, [editing])
      useAutoGrowTextArea(input, editing, brief)

      function switchMode(next) {
        if (locked || next === editing || (draft && !next && !hasDescription)) return
        if (!next && input.current) {
          const { selectionStart, selectionEnd, selectionDirection } = input.current
          lastSelection.current = [selectionStart, selectionEnd, selectionDirection]
        }
        restoreFocus.current = next
        setEditing(next)
      }
      const action = (label, next, props) => h('button', { className: 'dsh-tasks-description-action', type: 'button',
        'aria-controls': id + '-body', onClick: () => switchMode(next), ...props }, t(label))
      const title = fieldTitle('file', t('taskBrief'))
      const markdown = !editing && hasDescription && MarkdownText ? h(MarkdownText, { text: brief,
        labels: { code: { copyLabel: t('copyCode'), copiedLabel: t('copiedCode') }, footnotes: t('footnotes') } }) : null
      return h('div', { className: 'dsh-tasks-description' },
        h('div', { className: 'dsh-tasks-description-head' },
          editing ? h('label', { htmlFor: id }, title) : title,
          draft ? h('div', { className: 'dsh-tasks-description-actions dsh-tasks-segmented', role: 'group', 'aria-label': t('descriptionMode') },
            action('descriptionEdit', true, { 'aria-pressed': editing, disabled: locked }),
            action('descriptionPreview', false, { 'aria-pressed': !editing, disabled: locked || !hasDescription }))
            : action(editing ? 'descriptionPreview' : 'editDescription', !editing, { disabled: locked })),
        h('div', { className: 'dsh-tasks-description-body', id: id + '-body' },
          editing ? h(TaskTextArea, { className: 'dsh-tasks-description-input', inputRef: input, id, name: 'brief', paperInk: true,
            value: brief, rows: 2, placeholder: t('briefPlaceholder'), onChange: event => change('brief', event.target.value) })
            : hasDescription ? h('div', {
              className: 'dsh-tasks-description-markdown' + (!locked ? ' is-editable' : ''),
              onClick(event) {
                if (locked || event.target.closest('a, button, input, summary, [role="button"]') || window.getSelection()?.toString()) return
                switchMode(true)
              },
            }, markdown
              ? MarkdownDelegateProvider ? h(MarkdownDelegateProvider, taskMarkdownDelegate, markdown) : markdown
              : h('pre', null, brief))
              : h('p', { className: 'dsh-tasks-description-empty' }, t('noDescription'))))
    }

    function TaskAcceptanceCriteria({ t, value, change, draft, locked, revision, resetSignal = 0, dirty }) {
      const hasContent = !!(value || '').trim()
      const hasValue = !!(value || '')
      const [open, setOpen] = React.useState(false)
      const [editing, setEditing] = React.useState(!!draft)
      const id = React.useId()
      const input = React.useRef(null), restoreFocus = React.useRef(false)
      const lastRevision = React.useRef(revision), lastReset = React.useRef(resetSignal)
      const expanded = open || hasValue
      const showInput = expanded && (draft || editing || !hasContent)

      React.useLayoutEffect(() => {
        if (!draft && !dirty && (revision !== lastRevision.current || resetSignal !== lastReset.current)) {
          lastRevision.current = revision
          lastReset.current = resetSignal
          restoreFocus.current = false
          setEditing(false)
          setOpen(false)
        }
      }, [draft, dirty, revision, resetSignal])
      React.useLayoutEffect(() => {
        if (showInput && restoreFocus.current && input.current) {
          restoreFocus.current = false
          input.current.focus({ preventScroll: true })
        }
      }, [showInput])
      useAutoGrowTextArea(input, showInput, value)

      if (!expanded) {
        return h('div', { className: 'dsh-tasks-disclosure-row' },
          h(TaskButton, {
            className: 'dsh-tasks-disclosure-trigger', ink: false, disabled: locked,
            onClick: () => { restoreFocus.current = true; setOpen(true); setEditing(true) },
          }, h(Icon, { name: 'check', size: 14 }), h('span', null, t('addCriteria')), h(Icon, { name: 'plus', size: 13 })))
      }
      const title = fieldTitle('check', t('acceptanceCriteria'))
      const markdown = !showInput && hasContent && MarkdownText ? h(MarkdownText, { text: value,
        labels: { code: { copyLabel: t('copyCode'), copiedLabel: t('copiedCode') }, footnotes: t('footnotes') } }) : null
      return h('div', { className: 'dsh-tasks-criteria' },
        h('div', { className: 'dsh-tasks-description-head' },
          showInput ? h('label', { htmlFor: id }, title) : title,
          !draft && (showInput ? hasContent : true) ? h('button', {
            type: 'button', className: 'dsh-tasks-description-action', disabled: locked,
            onClick: () => { restoreFocus.current = !showInput; setEditing(!showInput) },
          }, t(showInput ? 'descriptionPreview' : 'editCriteria')) : null),
        showInput ? h(TaskTextArea, {
          className: 'dsh-tasks-description-input', inputRef: input, id, name: 'acceptanceCriteria', paperInk: true,
          rows: 2, maxLength: 4000, value: value || '', placeholder: t('criteriaPlaceholder'),
          onChange: event => change('acceptanceCriteria', event.target.value),
        }) : h('div', {
          className: 'dsh-tasks-description-markdown dsh-tasks-criteria-read' + (!locked ? ' is-editable' : ''),
          onClick(event) {
            if (locked || event.target.closest('a, button, input, summary, [role="button"]') || window.getSelection()?.toString()) return
            restoreFocus.current = true
            setEditing(true)
          },
        }, markdown
          ? MarkdownDelegateProvider ? h(MarkdownDelegateProvider, taskMarkdownDelegate, markdown) : markdown
          : h('pre', null, value)))
    }
    function TaskImagePreview({ t, src, alt, onClose, native }) {
      // The Host lightbox portals to body, below a native modal's top layer.
      if (native) return h(Modal, { t, title: t('images'), className: 'dsh-tasks-image-dialog', onClose },
        h('div', { className: 'dsh-tasks-dialog-body' }, h('img', { src, alt })))
      return ImageLightbox ? h(ImageLightbox, { src, alt, labels: { dialog: t('images'), close: t('close') }, onClose }) : null
    }
    function AttachmentRow({ className = '', thumb, label, status, announce, controls, children }) {
      return h('li', { className: 'dsh-tasks-attachment-row ' + className }, thumb,
        h('div', { className: 'dsh-tasks-attachment-info' }, h('span', null, label),
          h('span', { className: 'dsh-tasks-field-hint', role: announce ? 'status' : undefined }, status)),
        controls ? h('div', { className: 'dsh-tasks-attachment-actions' }, controls) : null, children)
    }

    const attachmentSize = bytes => bytes < 1024 ? bytes + ' B' : new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(bytes < 1048576 ? bytes / 1024 : bytes / 1048576) + (bytes < 1048576 ? ' KiB' : ' MiB')
    const attachmentStatus = (bytes, text) => attachmentSize(bytes) + ' · ' + text
    const fileIcon = () => h('span', { className: 'dsh-tasks-file-icon' }, h(Icon, { name: 'file', size: 19 }))

    function RemoveFileButton({ t, name, disabled, onClick }) {
      const label = t('removeFile')
      return h(TaskButton, { className: 'dsh-tasks-image-action dsh-tasks-image-remove', ink: false, disabled, onClick,
        'aria-label': label + ': ' + name, title: label }, h(Icon, { name: 'trash', size: 15 }))
    }

    function PendingFile({ t, job, taskId, actions, locked, readOnly }) {
      const [source, setSource] = React.useState(null), [preview, setPreview] = React.useState(false)
      const closePreview = React.useCallback(() => setPreview(false), [])
      React.useEffect(() => {
        if (!job.image || !window.URL?.createObjectURL) return
        const url = window.URL.createObjectURL(job.file)
        setSource({ file: job.file, url })
        return () => window.URL.revokeObjectURL(url)
      }, [job.file, job.image])
      const src = source?.file === job.file ? source.url : undefined
      const failure = ['tasks/file-limit', 'tasks/image-limit'].includes(job.error) ? 'fileLimit'
        : ['tasks/invalid-file', 'tasks/invalid-image'].includes(job.error) ? 'fileInvalid' : 'fileFailed'
      return h(AttachmentRow, { className: 'dsh-tasks-image-job', label: job.file.name, announce: true,
        status: attachmentStatus(job.file.size, t(job.state === 'failed' ? failure : job.state === 'sending' ? 'imageSending' : taskId ? 'imageQueued' : 'imageDraft')),
        thumb: src ? h(TaskButton, { className: 'dsh-tasks-thumb', disabled: !readOnly && !ImageLightbox, 'aria-label': t('images') + ': ' + job.file.name, onClick: () => setPreview(true) },
          h('img', { src, alt: '' })) : fileIcon(),
        controls: !readOnly ? h(React.Fragment, null,
          taskId && job.state === 'failed' ? h(TaskButton, { className: 'dsh-tasks-image-action', ink: false, disabled: locked, onClick: () => actions.retryImage(taskId, job.id) }, t('retry')) : null,
          h(RemoveFileButton, { t, name: job.file.name, disabled: locked || job.state === 'sending', onClick: () => actions.discardImage(taskId ?? 'draft', job.id) })) : null,
      }, preview && src ? h(TaskImagePreview, { t, src, alt: job.file.name, native: readOnly, onClose: closePreview }) : null)
    }
    function TaskImages({ t, actions, task, jobs = [], locked, active = true, readOnly = false, launchRequestId }) {
      const key = task?.id ?? 'draft', scope = key + ':' + (launchRequestId ?? 'current')
      const section = React.useRef(null), picker = React.useRef(null)
      const [loaded, setGallery] = React.useState(null), [epoch, reload] = React.useState(0)
      const gallery = loaded?.scope === scope ? loaded : null
      const [warning, setWarning] = React.useState(''), [preview, setPreview] = React.useState(null), [removal, setRemoval] = React.useState(null)
      const closePreview = React.useCallback(() => setPreview(null), [])
      const refresh = () => reload(value => value + 1)
      React.useEffect(() => {
        let current = true
        actions.getFiles(task?.id, launchRequestId).then(result => {
          if (!current) return
          const files = result.value?.files
          const valid = result.ok && Array.isArray(files)
            && (launchRequestId === undefined || result.value.launchRequestId === launchRequestId)
          setGallery({ ...(valid ? { ...result.value, files } : { error: true }), scope })
        }).catch(() => { if (current) setGallery({ error: true, scope }) })
        return () => { current = false }
      }, [actions, scope, task?.revision, epoch])
      const limits = gallery?.limits
      const add = files => { if (!readOnly && !locked && limits) setWarning(actions.queueFiles(key, files, limits) || '') }
      React.useEffect(() => {
        if (!active || readOnly) return
        const drawer = section.current?.closest('[role=dialog]')
        if (!drawer) return
        const paste = event => {
          const files = [...(event.clipboardData?.files ?? [])]
          if (files.length && limits && !locked) { event.preventDefault(); add(files) }
        }
        const over = event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault() }
        const drop = event => { if (event.dataTransfer?.files.length) { event.preventDefault(); add(event.dataTransfer.files) } }
        drawer.addEventListener('paste', paste); drawer.addEventListener('dragover', over); drawer.addEventListener('drop', drop)
        return () => { drawer.removeEventListener('paste', paste); drawer.removeEventListener('dragover', over); drawer.removeEventListener('drop', drop) }
      }, [actions, active, readOnly, key, limits, locked])
      async function remove(attachmentId) {
        if (readOnly || locked || removal?.pending) return
        const input = removal?.input.attachmentId === attachmentId ? removal.input : { taskId: key, attachmentId, requestId: newRequestId(), expectedRevision: gallery.revision }
        setRemoval({ input, pending: true }); setWarning('')
        try { await actions.removeFile(input); setRemoval(null); refresh() }
        catch (error) {
          setRemoval(error.code === 'tasks/revision-conflict' ? null : { input })
          setWarning(error.code === 'tasks/revision-conflict' ? 'boardConflict' : 'fileFailed'); refresh()
        }
      }
      const url = (id, download = false) => 'api/dsh-plugin-tasks/file?' + new URLSearchParams({ taskId: key, attachmentId: id,
        ...(launchRequestId !== undefined ? { launchRequestId } : {}), ...(download ? { download: '1' } : {}) })
      const files = gallery?.files ?? []
      const empty = !files.length && !jobs.length
      const pending = jobs.filter(job => job.state !== 'failed').length
      const count = task ? files.length : jobs.length
      const full = !readOnly && !!limits && (task ? files.length + jobs.length : jobs.length) >= limits.maxFiles
      const title = t('files')
      const previewed = preview?.scope === scope && files.find(row => row.attachmentId === preview.id)
      return h('section', { ref: section, className: 'dsh-tasks-images', 'aria-label': title },
        h('div', { className: 'dsh-tasks-image-head' },
          h('div', null, h('h3', null, h(Icon, { name: 'paperclip', size: 15 }), title),
            limits && !readOnly ? h('p', { className: 'dsh-tasks-field-hint dsh-tasks-image-count' }, count + '/' + limits.maxFiles,
              pending && task ? ' · ' + t('filePendingCount').replace('{count}', pending) : null) : null),
          limits && !readOnly ? h(TaskButton, { className: 'dsh-tasks-image-action dsh-tasks-image-add-button', ink: false,
            disabled: locked || full, onClick: () => picker.current?.click() }, h(Icon, { name: 'plus', size: 15 }), t('chooseFiles')) : null),
        limits && !readOnly ? h('input', { hidden: true, type: 'file', ref: picker, multiple: true,
          onChange(event) { add(event.target.files); event.target.value = '' } }) : null,
        !gallery ? h('p', { role: 'status' }, t('loading')) : gallery.error || !limits ? h('p', { role: gallery.error ? 'alert' : undefined },
          t(gallery.error ? 'fileListFailed' : 'filesUnavailable'), ' ',
          h(TaskButton, { className: 'dsh-tasks-image-action', ink: false, onClick: refresh }, t('retry'))) : !readOnly ?
          h('div', {
            className: 'dsh-tasks-image-add', 'data-empty': empty ? '' : undefined,
            'data-task-ink': empty ? 'empty' : undefined,
            onClick: empty && !locked && !full ? () => picker.current?.click() : undefined,
          },
            empty ? taskInk('empty') : null,
            h('p', { className: 'dsh-tasks-field-hint' }, t('fileHint'), ' · ≤ ', attachmentSize(limits.maxFileBytes))) : null,
        !readOnly && pending > 0 ? h('p', { className: 'dsh-tasks-field-hint' }, t('imageLocalHint')) : null,
        readOnly && gallery && !gallery.error && empty ? h('p', null, t('noLaunchFiles')) : null,
        launchRequestId ? h('p', { className: 'dsh-tasks-field-hint' }, t('launchFileSnapshot')) : null,
        warning ? h('p', { role: 'alert' }, t(warning)) : null,
        !empty ? h('ul', { className: 'dsh-tasks-image-grid', role: 'list' }, files.map((file, index) => {
          const label = file.name ?? t('imageNumber').replace('{number}', index + 1)
          const image = !!file.width && !!file.height
          return h(AttachmentRow, { key: 'attachment:' + file.attachmentId, label, status: attachmentStatus(file.bytes, t('imageUploaded')),
            thumb: image ? h(TaskButton, { className: 'dsh-tasks-thumb', disabled: !readOnly && !ImageLightbox, 'aria-label': label, onClick: () => setPreview({ id: file.attachmentId, scope }) },
              h('img', { src: url(file.attachmentId), loading: 'lazy', alt: '' })) : fileIcon(),
            controls: h(React.Fragment, null,
              h('a', { className: 'dsh-tasks-image-action dsh-tasks-file-download', href: url(file.attachmentId, true), download: '',
                'aria-label': t('downloadFile') + ': ' + label, title: t('downloadFile') }, h(Icon, { name: 'download', size: 17 })),
              !readOnly ? h(RemoveFileButton, { t, name: label, disabled: locked || !!removal?.pending, onClick: () => remove(file.attachmentId) }) : null),
          })
        }), jobs.map(job => h(PendingFile, { key: 'job:' + job.id, job, taskId: task?.id, t, actions, locked, readOnly }))) : null,
        previewed ? h(TaskImagePreview, { t, src: url(previewed.attachmentId), alt: previewed.name ?? t('images'), native: readOnly, onClose: closePreview }) : null)
    }

    function fieldTitle(icon, text, optional) {
      return h('span', { className: 'dsh-tasks-field-title' }, h(Icon, { name: icon, size: 14 }), text,
        optional ? h('span', { className: 'dsh-tasks-optional' }, optional) : null)
    }

    function PreferenceFields({ t, values, options, change }) {
      const workspace = options.workspaces.find(row => row.id === values.workspaceId)
      const selected = modelKey(values.model)
      const listed = options.groups.some(group => group.id === values.model?.provider && group.models.some(row => row.id === values.model.model))
      return h('div', { className: 'dsh-tasks-bindings' },
        h('label', null, fieldTitle('folder', t('workspace')),
          h(PaperSelect, { t, paperInk: true, className: 'dsh-tasks-stage', name: 'workspaceId', 'aria-label': t('workspace'), value: values.workspaceId || '',
            onChange: event => change('workspaceId', event.target.value) },
          h('option', { value: '' }, t('ungrouped')),
          values.workspaceId && !workspace ? h('option', { value: values.workspaceId }, workspaceLabel(t, values, options)) : null,
          options.workspaces.map(row => h('option', { key: row.id, value: row.id }, row.title))),
          workspace ? h('p', { className: 'dsh-tasks-field-hint dsh-tasks-workspace-path', title: workspace.path }, workspace.path) : null),
        h('label', null, fieldTitle('spark', t('model')),
          h(PaperSelect, { t, paperInk: true, className: 'dsh-tasks-stage', name: 'model', 'aria-label': t('model'), value: selected,
            onChange(event) {
              const key = event.target.value
              if (key === selected) return
              const [provider, model] = key ? JSON.parse(key) : []
              change('model', key ? { provider, model } : undefined)
            } }, h('option', { value: '' }, t('defaultModel')),
          selected && !listed ? h('option', { value: selected }, values.model.model) : null,
          options.groups.map(group => h('optgroup', { key: group.id, label: group.name }, group.models.map(row => h('option', {
            key: row.id, value: JSON.stringify([group.id, row.id]),
          }, row.name))))),
          h('p', { className: 'dsh-tasks-field-hint' }, t('modelHint'))))
    }

    function OptionsFeedback({ t, options, reload }) {
      if (options.status === 'loading') return h('p', { className: 'dsh-tasks-feedback', role: 'status' }, t('optionsLoading'))
      if (options.workspaceStatus === 'ready' && options.modelStatus === 'ready' && !options.modelFailures) return null
      return h('div', { className: 'dsh-tasks-feedback', role: 'status' },
        options.workspaceStatus !== 'ready' ? h('p', null, t('workspaceUnavailable')) : null,
        options.modelStatus !== 'ready' ? h('p', null, t('modelUnavailable')) : null,
        options.modelFailures > 0 ? h('p', null, t('partialModels')) : null,
        h(TaskButton, { className: 'dsh-tasks-retry', type: 'button', onClick: reload }, t('reloadOptions')))
    }

    function TaskPrerequisites({ t, values, change, byId, actions, options, locked, dirty }) {
      const selected = dependencyIds(values)
      const [open, setOpen] = React.useState(false)
      const [focusSelect, setFocusSelect] = React.useState(false)
      const rootRef = React.useRef(null)
      React.useLayoutEffect(() => {
        if (open && focusSelect) {
          setFocusSelect(false)
          rootRef.current?.querySelector('[role="combobox"]')?.focus({ preventScroll: true })
        }
      }, [open, focusSelect])
      const candidates = byId ? [...byId.values()]
        .filter(task => task.id !== values.id && !selected.includes(task.id))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) : []
      if (!selected.length && !open) {
        if (!candidates.length) return null
        return h('div', { className: 'dsh-tasks-disclosure-row' },
          h(TaskButton, {
            className: 'dsh-tasks-disclosure-trigger', ink: false, disabled: locked,
            onClick: () => { setOpen(true); setFocusSelect(true) },
          }, h(Icon, { name: 'link', size: 14 }), h('span', null, t('addPrerequisites')), h(Icon, { name: 'plus', size: 13 })))
      }
      return h('div', { ref: rootRef, className: 'dsh-tasks-prerequisites' },
        h('strong', null, fieldTitle('link', t('dependencyIds'))),
        selected.length ? h('ul', null, selected.map(id => {
          const task = byId?.get(id)
          return h('li', { key: id },
            task && !dirty ? h(TaskButton, { className: 'dsh-tasks-dependency-link', ink: false, onClick: () => actions.openDetails(id) }, task.title)
              : h('span', { title: task ? undefined : id }, task?.title ?? t('dependencyMissing')),
            task ? h('small', null, t(task.delivery?.status === 'pending' ? 'reviewPending' : STAGES[task.stage])) : null,
            h(TaskButton, { className: 'dsh-tasks-icon-button', ink: false, 'aria-label': t('removeDependency') + ': ' + (task?.title ?? id), disabled: locked,
              onClick: () => change('dependencyIds', selected.filter(value => value !== id)) }, h(Icon, { name: 'close', size: 13 })))
        })) : null,
        selected.length < 20 && candidates.length ? h('div', { className: 'dsh-tasks-dependency-chooser' },
          h(PaperSelect, {
            t, paperInk: true, maxVisible: 40, disabled: locked,
            'aria-label': t('addDependency'), name: 'dependency', value: '',
            onChange(event) {
              const id = event.target.value
              if (id && candidates.some(task => task.id === id)) change('dependencyIds', [...selected, id])
            },
          }, h('option', { value: '' }, t('addDependency')),
          candidates.map(task => h('option', { key: task.id, value: task.id }, task.title + ' · ' + workspaceLabel(t, task, options))))) : null)
    }

    function TaskDependents({ t, taskId, stage, byId, actions, dirty }) {
      const dependents = dependentsOf(taskId, byId)
      if (!dependents.length) return null
      const blocking = stage === 'done' ? 0 : dependents.filter(row => row.stage !== 'done').length
      return h('div', { className: 'dsh-tasks-dependents' },
        h('div', { className: 'dsh-tasks-dependents-head' },
          h('strong', null, fieldTitle('link', t('dependentTasks'))),
          blocking > 0 ? h('small', { className: 'dsh-tasks-dependents-badge' }, t('blockingCount').replace('{count}', String(blocking))) : null),
        h('ul', null, dependents.map(row => {
          const statusKey = row.stage === 'done'
            ? (row.delivery?.status === 'accepted' ? 'reviewAccepted' : 'colDone')
            : row.delivery?.status === 'pending' ? 'reviewPending'
              : blockersOf(row, byId).length ? 'dependencyBlocked' : STAGES[row.stage]
          return h('li', { key: row.id },
            !dirty ? h(TaskButton, { className: 'dsh-tasks-dependency-link', ink: false, onClick: () => actions.openDetails(row.id) }, row.title)
              : h('span', null, row.title),
            h('small', null, t(statusKey)))
        })))
    }

    function TaskEditorFields({ t, values, change, options, board, priorities, createLabel, locked, autofocus, draft, revision, resetSignal = 0, dirty, children, byId, actions, showTitle = true }) {
      return h(React.Fragment, null,
        h('fieldset', { className: 'dsh-tasks-fields dsh-tasks-task-fields', disabled: locked },
          showTitle ? h('label', null,
            h('span', { className: 'dsh-tasks-field-title' }, h(Icon, { name: 'edit', size: 14 }), t('taskTitle'),
              h('span', { className: 'dsh-tasks-required', 'aria-hidden': true }, '*')),
            h(TaskInput, {
              name: 'title', paperInk: true, value: values.title, required: true, 'data-modal-autofocus': autofocus ? '' : undefined,
              placeholder: draft ? t('titlePlaceholder') : undefined,
              onChange: event => change('title', event.target.value),
            })) : null,
          h(TaskDescription, { t, brief: values.brief ?? '', change, draft, locked, revision, resetSignal, dirty }),
          h(TaskAcceptanceCriteria, { t, value: values.acceptanceCriteria || '', change, draft, locked, revision, resetSignal, dirty }),
          h('section', { className: 'dsh-tasks-meta-card', 'aria-label': t('sectionProperties') },
            h('div', { className: 'dsh-tasks-meta-card-head' }, t('sectionProperties')),
            board ? h(Properties, { t, board, priorities, createLabel, values, change, paperInk: true }) : null,
            h(PreferenceFields, { t, values, options, change })),
          byId ? h(TaskPrerequisites, { t, values, change, byId, options, actions, locked, dirty: dirty || draft }) : null,
          byId && !draft && values.id ? h(TaskDependents, { t, taskId: values.id, stage: values.stage, byId, actions, dirty }) : null),
        children)
    }

    function CreateForm({ t, form, actions, writable, options, board, jobs, priorities, boardBusy, byId }) {
      const locked = form.pending || !!form.retryInput || boardBusy
      const columns = board?.columns?.length ? board.columns : defaults
      const currentColumn = (form.columnId && columns.find(col => col.id === form.columnId))
        || columns.find(col => col.stage === form.stage) || columns[0]
      const meta = h('div', { className: 'dsh-tasks-detail-meta dsh-tasks-create-meta' },
        h('span', { className: 'dsh-tasks-create-intro' }, t('createIntro')),
        h(ColumnPillSelect, {
          t, columns, current: currentColumn, disabled: locked || !writable,
          labelPrefix: t('createColumn'),
          onSelect(col) {
            if (board?.columns?.length) actions.editForm('columnId', col.id)
            else actions.editForm('stage', col.stage)
          },
        }))
      const submitCreate = () => {
        if (writable && !form.pending && !boardBusy && form.title.trim()) void actions.create()
      }
      return h(TaskDrawer, {
        t, title: t('newTask'), intro: t('createIntro'), meta, onClose: actions.closeForm, editorInk: true,
        onKeyDown(event) {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            submitCreate()
          }
        },
      }, h('form', {
        className: 'dsh-tasks-form', 'aria-label': t('newTask'), 'aria-busy': form.pending,
        onSubmit(event) { event.preventDefault(); void actions.create() },
      },
      h('div', { className: 'dsh-tasks-dialog-body dsh-tasks-detail-panel' },
      h(TaskEditorFields, { t, values: form, change: actions.editForm, options, board, priorities, byId, actions,
        createLabel: actions.editLabels, locked, autofocus: !locked, draft: true, showTitle: true },
        board ? h('fieldset', { className: 'dsh-tasks-attachment-fieldset', disabled: locked },
          h(TaskImages, { t, actions, jobs, locked: locked || !writable })) : null),
      h('input', { type: 'hidden', name: 'stage', value: form.stage }),
      h(OptionsFeedback, { t, options, reload: actions.loadOptions }),
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
          disabled: !writable || form.pending || boardBusy || !form.title.trim(),
        }, t(form.pending ? 'creating' : form.retryInput ? 'retry' : 'create')),
      )))
    }

    function sameCardProps(previous, next) {
      // A new task index alone doesn't change a card. Only its unfinished prerequisites are displayed.
      for (const key of Object.keys(next)) if (key !== 'byId' && !Object.is(previous[key], next[key])) return false
      if (previous.byId === next.byId) return true
      return dependencyIds(next.task).every(id => {
        const before = previous.byId.get(id), after = next.byId.get(id)
        return before === after || before?.stage === after?.stage && (before?.stage === 'done' || before?.title === after?.title)
      })
    }

    function startCardDrag(event, listener) {
      const control = event.target.closest('button, a, details, input, select, textarea, [contenteditable="true"]')
      if (control && !control.matches('.dsh-tasks-card-title, .dsh-tasks-grip')) return
      if (event.button != null && event.button !== 0) return
      listener?.(event)
    }

    function cardToneOf(task, runtime, byId) {
      if (task.stage === 'done') return undefined
      if (runtime === 'error') return 'danger'
      if (runtime === 'approval' || runtime === 'question') return 'warn'
      if (task.delivery?.status === 'pending') return 'action'
      if (task.delivery?.status === 'returned' && !task.delivery.continuedAt) return 'warn'
      if (!task.activeSessionId && blockersOf(task, byId).length) return 'blocked'
      return undefined
    }

    const TaskCard = React.memo(function TaskCard(props) {
      const { t, task, row, actions, draggable, gripVisible, selectMode, selected, onToggleSelect } = props
      const canDrag = draggable && !selectMode
      // Keep dnd-kit's frequently changing context above the memoized card contents.
      const drag = Dnd.useDraggable({ id: task.id, data: { task }, disabled: !canDrag })
      const drop = Dnd.useDroppable({ id: 'card:' + task.id, data: { columnId: taskColumn(task), taskId: task.id }, disabled: !canDrag })
      const { setNodeRef: setDragRef, setActivatorNodeRef, attributes, isDragging } = drag
      const { setNodeRef: setDropRef, isOver } = drop
      const { onMouseDown, onTouchStart, onKeyDown } = drag.listeners ?? {}
      const setNodeRef = React.useCallback(node => { setDragRef(node); setDropRef(node) }, [setDragRef, setDropRef])
      const grip = React.useMemo(() => gripVisible && !selectMode ? h(TaskButton, { type: 'button', className: 'dsh-tasks-grip', elementRef: setActivatorNodeRef,
        ...attributes, disabled: !canDrag, onKeyDown, 'aria-label': t('drag') + ': ' + task.title, title: t('drag') }, h(Icon, { name: 'grip', size: 13 })) : null,
      [gripVisible, selectMode, canDrag, setActivatorNodeRef, attributes, onKeyDown, t, task.title])
      return h(PaperFrame, { seed: task.id, className: 'dsh-tasks-card', 'aria-busy': !!row?.pending, 'data-task-id': task.id, 'data-stage': task.stage,
        'data-card-tone': cardToneOf(task, props.runtime, props.byId),
        'data-select-mode': selectMode || undefined, 'data-selected': selectMode && selected || undefined,
        elementRef: setNodeRef, 'data-dragging': isDragging || undefined, 'data-drop': isOver || undefined,
        'data-draggable': canDrag || undefined,
        onMouseDown: canDrag ? event => startCardDrag(event, onMouseDown) : undefined,
        onTouchStart: canDrag ? event => startCardDrag(event, onTouchStart) : undefined,
        onClick(event) {
          if (event.target.closest('button, details, input, textarea, select, a') || window.getSelection()?.toString()) return
          if (selectMode) { onToggleSelect?.(task.id); return }
          event.currentTarget.querySelector('.dsh-tasks-card-title')?.focus({ preventScroll: true })
          actions.openDetails(task.id)
        } }, h(TaskCardContents, { ...props, draggable: canDrag, gripVisible: gripVisible && !selectMode, grip }))
    }, sameCardProps)

    const TaskCardContents = React.memo(function TaskCardContents({ t, task, row, actions, writable, writing, options, runtime, statusSince, nowTick, board, priorities, draggable, gripVisible, previousId, nextId, byId, today, grip, selectMode, selected, onToggleSelect }) {
      const blockers = blockersOf(task, byId)
      const review = task.delivery?.status === 'pending' || task.delivery?.status === 'returned' && !task.delivery.continuedAt
      const unlinked = inProgressUnlinked(task)
      const action = unfinishedLaunch(task) ? [t('resumeLaunch'), () => actions.openLaunch(task.id), !writable || writing, 'promote']
        : task.stage === 'done' ? null
          : review ? [t('reviewDelivery'), () => actions.openDetails(task.id, 'deliveryTab'), false, 'promote']
            : task.activeSessionId ? [t('viewProgress'), () => actions.openSession(task.activeSessionId), false, 'neutral']
              : blockers.length ? [t('inspectDependencies'), () => actions.openDetails(task.id), false, 'neutral']
                : [t(unlinked ? 'createConversation' : 'launch'), () => actions.openLaunch(task.id), !writable || writing, 'promote']
      const badge = task.stage === 'done' ? task.delivery?.status === 'accepted' ? 'reviewAccepted' : 'colDone'
        : unfinishedLaunch(task) ? 'launchPending'
          : review ? task.delivery.status === 'pending' ? 'reviewPending' : 'reviewReturned'
            : !task.activeSessionId ? blockers.length ? 'dependencyBlocked' : unlinked ? 'unlinkedConversation' : 'dependencyReady' : runtime
      const runningElapsed = badge === 'running' && statusSince ? formatElapsed(t, statusSince, nowTick) : ''
      const feedbackId = 'dsh-tasks-feedback-' + task.id
      const workspace = workspaceLabel(t, task, options)
      const isOverdue = task.stage !== 'done' && task.dueDate && task.dueDate < today
      const fileCount = task.fileCount ?? task.imageCount
      const { brief: cardBrief, externalLink } = React.useMemo(() => parseCardBrief(task.brief), [task.brief])
      return h(React.Fragment, null,
        h('div', { className: 'dsh-tasks-card-heading' },
          grip,
          selectMode ? h('span', { className: 'dsh-tasks-card-select', 'aria-hidden': true }, selected ? h(Icon, { name: 'check', size: 11 }) : null) : null,
          // The shared small Button has a fixed block size: a wrapped title needs its own intrinsic height.
          h('button', { type: 'button', className: 'dsh-tasks-card-title', title: task.title,
            'aria-pressed': selectMode ? !!selected : undefined,
            onClick: () => selectMode ? onToggleSelect?.(task.id) : actions.openDetails(task.id) },
          task.stage === 'done' ? h('span', { className: 'dsh-tasks-done-check', 'aria-hidden': true }, h(Icon, { name: 'check', size: 13 })) : null,
          h('span', { className: 'dsh-tasks-card-title-text' }, task.title)),
          h(Dropdown, { className: 'dsh-tasks-card-actions', name: 'dsh-tasks-card-actions',
            onKeyDown(event) {
              if (event.key !== 'Escape') return
              event.currentTarget.removeAttribute('open')
              event.currentTarget.querySelector('summary').focus()
            },
          },
            h('summary', { className: 'dsh-tasks-icon-button', 'aria-label': t('moreTask') + ': ' + task.title }, h(Icon, { name: 'more' })),
            h('div', { className: 'dsh-tasks-menu dsh-tasks-command-list', popover: 'manual' },
              canStartNewConversation(task) ? h(TaskButton, { className: 'dsh-tasks-command', disabled: !writable || writing || !!row,
                onClick(event) {
                  const menu = event.currentTarget.closest('details')
                  menu.open = false
                  menu.querySelector('summary')?.focus()
                  actions.openLaunch(task.id, { newConversation: true })
                },
              }, h(Icon, { name: 'plus', size: 14 }), t('newSession')) : null,
              task.activeSessionId ? h(TaskButton, { className: 'dsh-tasks-command', onClick: () => actions.openSession(task.activeSessionId) },
                h(Icon, { name: 'link', size: 14 }), t('openSession')) : null,
              task.stage !== 'done' && !unfinishedLaunch(task) && !deliveryOpen(task) ? h(TaskButton, { className: 'dsh-tasks-command', disabled: !writable || writing || !!row,
                onClick(event) { event.currentTarget.closest('details').open = false; void actions.setStage(task.id, 'done') } },
              h(Icon, { name: 'check', size: 14 }), t('markDone')) : null,
              h('div', { className: 'dsh-tasks-menu-label' }, t('moveGroup')),
              (board?.columns || defaults).map(column => h(TaskButton, {
                key: column.id, type: 'button', disabled: !writable || writing || !!row || taskColumn(task) === column.id || column.stage === 'done' && deliveryOpen(task),
                className: 'dsh-tasks-command', 'data-current': taskColumn(task) === column.id || undefined, title: t('manualStage'),
                onClick(event) {
                  event.currentTarget.closest('details').removeAttribute('open')
                  if (board) void actions.move({ taskId: task.id, expectedRevision: task.revision, columnId: column.id })
                  else void actions.setStage(task.id, column.stage)
                },
              }, h(Icon, { name: taskColumn(task) === column.id ? 'check' : 'chevron', size: 12 }), t('moveTo') + ' ' + columnLabel(t, column))),
              gripVisible && (previousId || nextId) ? h('div', { className: 'dsh-tasks-command-group' }, h('div', { className: 'dsh-tasks-menu-label' }, t('reorder')),
                [[previousId, 'before', 'earlier'], [nextId, 'after', 'later']].map(([neighborId, side, label]) => h(TaskButton, {
                key: side, className: 'dsh-tasks-command', disabled: !draggable || !neighborId, onClick(event) { event.currentTarget.closest('details').open = false
                  void actions.move({ taskId: task.id, expectedRevision: task.revision, columnId: taskColumn(task), anchor: { taskId: neighborId, side } }) },
              }, h(Icon, { name: side === 'before' ? 'up' : 'down', size: 14 }), t(label)))) : null,
              h(TaskButton, { className: 'dsh-tasks-command dsh-tasks-danger', disabled: !writable || writing,
                onClick(event) { event.currentTarget.closest('details').removeAttribute('open'); actions.openDelete(task.id) },
              }, h(Icon, { name: 'trash', size: 14 }), t('deleteTask')),
            ),
          ),
        ),
        cardBrief ? h('div', { className: 'dsh-tasks-card-brief', title: cardBrief }, cardBrief) : null,
        h('div', { className: 'dsh-tasks-card-meta dsh-tasks-card-properties' },
          (board?.labels ?? []).filter(row => row.id === task.labelId).map(row => h(Tag, { key: row.id, className: 'dsh-tasks-label-tag' }, h('span', { title: row.name, 'data-label-chip': '', style: { borderInlineStart: '4px solid ' + row.color, paddingInlineStart: 4 } }, row.name))),
          task.priority ? h(Tag, { tone: task.priority === 'P0' ? 'warning' : 'neutral', className: 'dsh-tasks-priority-tag', 'data-priority': task.priority },
            h('span', { title: task.priority, 'data-priority': task.priority }, priorityLabel(priorities, task.priority))) : null,
          externalLink ? h('a', {
            key: 'ext-link',
            className: 'dsh-tasks-card-extlink',
            href: externalLink.url,
            title: externalLink.label + ': ' + externalLink.url,
            target: '_blank',
            rel: 'noopener noreferrer',
            onClick(event) {
              event.stopPropagation()
              taskMarkdownDelegate.openExternalLink(externalLink.url)
            }
          }, h('span', null, externalLink.label), h('span', { className: 'dsh-tasks-extlink-arrow', 'aria-hidden': true }, '↗')) : null,
          task.dueDate ? h('span', { className: 'dsh-tasks-card-due', 'data-overdue': isOverdue || undefined }, h(Icon, { name: 'calendar', size: 12 }), h('span', null, t(isOverdue ? 'overdue' : 'dueDate') + ': ' + task.dueDate)) : null),
        task.snippet ? h('p', { className: 'dsh-tasks-card-brief dsh-tasks-match-snippet', title: task.snippet }, t('comment') + ': ' + task.snippet) : null,
        blockers.length && task.stage !== 'done' ? h('div', { className: 'dsh-tasks-card-blockers', 'aria-label': t('dependencyBlocked') },
          h(Icon, { name: 'link', size: 12 }), blockers.slice(0, 2).map(id => {
            const prerequisite = byId.get(id)
            return prerequisite ? h(TaskButton, { key: id, className: 'dsh-tasks-dependency-link', title: prerequisite.title,
              onClick: () => actions.openDetails(id) }, h('span', { className: 'dsh-tasks-dependency-title' }, prerequisite.title)) : h('span', { key: id, className: 'dsh-tasks-dependency-title', title: id }, t('dependencyMissing'))
          }), blockers.length > 2 ? h('span', { className: 'dsh-tasks-blocker-more' }, '+' + (blockers.length - 2)) : null) : null,
        h('div', { className: 'dsh-tasks-card-footer' },
          h('div', { className: 'dsh-tasks-card-context' },
            h(StatusBadge, { status: task.stage === 'done' ? 'done' : badge, label: t(badge),
              elapsed: runningElapsed || undefined,
              time: task.stage === 'done' ? task.completedAt && relativeTime(t, task.completedAt) : undefined }),
            h('div', { className: 'dsh-tasks-card-meta' },
              h(Icon, { name: 'folder', size: 12 }), h('span', { className: 'dsh-tasks-meta-workspace', title: workspace }, workspace),
              task.model ? h('span', { className: 'dsh-tasks-meta-model', title: modelLabel(task, options) }, '· ' + modelLabel(task, options)) : null),
            fileCount || task.commentCount ? h('div', { className: 'dsh-tasks-card-counts' },
              fileCount ? h('span', { className: 'dsh-tasks-meta-count', title: t('files') + ': ' + fileCount, 'aria-label': t('files') + ': ' + fileCount },
                h(Icon, { name: 'paperclip', size: 11 }), h('span', null, String(fileCount))) : null,
              task.commentCount ? h('span', { className: 'dsh-tasks-meta-count', title: t('comment') + ': ' + task.commentCount, 'aria-label': t('comment') + ': ' + task.commentCount },
                h(Icon, { name: 'comment', size: 11 }), h('span', null, String(task.commentCount))) : null) : null),
          action ? h('div', { className: 'dsh-tasks-card-buttons' }, h(TaskButton, {
            className: 'dsh-tasks-retry dsh-tasks-card-action-btn', disabled: action[2], onClick: action[1], 'data-task-next-action': '', 'data-action-tone': action[3],
          }, action[0])) : null),
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
    }, sameCardProps)

    const ColumnCards = React.memo(function ColumnCards({ tasks, stage, sortBy, recentOnly, empty, stages, statuses, selectMode, selectedIds, onToggleSelect, nowTick, ...props }) {
      const visible = stage === 'done' && sortBy === 'manual'
        ? [...tasks].sort((a, b) => (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt)).slice(0, recentOnly ? DONE_PREVIEW : tasks.length)
        : recentOnly ? [...tasks].sort((a, b) => (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt)).slice(0, DONE_PREVIEW) : tasks
      const renderCard = (task, index, list) => {
        const entry = task.activeSessionId && statuses[task.id]?.sessionId === task.activeSessionId ? statuses[task.id] : undefined
        return h(TaskCard, {
          ...props, key: task.id, task, row: stages[task.id],
          previousId: list[index - 1]?.id, nextId: list[index + 1]?.id,
          runtime: entry ? entry.status : task.activeSessionId ? 'unknown' : 'notStarted',
          statusSince: entry?.since, nowTick: entry?.status === 'running' ? nowTick : undefined, selectMode,
          selected: !!selectedIds?.has(task.id), onToggleSelect,
        })
      }
      if (stage === 'done' && visible.length) {
        const weekStart = weekStartLocal(props.today)
        const buckets = new Map([['today', []], ['thisWeek', []], ['earlier', []]])
        for (const task of visible) buckets.get(doneTimeBucket(task, props.today, weekStart)).push(task)
        const labels = { today: 'doneGroupToday', thisWeek: 'doneGroupWeek', earlier: 'doneGroupEarlier' }
        return h('div', { className: 'dsh-tasks-collist' }, [...buckets].filter(([, rows]) => rows.length).map(([bucket, rows]) =>
          h(React.Fragment, { key: bucket },
            h('div', { className: 'dsh-tasks-done-group-head', 'data-done-group': bucket },
              h('span', null, props.t(labels[bucket])), h('small', null, rows.length)),
            rows.map((task, index) => renderCard(task, index, rows)))))
      }
      return h('div', { className: 'dsh-tasks-collist' }, visible.length
        ? visible.map((task, index) => renderCard(task, index, visible))
        : h('p', { className: 'dsh-tasks-empty' }, empty))
    })

    /** Counts show search matches / total; the actual classification is saved. */
    function Column({ t, column, board, stage, name, empty, ready, tasks, total, filtered, sortBy = 'manual', stages, actions, writable, writing, options, collapsed, showAllDone, statuses, priorities, byId, allowCollapse, today, workspaceFilter, selectMode, selectedIds, onToggleSelect, nowTick }) {
      const recentOnly = stage === 'done' && tasks.length > DONE_PREVIEW && !filtered && !showAllDone
      const gripVisible = !!board && !filtered && !recentOnly && sortBy === 'manual'
      const draggable = gripVisible && writable && !writing
      const canOrder = !!board && writable && !writing
      const drop = Dnd.useDroppable({ id: column.id, data: { columnId: column.id, boardColumn: true, name, acceptsTasks: !filtered && !collapsed }, disabled: !board })
      const order = Dnd.useDraggable({ id: 'order:' + column.id, data: { column: { id: column.id, revision: board?.revision, title: name } }, disabled: !canOrder })
      const ordering = !!drop.active?.data.current?.column
      const collision = Dnd.useDndContext().collisions?.[0]
      const insert = ordering && collision?.id === column.id && collision.data?.changed ? collision.data.side : undefined
      const keyFocus = React.useRef(null)
      const [quickOpen, setQuickOpen] = React.useState(false)
      const [quickTitle, setQuickTitle] = React.useState('')
      const [quickError, setQuickError] = React.useState('')
      const [quickBusy, setQuickBusy] = React.useState(false)
      const quickInputRef = React.useRef(null)
      const addButtonRef = React.useRef(null)
      React.useEffect(() => {
        if (collapsed && quickOpen) { setQuickOpen(false); setQuickError('') }
      }, [collapsed, quickOpen])
      React.useEffect(() => {
        if (quickOpen) quickInputRef.current?.focus({ preventScroll: true })
      }, [quickOpen])
      const closeQuick = () => {
        setQuickOpen(false)
        setQuickError('')
        window.queueMicrotask?.(() => addButtonRef.current?.focus({ preventScroll: true }))
      }
      const submitQuick = async event => {
        event.preventDefault()
        if (quickBusy || !writable || writing) return
        if (!quickTitle.trim()) { setQuickError(t('titleRequired')); return }
        setQuickBusy(true)
        setQuickError('')
        const result = await actions.quickCreate({ title: quickTitle, stage, columnId: board ? column.id : undefined })
        setQuickBusy(false)
        if (result?.ok) {
          setQuickTitle('')
          window.queueMicrotask?.(() => quickInputRef.current?.focus({ preventScroll: true }))
        } else {
          setQuickError(failureText(t, result?.errorCode || 'tasks/create-failed', 'createFailed'))
        }
      }
      const scopedWsLabel = workspaceFilter && workspaceFilter !== 'ungrouped'
        ? workspaceLabel(t, { workspaceId: workspaceFilter }, options) : ''
      React.useEffect(() => {
        if (writing || !keyFocus.current) return
        const button = keyFocus.current
        keyFocus.current = null
        if (!button.isConnected || button.disabled) return
        const focused = button.ownerDocument.activeElement
        if (focused !== button && focused !== button.ownerDocument.body) return
        button.focus({ preventScroll: true })
        button.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      })
      function handleColumnKey(event) {
        if (!canOrder || !['ArrowLeft', 'ArrowRight'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
        event.preventDefault()
        const rtl = window.getComputedStyle(event.currentTarget).direction === 'rtl'
        const step = (event.key === 'ArrowRight') !== rtl ? 1 : -1
        const index = board.columns.findIndex(row => row.id === column.id)
        const target = board.columns[index + step]
        if (target) {
          keyFocus.current = event.currentTarget
          void reorderColumn(board, actions, column.id, target.id, step > 0 ? 'after' : 'before', board.revision)
        }
      }
      const doneRange = !collapsed && !filtered && stage === 'done' && tasks.length > DONE_PREVIEW ? h(TaskButton, { className: 'dsh-tasks-done-range',
        'aria-pressed': !!showAllDone, title: t(showAllDone ? 'showRecent' : 'showAll') + ' · ' + tasks.length,
        onClick: () => actions.toggleDone(column.id) }, h(Icon, { name: showAllDone ? 'up' : 'down', size: 13 }), t(showAllDone ? 'showRecent' : 'showAll') + (showAllDone ? '' : ' ' + tasks.length)) : null
      return h(
        'section',
        { ref: drop.setNodeRef, className: 'dsh-tasks-col', 'aria-label': name, 'data-stage': stage, 'data-column-id': column.id, 'data-collapsed': collapsed || undefined,
          'data-column-color': column.color ? '' : undefined, style: column.color ? { '--dsh-tasks-col-color': column.color } : undefined,
          'data-drop': !ordering && drop.isOver || undefined, 'data-column-insert': insert,
          'data-column-dragging': order.isDragging || undefined },
        h(
          'div',
          { ref: order.setNodeRef, className: 'dsh-tasks-colhead' },
          board ? h(TaskButton, { className: 'dsh-tasks-icon-button dsh-tasks-column-grip', elementRef: order.setActivatorNodeRef, disabled: !canOrder,
            onMouseDown: order.listeners?.onMouseDown, onTouchStart: order.listeners?.onTouchStart, onKeyDown: handleColumnKey,
            'aria-keyshortcuts': 'ArrowLeft ArrowRight', 'aria-label': t('dragColumn') + ': ' + name, title: t('dragColumnHint'),
            onClick: () => actions.showColumns(column.id) }, h(Icon, { name: 'grip', size: 16 })) : null,
          h(TaskButton, { type: 'button', className: 'dsh-tasks-coltitle', 'aria-expanded': !collapsed, 'aria-disabled': !allowCollapse || undefined,
            onClick: () => { if (allowCollapse) actions.toggleColumn(board ? column.id : stage, !collapsed) } }, h('span', { className: 'dsh-tasks-colname' }, name),
          h('span', { className: 'dsh-tasks-count', title: t('countLabel') },
            ready ? filtered ? tasks.length + ' / ' + total : String(total) : '—')),
          !collapsed && board ? h(TaskButton, { type: 'button', className: 'dsh-tasks-icon-button dsh-tasks-col-rename', 'aria-label': t('rename') + ': ' + name, title: t('rename') + ': ' + name, onClick: () => actions.showColumns(column.id) }, h(Icon, { name: 'edit', size: 14 })) : null,
          !collapsed ? h(TaskButton, { type: 'button', className: 'dsh-tasks-icon-button', 'aria-label': t('add') + ': ' + name, title: t('add') + ': ' + name,
            onClick: () => actions.openForm(stage, board && column.id) }, h(Icon, { name: 'plus' })) : null,
        ),
        !collapsed ? h(ColumnCards, { tasks, stage, sortBy, recentOnly, empty, stages, statuses, t, actions, writable, writing,
          options, board, priorities, draggable, gripVisible, byId, today, selectMode, selectedIds, onToggleSelect, nowTick }) : null,
        !collapsed ? h('div', { className: 'dsh-tasks-colfoot', 'data-has-range': doneRange ? '' : undefined },
          doneRange,
          quickOpen ? h('form', { className: 'dsh-tasks-quick-create', onSubmit: submitQuick },
            h('input', {
              ref: quickInputRef, type: 'text', className: 'dsh-tasks-quick-input', maxLength: 200,
              value: quickTitle, disabled: quickBusy, placeholder: t('quickAddPlaceholder'), 'aria-label': t('add') + ': ' + name,
              onChange: event => { setQuickTitle(event.target.value); if (quickError) setQuickError('') },
              onKeyDown: event => {
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeQuick() }
              },
            }),
            scopedWsLabel ? h('div', { className: 'dsh-tasks-quick-scope' }, h(Icon, { name: 'folder', size: 11 }), h('span', null, scopedWsLabel)) : null,
            quickError ? h('p', { className: 'dsh-tasks-quick-error', role: 'alert' }, quickError) : null,
            h('div', { className: 'dsh-tasks-quick-actions' },
              h(TaskButton, { type: 'submit', className: 'dsh-tasks-primary dsh-tasks-quick-submit', disabled: !quickTitle.trim() || quickBusy || !writable || writing },
                t(quickBusy ? 'quickAddAdding' : 'quickAddSubmit')),
              h(TaskButton, { type: 'button', className: 'dsh-tasks-secondary dsh-tasks-quick-cancel', disabled: quickBusy, onClick: closeQuick }, t('cancelDelete')),
              h('button', {
                type: 'button', className: 'dsh-tasks-quick-expand', disabled: quickBusy,
                onClick: () => {
                  const draftTitle = quickTitle.trim()
                  setQuickOpen(false); setQuickTitle(''); setQuickError('')
                  actions.openForm(stage, board && column.id, draftTitle)
                },
              }, t('expandCreateForm'))))
            : h(TaskButton, {
              type: 'button', className: 'dsh-tasks-add', elementRef: addButtonRef,
              onClick: () => { setQuickOpen(true); setQuickError('') },
            }, h(Icon, { name: 'plus' }), t('add'))) : null,
      )
    }

    const BoardColumn = React.memo(Column)

    function Activity({ t, task, board, actions, activity, draft, writable, navigationLocked = false }) {
      const [onlyComments, setOnlyComments] = React.useState(false)
      const [composerOpen, setComposerOpen] = React.useState(false)
      const [expandedIds, setExpandedIds] = React.useState(() => new Set())
      const commentRef = React.useRef(null)
      const hasDraft = !!(draft?.text || '').trim()
      const showExpanded = composerOpen || !!draft?.text || !!draft?.error || !!draft?.requestId || !!draft?.pending
      useAutoGrowTextArea(commentRef, showExpanded, draft?.text || '')
      const kinds = { created: ['eventCreated', 'plus'], updated: ['eventUpdated', 'edit'], moved: ['eventMoved', 'move'],
        completed: ['eventCompleted', 'check'], reopened: ['eventReopened', 'refresh'], bound: ['eventBound', 'link'], comment: ['comment', 'comment'],
        'image-added': ['imageAdded', 'paperclip'], 'image-removed': ['imageRemoved', 'trash'], 'file-added': ['fileAdded', 'paperclip'], 'file-removed': ['fileRemoved', 'trash'],
        'delivery-submitted': ['eventDeliverySubmitted', 'check'], 'delivery-accepted': ['eventDeliveryAccepted', 'check'],
        'delivery-returned': ['eventDeliveryReturned', 'comment'], 'delivery-continued': ['eventDeliveryContinued', 'link'] }
      const contentKinds = new Set(['comment', 'delivery-submitted', 'delivery-accepted', 'delivery-returned', 'delivery-continued'])
      const sources = { rpc: 'activityRpc', service: 'activityService', agent: 'activityAgent' }
      const name = id => {
        const column = board.columns.find(row => row.id === id) || defaults.find(row => row.id === id)
        return column ? columnLabel(t, column) : t('unknownColumn')
      }
      const fields = { title: 'taskTitle', brief: 'taskBrief', workspaceId: 'workspace', model: 'model',
        ...Object.fromEntries([...metaKeys, ...checklistKeys].map(key => [key, key])) }
      const language = window.document.documentElement.lang || undefined
      const dateLabel = new Intl.DateTimeFormat(language, { dateStyle: 'long' })
      const timeLabel = new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit' })
      const fullTime = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'medium' })
      const localDay = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      const now = new Date(), today = localDay(now)
      now.setDate(now.getDate() - 1)
      const yesterday = localDay(now), days = []
      for (const event of activity?.events ?? []) {
        if (onlyComments && event.kind !== 'comment') continue
        const date = new Date(event.at), day = localDay(date)
        if (days.at(-1)?.day !== day) days.push({ day, label: dateLabel.format(date), events: [] })
        days.at(-1).events.push({ event, date })
      }
      const loadFailed = activity?.error === 'latest'
      const toggleExpand = id => setExpandedIds(prev => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      return h(React.Fragment, null,
        h('form', {
          className: 'dsh-tasks-fields dsh-tasks-comment-form',
          'data-collapsed': !showExpanded ? '' : undefined,
          onSubmit(event) { event.preventDefault(); void actions.postComment(task.id) },
          onBlur(event) {
            if (!event.currentTarget.contains(event.relatedTarget) && !draft?.text && !draft?.error && !draft?.pending && !draft?.requestId) {
              setComposerOpen(false)
            }
          },
        },
          h('label', { className: 'dsh-tasks-comment-field' },
            showExpanded ? fieldTitle('comment', t('comment')) : h('span', { className: 'dsh-tasks-sr-only' }, t('comment')),
            h(TaskTextArea, {
              name: 'comment', inputRef: commentRef, maxLength: 4000, rows: showExpanded ? 2 : 1, paperInk: true,
              value: draft?.text || '', disabled: !!draft?.requestId, placeholder: t('commentPlaceholder'),
              onFocus: () => setComposerOpen(true),
              onChange: event => actions.editComment(task.id, event.target.value),
              onKeyDown(event) {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  event.stopPropagation()
                  if (writable && hasDraft && !draft?.pending) void actions.postComment(task.id)
                } else if (event.key === 'Escape' && !draft?.text && !draft?.error && !draft?.requestId && !draft?.pending) {
                  event.preventDefault()
                  event.stopPropagation()
                  setComposerOpen(false)
                  event.currentTarget.blur()
                }
              },
            })),
          draft?.error ? h('p', { role: 'alert' }, t('commentFailed')) : null,
          showExpanded ? h('div', { className: 'dsh-tasks-comment-actions' },
            h('span', { className: 'dsh-tasks-field-hint' }, t('commentShortcut')),
            !draft?.text && !draft?.error && !draft?.pending && !draft?.requestId ? h(TaskButton, {
              type: 'button', ink: false, className: 'dsh-tasks-secondary dsh-tasks-comment-cancel',
              onClick: () => setComposerOpen(false),
            }, t('cancelDelete')) : null,
            h(TaskButton, { type: 'submit', className: 'dsh-tasks-primary', disabled: !writable || !hasDraft, loading: draft?.pending }, t(draft?.error ? 'retry' : 'post'))) : null),
        h('div', { className: 'dsh-tasks-activity-header' },
          h('h3', null, h(Icon, { name: 'clock', size: 16 }), t('activityHeading')),
          h('div', { className: 'dsh-tasks-activity-filters dsh-tasks-segmented', role: 'group', 'aria-label': t('activityHeading') },
            h('button', { type: 'button', 'aria-pressed': !onlyComments, onClick: () => setOnlyComments(false) }, t('activityAll')),
            h('button', { type: 'button', 'aria-pressed': onlyComments, onClick: () => setOnlyComments(true) }, t('activityComments')))),
        loadFailed ? h('div', { className: 'dsh-tasks-activity-controls' },
          h('p', { className: 'dsh-tasks-activity-message', role: 'alert' }, t(activity.events?.length ? 'historyRefreshFailed' : 'historyFailed')),
          h(TaskButton, { onClick: () => actions.loadHistory() }, t('retry'))) : null,
        !days.length && !loadFailed ? h('p', { className: 'dsh-tasks-activity-empty', role: 'status' },
          t(!activity || activity.loading === 'latest' ? 'historyLoading' : onlyComments ? 'noActivityComments' : 'historyEmpty')) : null,
        days.map(({ day, label, events }) => h(React.Fragment, { key: day },
          h('h4', { className: 'dsh-tasks-activity-day' }, day === today ? t('activityToday') : day === yesterday ? t('activityYesterday') : null,
            h('time', { dateTime: day }, label)),
          h('ol', { className: 'dsh-tasks-activity', role: 'list', 'aria-label': label }, events.map(({ event, date }) => {
            const [labelKey, icon] = kinds[event.kind] ?? ['activity', 'clock']
            const isContent = contentKinds.has(event.kind)
            const isDelivery = event.kind.startsWith('delivery-')
            const detailText = event.from && event.to ? name(event.from) + ' → ' + name(event.to) : event.name
            const timeMeta = h('span', { className: 'dsh-tasks-activity-meta' },
              h('time', { dateTime: event.at, title: fullTime.format(date) }, timeLabel.format(date)),
              h('span', { 'aria-hidden': true }, '·'), h('span', null, t(sources[event.source])))
            if (!isContent) {
              return h('li', { key: event.id, 'data-kind': event.kind, 'data-tier': 'system', 'data-activity-id': event.id },
                h('span', { className: 'dsh-tasks-activity-marker', 'aria-hidden': true }, h(Icon, { name: icon, size: 13 })),
                h('div', { className: 'dsh-tasks-activity-row' },
                  h('div', { className: 'dsh-tasks-activity-row-main' },
                    h('strong', null, t(labelKey)),
                    detailText ? h('span', { className: 'dsh-tasks-activity-inline' }, detailText) : null,
                    event.sessionId ? h(SessionChip, { t, sessionId: event.sessionId, disabled: navigationLocked, onOpen: actions.openSession }) : null,
                    event.fields?.length ? h('ul', { className: 'dsh-tasks-activity-fields' },
                      event.fields.map(key => h('li', { key }, fields[key] ? t(fields[key]) : key))) : null),
                  timeMeta))
            }
            const isLong = isDelivery && !!event.text && (event.text.length > 140 || event.text.split('\n').length > 3)
            const expanded = expandedIds.has(event.id)
            return h('li', { key: event.id, 'data-kind': event.kind, 'data-tier': 'content', 'data-activity-id': event.id },
              h('span', { className: 'dsh-tasks-activity-marker', 'aria-hidden': true }, h(Icon, { name: icon, size: 14 })),
              h('div', { className: 'dsh-tasks-activity-entry' },
                h('div', { className: 'dsh-tasks-activity-event' },
                  h('div', { className: 'dsh-tasks-activity-event-title' },
                    h('strong', null, t(labelKey)),
                    event.sessionId ? h(SessionChip, { t, sessionId: event.sessionId, disabled: navigationLocked, onOpen: actions.openSession }) : null),
                  timeMeta),
                event.text ? h(TaskMarkdown, { t, text: event.text, className: 'dsh-tasks-activity-comment' + (isLong && !expanded ? ' is-clamped' : '') }) : null,
                isDelivery ? h('div', { className: 'dsh-tasks-activity-card-actions' },
                  isLong ? h(TaskButton, { type: 'button', ink: false, className: 'dsh-tasks-activity-link', onClick: () => toggleExpand(event.id) },
                    t(expanded ? 'showLess' : 'showMore')) : null,
                  h(TaskButton, { type: 'button', ink: false, className: 'dsh-tasks-activity-link', onClick: () => actions.setDetailView('deliveryTab') },
                    t('viewDelivery') + ' →')) : null))
          })))),
        activity?.before ? h('div', { className: 'dsh-tasks-activity-controls' },
          activity.error === 'older' ? h('p', { className: 'dsh-tasks-activity-message', role: 'alert' }, t('historyMoreFailed')) : null,
          h(TaskButton, { disabled: activity.loading === 'latest', loading: activity.loading === 'older', onClick: () => actions.loadHistory(true) },
            t(activity.loading === 'older' ? 'historyLoading' : activity.error === 'older' ? 'retry' : 'older'))) : null)
    }
    function DetailConfirmation({ t, reload, onKeep, onDiscard, restoreFocus, disabled }) {
      const id = React.useId(), accepted = React.useRef(false)
      return h(Modal, { t, paper: true, alertId: id, className: 'dsh-tasks-confirm-dialog', title: t(reload ? 'reloadDetails' : 'unsavedDetails'),
        onClose: onKeep, restoreFocus: opener => restoreFocus(accepted.current ? null : opener) },
        h('div', { className: 'dsh-tasks-dialog-body' }, h('p', { id: id + '-description', className: 'dsh-tasks-dialog-note' }, t(reload ? 'discardReload' : 'discardDetails'))),
        h('div', { className: 'dsh-tasks-form-actions' },
          h(TaskButton, { 'data-dsh-initial-focus': '', onClick: onKeep }, t('keepEditing')),
          h(TaskButton, { className: 'dsh-tasks-primary dsh-tasks-danger', disabled, onClick(event) {
            if (disabled) return
            accepted.current = true
            // Release native inertness before the drawer's unmount restores its original opener.
            event.currentTarget.closest('dialog').close()
            onDiscard()
          } }, t(reload ? 'reloadDetails' : 'discardClose'))))
    }

    function DeliverySection({ t, task, status, actions, busy, navigationLocked, mutation, launchLabel, onLaunch }) {
      const delivery = task.delivery
      const [returning, setReturning] = React.useState(false)
      const [feedback, setFeedback] = React.useState('')
      const pending = delivery?.status === 'pending'
      const returned = delivery?.status === 'returned'
      const statusKey = pending ? 'reviewPending' : returned ? 'reviewReturned' : 'reviewAccepted'
      const bannerTone = !delivery ? 'empty' : pending ? 'pending' : returned ? 'returned' : 'accepted'
      const formatted = date => new Date(date).toLocaleString()
      const trivialRemaining = /^(?:无|暂无|none|n\/a)[。.\s]*$/i.test((delivery?.remaining || '').trim())
      const evidenceCard = (key, text, icon, { callout = false } = {}) => text ? h('section', {
        className: 'dsh-tasks-evidence-card' + (callout ? ' dsh-tasks-evidence-callout' : ''),
      },
        h('h4', null, h(Icon, { name: icon, size: 14 }), t(key)),
        h(TaskMarkdown, { t, text })) : null
      const links = (delivery?.links ?? []).flatMap(link => {
        const url = evidenceUrl(link.url)
        return url ? [{ ...link, url }] : []
      })
      const snapshotMismatch = !!(delivery?.criteria && delivery.criteria !== task.acceptanceCriteria)
      return h('section', { className: 'dsh-tasks-delivery-section', 'aria-label': t('deliveryHeading'), 'aria-busy': !!mutation?.pending },
        h('div', { className: 'dsh-tasks-delivery-banner', 'data-tone': bannerTone },
          delivery ? h('div', { className: 'dsh-tasks-delivery-banner-info' },
            h(StatusBadge, { status: statusKey, label: t(statusKey), paperInk: true }),
            h('div', { className: 'dsh-tasks-delivery-times' },
              h('span', null, t('deliverySubmittedAt') + ' ', h('time', { dateTime: delivery.submittedAt }, formatted(delivery.submittedAt))),
              delivery.reviewedAt ? h('span', null, '· ' + t('deliveryReviewedAt') + ' ', h('time', { dateTime: delivery.reviewedAt }, formatted(delivery.reviewedAt))) : null))
            : h('div', { className: 'dsh-tasks-delivery-banner-info' },
              h('span', { className: 'dsh-tasks-delivery-runtime-label' }, t('deliveryRuntime')),
              h(StatusBadge, { status, label: t(status), paperInk: true })),
          h('div', { className: 'dsh-tasks-delivery-banner-actions' },
            delivery && task.activeSessionId && status !== 'idle' ? h(StatusBadge, { status, label: t(status), paperInk: true }) : null,
            task.activeSessionId ? h(TaskButton, { className: 'dsh-tasks-retry', disabled: navigationLocked, onClick: () => actions.openSession(task.activeSessionId) }, t('openSession'))
              : !delivery && launchLabel ? h(TaskButton, { className: 'dsh-tasks-primary', disabled: busy, onClick: onLaunch }, t(launchLabel)) : null)),
        snapshotMismatch ? evidenceCard('deliveryCriteriaSnapshot', delivery.criteria, 'check') : null,
        task.acceptanceCriteria ? h('details', { className: 'dsh-tasks-delivery-criteria', open: pending && !snapshotMismatch ? true : undefined },
          h('summary', null, h(Icon, { name: 'check', size: 14 }), h('span', null, t('deliveryCriteriaRef')), h(Icon, { name: 'chevronDown', size: 14 })),
          h('div', { className: 'dsh-tasks-delivery-criteria-body' }, h(TaskMarkdown, { t, text: task.acceptanceCriteria }))) : null,
        delivery ? h(React.Fragment, null,
          evidenceCard('deliveryEvidence', delivery.summary, 'file'),
          evidenceCard('deliveryVerification', delivery.verification, 'check'),
          evidenceCard('deliveryUnverified', delivery.remaining, 'alert', { callout: !trivialRemaining }),
          links.length ? h('section', { className: 'dsh-tasks-evidence-card' },
            h('h4', null, h(Icon, { name: 'link', size: 14 }), t('deliveryLinksHeading')),
            h('ul', { className: 'dsh-tasks-evidence-links' }, links.map((link, index) => h('li', { key: index },
              h('a', { href: link.url, title: link.url, target: '_blank', rel: 'noopener noreferrer' },
                h(Icon, { name: 'link', size: 13 }), h('span', null, link.label), h(Icon, { name: 'externalLink', size: 12 })))))) : null,
          evidenceCard('deliveryFeedback', delivery.feedback, 'comment'),
          pending && returning ? h('label', { className: 'dsh-tasks-review-input' }, fieldTitle('comment', t('deliveryFeedback')), h(TaskTextArea, {
            rows: 3, maxLength: 4000, paperInk: true, value: feedback, disabled: busy, name: 'reviewFeedback', placeholder: t('deliveryFeedbackHint'),
            onChange: event => setFeedback(event.target.value),
            onKeyDown(event) {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing && !busy && feedback.trim()) {
                event.preventDefault()
                event.stopPropagation()
                void actions.reviewDelivery(task.id, 'return', feedback)
              }
            },
          })) : null,
          pending ? h('div', { className: 'dsh-tasks-delivery-actions' },
            returning ? h(React.Fragment, null,
              h(TaskButton, { disabled: busy, onClick: () => setReturning(false) }, t('cancelDelete')),
              h(TaskButton, { className: 'dsh-tasks-primary', disabled: busy || !feedback.trim(), onClick: () => actions.reviewDelivery(task.id, 'return', feedback) }, t('returnDelivery')))
              : h(React.Fragment, null,
                h(TaskButton, { disabled: busy, onClick: () => setReturning(true) }, t('returnDelivery')),
                h(TaskButton, { className: 'dsh-tasks-primary', disabled: busy, onClick: () => actions.reviewDelivery(task.id, 'accept') }, t('acceptDelivery')))) : null,
          returned ? delivery.continuedAt ? h('p', { className: 'dsh-tasks-delivery-status', role: 'status' }, h(Icon, { name: 'check', size: 14 }), t('feedbackSent'))
            : h('div', { className: 'dsh-tasks-delivery-actions' },
              h(TaskButton, { className: 'dsh-tasks-primary', disabled: busy, onClick: () => actions.continueDelivery(task.id) }, t('sendReviewFeedback'))) : null,
          mutation?.errorCode ? h('p', { className: 'dsh-tasks-feedback', role: 'alert' }, failureText(t, mutation.errorCode, 'deliveryMutationFailed')) : null)
          : h('div', { className: 'dsh-tasks-delivery-empty' },
            h('p', { className: 'dsh-tasks-field-hint' }, t('deliveryNotSubmitted'), task.activeSessionId ? ' ' + t('deliveryWait') : '')))
    }

    function TaskDetails({ t, task, editor, options, actions, writable, writing, column, runtime, board, activity, draft, jobs, priorities, byId, mutation, view = 'detailTab' }) {
      const [copyState, setCopyState] = React.useState()
      const [confirmation, setConfirmation] = React.useState(null)
      const [resetSignal, setResetSignal] = React.useState(0)
      const detailPanel = React.useRef(null), lastField = React.useRef(null)
      const viewId = React.useId()
      const views = board ? DETAIL_VIEWS : DETAIL_VIEWS.filter(key => key !== 'activity')
      const selected = views.includes(view) ? view : 'detailTab'
      const activityView = selected === 'activity', deliveryView = selected === 'deliveryTab', detailsView = selected === 'detailTab'
      const sourceChanged = editor?.errorCode === 'tasks/edit-source-changed'
      const conflict = sourceChanged || editor && !editor.retryInput && (editor.revision !== task.revision || editor.errorCode === 'tasks/revision-conflict')
      const close = () => {
        if (confirmation || mutation?.pending) return
        if (editor?.pending || editor?.retryInput) { if (!detailsView) actions.setDetailView('detailTab'); return }
        if (editor) setConfirmation('close')
        else actions.closeDetails()
      }
      const restoreEditorFocus = opener => {
        const drawer = detailPanel.current?.closest('[role="dialog"]')
        if (!drawer) return // The drawer itself restores its board opener on discard.
        const target = (opener && [opener, lastField.current].find(node => node && drawer.contains(node) && node.getClientRects().length && !node.matches(':disabled')))
          || drawer.querySelector('[role="tab"][aria-selected="true"], [data-modal-autofocus]:not(:disabled)') || drawer
        target.focus({ preventScroll: true })
      }
      const locked = !writable || !!editor?.pending || !!editor?.retryInput
      const busy = !writable || writing || !!editor
      const resume = unfinishedLaunch(task), openSession = canStartNewConversation(task)
      const launch = () => actions.openLaunch(task.id)
      const blockers = blockersOf(task, byId)
      const unlinked = inProgressUnlinked(task)
      const status = unlinked && !resume ? 'unlinkedConversation' : runtime
      const launchLabel = resume ? 'resumeLaunch' : !task.activeSessionId && task.stage !== 'done' && !blockers.length
        ? unlinked ? 'createConversation' : 'launch' : undefined
      const columns = board?.columns?.length ? board.columns : defaults
      const currentColumn = column || columns.find(row => row.id === taskColumn(task)) || columns[0]
      const handleDiscardEdits = () => {
        const fromFooter = window.document?.activeElement?.closest?.('.dsh-tasks-detail-actions')
        actions.discardDetails()
        setResetSignal(value => value + 1)
        if (fromFooter) queueMicrotask(() => restoreEditorFocus(null))
      }
      const run = h(DeliverySection, {
        key: task.delivery?.id || 'run', t, task, status, actions, busy,
        navigationLocked: !!editor || !!mutation?.pending, mutation, launchLabel, onLaunch: launch,
      })
      const meta = h('div', { className: 'dsh-tasks-detail-meta' },
        h(ColumnPillSelect, {
          t, columns, current: currentColumn, disabled: busy, blockDone: deliveryOpen(task), labelPrefix: t('changeColumn'),
          onSelect(targetColumn) {
            if (targetColumn.id === currentColumn?.id) return
            if (targetColumn.stage === 'done' && deliveryOpen(task)) return
            if (board?.columns?.length) void actions.move({ taskId: task.id, expectedRevision: task.revision, columnId: targetColumn.id })
            else void actions.setStage(task.id, targetColumn.stage)
          },
        }),
        h(StatusBadge, { status, label: t(status), paperInk: true }),
        h(TaskButton, { className: 'dsh-tasks-copy-id', 'aria-label': t('copyTaskId'), title: t('copyTaskId'), onClick: async () => {
          try { await window.navigator.clipboard.writeText(task.id); setCopyState('copied') }
          catch { setCopyState('show') }
        } }, h(Icon, { name: 'copy', size: 14 }), 'ID'),
        copyState ? h('span', { className: copyState === 'show' ? 'dsh-tasks-detail-copy' : undefined, role: 'status' },
          copyState === 'show' ? t('taskId') + ': ' + task.id : t('taskIdCopied')) : null,
        editor ? h('span', { className: 'dsh-tasks-unsaved-pill', role: 'status' },
          h('span', { className: 'dsh-tasks-dot', 'aria-hidden': true }), t('unsavedBadge')) : null)
      const menu = h(Dropdown, { className: 'dsh-tasks-detail-menu' },
        h('summary', { className: 'dsh-tasks-icon-button', 'aria-label': t('moreTask'), title: t('moreTask'), 'data-task-ink': 'button' },
          taskInk('button', { variant: 'ghost' }), h(Icon, { name: 'more' })),
        h('div', { className: 'dsh-tasks-menu', 'data-task-ink': 'overlay' },
          openSession ? h(TaskButton, { className: '', disabled: busy,
            onClick: () => actions.openLaunch(task.id, { newConversation: true }),
          }, t('newSession')) : null,
          h(TaskButton, { className: 'dsh-tasks-danger', disabled: busy, onClick: () => actions.openDelete(task.id) }, h(Icon, { name: 'trash', size: 14 }), t('deleteTask'))))
      const showSaveFooter = !!editor
      const showIdleFooter = !editor && detailsView && (launchLabel || !!task.activeSessionId)
      return h(React.Fragment, null, h(TaskDrawer, {
        t, title: t('details'),
        headingNode: h(DetailHeaderTitle, { t, value: editor ? editor.title : task.title, disabled: locked, onChange: value => actions.editDetails('title', value) }),
        meta, menu, onClose: close, editorInk: true,
        onKeyDown(event) {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing
            && editor && writable && !writing && editor.title.trim() && !conflict && !editor.pending) {
            event.preventDefault()
            void actions.saveDetails()
          }
        },
      },
        h('div', { className: 'dsh-tasks-detail-tabs', role: 'tablist', 'aria-label': t('detailViews') },
          views.map((key, index) => {
            const count = key === 'activity' ? (activity ? activity.events.length : task.commentCount) : 0
            const deliveryStatus = key === 'deliveryTab' ? task.delivery?.status : undefined
            const deliveryLabel = deliveryStatus === 'pending' ? t('reviewPending')
              : deliveryStatus === 'returned' ? t('reviewReturned')
                : deliveryStatus === 'accepted' ? t('reviewAccepted') : undefined
            return h('button', {
              key, type: 'button', id: viewId + key, role: 'tab', 'data-task-ink': 'tabs',
              'aria-label': t(key), 'aria-selected': selected === key,
              'aria-controls': viewId + key + '-panel', tabIndex: selected === key ? 0 : -1,
              'data-modal-autofocus': selected === key ? '' : undefined,
              onClick: () => actions.setDetailView(key),
              onKeyDown(event) {
                const countTabs = views.length
                const next = { Home: 0, End: countTabs - 1, ArrowLeft: (index + countTabs - 1) % countTabs, ArrowRight: (index + 1) % countTabs }[event.key]
                if (next === undefined) return
                event.preventDefault()
                actions.setDetailView(views[next])
                event.currentTarget.parentElement?.querySelectorAll('[role="tab"]')[next]?.focus()
              },
            },
              taskInk('tabs'),
              h('span', { className: 'dsh-tasks-tab-label' }, t(key)),
              count > 0 ? h('span', { className: 'dsh-tasks-tab-count', 'aria-hidden': true }, String(count)) : null,
              deliveryLabel ? h('span', { className: 'dsh-tasks-tab-badge', 'data-tone': deliveryStatus, 'aria-hidden': true },
                h('span', { className: 'dsh-tasks-dot' }), deliveryLabel) : null)
          })),
        h('div', { ref: detailPanel, onFocusCapture: event => { lastField.current = event.target }, className: 'dsh-tasks-dialog-body dsh-tasks-detail-panel',
          hidden: !detailsView, role: 'tabpanel', id: viewId + 'detailTab-panel', 'aria-labelledby': viewId + 'detailTab' },
          h(TaskEditorFields, { t, values: editor ? { ...editor, id: task.id, stage: task.stage } : task, change: actions.editDetails, options, board, priorities, locked, autofocus: false,
            revision: task.revision, resetSignal, dirty: !!editor, byId, actions, showTitle: false },
            board ? h(TaskImages, { key: task.id, t, task, actions, jobs, active: detailsView, locked: !writable || !!editor?.pending }) : null),
          h(OptionsFeedback, { t, options, reload: actions.loadOptions }),
          conflict ? h('div', { className: 'dsh-tasks-feedback', role: 'alert' }, t(sourceChanged ? 'editSourceChanged' : 'editConflict'), ' ',
            !editor?.retryInput ? h(TaskButton, { className: 'dsh-tasks-retry', disabled: writing, onClick: () => setConfirmation('reload') }, t('reloadDetails')) : null) : null,
          editor?.errorCode && !conflict ? h('p', { className: 'dsh-tasks-feedback', role: 'alert' },
            editor.retryInput ? t('editUnknown') : failureText(t, editor.errorCode, 'editFailed')) : null,
          h('dl', { className: 'dsh-tasks-detail-grid' },
            h('dt', null, t('created')), h('dd', null, new Date(task.createdAt).toLocaleString()),
            task.stage === 'done' ? h(React.Fragment, null, h('dt', null, t('completedAt')), h('dd', null, task.completedAt ? new Date(task.completedAt).toLocaleString() : t('unknownTime'))) : null,
            task.previousSessionIds?.length ? h(React.Fragment, null, h('dt', null, t('history')), h('dd', { className: 'dsh-tasks-detail-sessions' },
              task.previousSessionIds.map(id => h(SessionChip, { key: id, t, sessionId: id, disabled: !!editor, onOpen: actions.openSession })))) : null,
           ),
        ),
        board ? h('div', { className: 'dsh-tasks-dialog-body dsh-tasks-detail-panel dsh-tasks-detail-activity', hidden: !activityView,
          role: 'tabpanel', id: viewId + 'activity-panel', 'aria-labelledby': viewId + 'activity' },
          activityView || activity ? h(Activity, { t, task, board, actions, activity, draft, writable, navigationLocked: !!editor || !!mutation?.pending }) : null) : null,
        h('div', { className: 'dsh-tasks-dialog-body dsh-tasks-detail-panel dsh-tasks-detail-delivery', hidden: !deliveryView,
          role: 'tabpanel', id: viewId + 'deliveryTab-panel', 'aria-labelledby': viewId + 'deliveryTab' }, run),
        showSaveFooter || showIdleFooter ? h('div', { className: 'dsh-tasks-form-actions dsh-tasks-detail-actions' },
          showSaveFooter ? h(React.Fragment, null,
            h('span', { className: 'dsh-tasks-draft-hint' }, t('unsavedBadge')),
            !editor.pending && !editor.retryInput ? h(TaskButton, { className: 'dsh-tasks-secondary', key: 'discard', onClick: handleDiscardEdits }, t('discardEdits')) : null,
            h(TaskButton, { className: 'dsh-tasks-primary', key: 'save', disabled: !writable || writing || !editor.title.trim() || conflict, onClick: actions.saveDetails },
              t(editor.pending ? 'savingDetails' : editor.retryInput ? 'retry' : 'saveDetails')))
            : launchLabel ? h(TaskButton, { className: 'dsh-tasks-primary', key: 'session', disabled: busy,
              onClick: launch }, t(launchLabel))
              : h(TaskButton, { className: 'dsh-tasks-secondary', key: 'openSession', disabled: !!mutation?.pending,
                onClick: () => actions.openSession(task.activeSessionId) }, t('openSession'))) : null,
      ), confirmation ? h(DetailConfirmation, { t, reload: confirmation === 'reload', restoreFocus: restoreEditorFocus,
        disabled: !editor || !!editor.pending || !!editor.retryInput || (confirmation === 'reload' && writing),
        onKeep: () => setConfirmation(null), onDiscard: () => {
          setConfirmation(null)
          if (confirmation === 'reload') void actions.reloadDetails()
          else actions.closeDetails()
        } }) : null)
    }

    class McpAccessDialog extends React.Component {
      state = { busy: true }
      componentDidMount() { this.closed = false; void this.perform('status') }
      componentWillUnmount() { this.closed = true }
      perform = async action => {
        if (this.pending || this.closed) return
        this.pending = true
        this.setState({ busy: true, confirm: undefined, error: undefined, copyState: undefined, config: undefined })
        let status, error, config
        try {
          const result = await this.props.manage(action)
          if (!result.ok) error = result.error.code === 'tasks/mcp-listen-failed' ? 'mcpListenFailed' : 'mcpFailed'
          else {
            status = result.value
            if (typeof status?.enabled !== 'boolean' || typeof status.active !== 'boolean') throw new TypeError('Invalid MCP access state')
            if (action === 'generate') {
              if (!/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(status.url) || !/^dsh_tasks_[A-Za-z0-9_-]{43}$/.test(status.key)) {
                throw new TypeError('Invalid generated MCP configuration')
              }
              config = JSON.stringify({ mcpServers: { dsh_tasks: { type: 'http', url: status.url,
                headers: { Authorization: 'Bearer ' + status.key } } } }, null, 2)
            }
            // Keep only the display state; the one-time configuration stays in this mounted dialog.
            status = { enabled: status.enabled, active: status.active, url: status.url, listenFailed: status.listenFailed }
          }
        } catch { status = undefined; error = 'mcpFailed' }
        finally {
          this.pending = false
          if (!this.closed) this.setState({ busy: false, status, config, error })
        }
      }
      copy = async () => {
        const { config } = this.state
        let copyState = 'mcpCopyDone'
        try { await window.navigator.clipboard.writeText(config) }
        catch { copyState = 'mcpCopyFailed' }
        if (!this.closed && this.state.config === config) this.setState({ copyState })
      }
      render() {
        const { t, onClose } = this.props
        const { status, error, confirm, config, busy, copyState } = this.state
        const revoke = confirm === 'revoke'
        const confirmAction = revoke ? 'mcpRevoke' : 'mcpRotate'
        return h(Modal, { t, paper: true, title: t('mcpAccess'), onClose, dismissDisabled: busy },
          h('div', { className: 'dsh-tasks-dialog-body dsh-tasks-mcp-body' },
            h('p', null, t('mcpIntro')),
            busy ? h('p', { role: 'status' }, t('mcpBusy')) : null,
            error || status?.listenFailed ? h('p', { className: 'dsh-tasks-feedback', role: 'alert' }, t(error || 'mcpListenFailed')) : null,
            !busy && status ? h('p', { role: 'status' }, t(!status.enabled ? 'mcpDisabled' : !status.active ? 'mcpNotConfigured' : config ? 'mcpConfigured' : 'mcpHidden')) : null,
            status?.active && status.url ? h('p', null, t('mcpEndpoint') + ': ', h('code', null, status.url)) : null,
            config ? h('div', { className: 'dsh-tasks-fields' },
              h('p', null, t('mcpOneTime')),
              h('label', null, t('mcpConfig'), h(TaskTextArea, { readOnly: true, rows: 10, spellCheck: false, value: config })),
              h(TaskButton, { className: 'dsh-tasks-secondary', onClick: this.copy }, t('mcpCopyConfig')),
              copyState ? h('p', { role: 'status' }, t(copyState)) : null) : null,
            confirm ? h('p', { role: 'status' }, t(revoke ? 'mcpConfirmRevoke' : 'mcpConfirmRotate')) : null),
          h('div', { className: 'dsh-tasks-form-actions dsh-tasks-mcp-actions' },
            h(TaskButton, { className: 'dsh-tasks-secondary', disabled: busy,
              onClick: confirm ? () => this.setState({ confirm: undefined }) : onClose }, t(confirm ? 'cancelDelete' : 'close')),
            h('span', { className: 'dsh-tasks-spacer' }),
            !busy && (error || status?.listenFailed) ? h(TaskButton, { className: 'dsh-tasks-secondary', onClick: () => this.perform('status') }, t('mcpRetry')) : null,
            !busy && confirm ? h(TaskButton, { className: 'dsh-tasks-primary' + (revoke ? ' dsh-tasks-danger' : ''),
              onClick: () => this.perform(confirm) }, t(confirmAction)) : null,
            !busy && !confirm && status?.enabled ? (status.active ? h(React.Fragment, null,
              h(TaskButton, { className: 'dsh-tasks-secondary dsh-tasks-danger', onClick: () => this.setState({ confirm: 'revoke' }) }, t('mcpRevoke')),
              !status.listenFailed ? h(TaskButton, { className: 'dsh-tasks-secondary', onClick: () => this.setState({ confirm: 'generate' }) }, t('mcpRotate')) : null)
              : h(TaskButton, { className: 'dsh-tasks-primary', onClick: () => this.perform('generate') }, t('mcpGenerate'))) : null))
      }
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

    function RestoreDialog({ t, restore, actions }) {
      const id = React.useId()
      return h(Modal, { t, paper: true, alertId: id, className: 'dsh-tasks-confirm-dialog', title: t('restoreTitle'),
        dismissDisabled: restore.pending, onClose: actions.cancelRestore },
        h('div', { className: 'dsh-tasks-dialog-body' }, h('p', { id: id + '-description' }, t('restoreNote')),
          restore.error ? h('p', { role: 'alert' }, t(restore.error)) : null),
        h('div', { className: 'dsh-tasks-form-actions' },
          h(TaskButton, { 'data-dsh-initial-focus': '', disabled: restore.pending, onClick: actions.cancelRestore }, t('cancelDelete')),
          h(TaskButton, { className: 'dsh-tasks-primary', disabled: restore.pending, onClick: actions.restoreSession }, t('restoreOpen'))))
    }

    function LaunchForm({ t, form, task, options, actions, writable, runtime, jobs, dependenciesBlocked }) {
      const locked = form.pending || !!form.retryInput
      const legacyImages = !!form.retryInput?.includeImages && !form.retryInput?.includeFiles
      const sendingFiles = form.retryInput ? !!form.retryInput.includeFiles || legacyImages : !!form.includeFiles
      const hasLaunchFiles = form.retryInput ? sendingFiles : !!(task.fileCount || task.imageCount || jobs?.length)
      const waitingForFiles = !locked && sendingFiles && !!jobs?.length
      const existing = !!task.activeSessionId && !locked
      const busy = busySource(runtime)
      const newConversation = existing && !!form.newConversation
      const replacing = existing && !busy && (newConversation || form.replaceActive)
      const showFields = !existing || replacing
      const source = form.retryInput ? form.retryInput.forkFromSessionId : form.forkFromSessionId
      const blocked = !locked && (source && source !== task.activeSessionId ? 'forkChanged' : forkBlock(options, runtime))
      const receipt = receiptFor(task, form)
      const unknown = unknownFork(receipt) || form.errorCode === 'tasks/fork-unknown'
      const checkReceipt = form.checkReceipt || (form.errorCode === 'tasks/fork-unknown' && !unknownFork(receipt))
      const dependencyRefusal = !locked && dependenciesBlocked
      const canSubmit = showFields && writable && !form.pending && !waitingForFiles && !dependencyRefusal && !(blocked && source) && !unknown && !checkReceipt && !!form.content?.trim()
      const unlinked = inProgressUnlinked(task)
      const title = form.retryInput && !form.pending ? 'resumeLaunch' : newConversation || form.retryInput?.replaceActive ? 'newSession'
        : unlinked ? 'createConversation' : 'launch'
      const note = form.retryInput && !form.pending ? 'resumeNote' : replacing ? 'newSessionNote'
        : !existing && !locked ? unlinked ? 'createConversationNote' : 'launchNote' : null
      const selection = form.model ?? (source ? undefined : options.defaultModel)
      const model = options.groups.find(group => group.id === selection?.provider)?.models.find(row => row.id === selection?.model)
      const efforts = model?.reasoning?.efforts ?? []
      const effort = efforts.find(row => row.id === selection?.reasoningEffort)?.id ?? ''
      const launchRequestId = receipt && unfinishedLaunch(task) ? receipt.input.requestId : undefined
      return h(Modal, { t, paper: true, className: 'dsh-tasks-launch-dialog', title: t(title), intro: task.title, onClose: actions.closeLaunch },
        h('form', { className: 'dsh-tasks-form', onSubmit(event) {
          event.preventDefault()
          if (!canSubmit) return
          void actions.launchTask()
        } },
          h('div', { className: 'dsh-tasks-dialog-body' },
            note && !unknown && !checkReceipt ? h('p', { className: 'dsh-tasks-dialog-note' }, t(note)) : null,
            dependencyRefusal ? h('p', { className: 'dsh-tasks-feedback', role: 'status' }, t('dependencyBlocked')) : null,
            showFields && !locked && task.acceptanceCriteria ? h('details', { className: 'dsh-tasks-launch-criteria' },
              h('summary', null, t('acceptanceCriteria')), h('p', null, task.acceptanceCriteria),
              h('small', null, t('criteriaLaunchHint'))) : null,
            showFields && (newConversation || form.replaceActive || form.retryInput?.replaceActive || source) ? h('fieldset', { className: 'dsh-tasks-history-choice', disabled: locked },
              h('legend', null, t('conversationType')),
              h('label', null, h('input', { type: 'radio', name: 'launchHistory', value: 'blank', checked: !source, disabled: locked,
                onChange: () => actions.editLaunch('forkFromSessionId', undefined) }), t('blankSession')),
              h('label', null, h('input', { type: 'radio', name: 'launchHistory', value: 'fork', checked: !!source, disabled: locked || !!blocked,
                onChange: () => actions.editLaunch('forkFromSessionId', task.activeSessionId) }), t('forkSession')),
              blocked !== 'sessionStatusUnknown' ? h('p', { className: 'dsh-tasks-field-hint' }, t(blocked || 'forkHint')) : null) : null,
            showFields && hasLaunchFiles ? h(Checkbox, { checked: sendingFiles, disabled: locked,
              label: t(legacyImages ? 'launchImages' : 'launchFiles'), onChange: checked => actions.editLaunch('includeFiles', checked) }) : null,
            showFields && waitingForFiles ? h('p', { role: 'status' }, t('launchUploadPending')) : null,
            existing ? h('div', { className: 'dsh-tasks-feedback' },
              h('p', null, t(runtime === 'unknown' ? 'sessionStatusUnknown' : busy ? 'sessionBusy' : newConversation ? 'existingSessionNote' : 'sessionExists')),
              h(TaskButton, { type: 'button', className: 'dsh-tasks-retry', 'data-dsh-initial-focus': showFields ? undefined : '', onClick: () => actions.openSession(task.activeSessionId) }, t('openSession')),
              !newConversation && !busy ? h(Checkbox, { checked: !!form.replaceActive, label: t('newSession'),
                onChange: checked => actions.editLaunch('replaceActive', checked) }) : null) : null,
            showFields ? h('fieldset', { className: 'dsh-tasks-fields', disabled: locked },
              !source ? h(React.Fragment, null, h('label', null, h('span', { className: 'dsh-tasks-field-title' }, t('workspace')),
                h(PaperSelect, { t, className: 'dsh-tasks-stage', name: 'launchWorkspace', 'aria-label': t('workspace'), value: form.workspaceId,
                  onChange: event => actions.editLaunch('workspaceId', event.target.value) },
                  h('option', { value: '' }, t('ungrouped')),
                  form.workspaceId && !options.workspaces.some(row => row.id === form.workspaceId) ? h('option', { value: form.workspaceId }, t('workspaceMissing')) : null,
                  options.workspaces.map(row => h('option', { key: row.id, value: row.id }, row.title)))),
              h('p', { className: 'dsh-tasks-field-hint' }, t('launchWorkspaceSync'))) : null,
              h('label', null, h('span', { className: 'dsh-tasks-field-title' }, t('model')),
                h(PaperSelect, { t, className: 'dsh-tasks-stage', name: 'launchModel', 'aria-label': t('model'), value: modelKey(form.model), onChange(event) {
                  actions.editLaunch('model', event.target.value ? (() => { const [provider, model] = JSON.parse(event.target.value); return { provider, model } })() : undefined)
                } }, h('option', { value: '' }, t(source ? 'forkModel' : 'defaultModel')),
                form.model && !model ? h('option', { value: modelKey(form.model) }, form.model.model) : null,
                options.groups.map(group => h('optgroup', { key: group.id, label: group.name }, group.models.map(row => h('option', {
                  key: row.id, value: JSON.stringify([group.id, row.id]),
                }, row.name))))), h('p', { className: 'dsh-tasks-field-hint' }, t('modelDefaultNotice'))),
              efforts.length ? h('label', null,
                h('span', { className: 'dsh-tasks-field-title' }, t('reasoningEffort')),
                h(PaperSelect, { t, selectOnly: true, name: 'reasoningEffort', 'aria-label': t('reasoningEffort'),
                  value: effort, onChange: event => {
                    const value = event.target.value
                    actions.editLaunch('model', { provider: selection.provider, model: selection.model,
                      ...(value ? { reasoningEffort: value } : {}) })
                  } }, h('option', { value: '' }, t('defaultEffort')), efforts.map(row => h('option', { key: row.id, value: row.id }, row.name || row.id))),
                !form.model ? h('span', { className: 'dsh-tasks-field-hint' }, t('defaultEffortHint')) : null) : null,
              !source ? h('label', null, h('span', { className: 'dsh-tasks-field-title' }, t('preset')),
                h(PaperSelect, { t, className: 'dsh-tasks-stage', name: 'agentPreset', 'aria-label': t('preset'), value: form.agentPreset || '', onChange: event => actions.editLaunch('agentPreset', event.target.value) },
                  h('option', { value: '' }, t('defaultPreset')), (options.presets || []).map(row => h('option', { key: row.id, value: row.id }, row.name || (['standard', 'ptc', 'minimal', 'cordis'].includes(row.id) ? t('preset_' + row.id) : row.id))))) : null,
              h('label', null, h('span', { className: 'dsh-tasks-field-title' }, t('firstMessage')),
                h(TaskTextArea, { name: 'content', rows: 6, required: true, 'data-dsh-initial-focus': '', value: form.content,
                  onChange: event => actions.editLaunch('content', event.target.value) }))) : null,
            showFields && hasLaunchFiles ? h(React.Fragment, null,
              form.retryInput && !launchRequestId ? h('p', { role: 'status' }, t('launchPreviewPending'), ' ',
                h(TaskButton, { disabled: form.pending, onClick: actions.refresh }, t('refresh')))
                : h(TaskImages, { key: task.id + ':' + (launchRequestId ?? 'current'), t, task, actions, readOnly: true,
                  launchRequestId, jobs: launchRequestId ? [] : jobs }),
              !sendingFiles ? h('p', { className: 'dsh-tasks-field-hint' }, t('launchWithoutFiles')) : null) : null,
            unknown ? h('p', { className: 'dsh-tasks-feedback', role: 'alert' }, t('forkUnknown')) : null,
            checkReceipt ? h('div', { className: 'dsh-tasks-feedback' }, h('p', null, t('checkLaunchNote')),
              h(TaskButton, { disabled: form.pending || !writable, onClick: actions.checkForkReceipt }, t('checkLaunch'))) : null,
            launchRequestId && receipt.sessionId ? h('div', { className: 'dsh-tasks-feedback' },
              h('p', null, t('launchSaved')), h(TaskButton, { type: 'button', className: 'dsh-tasks-retry', onClick: () => actions.openSession(receipt.sessionId) }, t('openSession'))) : null,
            !checkReceipt && ['prepared', 'forking', 'created'].includes(receipt?.phase) && !form.pending ? h('div', { className: 'dsh-tasks-feedback' },
              receipt.sessionId ? h('p', null, t('abandonHint')) : null, h(TaskButton, { type: 'button', className: 'dsh-tasks-retry', disabled: !writable, onClick: actions.abandonLaunch }, t('abandonLaunch'))) : null,
            form.errorCode && form.errorCode !== 'tasks/fork-unknown' && !(form.checkReceipt && form.errorCode === 'tasks/launch-unknown') ? h('p', { className: 'dsh-tasks-feedback', role: 'alert' }, failureText(t, form.errorCode, 'launchFailed')) : null,
            options.status === 'error' ? h(TaskButton, { type: 'button', className: 'dsh-tasks-retry', onClick: actions.loadOptions }, t('reloadOptions')) : null),
          h('div', { className: 'dsh-tasks-form-actions' },
            h('span', { className: 'dsh-tasks-spacer' }),
            h(TaskButton, { type: 'button', className: 'dsh-tasks-retry', onClick: actions.closeLaunch }, t('close')),
            (showFields || newConversation) && !unknown && !checkReceipt ? h(TaskButton, { type: 'submit', className: 'dsh-tasks-primary', disabled: !canSubmit },
              t(form.pending ? 'starting' : form.retryInput ? 'resumeLaunch' : newConversation || unlinked ? 'newSessionAction' : 'launch')) : null)))
    }

    /**
     * The task board panel.
     * @param props - slot props.
     * @param props.t - translate function bound to this plugin's namespace.
     * @param props.useTasks - renderer-bound task-list hook.
     * @param props.actions - stable data-source callbacks.
     * @returns the panel.
     */
    function ManagedColumn({ column, revision, t, children, ...props }) {
      const drag = Dnd.useDraggable({ id: column.id, data: { task: { id: column.id, revision, title: columnLabel(t, column) } } })
      const drop = Dnd.useDroppable({ id: 'card:' + column.id, data: { columnId: column.id, taskId: column.id } })
      return h('form', { ...props, ref: node => { drag.setNodeRef(node); drop.setNodeRef(node) }, 'data-drop': drop.isOver || undefined },
        h(TaskButton, { type: 'button', className: 'dsh-tasks-grip', elementRef: drag.setActivatorNodeRef, ...drag.attributes, ...drag.listeners,
          'aria-label': t('columns') + ': ' + columnLabel(t, column) }, h(Icon, { name: 'grip', size: 16 })), children)
    }

    function ManageTitle({ title, count }) {
      return h('h3', { className: 'dsh-tasks-manage-title' }, title, count != null ? h('span', { className: 'dsh-tasks-counter' }, count) : null)
    }

    function RowAction({ label, icon, danger, ...props }) {
      return h(TaskButton, { className: 'dsh-tasks-row-action' + (danger ? ' dsh-tasks-danger' : ''), 'aria-label': label, title: label, ...props }, h(Icon, { name: icon, size: 15 }))
    }

    function restoreManagerFocus(opener) {
      if (opener?.isConnected && opener.closest('.dsh-tasks-board-view') && !opener.matches(':disabled') && opener.getClientRects().length) {
        opener.focus({ preventScroll: true })
      } else {
        // The column's rename button may be gone after an empty column is removed.
        window.document.querySelector('.dsh-tasks-board-view .dsh-tasks-settings > summary')?.focus({ preventScroll: true })
      }
    }

    function reorderColumn(board, actions, id, targetId, side, expectedRevision) {
      if (!board || id === targetId) return
      const remaining = board.columns.filter(column => column.id !== id)
      const index = remaining.findIndex(column => column.id === targetId)
      if (index === -1 || remaining.length === board.columns.length) return
      const before = remaining[index + (side === 'after' ? 1 : 0)]?.id ?? null
      const currentIndex = board.columns.findIndex(column => column.id === id)
      if (before === (board.columns[currentIndex + 1]?.id ?? null)) return
      return actions.editColumns({ action: 'reorder', columnId: id, before, expectedRevision })
    }

    const COLUMN_COLOR_PRESETS = ['#e5b94c', '#8451b4', '#3b82c4', '#3b9e6c', '#d96b6b', '#d9823b', '#2d9d9c', '#7a7670']
    const stagePreviewColor = (stage, columnId) => stage === 'done' ? '#3b9e6c' : stage === 'doing' ? '#3b82c4' : columnId === 'stage:todo' ? '#e5b94c' : '#8451b4'

    function ColumnColorPicker({ t, value = '', stage, columnId, disabled = false, onChange, onCommit }) {
      const fallback = stagePreviewColor(stage, columnId)
      const [picked, setPicked] = React.useState(null)
      const normalized = value ? value.toLowerCase() : ''
      const preview = value || fallback
      const draftHex = (picked || normalized || fallback).toLowerCase()
      const closeMenu = event => {
        const menu = event?.currentTarget?.closest?.('details')
        if (!menu) return
        menu.open = false
        menu.querySelector('summary')?.focus()
      }
      const choose = (event, nextColor) => {
        setPicked(null)
        closeMenu(event)
        if (onCommit) onCommit(nextColor, event)
        else onChange?.(nextColor || '')
      }
      const triggerLabel = t('columnColor') + ': ' + (value ? value.toUpperCase() : t('columnColorDefault'))
      return h(Dropdown, {
        className: 'dsh-tasks-col-color-picker',
        onToggle(event) { if (!event.currentTarget.open) setPicked(null) },
      },
        h('summary', {
          className: 'dsh-tasks-col-color-trigger',
          'aria-label': triggerLabel,
          title: triggerLabel,
          'aria-disabled': disabled || undefined,
          tabIndex: disabled ? -1 : undefined,
          'data-custom': value ? '' : undefined,
          style: { '--dsh-tasks-swatch': preview },
          onClick(event) { if (disabled) event.preventDefault() },
        }, h('span', { className: 'dsh-tasks-col-color-dot', 'aria-hidden': true })),
        h('input', { type: 'hidden', name: 'color', value: value || '' }),
        h('div', { className: 'dsh-tasks-menu dsh-tasks-col-color-menu', popover: 'manual', 'data-task-ink': 'overlay' },
          h('div', { className: 'dsh-tasks-col-color-head' },
            h('span', { className: 'dsh-tasks-menu-label' }, t('columnColor')),
            h(TaskButton, {
              type: 'button',
              className: 'dsh-tasks-col-color-reset',
              disabled: disabled || !value,
              'aria-pressed': !value,
              onClick: event => choose(event, null),
            }, t('columnColorDefault'))),
          h('div', { className: 'dsh-tasks-col-color-swatches', role: 'group', 'aria-label': t('columnColor') },
            COLUMN_COLOR_PRESETS.map(hex => h('button', {
              key: hex,
              type: 'button',
              className: 'dsh-tasks-col-color-swatch',
              'data-color': hex,
              'aria-label': t('columnColor') + ' ' + hex.toUpperCase(),
              'aria-pressed': normalized === hex,
              disabled,
              style: { '--dsh-tasks-swatch': hex },
              onClick: event => choose(event, hex),
            }))),
          h('div', { className: 'dsh-tasks-col-color-custom' },
            h('label', { className: 'dsh-tasks-swatch-field' },
              h('span', null, t('columnColorCustom')),
              h('input', {
                type: 'color',
                'aria-label': t('columnColorCustom'),
                value: draftHex,
                disabled,
                onChange(event) {
                  const hex = event.target.value.toLowerCase()
                  if (onCommit) setPicked(hex)
                  else onChange?.(hex)
                },
              })),
            h('code', { className: 'dsh-tasks-col-color-hex' }, draftHex.toUpperCase()),
            onCommit ? h(TaskButton, {
              type: 'button',
              className: 'dsh-tasks-secondary dsh-tasks-col-color-apply',
              disabled,
              onClick: event => choose(event, draftHex),
            }, t('applyColor')) : null)))
    }

    function ColumnManager({ t, board, actions, busy, tasks, error, selected }) {
      const [stage, setStage] = React.useState('doing')
      const [newColor, setNewColor] = React.useState('')
      const edit = change => actions.editColumns({ ...change, expectedRevision: board.revision })
      return h(Modal, { t, title: t('columns'), intro: t('columnsIntro'), className: 'dsh-tasks-management-dialog dsh-tasks-column-manager', focusClose: true,
        onClose: () => actions.showColumns(false), restoreFocus: restoreManagerFocus },
        h('div', { className: 'dsh-tasks-dialog-body dsh-tasks-management' }, error, h('fieldset', { disabled: busy, className: 'dsh-tasks-manage-layout' },
          h('section', null, h(ManageTitle, { title: t('boardColumns'), count: board.columns.length }), h('div', { className: 'dsh-tasks-manage-list' }, h(DragBoard, { onMove: input => {
            void reorderColumn(board, actions, input.taskId, input.columnId, input.anchor?.side, input.expectedRevision)
          } }, board.columns.map((column, index) => {
            const count = tasks.filter(task => taskColumn(task) === column.id).length
            return h(ManagedColumn, { key: column.id + ':' + (column.name || '') + ':' + (column.color || ''), column, revision: board.revision, t, className: 'dsh-tasks-column-form', 'data-column-id': column.id,
              onSubmit(event) {
                event.preventDefault()
                const colorField = event.currentTarget.elements.color
                const rawColor = colorField?.value?.trim()
                const colorPatch = colorField === undefined ? {} : rawColor ? { color: rawColor } : column.color ? { color: null } : {}
                void edit({ action: 'rename', columnId: column.id, name: event.currentTarget.elements.name.value, ...colorPatch })
              } },
            h(ColumnColorPicker, { t, value: column.color || '', stage: column.stage, columnId: column.id, disabled: busy,
              onCommit(nextColor, event) {
                const form = event?.currentTarget?.closest?.('form')
                const rawName = form?.elements?.name?.value
                const name = rawName?.trim() ? rawName : columnLabel(t, column)
                void edit({ action: 'rename', columnId: column.id, name, color: nextColor })
              } }),
            h('div', { className: 'dsh-tasks-row-name' }, h(TaskInput, { name: 'name', required: true, maxLength: 80, defaultValue: columnLabel(t, column), 'data-dsh-initial-focus': selected === column.id ? '' : undefined, 'aria-label': t('columnName') }),
              h('small', null, t(STAGES[column.stage]) + ' · ' + count + ' ' + t('taskCount'))),
            h('div', { className: 'dsh-tasks-row-tools' }, h(RowAction, { type: 'submit', label: t('rename'), icon: 'check' }),
            h(RowAction, { disabled: !index, label: t('earlier'), icon: 'up', onClick: () => edit({ action: 'reorder', columnId: column.id, before: board.columns[index - 1].id }) }),
            h(RowAction, { disabled: index === board.columns.length - 1, label: t('later'), icon: 'down', onClick: () => edit({ action: 'reorder', columnId: column.id, before: board.columns[index + 2]?.id || null }) }),
            h(RowAction, { danger: true, disabled: count > 0 || column.id.startsWith('stage:'), label: t('removeColumn'), title: count || column.id.startsWith('stage:') ? t('columnProtected') : t('removeColumn'), icon: 'trash', onClick: () => edit({ action: 'remove', columnId: column.id }) })))
          })))),
          h('section', null, h(ManageTitle, { title: t('addColumn') }), h('form', { className: 'dsh-tasks-column-form dsh-tasks-manage-create', onSubmit(event) {
            event.preventDefault()
            const fields = event.currentTarget.elements
            const rawColor = fields.color?.value?.trim()
            void edit({ action: 'add', name: fields.name.value, stage: fields.stage.value, ...(rawColor ? { color: rawColor } : {}) })
            if (rawColor) setNewColor('')
          } },
            h('div', { className: 'dsh-tasks-col-color-field' }, h('span', null, t('color')), h(ColumnColorPicker, { t, value: newColor, stage, disabled: busy, onChange: setNewColor })),
            h('label', null, t('columnName'), h(TaskInput, { name: 'name', maxLength: 80, required: true, 'aria-label': t('addColumn'), placeholder: t('columnName') })),
            h('label', null, t('moveTask'), h(PaperSelect, { t, name: 'stage', value: stage, onChange: event => setStage(event.target.value), 'aria-label': t('moveTask') }, defaults.map(column => h('option', { key: column.stage, value: column.stage }, columnLabel(t, column))))),
            h(TaskButton, { type: 'submit', className: 'dsh-tasks-primary' }, h(Icon, { name: 'plus', size: 14 }), t('addColumn')))))))
    }

    function columnCollision(args, point) {
      const containers = args.droppableContainers.filter(row => row.data.current?.boardColumn)
      const strip = containers[0]?.node.current?.parentElement
      const bounds = strip?.getBoundingClientRect()
      if (!bounds || point.x < bounds.left || point.x > bounds.right || point.y < bounds.top || point.y > bounds.bottom) return []
      const direction = window.getComputedStyle(strip).direction === 'rtl' ? -1 : 1
      const rows = containers.flatMap(row => {
        const rect = args.droppableRects.get(row.id)
        return rect ? [{ row, center: direction * (rect.left + rect.width / 2) }] : []
      }).sort((a, b) => a.center - b.center)
      const from = rows.findIndex(({ row }) => row.id === args.active.data.current.column.id)
      if (from === -1 || rows.length < 2) return []
      rows.splice(from, 1)
      // The entire space between neighbouring midpoints maps to the same insertion gap.
      const next = rows.findIndex(({ center }) => direction * point.x < center)
      const to = next === -1 ? rows.length : next
      const target = rows[Math.min(to, rows.length - 1)].row
      return [{ id: target.id, data: { droppableContainer: target, changed: from !== to,
        side: to === rows.length ? 'after' : 'before', label: target.data.current.name } }]
    }

    function positionColumnPreview({ transform, activatorEvent, activeNodeRect, windowRect }) {
      if (!activeNodeRect || !windowRect || !activatorEvent) return transform
      const start = activatorEvent.touches?.[0] || activatorEvent
      if (!Number.isFinite(start.clientX)) return transform
      const left = Math.max(8, Math.min(windowRect.width - Math.min(252, windowRect.width - 8), start.clientX + transform.x + 12))
      const top = Math.max(8, Math.min(windowRect.height - 52, start.clientY + transform.y + 14))
      return { ...transform, x: left - activeNodeRect.left, y: top - activeNodeRect.top }
    }

    function ColumnPreview({ t, title }) {
      const slot = Dnd.useDndContext().collisions?.[0]?.data
      const hint = slot?.changed
        ? t(slot.side === 'before' ? 'columnDropBefore' : 'columnDropAfter').replace('{column}', () => slot.label)
        : t('columnDragPrompt')
      return h('div', { className: 'dsh-tasks-column-preview', 'data-can-drop': slot?.changed || undefined, 'aria-hidden': true },
        h(Icon, { name: 'grip', size: 16 }), h('div', null, h('strong', null, title), h('small', null, hint)))
    }

    function DragBoard({ t, onMove, onColumnOrder, children }) {
      const [active, setActive] = React.useState(null)
      const sensors = Dnd.useSensors(Dnd.useSensor(Dnd.MouseSensor, { activationConstraint: { distance: 8 } }),
        Dnd.useSensor(Dnd.TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }), Dnd.useSensor(Dnd.KeyboardSensor))
      return h(Dnd.DndContext, { sensors, collisionDetection(args) {
        const point = args.pointerCoordinates || { x: args.collisionRect.left + args.collisionRect.width / 2, y: args.collisionRect.top + args.collisionRect.height / 2 }
        if (args.active.data.current?.column) return columnCollision(args, point)
        const containers = args.droppableContainers.filter(row => row.data.current?.acceptsTasks !== false)
        const hits = Dnd.pointerWithin({ ...args, droppableContainers: containers, pointerCoordinates: point })
        const hit = hits.find(item => String(item.id).startsWith('card:')) || hits[0]
        if (!hit) return []
        const rect = args.droppableRects.get(hit.id)
        return [{ ...hit, data: { ...hit.data, side: point.y < rect.top + rect.height / 2 ? 'before' : 'after' } }]
      }, onDragStart(event) {
        const { column, task } = event.active.data.current || {}
        setActive(column ? { ...column, ordering: true } : task)
      }, onDragCancel: () => setActive(null),
      onDragEnd(event) {
        const target = event.over?.data.current
        const hit = event.collisions?.[0]
        const side = hit?.data?.side || 'before'
        if (active && target) {
          if (active.ordering) {
            if (hit?.id === event.over.id && hit.data?.changed) void onColumnOrder?.(active.id, target.columnId, side, active.revision)
          } else if (active.id !== target.taskId) void onMove({ taskId: active.id, expectedRevision: active.revision,
            columnId: target.columnId, ...(target.taskId ? { anchor: { taskId: target.taskId, side } } : {}) })
        }
        setActive(null)
      } }, children, h(Dnd.DragOverlay, { dropAnimation: null,
        ...(active?.ordering ? { modifiers: [positionColumnPreview], style: { pointerEvents: 'none' } } : {}) },
        active?.ordering ? h(ColumnPreview, { t, title: active.title })
          : active ? h('div', { className: 'dsh-tasks-drag-preview', 'aria-hidden': true },
            h(Icon, { name: 'grip' }), h('div', null, h('strong', null, active.title), active.brief ? h('p', null, active.brief) : null)) : null))
    }

    function LabelManager({ t, board, actions, busy, error, tasks }) {
      const labels = board.labels ?? []
      const form = row => h('form', { className: row ? 'dsh-tasks-label-row' : 'dsh-tasks-manage-create dsh-tasks-new-label', key: row ? row.id + row.name + row.color : 'add-' + labels.length,
        onSubmit(event) { event.preventDefault(); const { name, color } = event.currentTarget.elements
          void actions.editLabels({ action: row ? 'edit' : 'add', expectedRevision: board.revision, ...(row ? { labelId: row.id } : {}), name: name.value, color: color.value }) } },
        h('label', { className: 'dsh-tasks-swatch-field' }, !row && t('color'), h('input', { name: 'color', type: 'color', 'aria-label': t('color'), title: t('color'), defaultValue: row?.color || '#4879bc' })),
        h('label', { className: row ? 'dsh-tasks-row-name' : undefined }, !row && t('labelName'), h(TaskInput, { name: 'name', required: true, maxLength: 80, 'aria-label': t('labelName'), placeholder: t('labelName'), defaultValue: row?.name || '' })),
        row ? h('div', { className: 'dsh-tasks-row-tools' }, h(RowAction, { type: 'submit', label: t('saveDetails'), icon: 'check' }),
          h(RowAction, { danger: true, disabled: busy || tasks.some(task => task.labelId === row.id), label: t('removeLabel'), icon: 'trash', title: tasks.some(task => task.labelId === row.id) ? t('labelProtected') : t('removeLabel'),
            onClick: () => actions.editLabels({ action: 'remove', labelId: row.id, expectedRevision: board.revision }) }))
          : h(TaskButton, { type: 'submit', className: 'dsh-tasks-primary' }, h(Icon, { name: 'plus', size: 14 }), t('addLabel')))
      return h(Modal, { t, title: t('labels'), intro: t('labelsIntro'), className: 'dsh-tasks-management-dialog dsh-tasks-label-manager', focusClose: true,
        onClose: () => actions.showColumns(false), restoreFocus: restoreManagerFocus },
        h('div', { className: 'dsh-tasks-dialog-body dsh-tasks-management' }, error, h('fieldset', { className: 'dsh-tasks-manage-layout', disabled: busy },
          h('section', null, h(ManageTitle, { title: t('addLabel') }), form()),
          h('section', null, h(ManageTitle, { title: t('boardLabels'), count: labels.length }), labels.length
            ? h('div', { className: 'dsh-tasks-manage-list' }, labels.map(form))
            : h('div', { className: 'dsh-tasks-empty-labels' }, h(Icon, { name: 'tag', size: 18 }), h('div', null, h('strong', null, t('noLabels')), h('p', null, t('noLabelsHint'))))))))
    }
    function DueOverview({ t, tasks, today, selected, change }) {
      const counts = { overdue: 0, today: 0, tomorrow: 0, nextWeek: 0 }
      let open = 0, dated = 0
      for (const task of tasks) {
        if (task.stage === 'done') continue
        open++
        if (task.dueDate) dated++
        const bucket = dueBucket(task, today)
        if (bucket) counts[bucket]++
      }
      const max = Math.max(...Object.values(counts))
      return h('section', { className: 'dsh-tasks-due-overview' },
        h('h3', null, h(Icon, { name: 'calendar' }), t('dueOverview')),
        max ? [
          h('p', null, t('dueScope')),
          Object.entries(counts).map(([key, count]) => h('button', { key, type: 'button', 'data-period': key,
            'aria-pressed': selected === key, disabled: !count && selected !== key, onClick: () => change('dueDate', selected === key ? '' : key) },
            h(Icon, { name: dueIcons[key] }), t(key), h('span', { className: 'dsh-tasks-due-count' }, count),
            h('span', { className: 'dsh-tasks-due-track', 'aria-hidden': true }, h('span', { style: { width: count / max * 100 + '%' } }))))
        ] : h('p', { className: 'dsh-tasks-empty-hint' }, t(!open ? 'noOpenTasks' : !dated ? 'noDueDates' : 'noNearDates')))
    }

    function ColumnOverview({ t, tasks, columns }) {
      const counts = new Map()
      for (const task of tasks) {
        const id = taskColumn(task)
        counts.set(id, (counts.get(id) || 0) + 1)
      }
      const rows = columns.map(column => ({ id: column.id, label: columnLabel(t, column), stage: column.stage, color: column.color, count: counts.get(column.id) || 0 }))
      if (rows.length > 6) {
        const rest = rows.splice(5)
        rows.push({ id: 'other', label: t('otherColumns') + ' · ' + rest.length, count: rest.reduce((sum, row) => sum + row.count, 0) })
      }
      const max = Math.max(1, ...rows.map(row => row.count))
      return h('section', { 'aria-label': t('byColumn') },
        h('h3', null, h(Icon, { name: 'board' }), t('byColumn')),
        h('ul', { className: 'dsh-tasks-column-mix', role: 'list' }, rows.map(row => h('li', { key: row.id, 'data-stage': row.stage },
          h('span', { title: row.label }, row.label),
          h('span', { className: 'dsh-tasks-column-meter', 'aria-hidden': true }, h('b', { style: { width: row.count / max * 100 + '%', ...(row.color ? { backgroundColor: row.color } : {}) } })),
          h('strong', null, row.count)))))
    }

    const attentionRank = { approval: 0, question: 1, reviewPending: 2, error: 3, reviewReturned: 4, overdue: 5, today: 6, tomorrow: 7, nextWeek: 8, P0: 9, P1: 10 }
    const attentionIcons = { approval: 'alert', question: 'question', reviewPending: 'check', error: 'alert', reviewReturned: 'comment', ...dueIcons, P0: 'tag', P1: 'tag' }
    function OverviewTaskLists({ t, open, recent, today, statuses, dueFilter, openTask, priorities }) {
      const attention = open.flatMap(task => {
        const due = dueBucket(task, today)
        if (dueFilter && due !== dueFilter) return []
        const highPriority = task.priority === 'P0' || task.priority === 'P1'
        const reason = attentionOf(task, statuses) ?? due ?? (highPriority ? task.priority : undefined)
        return reason ? [{ task, reason }] : []
      }).sort((a, b) => attentionRank[a.reason] - attentionRank[b.reason]
        || (a.task.dueDate || '9999-12-31').localeCompare(b.task.dueDate || '9999-12-31')
        || a.task.id.localeCompare(b.task.id)).slice(0, 5)
      const formatDay = new Intl.DateTimeFormat(t('localeCode'), { year: 'numeric', month: 'short', day: 'numeric' })
      const list = (kind, heading, icon, empty, rows) => h('section', { className: 'dsh-tasks-insight-list', 'data-list': kind, 'aria-label': t(heading) },
        h('h3', null, h(Icon, { name: icon }), t(heading)),
        rows.length ? h('ul', { role: 'list' }, rows.map(({ task, label, icon: rowIcon, tone, date }) =>
          h('li', { key: task.id }, h(TaskButton, { className: 'dsh-tasks-insight-row', 'data-tone': tone,
            'aria-label': task.title + ' · ' + label, onClick: () => openTask(task.id) },
          h(Icon, { name: rowIcon, size: 14 }),
          h('span', null, h('strong', { title: task.title }, task.title), date ? h('time', { dateTime: date }, label) : h('small', { title: label }, label)),
          h(Icon, { name: 'chevron', size: 12 }))))) : h('p', null, t(empty)))
      return h('div', { className: 'dsh-tasks-insight-lists' },
        list('attention', 'attentionQueue', 'spark', 'noAttentionQueue', attention.map(({ task, reason }) => ({ task,
          label: reason === 'P0' || reason === 'P1' ? t('highPriority') + ' · ' + priorityLabel(priorities, reason)
            : t(reason) + (Object.hasOwn(dueIcons, reason) ? ' · ' + task.dueDate : ''),
          icon: attentionIcons[reason], tone: attentionRank[reason] <= attentionRank.overdue ? 'urgent' : 'soon' }))),
        list('recent', 'recentDone', 'check', 'noRecentDone', recent.map(({ task, timestamp }) => ({ task,
          label: formatDay.format(timestamp), date: task.completedAt, icon: 'check', tone: 'done' }))))
    }

    function WorkspaceInsights({ t, scope, tasks, columns, priorities, today, options, statuses, sync, selected, change, openTask, onClose }) {
      const week = Array.from({ length: 7 }, (_, index) => {
        const date = new Date(today + 'T12:00:00')
        date.setDate(date.getDate() + index - 6)
        return { day: date.toLocaleDateString('sv-SE'), count: 0 }
      })
      const done = tasks.filter(task => task.stage === 'done')
      let elapsed = 0, timed = 0
      const completed = []
      for (const task of done) {
        const timestamp = Date.parse(task.completedAt)
        if (!Number.isFinite(timestamp)) continue
        completed.push({ task, timestamp })
        const day = new Date(timestamp).toLocaleDateString('sv-SE')
        const bucket = week.find(row => row.day === day)
        if (bucket) bucket.count++
        const duration = timestamp - Date.parse(task.createdAt)
        if (duration >= 0) { elapsed += duration; timed++ }
      }
      const recent = completed.sort((a, b) => b.timestamp - a.timestamp || a.task.id.localeCompare(b.task.id)).slice(0, 5)
      const open = tasks.filter(task => task.stage !== 'done')
      const blocked = open.filter(task => attentionOf(task, statuses))
      const rate = tasks.length ? Math.round(100 * done.length / tasks.length) : 0
      function groupBy(keyOf, labelOf) {
        const rows = new Map()
        for (const task of tasks) {
          const key = keyOf(task)
          if (!rows.has(key)) rows.set(key, { key, label: labelOf(task), count: 0 })
          rows.get(key).count++
        }
        return [...rows.values()].sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
      }
      const priorityGroups = groupBy(task => task.priority || '', task => task.priority ? priorityLabel(priorities, task.priority) : t('none'))
      const workspaces = groupBy(task => task.workspaceId || '', task => workspaceLabel(t, task, options))
      const models = groupBy(task => modelKey(task.model), task => modelLabel(task, options) || t('defaultModel'))
      const max = Math.max(1, ...week.map(row => row.count))
      const recentTotal = week.reduce((sum, row) => sum + row.count, 0)
      const heading = (key, icon) => h('h3', null, h(Icon, { name: icon }), t(key))
      const line = (label, value, key) => h('div', { key, className: 'dsh-tasks-insight-line' }, h('span', null, label), h('strong', null, value))
      const tags = (rows, value) => h('div', { className: 'dsh-tasks-mix-tags' }, rows.map(row => h('span', { key: row.key }, row.label + ' · ' + value(row))))
      const metric = (key, value) => h('div', { className: 'dsh-tasks-metric' }, t(key), h('strong', null, value))
      const colors = { P0: 'var(--dsw-alias-state-error-primary)', P1: 'var(--dsw-alias-state-warn-primary)', P2: 'var(--dsh-tasks-muted)' }
      return h('aside', { className: 'dsh-tasks-insights', 'aria-label': t('insights') },
        h('div', { className: 'dsh-tasks-insight-body' },
          h('header', null,
            h('div', { className: 'dsh-tasks-insight-line' },
              h('h2', null, h(Icon, { name: 'chart', size: 16 }), t('insights')),
              h('div', { className: 'dsh-tasks-insight-header-actions' },
                sync === 'live' ? h('span', { className: 'dsh-tasks-insight-sync', 'data-live': true }, t('syncLive')) : null,
                onClose ? h(TaskButton, {
                  className: 'dsh-tasks-icon-button dsh-tasks-insight-close',
                  title: t('close') || '关闭概览',
                  'aria-label': t('close') || '关闭概览',
                  onClick: onClose
                }, h(Icon, { name: 'close', size: 14 })) : null
              )
            ),
            h('small', null, scope)
          ),
          h('div', { className: 'dsh-tasks-insight-sections' },
            h('section', { className: 'dsh-tasks-insight-delivery' }, heading('delivery', 'check'),
              h('strong', { className: 'dsh-tasks-rate' }, tasks.length ? rate + '%' : '—'),
              h('progress', { value: rate, max: 100, 'aria-label': t('delivery') }),
              h('small', { className: 'dsh-tasks-insight-line' }, t('colDone') + ' ' + done.length, h('span', null, t('openTasks') + ' ' + open.length))),
            h(ColumnOverview, { t, columns, tasks }),
            h(DueOverview, { t, tasks, today, selected, change }),
            h('section', null, heading('metrics', 'chart'), h('div', { className: 'dsh-tasks-metrics' },
              metric('needsAction', blocked.length), metric('colDoing', open.filter(task => task.stage === 'doing').length),
              metric('closedToday', week[6].count), metric('cycle', timed ? (elapsed / timed / 86400000).toFixed(1) + ' ' + t('dayUnit') : '—'))),
            h('section', null, heading('weekly', 'chart'), line(t('recentCompletions'), recentTotal),
              h('div', { className: 'dsh-tasks-week' }, week.map(({ day, count }) => h('span', { key: day, title: day + ': ' + count }, count,
                h('i', { 'aria-hidden': true }, h('b', { style: { height: count / max * 100 + '%' } })), h('small', null, day.slice(5)))))),
            h('section', null, heading('breakdown', 'tag'),
              tasks.length ? h(React.Fragment, null,
                h('h4', null, t('mix')), h('div', { className: 'dsh-tasks-mix-track', 'aria-hidden': true }, priorityGroups.map(row => h('span', { key: row.key, style: { flex: row.count, background: Object.hasOwn(colors, row.key) ? colors[row.key] : 'var(--dsh-tasks-line)' } }))), tags(priorityGroups, row => row.count),
                h('h4', null, t('bindingsMix')), workspaces.map(row => line(row.label, row.count, row.key)), tags(models, row => Math.round(row.count / tasks.length * 100) + '%'))
                : h('small', null, t('noMatches')))),
          h(OverviewTaskLists, { t, open, recent, today, statuses, dueFilter: selected, openTask, priorities })))
    }

    function WorkspacePicker({ t, options, value, actions }) {
      const missing = value && value !== 'ungrouped' && !options.workspaces.some(row => row.id === value)
      return h('div', { className: 'dsh-tasks-workspace-picker', 'data-scoped': !!value || undefined },
        h(Icon, { name: 'folder' }), h(PaperSelect, { t, 'aria-label': t('workspaceFilter'), value, minPopoverWidth: 240,
          onOpen: actions.loadOptions, onChange: event => actions.setWorkspaceFilter(event.target.value),
          statusText: options.status === 'loading' ? t('loadingWorkspaces') : options.workspaceStatus !== 'ready' ? t('workspaceUnavailable') : undefined },
          h('option', { value: '' }, t('allWorkspaces')),
          h('option', { value: 'ungrouped' }, t('ungrouped')),
          options.workspaces.map(row => h('option', { key: row.id, value: row.id }, row.title)),
          missing ? h('option', { value }, options.workspaceStatus === 'ready' ? t('workspaceMissing') : t('workspace')) : null),
        h(Icon, { name: 'chevronDown', size: 13 }))
    }

    function ShortcutsDialog({ t, onClose }) {
      const items = [
        ['/', 'shortcutSearch'],
        ['N', 'shortcutNew'],
        ['R', 'shortcutRefresh'],
        ['I', 'shortcutInsights'],
        ['?', 'shortcutHelp'],
      ]
      return h(Modal, { t, paper: true, focusClose: true, title: t('shortcuts'), onClose },
        h('div', { className: 'dsh-tasks-dialog-body' },
          h('p', { className: 'dsh-tasks-field-hint' }, t('shortcutsIntro')),
          h('ul', { className: 'dsh-tasks-shortcuts-list' },
            items.map(([key, labelKey]) => h('li', { key }, h('span', null, t(labelKey)), h('kbd', null, key))))),
        h('div', { className: 'dsh-tasks-form-actions' },
          h(TaskButton, { className: 'dsh-tasks-primary', type: 'button', onClick: onClose }, t('close'))))
    }

    function BoardSettings({ t, board, actions, renderSlot, openMcp, openShortcuts, selectMode, toggleSelectMode }) {
      const command = (key, icon, action) => h(TaskButton, { className: 'dsh-tasks-command', onClick(event) {
        const details = event.currentTarget.closest('details')
        details.open = false
        details.querySelector('summary')?.focus()
        action()
      } }, h(Icon, { name: icon }), t(key))
      return h(Dropdown, { className: 'dsh-tasks-settings' },
        h('summary', { className: 'dsh-tasks-toolbar-button dsh-tasks-toolbar-icon', title: t('boardSettings'), 'aria-label': t('boardSettings') }, h(Icon, { name: 'more' })),
        h('div', { className: 'dsh-tasks-menu dsh-tasks-command-list dsh-tasks-board-settings', popover: 'manual' },
          h('div', { className: 'dsh-tasks-menu-label' }, t('boardSettings')),
          board ? command('labels', 'tag', () => actions.showColumns('labels')) : null,
          board ? command('columns', 'board', () => actions.showColumns(true)) : null,
          command(selectMode ? 'batchExit' : 'batchSelect', 'check', toggleSelectMode),
          command('shortcuts', 'question', openShortcuts),
          command('mcpAccess', 'link', openMcp),
          renderSlot?.(APPEARANCE_SLOT, {})))
    }

    function useBoardWidth() {
      const ref = React.useRef(null)
      const [width, setWidth] = React.useState(0)
      React.useEffect(() => {
        if (!ref.current || !window.ResizeObserver) return
        const observer = new window.ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
        observer.observe(ref.current)
        return () => observer.disconnect()
      }, [])
      return [ref, width]
    }

    function AttentionBar({ t, tasks, statuses, actions, options, workspaceFilter }) {
      const detailsRef = React.useRef(null)
      const [open, setOpen] = React.useState(false)
      const [selectedReason, setSelectedReason] = React.useState(null)
      const groups = new Map(attentionKinds.map(kind => [kind, []]))
      for (const task of tasks) {
        const reason = attentionOf(task, statuses)
        if (reason) groups.get(reason).push(task)
      }
      const entries = [...groups].filter(([, rows]) => rows.length)
      if (!entries.length) return null
      const count = entries.reduce((total, [, rows]) => total + rows.length, 0)
      const activeReason = selectedReason && groups.get(selectedReason)?.length ? selectedReason : null
      const visibleEntries = activeReason ? entries.filter(([reason]) => reason === activeReason) : entries
      const tone = groups.get('error').length ? 'danger'
        : (groups.get('approval').length || groups.get('question').length || groups.get('reviewReturned').length) ? 'warn' : 'action'
      const firstTask = entries[0][1][0]
      return h('details', {
        ref: detailsRef, className: 'dsh-tasks-attention', 'data-needs-attention': count, 'data-attention-tone': tone,
        onToggle(event) {
          const isOpen = event.currentTarget.open
          setOpen(isOpen)
          if (!isOpen) setSelectedReason(null)
        },
      },
      h('summary', { className: 'dsh-tasks-attention-summary' },
        h('span', { className: 'dsh-tasks-attention-badge', 'aria-hidden': true }, h(Icon, { name: 'spark', size: 14 })),
        h('strong', null, t('needsMyAction') + ' · ' + count),
        h('span', { className: 'dsh-tasks-attention-counts' }, entries.map(([reason, rows]) => h('small', { key: reason, 'data-reason': reason },
          h('button', {
            type: 'button',
            className: 'dsh-tasks-attention-pill',
            'aria-pressed': activeReason === reason,
            'data-active': activeReason === reason || undefined,
            title: t(activeReason === reason ? 'attentionPillShowAll' : 'attentionPillFilter') + ': ' + t(reason),
            onKeyUp(event) { if (event.key === ' ') event.preventDefault() },
            onClick(event) {
              event.preventDefault()
              event.stopPropagation()
              const el = detailsRef.current
              if (entries.length === 1) {
                const nextOpen = !(el ? el.open : open)
                if (el) el.open = nextOpen
                setOpen(nextOpen)
                setSelectedReason(null)
                return
              }
              if ((el ? el.open : open) && activeReason === reason) {
                setSelectedReason(null)
              } else {
                setSelectedReason(reason)
                if (el && !el.open) el.open = true
                setOpen(true)
              }
            },
          }, t(reason) + ' ' + rows.length)))),
        h('span', { className: 'dsh-tasks-attention-preview', 'aria-hidden': true },
          h('span', { title: firstTask.title }, firstTask.title),
          count > 1 ? h('span', { className: 'dsh-tasks-attention-preview-more' }, '+' + (count - 1)) : null),
        h('span', { className: 'dsh-tasks-attention-toggle', 'aria-hidden': true }, h(Icon, { name: 'chevronDown', size: 14 }))),
      h('div', { className: 'dsh-tasks-attention-list' }, visibleEntries.map(([reason, rows]) => {
        const isDelivery = reason === 'reviewPending' || reason === 'reviewReturned'
        const actionLabel = t(isDelivery ? 'reviewDelivery' : 'openSession')
        return h('section', { key: reason, 'data-reason': reason, 'aria-label': t(reason) },
          h('div', { className: 'dsh-tasks-attention-group-head' },
            h(Icon, { name: attentionIcons[reason] || 'spark', size: 13 }),
            h('strong', null, t(reason)),
            h('small', { 'aria-hidden': true }, rows.length),
            activeReason && entries.length > 1 ? h('button', {
              type: 'button', className: 'dsh-tasks-attention-show-all',
              onClick: () => setSelectedReason(null),
            }, t('attentionShowAll').replace('{count}', String(count))) : null),
          h('ul', null, rows.map(task => {
            const ws = !workspaceFilter && options ? workspaceLabel(t, task, options) : ''
            return h('li', { key: task.id }, h(TaskButton, {
              className: 'dsh-tasks-attention-item',
              onClick: () => isDelivery ? actions.openDetails(task.id, 'deliveryTab') : actions.openSession(task.activeSessionId),
            },
            h('span', { className: 'dsh-tasks-attention-item-title', title: task.title }, task.title),
            h('span', { className: 'dsh-tasks-attention-item-meta', 'aria-hidden': true },
              ws ? h('span', { className: 'dsh-tasks-attention-item-ws', title: ws }, h(Icon, { name: 'folder', size: 11 }), h('span', null, ws)) : null,
              h('span', { className: 'dsh-tasks-attention-item-action' }, actionLabel, h(Icon, { name: 'chevron', size: 12 })))))
          })))
      })))
    }

    const emptyFilters = {}, emptyColumnTasks = []
    const BoardAttention = React.memo(AttentionBar)
    const BoardInsights = React.memo(WorkspaceInsights)

    function TaskBoard({ t, useTasks, actions, renderSlot }) {
      const [mcpOpen, setMcpOpen] = React.useState(false)
      const [shortcutsOpen, setShortcutsOpen] = React.useState(false)
      const [selectMode, setSelectMode] = React.useState(false)
      const [selectedIds, setSelectedIds] = React.useState(() => new Set())
      const [batchBusy, setBatchBusy] = React.useState(false)
      const [batchDeleteOpen, setBatchDeleteOpen] = React.useState(false)
      const [batchDeleteError, setBatchDeleteError] = React.useState(undefined)
      const [panelRef, panelWidth] = useBoardWidth()
      React.useEffect(() => { void actions.loadOptions() }, [actions])
      const { status, errorCode, tasks, hasLoaded, sync, query, form, quickCreating, unlockNotice, sortBy = 'manual', stages, options, workspaceFilter, collapsed, showAllDone, overview, detailId, detailView, editor, launchForm, statuses, navigationError, restore, deletion, board, managing, boardBusy, boardError, filters = emptyFilters, matches, searchError, comments, activity, imageJobs, deliveryMutation } = useTasks(state => state)
      const columns = board?.columns || defaults
      const byId = React.useMemo(() => taskIndex(tasks), [tasks])
      const detailTask = byId.get(detailId)
      const launchTarget = byId.get(launchForm?.taskId)
      const filterCount = Object.values(filters).filter(Boolean).length
      const hasSort = sortBy !== 'manual'
      const search = query.trim().toLocaleLowerCase()
      const filtered = !!search || !!workspaceFilter || !!filterCount
      const sizes = React.useMemo(() => {
        const counts = new Map()
        for (const task of tasks) { const key = taskColumn(task); counts.set(key, (counts.get(key) || 0) + 1) }
        return counts
      }, [tasks])
      const isCollapsed = column => !(search || filterCount) && (collapsed[column.id]
        ?? (hasLoaded && !filtered && column.stage !== 'done' && column.id !== 'stage:' + column.stage && !sizes.get(column.id)))
      const collapsedCount = columns.filter(isCollapsed).length
      const expandedCount = columns.length - collapsedCount
      const gaps = Math.max(0, columns.length - 1)
      // Match the CSS gutters; the overview should never be the reason a column has to scroll.
      const gutter = Math.min(boardLayout.maxGutter, Math.max(12, panelWidth * .016))
      const gap = Math.min(boardLayout.maxGap, Math.max(12, panelWidth * .014))
      const required = expandedCount * boardLayout.columnMin + collapsedCount * boardLayout.collapsed + gaps * gap + 3 * gutter + boardLayout.insightsMin
      const canDockInsights = panelWidth >= Math.max(boardLayout.wide, Math.ceil(required))
      const showInsights = !!board && hasLoaded && !!overview
      const catalog = board?.priorities ?? fallbackPriorities
      const extraPriorities = React.useMemo(() => {
        const known = new Set(catalog.map(row => row.key))
        return JSON.stringify([...new Set(tasks.map(task => task.priority).filter(key => key && !known.has(key)))].sort())
      }, [catalog, tasks])
      const priorities = React.useMemo(() => new Map([
        ...catalog.map(({ key, name }) => [key, name]), ...JSON.parse(extraPriorities).map(key => [key, key]),
      ]), [catalog, extraPriorities])
      const boardFeedback = { 'tasks/revision-conflict': 'boardConflict', 'tasks/label-in-use': 'labelProtected',
        'tasks/column-not-empty-or-default': 'columnProtected', 'tasks/delivery-review-required': 'deliveryActionRequired' }
      const feedback = boardError ? h('p', { className: 'dsh-tasks-feedback', role: 'alert' }, t(boardFeedback[boardError] || 'boardFailed')) : null
      const ready = hasLoaded
      const writable = status === 'ready'
      // The modal already prevents interacting with the board while it saves. Keep the
      // controls behind it stable; the store still enforces the full write lock.
      const writingBoard = boardWritePending({ form, quickCreating, launchForm, deletion, stages, deliveryMutation })
      const writing = writingBoard || !!editor?.pending
      const workspaceTasks = React.useMemo(() => !workspaceFilter ? tasks : tasks.filter(task => workspaceFilter === 'ungrouped'
        ? !task.workspaceId : task.workspaceId === workspaceFilter), [tasks, workspaceFilter])
      const hasRunning = React.useMemo(() => workspaceTasks.some(task => task.stage !== 'done' && runtimeOf(task, statuses) === 'running'), [workspaceTasks, statuses])
      const nowTick = useNowTick(hasRunning)
      const workspaceScope = !workspaceFilter ? t('allWorkspaces') : workspaceLabel(t, { workspaceId: workspaceFilter === 'ungrouped' ? undefined : workspaceFilter }, options)
      const today = useLocalDay()
      const scoped = React.useMemo(() => [...workspaceTasks].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)).flatMap(task => {
        if (filters.labelId && filters.labelId !== task.labelId || filters.priority && filters.priority !== task.priority
          || filters.ready && !isReadyToStart(task, byId)) return []
        if (!search || [task.id, task.title, task.brief || '', task.acceptanceCriteria || ''].some(text => text.toLocaleLowerCase().includes(search))) return [task]
        return matches?.[task.id] ? [{ ...task, snippet: matches[task.id] }] : []
      }), [workspaceTasks, filters.labelId, filters.priority, filters.ready, byId, search, matches])
      const { tasksByColumn, count } = React.useMemo(() => {
        const tasksByColumn = new Map()
        let count = 0
        for (const task of scoped) {
          if (filters.dueDate && dueBucket(task, today) !== filters.dueDate) continue
          const key = board ? taskColumn(task) : 'stage:' + task.stage
          if (!tasksByColumn.has(key)) tasksByColumn.set(key, [])
          tasksByColumn.get(key).push(task)
          count++
        }
        for (const [key, rows] of tasksByColumn) {
          rows.sort((a, b) => a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0)
          if (hasSort) tasksByColumn.set(key, sortColumnTasks(rows, sortBy, priorities))
        }
        return { tasksByColumn, count }
      }, [scoped, filters.dueDate, today, !!board, hasSort, sortBy, priorities])
      const visibleTaskIds = React.useMemo(() => {
        const ids = []
        for (const rows of tasksByColumn.values()) for (const row of rows) ids.push(row.id)
        return ids
      }, [tasksByColumn])
      const selectedTasks = React.useMemo(() => [...selectedIds].map(id => byId.get(id)).filter(Boolean), [selectedIds, byId])
      const toggleSelect = React.useCallback(id => {
        setSelectedIds(prev => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }, [])
      const exitSelectMode = React.useCallback(() => {
        setSelectMode(false)
        setSelectedIds(new Set())
        setBatchDeleteOpen(false)
        setBatchDeleteError(undefined)
      }, [])
      const toggleSelectMode = React.useCallback(() => {
        if (selectMode) exitSelectMode()
        else setSelectMode(true)
      }, [selectMode, exitSelectMode])
      const runBatchMove = async targetColumn => {
        if (!selectedTasks.length || batchBusy || !writable || writing) return
        const targets = selectedTasks.filter(task => taskColumn(task) !== targetColumn.id && !(targetColumn.stage === 'done' && deliveryOpen(task)))
        if (!targets.length) return
        setBatchBusy(true)
        try {
          for (const task of targets) {
            if (board) await actions.move({ taskId: task.id, expectedRevision: task.revision, columnId: targetColumn.id })
            else await actions.setStage(task.id, targetColumn.stage)
          }
          setSelectedIds(new Set())
        } finally {
          setBatchBusy(false)
        }
      }
      const runBatchDone = async () => {
        if (!selectedTasks.length || batchBusy || !writable || writing) return
        const targets = selectedTasks.filter(task => task.stage !== 'done' && !unfinishedLaunch(task) && !deliveryOpen(task))
        if (!targets.length) return
        setBatchBusy(true)
        try {
          for (const task of targets) await actions.setStage(task.id, 'done')
          setSelectedIds(new Set())
        } finally {
          setBatchBusy(false)
        }
      }
      const runBatchDelete = async () => {
        if (!selectedTasks.length || batchBusy || !writable || writing) return
        const targets = [...selectedTasks]
        setBatchBusy(true)
        setBatchDeleteError(undefined)
        const failedIds = []
        let firstErrorCode
        try {
          for (const task of targets) {
            const res = await actions.deleteTaskById(task.id, task.revision)
            if (!res?.ok) {
              failedIds.push(task.id)
              if (!firstErrorCode) firstErrorCode = res?.code
            }
          }
          setSelectedIds(new Set(failedIds))
          if (!failedIds.length) {
            setBatchDeleteOpen(false)
          } else {
            setBatchDeleteError(
              firstErrorCode === 'tasks/revision-conflict' ? t('deleteConflict')
                : firstErrorCode === 'tasks/launch-pending' ? t('deletePendingLaunch')
                : firstErrorCode === 'tasks/delete-unknown' ? t('deleteUnknown')
                : failureText(t, firstErrorCode, 'deleteFailed'),
            )
          }
        } finally {
          setBatchBusy(false)
        }
      }
      React.useEffect(() => {
        if (!window.addEventListener) return
        const onKeyDown = event => {
          if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return
          const target = event.target
          if (target?.closest?.('input, textarea, select, [contenteditable="true"], [role="combobox"], [role="textbox"]')) return
          if (form.open || detailId || launchForm?.open || deletion || restore || managing || mcpOpen || shortcutsOpen || batchDeleteOpen
            || window.document?.querySelector?.('dialog[open]')) return
          if (!panelRef.current?.getClientRects?.().length) return
          if (event.key === '/' && !event.shiftKey) {
            event.preventDefault()
            const input = panelRef.current.querySelector('.dsh-tasks-search input, input.dsh-tasks-search')
            input?.focus({ preventScroll: true })
          } else if ((event.key === 'n' || event.key === 'N') && !event.shiftKey) {
            event.preventDefault()
            actions.openForm()
          } else if ((event.key === 'r' || event.key === 'R') && !event.shiftKey && status !== 'loading' && !writing) {
            event.preventDefault()
            void actions.refresh(); void actions.loadOptions()
          } else if ((event.key === 'i' || event.key === 'I') && !event.shiftKey && board && ready) {
            event.preventDefault()
            actions.toggleOverview()
          } else if (event.key === '?') {
            event.preventDefault()
            setShortcutsOpen(true)
          } else if (event.key === 'Escape' && selectMode) {
            event.preventDefault()
            exitSelectMode()
          }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [actions, board, ready, status, writing, form.open, detailId, launchForm?.open, deletion, restore, managing, mcpOpen, shortcutsOpen, batchDeleteOpen, selectMode, exitSelectMode])
      const message = status === 'loading' ? t('loading') : status === 'error'
        ? failureText(t, errorCode, 'loadFailed')
        : tasks.length ? t(filtered ? 'matched' : 'total') + ': ' + count : t('loaded')
      const empty = key => t(ready ? filtered ? 'noMatches' : key
        : status === 'loading' ? 'loading' : 'listUnavailable')
      return h(
        'div',
        { ref: panelRef, className: 'dsh-tasks-root dsh-tasks-board-view', 'aria-busy': status === 'loading',
          // Older appearance clients set their own container shorthand on the same root.
          style: { container: 'task-panel dsh-tasks / inline-size' } },
        h(Styles, null),
        h('header', { className: 'dsh-tasks-board-toolbar' },
          h('div', { className: 'dsh-tasks-heading' },
            h('span', { className: 'dsh-tasks-icon dsh-tasks-logo' }, h(Icon, { name: 'board', size: 17 })),
            h('h1', { className: 'dsh-tasks-title' }, h('span', { className: 'dsh-tasks-host-title' }, t('title')), h('span', { className: 'dsh-tasks-paper-title' }, t('paperTitle')))),
          h('div', { className: 'dsh-tasks-toolbar-filters' },
            h(WorkspacePicker, { t, options, value: workspaceFilter, actions }),
            h('div', { className: 'dsh-tasks-search-wrap' }, h(Icon, { name: 'search' }), h(TaskInput, {
              className: 'dsh-tasks-search', type: 'search', maxLength: 2048, placeholder: t('searchPlaceholder'),
              'aria-label': t('search'), title: t('search'), value: query, onChange: event => actions.setQuery(event.target.value),
            })),
            board ? h(Dropdown, { className: 'dsh-tasks-filter' },
              h('summary', { className: 'dsh-tasks-toolbar-button', title: t('filter'), 'aria-label': filterCount + (hasSort ? 1 : 0) ? t('filter') + ' · ' + t('filterCount') + ': ' + (filterCount + (hasSort ? 1 : 0)) : t('filter') },
                h(Icon, { name: 'filter' }), h('span', { className: 'dsh-tasks-filter-label' }, t('filter')), filterCount + (hasSort ? 1 : 0) ? h('span', { className: 'dsh-tasks-counter', 'aria-hidden': true }, filterCount + (hasSort ? 1 : 0)) : null),
              h('div', { className: 'dsh-tasks-menu dsh-tasks-filter-panel', popover: 'manual' },
                h('div', { className: 'dsh-tasks-filter-head' }, h('strong', null, t('filter')), h(TaskButton, { className: 'dsh-tasks-text-action', disabled: !filterCount && !hasSort, onClick(event) {
                  event.currentTarget.closest('.dsh-tasks-filter-panel').querySelector('[role="combobox"]').focus({ preventScroll: true })
                  actions.clearFilters()
                } }, t('resetFilters'))),
                h(Properties, { t, board, priorities, values: filters, change: actions.setFilter, filter: true }),
                h('label', null, t('sortBy'), h(PaperSelect, {
                  t, className: 'dsh-tasks-stage', name: 'sortBy', 'aria-label': t('sortBy'), value: sortBy,
                  onChange: event => actions.setSortBy(event.target.value),
                }, SORT_MODES.map(mode => h('option', { key: mode, value: mode }, t(SORT_LABELS[mode]))))),
                h(TaskButton, { className: 'dsh-tasks-ready-filter', 'aria-pressed': !!filters.ready,
                  onClick: () => actions.setFilter('ready', !filters.ready) }, h(Icon, { name: 'check', size: 14 }), t('dependencyReady')))) : null),
          h('div', { className: 'dsh-tasks-toolbar-actions' },
            board && ready ? h(TaskButton, { className: 'dsh-tasks-icon-button dsh-tasks-toolbar-button dsh-tasks-toolbar-icon',
              'aria-label': t('insights'), title: t('insights'), 'aria-expanded': showInsights, onClick: actions.toggleOverview }, h(Icon, { name: 'chart' })) : null,
            h(BoardSettings, { t, board, actions, renderSlot, openMcp: () => setMcpOpen(true), openShortcuts: () => setShortcutsOpen(true), selectMode, toggleSelectMode }),
            h(TaskButton, { className: 'dsh-tasks-icon-button dsh-tasks-toolbar-button dsh-tasks-toolbar-icon', onClick: () => { void actions.refresh(); void actions.loadOptions() },
              'aria-label': t('refresh'), title: t('refresh'), disabled: status === 'loading' || writing }, h(Icon, { name: 'refresh' })),
            h(TaskButton, { className: 'dsh-tasks-primary dsh-tasks-toolbar-button', onClick: () => actions.openForm(),
              'aria-haspopup': 'dialog', 'aria-expanded': form.open, 'aria-label': t(form.retryInput || form.pending ? 'resumeCreate' : 'newTask'),
              title: t(form.retryInput || form.pending ? 'resumeCreate' : 'newTask') }, h(Icon, { name: 'plus' }),
              h('span', { className: 'dsh-tasks-create-label' }, t(form.retryInput || form.pending ? 'resumeCreate' : 'newTask'))))),
        h(BoardAttention, { t, tasks: workspaceTasks, statuses, actions, options, workspaceFilter }),
        mcpOpen ? h(McpAccessDialog, { t, manage: actions.mcpAccess, onClose: () => setMcpOpen(false) }) : null,
        shortcutsOpen ? h(ShortcutsDialog, { t, onClose: () => setShortcutsOpen(false) }) : null,
        form.open ? h(CreateForm, { t, form, actions, writable, options, board, boardBusy, priorities, byId, jobs: imageJobs?.draft }) : null,
        searchError ? h('p', { role: 'alert' }, t('searchFailed'), h(TaskButton, { onClick: actions.retrySearch }, t('retry'))) : null,
        managing && board ? h(managing === 'labels' ? LabelManager : ColumnManager, { t, board, actions, tasks, selected: managing, busy: boardBusy || !writable || sync !== 'live', error: feedback }) : feedback,
        navigationError ? h('p', { className: 'dsh-tasks-feedback', role: 'alert' }, failureText(t, navigationError, 'navigationFailed')) : null,
        launchForm?.open && launchTarget ? h(LaunchForm, { t, form: launchForm, jobs: imageJobs?.[launchForm.taskId], task: launchTarget,
          options, actions, writable, runtime: runtimeOf(launchTarget, statuses), dependenciesBlocked: !!blockersOf(launchTarget, byId).length }) : null,
        detailTask ? h(TaskDetails, { key: detailId, t, priorities, task: detailTask, runtime: runtimeOf(detailTask, statuses),
          column: columns.find(column => column.id === taskColumn(detailTask)), editor, board, draft: comments?.[detailId], jobs: imageJobs?.[detailId],
          activity, options, actions, writable, writing, byId, view: detailView,
          mutation: deliveryMutation?.input.taskId === detailId && deliveryMutation.input.deliveryId === detailTask.delivery?.id ? deliveryMutation : undefined }) : null,
        deletion ? h(DeleteDialog, { t, deletion, actions, writable }) : null,
        selectMode && batchDeleteOpen ? h(Modal, {
          t,
          title: t('batchConfirmDelete').replace('{count}', String(selectedTasks.length)),
          dismissDisabled: batchBusy,
          onClose: () => { if (!batchBusy) { setBatchDeleteOpen(false); setBatchDeleteError(undefined) } },
        },
        h('div', { className: 'dsh-tasks-dialog-body' },
          selectedTasks.slice(0, 5).map(task => h('p', { key: task.id, className: 'dsh-tasks-delete-title' }, task.title)),
          selectedTasks.length > 5 ? h('p', null, t('batchDeleteMore').replace('{count}', String(selectedTasks.length - 5))) : null,
          h('p', null, t('deleteNotice')),
          batchDeleteError ? h('p', { className: 'dsh-tasks-feedback', role: 'alert' }, batchDeleteError) : null),
        h('div', { className: 'dsh-tasks-form-actions' },
          h('span', { className: 'dsh-tasks-spacer' }),
          h(TaskButton, {
            className: 'dsh-tasks-secondary',
            'data-dsh-initial-focus': '',
            disabled: batchBusy,
            onClick: () => { setBatchDeleteOpen(false); setBatchDeleteError(undefined) },
          }, t('cancelDelete')),
          h(TaskButton, {
            className: 'dsh-tasks-primary dsh-tasks-danger',
            disabled: !writable || batchBusy || !selectedTasks.length,
            onClick: () => { void runBatchDelete() },
          }, t(batchBusy ? 'deleting' : 'batchDelete')))) : null,
        restore ? h(RestoreDialog, { t, restore, actions }) : null,
        filterCount || hasSort ? (() => {
          const activeLabel = filters.labelId ? (board?.labels ?? []).find(row => row.id === filters.labelId) : undefined
          const labelText = activeLabel?.name || filters.labelId
          const priorityText = filters.priority ? priorityLabel(priorities, filters.priority) : ''
          const activeChipCount = filterCount + (hasSort ? 1 : 0)
          return h('div', { className: 'dsh-tasks-active-filters', role: 'group', 'aria-label': t('filterCount') },
            filters.labelId ? h('button', {
              type: 'button', className: 'dsh-tasks-filter-chip', 'data-filter-key': 'labelId',
              'aria-label': t('removeFilter') + ': ' + t('labelId') + ' ' + labelText,
              onClick: () => actions.setFilter('labelId', ''),
            },
            activeLabel?.color ? h('span', { className: 'dsh-tasks-filter-chip-swatch', 'aria-hidden': true, style: { background: activeLabel.color } }) : h(Icon, { name: 'tag', size: 12 }),
            h('span', { className: 'dsh-tasks-filter-chip-key' }, t('labelId')),
            h('span', { className: 'dsh-tasks-filter-chip-value', title: labelText }, labelText),
            h(Icon, { name: 'close', size: 12 })) : null,
            filters.priority ? h('button', {
              type: 'button', className: 'dsh-tasks-filter-chip', 'data-filter-key': 'priority', 'data-priority': filters.priority,
              'aria-label': t('removeFilter') + ': ' + t('priority') + ' ' + priorityText,
              onClick: () => actions.setFilter('priority', ''),
            },
            h(Icon, { name: 'flag', size: 12 }),
            h('span', { className: 'dsh-tasks-filter-chip-key' }, t('priority')),
            h('span', { className: 'dsh-tasks-filter-chip-value', title: priorityText }, priorityText),
            h(Icon, { name: 'close', size: 12 })) : null,
            filters.dueDate ? h('button', {
              type: 'button', className: 'dsh-tasks-due-chip', 'data-filter-key': 'dueDate', 'data-overdue': filters.dueDate === 'overdue' || undefined,
              'aria-label': t('removeDue') + ': ' + t(filters.dueDate),
              onClick: () => actions.setFilter('dueDate', ''),
            },
            h(Icon, { name: dueIcons[filters.dueDate] || 'calendar', size: 12 }),
            h('span', { className: 'dsh-tasks-filter-chip-value' }, t(filters.dueDate)),
            h(Icon, { name: 'close', size: 12 })) : null,
            filters.ready ? h('button', {
              type: 'button', className: 'dsh-tasks-filter-chip', 'data-filter-key': 'ready',
              'aria-label': t('removeFilter') + ': ' + t('dependencyReady'),
              onClick: () => actions.setFilter('ready', false),
            },
            h(Icon, { name: 'check', size: 12 }),
            h('span', { className: 'dsh-tasks-filter-chip-value' }, t('dependencyReady')),
            h(Icon, { name: 'close', size: 12 })) : null,
            hasSort ? h('button', {
              type: 'button', className: 'dsh-tasks-filter-chip', 'data-filter-key': 'sortBy',
              'aria-label': t('removeSort') + ': ' + t(SORT_LABELS[sortBy]),
              onClick: () => actions.setSortBy('manual'),
            },
            h(Icon, { name: 'move', size: 12 }),
            h('span', { className: 'dsh-tasks-filter-chip-key' }, t('sortBy')),
            h('span', { className: 'dsh-tasks-filter-chip-value' }, t(SORT_LABELS[sortBy])),
            h(Icon, { name: 'close', size: 12 })) : null,
            activeChipCount >= 2 ? h('button', { type: 'button', className: 'dsh-tasks-filter-clear', onClick: actions.clearFilters }, t('resetFilters')) : null)
        })() : null,
        h('div', { className: 'dsh-tasks-workspace', 'data-show-insights': showInsights && canDockInsights || undefined,
          'data-overlay-insights': showInsights && !canDockInsights || undefined,
          style: { '--dsh-tasks-expanded': expandedCount, '--dsh-tasks-collapsed': collapsedCount, '--dsh-tasks-gaps': gaps } },
        board && ready ? h(BoardInsights, { t, scope: workspaceScope, tasks: scoped, columns, priorities, options, statuses, sync, today,
          selected: filters.dueDate, change: actions.setFilter, openTask: actions.openDetails, onClose: actions.toggleOverview }) : null,
        h(DragBoard, { t, onMove: actions.move, onColumnOrder: (id, target, side, revision) => reorderColumn(board, actions, id, target, side, revision) }, h(
          'div',
          { className: 'dsh-tasks-board dsh-tasks-board-strip', role: 'region', 'aria-label': t('boardColumns'), tabIndex: 0 },
          columns.map(column => h(BoardColumn, {
            key: column.id, t, stage: column.stage, column, board, name: columnLabel(t, column), empty: empty({ todo: 'emptyTodo', doing: 'emptyDoing', done: 'emptyDone' }[column.stage]),
            ready, tasks: tasksByColumn.get(column.id) ?? emptyColumnTasks,
            total: sizes.get(column.id) ?? 0, filtered, sortBy, allowCollapse: !search && !filterCount,
            stages, actions, writable: writable && (!board || sync === 'live'), writing: writingBoard || boardBusy, options,
            collapsed: isCollapsed(column), showAllDone: showAllDone[column.id], statuses, priorities, byId, today, workspaceFilter,
            selectMode, selectedIds, onToggleSelect: toggleSelect, nowTick: hasRunning ? nowTick : undefined,
          })),
        ))),
        selectMode ? h('div', { className: 'dsh-tasks-batch-bar', role: 'region', 'aria-label': t('batchSelect') },
          h('span', { className: 'dsh-tasks-batch-count' }, t('batchSelected').replace('{count}', String(selectedTasks.length))),
          h('div', { className: 'dsh-tasks-batch-actions' },
            h(TaskButton, { className: 'dsh-tasks-secondary', disabled: batchBusy || !visibleTaskIds.length, onClick: () => setSelectedIds(new Set(visibleTaskIds)) }, t('batchSelectAll')),
            selectedTasks.length ? h(TaskButton, { className: 'dsh-tasks-secondary', disabled: batchBusy, onClick: () => setSelectedIds(new Set()) }, t('batchClear')) : null,
            h(Dropdown, { className: 'dsh-tasks-batch-move' },
              h('summary', { className: 'dsh-tasks-secondary', 'aria-disabled': !selectedTasks.length || batchBusy || !writable || writing || undefined }, t('batchMoveTo')),
              h('div', { className: 'dsh-tasks-menu dsh-tasks-command-list', popover: 'manual' },
                columns.map(column => h(TaskButton, {
                  key: column.id, className: 'dsh-tasks-command',
                  disabled: !selectedTasks.length || batchBusy || !writable || writing,
                  onClick(event) {
                    event.currentTarget.closest('details').open = false
                    void runBatchMove(column)
                  },
                }, columnLabel(t, column))))),
            h(TaskButton, { className: 'dsh-tasks-primary', disabled: !selectedTasks.length || batchBusy || !writable || writing, onClick: runBatchDone }, t('batchMarkDone')),
            h(TaskButton, {
              className: 'dsh-tasks-secondary dsh-tasks-danger',
              disabled: !selectedTasks.length || batchBusy || !writable || writing,
              onClick: () => { setBatchDeleteError(undefined); setBatchDeleteOpen(true) },
            }, t('batchDelete')),
            h(TaskButton, { className: 'dsh-tasks-secondary', disabled: batchBusy, onClick: exitSelectMode }, t('batchExit')))) : null,
        unlockNotice ? h('div', { className: 'dsh-tasks-unlock-toast', role: 'status', 'aria-live': 'polite' },
          h('span', { className: 'dsh-tasks-unlock-icon', 'aria-hidden': true }, h(Icon, { name: 'check', size: 13 })),
          h('div', { className: 'dsh-tasks-unlock-body' },
            h('strong', null, t('unlockedNotice').replace('{count}', String(unlockNotice.tasks.length))),
            h('div', { className: 'dsh-tasks-unlock-links' },
              unlockNotice.tasks.slice(0, 2).map(item => h('button', {
                key: item.id, type: 'button', className: 'dsh-tasks-unlock-link', title: item.title,
                onClick: () => { actions.dismissUnlockNotice(); actions.openDetails(item.id) },
              }, item.title)),
              unlockNotice.tasks.length > 2 ? h('span', { className: 'dsh-tasks-unlock-more' }, '+' + (unlockNotice.tasks.length - 2)) : null)),
          h(TaskButton, { className: 'dsh-tasks-icon-button', 'aria-label': t('close'), title: t('close'), onClick: actions.dismissUnlockNotice }, h(Icon, { name: 'close', size: 13 }))) : null,
        h('div', { className: 'dsh-tasks-footnote dsh-tasks-board-view-footer', role: status === 'error' ? 'alert' : 'status' },
          h('span', null, h(Icon, { name: 'board', size: 12 }), message),
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
        const tasks = createTaskList(ctx.connection, {
          archived: id => ctx.get('workspaces')?.list.getSnapshot().archivedSessionIds.includes(id),
          open: id => ctx.get('uiWorkspace').openSession(id),
          restore: id => ctx.get('uiWorkspace').unarchiveSession(id),
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
            children: { [APPEARANCE_SLOT]: { kind: 'single', scope: 'root', inline: true } },
            inject: () => ({ t, hooks: { tasks }, actions: tasks }),
          }, TaskBoard),
        )

        ctx.inject(['layout', 'contextMenus'], branch => registerSessionTaskMenu(branch, tasks, t))
      },
    }
  },
})
