import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import React from 'react'

// Exercise the source factory (not yesterday's built bundle) without adding public exports.
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
function harness() {
  let active
  const detailHooks = [], descriptionHooks = [], calls = []
  function render(fn, props, slots) {
    active = { slots, index: 0 }
    try { return fn(props) } finally { active = undefined }
  }
  function hook(initial) {
    const { slots } = active, index = active.index++
    if (!(index in slots)) slots[index] = initial()
    return [slots, index]
  }
  // No DOM is mounted here; focus effects are covered by the browser probe.
  const hooks = { ...React, useId: () => 'confirm-id', useLayoutEffect() {}, useRef(initial) {
    if (!active) return { current: initial }
    const [slots, index] = hook(() => ({ current: initial }))
    return slots[index]
  }, useState(initial) {
    const [slots, index] = hook(() => typeof initial === 'function' ? initial() : initial)
    return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
  } }
  const window = { navigator: { clipboard: { writeText: async value => { calls.push(['copy', value]) } } },
    __ModuleLoader__: { load({ factory }) { factory(name => name === 'react' ? hooks : name.endsWith('ui-primitives') ? { Checkbox: 'checkbox', MarkdownText: 'markdown-text' } : {}) } } }
  runInNewContext(source.replace('factory(require) {', 'factory(require) { window.components = () => ({CreateForm, TaskDetails, LaunchForm, McpAccessDialog});'), { window })
  const { CreateForm, TaskDetails, LaunchForm, McpAccessDialog } = window.components()
  const actions = new Proxy({}, { get: (_, method) => (...args) => calls.push([method, ...args]) })
  const task = { id: 'task', title: 'Task', stage: 'todo', revision: 1 }, options = { groups: [], workspaces: [] }
  const props = { t: key => key, writable: true, runtime: 'idle', actions, task, options }
  return { calls, task, details(editor, extra) { return render(TaskDetails, { ...props, editor, ...extra }, detailHooks) },
    create(form, extra) { return CreateForm({ ...props, form, ...extra }) },
    description(tree) {
      const fields = component(tree, 'TaskEditorFields')
      const description = component(fields.type(fields.props), 'TaskDescription')
      assert(description, 'the shared editor renders TaskDescription')
      return render(description.type, description.props, descriptionHooks)
    },
    launch(form, extra) { return LaunchForm({ ...props, form: { content: 'First message', ...form }, ...extra }) },
    access(manage) {
      const dialog = new McpAccessDialog({ ...props, manage, onClose: () => calls.push(['close']) })
      dialog.setState = changes => { dialog.state = { ...dialog.state, ...changes } }
      return dialog
    } }
}
function nodes(element) {
  return React.Children.toArray(element).flatMap(child => React.isValidElement(child) ? [child, ...nodes(child.props.children)] : [])
}
const button = (tree, label) => nodes(tree).find(el => el.props.children === label && el.props.onClick)
const submit = tree => nodes(tree).find(el => el.props.type === 'submit')
const send = tree => nodes(tree).find(el => el.type === 'form').props.onSubmit({ preventDefault() {} })
const edit = { title: 'Edited', revision: 1 }

const component = (tree, name) => nodes(tree).find(el => el.type.name === name)

test('Create and detail share task editor layout without sharing write or attachment permissions', () => {
  const ui = harness(), board = { labels: [] }, form = { title: 'Draft', brief: '', stage: 'todo' }
  const create = ui.create(form, { board, boardBusy: true })
  const detail = ui.details({ ...edit, brief: 'New description' }, { board })
  const draftFields = component(create, 'TaskEditorFields'), detailFields = component(detail, 'TaskEditorFields')
  assert.equal(draftFields.type, detailFields.type)
  assert.equal(component(create, 'TaskDrawer').props.editorInk, true)
  assert.equal(component(detail, 'TaskDrawer').props.editorInk, true)
  const inspect = fields => {
    const layout = fields.type(fields.props)
    const fieldset = nodes(layout).find(el => el.props.className?.includes('dsh-tasks-task-fields'))
    const order = React.Children.toArray(fieldset.props.children).map(el => el.type === 'label' ? el.props.children[1].props.name : el.type.name)
    assert.deepEqual(order, ['title', 'TaskDescription', 'Properties', 'PreferenceFields'])
    assert(!component(fieldset, 'TaskImages'))
    const attachments = component(layout, 'TaskImages')
    assert(attachments)
    return { fieldset, attachments }
  }
  const draftLayout = inspect(draftFields), detailLayout = inspect(detailFields)
  assert.equal(draftLayout.fieldset.props.disabled, true)
  assert.equal(draftLayout.attachments.props.locked, true)
  assert.equal(detailLayout.fieldset.props.disabled, false)
  assert.equal(detailLayout.attachments.props.task, ui.task)
  assert.equal(submit(create).props.disabled, true)
  assert(button(detail, 'saveDetails'))
  assert(!button(detail, 'launch'))
})

const briefField = tree => nodes(tree).find(el => el.type.name === 'TaskTextArea' && el.props.name === 'brief')
const markdown = tree => nodes(tree).find(el => el.type === 'markdown-text')
const hasText = (el, text) => React.Children.toArray(el.props.children).includes(text)
const descriptionControl = (tree, label) => nodes(tree).find(el => el.props.onClick && (hasText(el, label) || el.props['aria-label'] === label))
function toggleDescription(tree, label) {
  const control = descriptionControl(tree, label)
  assert(control, `description shows the ${label} button`)
  assert.equal(control.props.type, 'button')
  assert(!control.props.disabled)
  control.props.onClick()
}

test('Draft description edits inline, previews nonblank Markdown, and still submits through Create', () => {
  const ui = harness(), brief = '**Draft description**', form = { title: 'Draft', brief: '', stage: 'todo' }
  const describe = () => ui.description(ui.create(form))
  let description = describe()
  assert.equal(briefField(description).props.rows, 2)
  assert.equal(briefField(description).props.value, '')
  assert(!markdown(description))
  assert.equal(descriptionControl(description, 'descriptionEdit').props['aria-pressed'], true)
  assert.equal(descriptionControl(description, 'descriptionPreview').props.disabled, true)
  form.brief = ' \n '
  assert.equal(descriptionControl(describe(), 'descriptionPreview').props.disabled, true)

  briefField(describe()).props.onChange({ target: { value: brief } })
  assert.deepEqual(ui.calls, [['editForm', 'brief', brief]])
  form.brief = brief
  toggleDescription(describe(), 'descriptionPreview')
  description = describe()
  assert(!briefField(description))
  assert.equal(markdown(description).props.text, brief)
  assert(!nodes(description).some(el => el.type === 'details'))
  assert.equal(descriptionControl(description, 'descriptionPreview').props['aria-pressed'], true)
  toggleDescription(description, 'descriptionEdit')
  assert.equal(briefField(describe()).props.value, brief)

  toggleDescription(describe(), 'descriptionPreview')
  const create = ui.create(form)
  assert.equal(submit(create).props.disabled, false)
  send(create)
  assert.deepEqual(ui.calls, [['editForm', 'brief', brief], ['create']])
})

test('Detail description defaults to read mode; switching modes preserves edits for Save', () => {
  const ui = harness(), brief = '**Saved description**', changed = '*Unsaved description*'
  let editor
  const describe = () => ui.description(ui.details(editor))
  let description = describe()
  assert(nodes(description).some(el => hasText(el, 'noDescription')))
  assert(!briefField(description))
  assert(!markdown(description))

  ui.task.brief = brief
  const readOnly = ui.description(ui.details(undefined, { writable: false }))
  assert.equal(descriptionControl(readOnly, 'editDescription').props.disabled, true)
  assert.equal(markdown(readOnly).props.text, brief)
  assert(!briefField(readOnly))

  description = describe()
  assert.equal(markdown(description).props.text, brief)
  assert(!briefField(description))
  assert(!nodes(description).some(el => el.type === 'details'))
  toggleDescription(description, 'editDescription')
  assert.deepEqual(ui.calls, [])
  assert(!button(ui.details(), 'saveDetails'))
  description = describe()
  const textarea = briefField(description)
  assert.equal(textarea.props.rows, 2)
  assert.equal(textarea.props.value, brief)
  assert(!markdown(description))

  textarea.props.onChange({ target: { value: changed } })
  assert.deepEqual(ui.calls, [['editDetails', 'brief', changed]])
  editor = { ...ui.task, brief: changed }
  toggleDescription(describe(), 'descriptionPreview')
  description = describe()
  assert(!briefField(description))
  assert.equal(markdown(description).props.text, changed)
  toggleDescription(description, 'editDescription')
  assert.equal(briefField(describe()).props.value, changed)
  toggleDescription(describe(), 'descriptionPreview')

  const save = button(ui.details(editor), 'saveDetails')
  assert.equal(save.props.disabled, false)
  save.props.onClick()
  assert.deepEqual(ui.calls, [['editDetails', 'brief', changed], ['saveDetails']])
})

for (const reload of [false, true]) test(`${reload ? 'Conflict reload' : 'Dirty close'} uses a named alertdialog; Escape keeps edits and only explicit confirmation acts`, () => {
  const ui = harness(), draft = { ...edit, revision: reload ? 0 : 1 }
  const request = () => {
    const tree = ui.details(draft)
    if (reload) button(tree, 'reloadDetails').props.onClick()
    else nodes(tree).find(el => el.type.name === 'TaskDrawer').props.onClose()
  }
  const alert = () => {
    const component = nodes(ui.details(draft)).find(el => el.type.name === 'DetailConfirmation')
    const modal = component.type(component.props)
    return new modal.type(modal.props).render()
  }
  request()
  let dialog = alert()
  assert.equal(dialog.props.role, 'alertdialog')
  assert(nodes(dialog).some(el => el.type === 'h2' && el.props.id === dialog.props['aria-labelledby']))
  assert(nodes(dialog).some(el => el.type === 'p' && el.props.id === dialog.props['aria-describedby']))
  assert.equal(button(dialog, 'keepEditing').props['data-dsh-initial-focus'], '')
  const target = { closest: () => target, getBoundingClientRect: () => ({ left: 20, top: 20, right: 100, bottom: 100 }) }
  dialog.props.onClick({ target, currentTarget: target, clientX: 0, clientY: 0 })
  dialog = alert() // Backdrop didn't dismiss the confirmation.
  dialog.props.onKeyDown({ key: 'Escape', target, currentTarget: target, preventDefault() {}, stopPropagation() {}, nativeEvent: {} })
  assert(!nodes(ui.details(draft)).some(el => el.type.name === 'DetailConfirmation'))
  assert.deepEqual(ui.calls, [])
  request()
  button(alert(), reload ? 'reloadDetails' : 'discardClose').props.onClick({ currentTarget: { closest: () => ({ close() {} }) } })
  assert.deepEqual(ui.calls, [[reload ? 'reloadDetails' : 'closeDetails']])
})

test('Clean detail closes directly; pending and uncertain saves cannot be discarded', () => {
  for (const editor of [undefined, { ...edit, pending: true }, { ...edit, retryInput: { requestId: 'same' } }]) {
    const ui = harness()
    nodes(ui.details(editor)).find(el => el.type.name === 'TaskDrawer').props.onClose()
    assert(!nodes(ui.details(editor)).some(el => el.type.name === 'DetailConfirmation'))
    assert.deepEqual(ui.calls, editor ? [] : [['closeDetails']])
  }
})

test('The detail menu opens replacement mode directly; unconfirmed or busy alternatives cannot submit', () => {
  const ui = harness()
  ui.task.activeSessionId = 'previous'
  const drawer = nodes(ui.details()).find(el => el.type.name === 'TaskDrawer')
  button(drawer.props.menu, 'newSession').props.onClick()
  assert.deepEqual(ui.calls.map(([method, id]) => [method, id]), [['openLaunch', 'task']])
  assert.equal(ui.calls[0][2].newConversation, true)
  ui.calls.length = 0
  const existing = ui.launch({})
  assert(button(existing, 'openSession'))
  assert(!submit(existing)); send(existing)
  const busy = ui.launch({ newConversation: true }, { runtime: 'running' })
  assert(button(busy, 'openSession'))
  assert.equal(submit(busy).props.disabled, true); send(busy)
  assert.deepEqual(ui.calls, [])
  assert(nodes(ui.launch({})).some(el => el.props.label === 'newSession'))
  const fresh = ui.launch({ newConversation: true })
  assert(!nodes(fresh).some(el => el.props.label === 'newSession'))
  assert.equal(fresh.props.title, 'newSession')
  assert.equal(submit(fresh).props.children, 'newSessionAction')
  assert.equal(submit(fresh).props.disabled, false)
  send(fresh); assert.deepEqual(ui.calls, [['launchTask']])
})

test('Launch and resume share a sheet but keep distinct titles/actions and the pending submit guard', () => {
  const ui = harness(), first = ui.launch({})
  assert.equal(first.props.paper, true); assert.equal(first.props.title, 'launch')
  const retryInput = { requestId: 'same' }
  const retry = ui.launch({ retryInput })
  assert.equal(retry.props.title, 'resumeLaunch'); assert.equal(submit(retry).props.children, 'resumeLaunch')
  const pending = ui.launch({ retryInput, pending: true })
  assert(submit(pending).props.disabled); send(pending)
  assert.deepEqual(ui.calls, [])
})

test('MCP dialog copies one-time config and requires confirmation to replace or revoke an active key', async () => {
  const ui = harness(), operations = [], url = 'http://127.0.0.1:32145/mcp'
  let active = false, count = 0
  const manage = async action => {
    operations.push(action)
    if (action === 'revoke') active = false
    if (action === 'generate') {
      active = true
      return { ok: true, value: { enabled: true, active, url, key: 'dsh_tasks_' + String(++count).repeat(43) } }
    }
    return { ok: true, value: { enabled: true, active, url } }
  }
  const dialog = ui.access(manage)
  const click = (component, key) => button(component.render(), key).props.onClick()
  const config = component => nodes(component.render()).find(el => el.props.readOnly)?.props.value
  assert.equal(dialog.render().props.title, 'mcpAccess')
  await dialog.perform('status')
  assert.equal(config(dialog), undefined)
  await click(dialog, 'mcpGenerate')
  const copied = config(dialog)
  assert.deepEqual(JSON.parse(copied), { mcpServers: { dsh_tasks: {
    type: 'http', url, headers: { Authorization: 'Bearer dsh_tasks_' + '1'.repeat(43) },
  } } })
  await click(dialog, 'mcpCopyConfig')
  assert.deepEqual(ui.calls, [['copy', copied]])
  click(dialog, 'mcpRotate')
  assert.deepEqual(operations, ['status', 'generate'])
  await click(dialog, 'mcpRotate')
  assert.notEqual(config(dialog), copied)
  click(dialog, 'close')
  dialog.componentWillUnmount()
  const reopened = ui.access(manage)
  await reopened.perform('status')
  assert.equal(config(reopened), undefined)
  click(reopened, 'mcpRevoke')
  assert(active)
  await click(reopened, 'mcpRevoke')
  assert(!active)
  assert(button(reopened.render(), 'mcpGenerate'))
  assert.deepEqual(operations, ['status', 'generate', 'generate', 'status', 'revoke'])
})
