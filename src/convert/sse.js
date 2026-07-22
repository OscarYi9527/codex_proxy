// Incremental Server-Sent Events decoder.
//
// Network chunks are decoded as a continuous UTF-8 stream, then split into
// lines without assuming that CRLF pairs or event boundaries share a chunk.

export class SSEDecoder {
  constructor() {
    this.decoder = new TextDecoder()
    this.buffer = ''
    this.dataLines = []
    this.eventType = ''
    this.lastEventId = undefined
    this.retry = undefined
    this.closed = false
  }

  push(chunk) {
    if (this.closed) throw new Error('SSE decoder is already closed')
    const text = typeof chunk === 'string'
      ? chunk
      : this.decoder.decode(chunk, { stream: true })
    return this.#consume(text, false)
  }

  end(chunk) {
    if (this.closed) return []
    let text = ''
    if (chunk != null) {
      text += typeof chunk === 'string'
        ? chunk
        : this.decoder.decode(chunk, { stream: true })
    }
    text += this.decoder.decode()
    this.closed = true
    return this.#consume(text, true)
  }

  #consume(text, eof) {
    this.buffer += text
    const events = []
    let lineStart = 0
    let cursor = 0

    while (cursor < this.buffer.length) {
      const character = this.buffer[cursor]
      if (character !== '\r' && character !== '\n') {
        cursor++
        continue
      }

      // A trailing CR may be the first half of a CRLF split across chunks.
      if (character === '\r' && cursor + 1 === this.buffer.length && !eof) break

      this.#processLine(this.buffer.slice(lineStart, cursor), events)
      if (character === '\r' && this.buffer[cursor + 1] === '\n') cursor += 2
      else cursor++
      lineStart = cursor
    }

    this.buffer = this.buffer.slice(lineStart)
    if (eof) {
      if (this.buffer.length) this.#processLine(this.buffer, events)
      this.buffer = ''
      this.#dispatch(events)
    }
    return events
  }

  #processLine(line, events) {
    if (line === '') {
      this.#dispatch(events)
      return
    }
    if (line.startsWith(':')) return

    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    if (field === 'data') {
      this.dataLines.push(value)
    } else if (field === 'event') {
      this.eventType = value
    } else if (field === 'id' && !value.includes('\0')) {
      this.lastEventId = value
    } else if (field === 'retry' && /^\d+$/.test(value)) {
      this.retry = Number(value)
    }
  }

  #dispatch(events) {
    if (this.dataLines.length) {
      const event = {
        event: this.eventType || 'message',
        data: this.dataLines.join('\n')
      }
      if (this.lastEventId !== undefined) event.id = this.lastEventId
      if (this.retry !== undefined) event.retry = this.retry
      events.push(event)
    }
    this.dataLines = []
    this.eventType = ''
  }
}
