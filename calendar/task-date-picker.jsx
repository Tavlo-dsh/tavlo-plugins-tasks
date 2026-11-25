import * as React from 'react'
import { zhCN } from 'react-day-picker/locale/zh-CN'
import { DatePicker, toIsoDate } from '@/components/ui/date-picker'
import { InkContext, DEFAULT_INK_CONTEXT } from '@/lib/ink/react/hooks'
import { PortalHost } from './primitives'
import styles from './task-date-picker.css'

export { TaskPaperInk } from './task-paper-ink'

const ink = { ...DEFAULT_INK_CONTEXT, density: 'calm', hasProvider: true }
const dateIn = offset => { const date = new Date(); date.setDate(date.getDate() + offset); return date }

export function TaskDatePicker({ t, value, change, paperInk, label }) {
  const host = React.useRef(null), id = React.useId()
  const [open, setOpen] = React.useState(false)
  return <div className="dsh-tasks-date-field" ref={host}>
    <style>{styles}</style>
    <label htmlFor={id}>{label ?? t('dueDate')}</label>
    <div className="dsh-tasks-date-control" data-task-ink={paperInk ? 'field' : undefined} data-has-value={value ? '' : undefined}>
      <PortalHost.Provider value={host}><InkContext.Provider value={ink}>
        <DatePicker id={id} name="dueDate" value={value ? new Date(value + 'T00:00:00') : undefined}
          onValueChange={date => change('dueDate', date ? toIsoDate(date) : '')} format="yyyy-MM-dd"
          locale={t('localeCode') === 'zh' ? zhCN : undefined} placeholder={t('pickDate')} calendarLabel={t('pickDate')}
          typeable={false} open={open} onOpenChange={setOpen} aria-label={t('dueDate') + ': ' + (value || t('pickDate'))}
          presets={[{ label: t('dateToday'), value: () => dateIn(0) }, { label: t('dateTomorrow'), value: () => dateIn(1) }]}
          contentProps={{ 'data-task-ink': paperInk ? 'overlay' : undefined, onEscapeKeyDown(event) { event.preventDefault(); setOpen(false) } }} />
      </InkContext.Provider></PortalHost.Provider>
      {value && <button type="button" className="dsh-tasks-date-clear" aria-label={t('clearDate')} title={t('clearDate')}
        onClick={() => { setOpen(false); change('dueDate', ''); host.current?.querySelector('button[data-slot="date-picker"]')?.focus() }}>
        <svg aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="m4 4 8 8m0-8-8 8" />
        </svg>
      </button>}
    </div>
  </div>
}
