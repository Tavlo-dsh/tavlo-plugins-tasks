import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import React from 'react'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const board = { revision: 12, columns: [
  { id: 'stage:todo', stage: 'todo' },
  { id: 'review', stage: 'doing', name: 'Review' },
], labels: [
  { id: 'used', name: 'Used', color: '#223344' },
  { id: 'free', name: 'Free', color: '#334455' },
] }
const tasks = [{ columnId: 'stage:todo', labelId: 'used' }]
const all = children => React.Children.toArray(children).flatMap(child => React.isValidElement(child) ? [child, ...all(child.props.children)] : [])
const node = (root, match) => all(root).find(match)

function harness() {
  const calls = []
  const t = key => key
  const actions = Object.fromEntries(['showColumns', 'editColumns', 'editLabels'].map(key => [key, input => calls.push([key, input])]))
  const window = { document: {}, __ModuleLoader__: { load({ factory }) {
    factory(name => name === 'react' ? { ...React, useState: value => [value, () => {}] } : {})
  } } }
  runInNewContext(source.replace('factory(require) {', 'factory(require) { window.components = () => ({ ColumnManager, LabelManager, Modal });'), { window, queueMicrotask })
  return { window, calls, ...window.components(), props: { t, actions, board, tasks } }
}

for (const type of ['Column', 'Label']) test(`${type} management uses the native dialog and stays dismissible while writes are blocked`, () => {
  const ui = harness()
  const manager = ui[type + 'Manager']({ ...ui.props, busy: true })
  assert.equal(manager.type, ui.Modal)
  assert.match(manager.props.className, new RegExp('dsh-tasks-management-dialog dsh-tasks-' + type.toLowerCase() + '-manager'))
  assert.equal(manager.props.focusClose, true)
  assert.equal(node(manager, child => child.type === 'fieldset').props.disabled, true)
  const dialog = new ui.Modal(manager.props).render()
  assert.equal(dialog.type, 'dialog')
  assert.equal(dialog.props['aria-label'], type === 'Column' ? 'columns' : 'labels')
  assert.equal(node(dialog, child => child.props['aria-label'] === 'close').props.disabled, undefined)
  dialog.props.onCancel({ preventDefault() {}, stopPropagation() {} })
  assert.deepEqual(ui.calls, [['showColumns', false]])
})

test('Native management focus opens on the requested field, then restores the invoking control or board settings', async () => {
  const ui = harness()
  const manager = ui.ColumnManager({ ...ui.props, selected: 'review' })
  const selected = all(manager).filter(child => child.props['data-dsh-initial-focus'] === '')
  assert.deepEqual(selected.map(child => child.props.defaultValue), ['Review'])
  const opener = { isConnected: true, closest: () => ({}), matches: () => false, getClientRects: () => [{}], focus: () => ui.calls.push('opener') }
  const settings = { focus: () => ui.calls.push('settings') }
  const doc = ui.window.document
  doc.activeElement = opener
  doc.querySelector = selector => selector === '.dsh-tasks-board-view .dsh-tasks-settings > summary' ? settings : undefined
  doc.querySelectorAll = () => []
  const dialog = new ui.Modal(manager.props)
  let hasTarget = true
  dialog.dialog = {
    showModal() { ui.calls.push('show'); doc.activeElement = {} },
    close() { ui.calls.push('close') },
    querySelector(selector) {
      if (selector === '[data-dsh-initial-focus]:not(:disabled)' && hasTarget) return { focus: () => ui.calls.push('selected') }
      if (selector === '.dsh-tasks-dialog-head button:not(:disabled)') return { focus: () => ui.calls.push('header close') }
    },
  }
  dialog.componentDidMount()
  dialog.componentWillUnmount()
  await Promise.resolve()
  assert.deepEqual(ui.calls, ['show', 'selected', 'close', 'opener'])
  ui.calls.length = 0
  doc.activeElement = opener
  hasTarget = false
  dialog.componentDidMount()
  opener.isConnected = false
  dialog.componentWillUnmount()
  await Promise.resolve()
  assert.deepEqual(ui.calls, ['show', 'header close', 'close', 'settings'])
})

test('Manager commands still pass the current revision and protect columns and labels in use', () => {
  const ui = harness()
  const columns = ui.ColumnManager(ui.props)
  const row = id => node(columns, child => child.props['data-column-id'] === id)
  const action = (root, label) => node(root, child => child.props.label === label)
  const submit = (form, fields) => form.props.onSubmit({ preventDefault() {}, currentTarget: { elements: Object.fromEntries(
    Object.entries(fields).map(([name, value]) => [name, { value }])) } })
  const columnAdd = node(columns, child => child.type === 'form' && child.props.className.includes('dsh-tasks-manage-create'))
  submit(columnAdd, { name: 'New', stage: 'doing' })
  submit(row('review'), { name: 'Renamed' })
  action(row('review'), 'earlier').props.onClick()
  assert.equal(action(row('stage:todo'), 'removeColumn').props.disabled, true)
  action(row('review'), 'removeColumn').props.onClick()
  const labels = ui.LabelManager(ui.props)
  const labelForms = all(labels).filter(child => child.type === 'form')
  submit(labelForms[0], { name: 'New label', color: '#447788' })
  submit(labelForms[2], { name: 'Renamed label', color: '#556677' })
  assert.equal(action(labelForms[1], 'removeLabel').props.disabled, true)
  action(labelForms[2], 'removeLabel').props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls)), [
    ['editColumns', { action: 'add', name: 'New', stage: 'doing', expectedRevision: 12 }],
    ['editColumns', { action: 'rename', columnId: 'review', name: 'Renamed', expectedRevision: 12 }],
    ['editColumns', { action: 'reorder', columnId: 'review', before: 'stage:todo', expectedRevision: 12 }],
    ['editColumns', { action: 'remove', columnId: 'review', expectedRevision: 12 }],
    ['editLabels', { action: 'add', expectedRevision: 12, name: 'New label', color: '#447788' }],
    ['editLabels', { action: 'edit', expectedRevision: 12, labelId: 'free', name: 'Renamed label', color: '#556677' }],
    ['editLabels', { action: 'remove', labelId: 'free', expectedRevision: 12 }],
  ])
})
