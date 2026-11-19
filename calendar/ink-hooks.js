import { useMemo } from 'react'
import { useInk as upstreamInk, useMergedRef as upstreamMergedRef } from '@/lib/ink/react/hooks'
export { useInkContext } from '@/lib/ink/react/hooks'

function useLegacyRef(ref) {
  return useMemo(() => {
    let release
    return node => {
      release?.()
      release = node ? ref(node) : undefined
    }
  }, [ref])
}

export function useInk(options) {
  const ink = upstreamInk(options)
  return { ...ink, hostRef: useLegacyRef(ink.hostRef) }
}

export function useMergedRef(...refs) {
  return useLegacyRef(upstreamMergedRef(...refs))
}
