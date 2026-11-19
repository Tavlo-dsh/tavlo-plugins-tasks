import { calendarCss as upstreamCss } from '@looseleaf/lib/ink/recipes/calendar-ink'
export { calendarDropdownRecipe, calendarGridRecipe, RING_HANDS } from '@looseleaf/lib/ink/recipes/calendar-ink'

let scoped
export const calendarCss = () => scoped ??= upstreamCss().replaceAll('[data-slot=calendar]', '.dsh-tasks-date-popup [data-slot=calendar]')
