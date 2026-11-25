/** Public, transport-independent API; store lifetime and private state stay owned by tasks. */
export function createTaskService(store) {
  return Object.freeze({
    contractVersion: 1,
    execute: (operation, input, signal, source, agentSessionId) => store.execute(operation, input, signal, source, agentSessionId),
    watch: (observer, signal) => store.watch(observer, signal),
    async capabilities() {
      const result = await store.execute('capabilities', {})
      if (!result.ok) throw Object.assign(new Error(result.error.message), result.error)
      return result.value
    },
  })
}
