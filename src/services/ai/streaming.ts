import * as vscode from 'vscode';

/**
 * Bridge a VS Code CancellationToken to an AbortSignal for fetch().
 * Dispose the returned handle to release the token subscription.
 */
export function toAbortSignal(token?: vscode.CancellationToken): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  if (token?.isCancellationRequested) {
    controller.abort();
  }
  const sub = token?.onCancellationRequested(() => controller.abort());
  return {
    signal: controller.signal,
    dispose: () => sub?.dispose(),
  };
}

export interface SseEvent {
  event?: string;
  data: string;
}

/**
 * Parse a Server-Sent-Events byte stream into events.
 *
 * Handles the wire realities all HTTP AI providers share: frames split across
 * network reads, CRLF and LF line endings, multi-line `data:` fields (joined
 * with newlines per the SSE spec), `event:` names (Anthropic), comment lines,
 * and the OpenAI `[DONE]` sentinel (passed through — callers decide).
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let eventName: string | undefined;
  let dataLines: string[] = [];

  const flush = (): SseEvent | null => {
    if (dataLines.length === 0) {
      eventName = undefined;
      return null;
    }
    const evt: SseEvent = { event: eventName, data: dataLines.join('\n') };
    eventName = undefined;
    dataLines = [];
    return evt;
  };

  try {
    for (;;) {
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      // Process complete lines; keep the trailing partial line in the buffer.
      for (;;) {
        const nl = buffer.indexOf('\n');
        if (nl === -1) {
          break;
        }
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith('\r')) {
          line = line.slice(0, -1);
        }

        if (line === '') {
          const evt = flush();
          if (evt) {
            yield evt;
          }
        } else if (line.startsWith(':')) {
          // comment / keep-alive
        } else if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        // other fields (id:, retry:) are irrelevant here
      }
    }
    // Stream ended without a trailing blank line — emit what's pending.
    const evt = flush();
    if (evt) {
      yield evt;
    }
  } finally {
    reader.releaseLock();
  }
}
