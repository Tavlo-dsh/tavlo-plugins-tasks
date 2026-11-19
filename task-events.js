/** Bounded, lifecycle-owned SSE connections over committed task changes. */

/**
 * @param store - serialized task store with an atomic snapshot subscription.
 * @param config - maximum queued bytes and heartbeat interval per connection.
 * @returns open(Request) and close(), which releases all subscriptions.
 */
export function createTaskEvents(store, config) {
  const encoder = new TextEncoder()
  const clients = new Set()
  let closing = false

  async function open(request) {
    if (closing) return new Response('Task events are closing', { status: 503 })
    let controller
    let unsubscribe
    let heartbeat
    let closed = false
    let overflow = false
    function finish(closeStream = true) {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      request.signal.removeEventListener('abort', finish)
      unsubscribe?.()
      clients.delete(finish)
      if (closeStream) controller.close()
    }
    function send(text) {
      if (closed) return
      const bytes = encoder.encode(text)
      if (bytes.byteLength > controller.desiredSize) {
        overflow = true
        finish()
        return
      }
      controller.enqueue(bytes)
    }
    const body = new ReadableStream({
      start(value) { controller = value },
      cancel() { finish(false) },
    }, { highWaterMark: config.eventBufferBytes, size: chunk => chunk.byteLength })
    clients.add(finish)
    request.signal.addEventListener('abort', finish, { once: true })
    if (request.signal.aborted) finish()
    try {
      unsubscribe = await store.watch(event => {
        send('event: tasks\ndata: ' + JSON.stringify(event) + '\n\n')
        if (event.type === 'unavailable') finish()
      }, request.signal, request.headers.get('x-tavlo-board') === '1')
    } catch (error) {
      finish()
      return Response.json({ code: error.code ?? 'tasks/unavailable' }, { status: 503 })
    }
    // Cancellation or a full baseline can close while watch() is still resolving.
    if (closed) {
      unsubscribe()
      if (overflow) return Response.json({ code: 'tasks/events-too-large' }, { status: 503 })
    }
    else {
      heartbeat = setInterval(() => send(': heartbeat\n\n'), config.eventHeartbeatMs)
      heartbeat.unref?.()
    }
    return new Response(body, { headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    } })
  }

  function close() {
    closing = true
    for (const finish of [...clients]) finish()
  }

  return { open, close }
}
