import { createHash } from 'node:crypto'

/** Tuple encoding is unambiguous even when identifiers contain separators. */
export function externalKey(ref) {
  return ref && JSON.stringify([ref.provider, ref.connectionId, ref.scopeId, ref.objectType, ref.objectId])
}

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]))
  return value
}

export const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
