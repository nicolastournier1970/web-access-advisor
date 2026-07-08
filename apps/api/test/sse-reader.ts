/**
 * Minimal raw-http SSE client for the specs. supertest buffers the whole
 * response body, which never arrives on an open SSE stream, so the stream
 * tests read chunks straight off node:http and destroy the socket once the
 * expected number of messages arrived.
 */
import http from 'node:http';

export interface SseMessage {
  id?: string;
  event?: string;
  data: string;
}

/** Parse one `field: value` block; returns undefined for comment/blank blocks. */
function parseBlock(block: string): SseMessage | undefined {
  const message: SseMessage = { data: '' };
  const dataLines: string[] = [];
  let sawField = false;
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') message.id = value;
    else if (field === 'event') message.event = value;
    else if (field === 'data') dataLines.push(value);
    else continue;
    sawField = true;
  }
  if (!sawField) return undefined;
  message.data = dataLines.join('\n');
  return message;
}

export function readSseMessages(options: {
  port: number;
  path: string;
  lastEventId?: string;
  count: number;
  timeoutMs?: number;
  /** Runs once the response headers arrive (stream subscription is live). */
  onOpen?: () => void;
}): Promise<SseMessage[]> {
  const { port, path, lastEventId, count, timeoutMs = 10_000, onOpen } = options;
  return new Promise((resolve, reject) => {
    const messages: SseMessage[] = [];
    let settled = false;

    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        headers: {
          accept: 'text/event-stream',
          ...(lastEventId !== undefined ? { 'last-event-id': lastEventId } : {}),
        },
      },
      (res) => {
        onOpen?.();
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let separator: number;
          while ((separator = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);
            const message = parseBlock(block);
            if (message) messages.push(message);
            if (messages.length >= count) {
              finish(() => resolve(messages));
              return;
            }
          }
        });
        res.on('end', () =>
          finish(() => reject(new Error(`stream ended with ${messages.length}/${count} messages`))),
        );
        res.on('error', () => finish(() => reject(new Error('stream errored'))));
      },
    );

    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new Error(`timed out with ${messages.length}/${count}: ${JSON.stringify(messages)}`),
          ),
        ),
      timeoutMs,
    );

    function finish(complete: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      complete();
    }

    req.on('error', (err) => finish(() => reject(err)));
    req.end();
  });
}
