import * as React from 'react'
import { defineRecipe, DEFAULT_KNOBS } from '@/lib/ink/recipes'
import { drawFieldFrame } from '@/lib/ink/recipes/field-frame-ink'
import { buttonRecipe } from '@/lib/ink/recipes/button-ink'
import { badgeRecipe } from '@/lib/ink/recipes/badge-ink'
import { tabsRecipe } from '@/lib/ink/recipes/tabs-ink'
import { emptyFrameRecipe } from '@/lib/ink/recipes/empty-ink'
import { useInkBox } from '@/lib/ink/react/hooks'
import { inkFrame } from '@/lib/ink/react/cache'
import { InkSvg } from '@/lib/ink/react/svg'

// Looseleaf artwork, without its React 19 component shells or global theme.
// The host controls keep ownership of input, selection, native validation and focus.
const fieldRecipe = defineRecipe({
  id: 'task-field', kind: 'field', layers: ['rest', 'disabled'], pad: 2,
  draw(ink, box, params, ctx) { drawFieldFrame(ink, box, params, ctx) },
})
const recipes = { field: fieldRecipe, button: buttonRecipe, badge: badgeRecipe, tabs: tabsRecipe, empty: emptyFrameRecipe }

function useReact18Ref(ref) {
  return React.useMemo(() => {
    let release
    return node => { release?.(); release = node ? ref(node) : undefined }
  }, [ref])
}

export function TaskPaperInk({ kind, variant, disabled, multiline }) {
  const { ref, box } = useInkBox()
  const hostRef = useReact18Ref(ref)
  const frame = React.useMemo(() => {
    if (!box) return null
    const params = kind === 'tabs' ? { variant: 'line', orientation: 'horizontal' }
      : kind === 'button' ? { variant: variant || 'outline', size: 'sm', disabled }
      : kind === 'badge' ? { variant: 'outline', size: 'sm' }
      : kind === 'field' ? { multiline, disabled } : {}
    return inkFrame(recipes[kind], {
      box, params, seed: 'tasks:' + kind, density: 'calm', tier: 'lo', dir: 'ltr', knobs: DEFAULT_KNOBS, pad: 2,
    })
  }, [box, kind, variant, disabled, multiline])
  return <span aria-hidden="true" ref={hostRef} data-task-ink-layer={kind} data-task-ink-ready={frame ? '' : undefined}>
    {frame && <InkSvg kind={kind} frame={frame} still />}
  </span>
}
