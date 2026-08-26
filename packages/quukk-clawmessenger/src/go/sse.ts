const DEFAULT_SSE_LIMIT = 1 << 20;
const PROCESSING_SLICE = 64 << 10;

export type SSEMessage =
  | { kind: 'heartbeat' }
  | { kind: 'event'; id: string; event: string; data: string };

export type SSEProtocolErrorCode = 'sse_protocol_error' | 'sse_frame_too_large';

export class SSEProtocolError extends Error {
  readonly code: SSEProtocolErrorCode;

  constructor(code: SSEProtocolErrorCode = 'sse_protocol_error') {
    super(code);
    this.name = 'SSEProtocolError';
    this.code = code;
  }
}

type Frame = {
  id?: string;
  event?: string;
  data?: string;
  dataBytes: number;
  fields: number;
};

function emptyFrame(): Frame {
  return { dataBytes: 0, fields: 0 };
}

function decodeLine(bytes: readonly number[]): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    throw new SSEProtocolError();
  }
}

function parseID(value: string): void {
  if (!/^[1-9]\d*$/.test(value)) throw new SSEProtocolError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new SSEProtocolError();
}

function addLine(frame: Frame, bytes: readonly number[], maximumBytes: number): void {
  const line = decodeLine(bytes);
  const separator = line.indexOf(':');
  const field = separator === -1 ? line : line.slice(0, separator);
  let value = separator === -1 ? '' : line.slice(separator + 1);
  if (value.startsWith(' ')) value = value.slice(1);
  switch (field) {
    case 'id':
      if (frame.id !== undefined) throw new SSEProtocolError();
      parseID(value);
      frame.id = value;
      break;
    case 'event':
      if (frame.event !== undefined || value.length === 0 || value.length > 64) {
        throw new SSEProtocolError();
      }
      frame.event = value;
      break;
    case 'data': {
      if (frame.data !== undefined) throw new SSEProtocolError();
      const prefixBytes = encoderLength(line) - encoderLength(value);
      frame.dataBytes = bytes.length - Math.min(bytes.length, prefixBytes);
      if (frame.dataBytes > maximumBytes) throw new SSEProtocolError('sse_frame_too_large');
      frame.data = value;
      break;
    }
    default:
      throw new SSEProtocolError();
  }
  frame.fields += 1;
}

function encoderLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function dispatch(frame: Frame): SSEMessage | undefined {
  if (frame.fields === 0) return undefined;
  if (frame.id === undefined || frame.event === undefined || frame.data === undefined) {
    throw new SSEProtocolError();
  }
  return { kind: 'event', id: frame.id, event: frame.event, data: frame.data };
}

export async function* parseSSE(
  source: AsyncIterable<Uint8Array>,
  maximumBytes = DEFAULT_SSE_LIMIT,
): AsyncIterable<SSEMessage> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0 || maximumBytes > DEFAULT_SSE_LIMIT) {
    throw new SSEProtocolError();
  }
  let frame = emptyFrame();
  let frameBytes = 0;
  let line: number[] = [];
  let pendingCR = false;

  const finishLine = (): SSEMessage | undefined => {
    if (line.length === 0) {
      const message = dispatch(frame);
      frame = emptyFrame();
      frameBytes = 0;
      return message;
    }
    if (line[0] === 0x3a) {
      if (frame.fields !== 0) throw new SSEProtocolError();
      decodeLine(line);
      line = [];
      frameBytes = 0;
      return { kind: 'heartbeat' };
    }
    addLine(frame, line, maximumBytes);
    line = [];
    return undefined;
  };

  for await (const chunk of source) {
    if (!(chunk instanceof Uint8Array)) throw new SSEProtocolError();
    for (let start = 0; start < chunk.byteLength; start += PROCESSING_SLICE) {
      const end = Math.min(start + PROCESSING_SLICE, chunk.byteLength);
      for (let index = start; index < end; index += 1) {
        const byte = chunk[index]!;
        if (pendingCR) {
          if (byte !== 0x0a) throw new SSEProtocolError();
          frameBytes += 1;
          if (frameBytes > maximumBytes) {
            throw new SSEProtocolError('sse_frame_too_large');
          }
          const message = finishLine();
          if (message !== undefined) yield message;
          pendingCR = false;
          continue;
        }
        frameBytes += 1;
        if (frameBytes > maximumBytes) throw new SSEProtocolError('sse_frame_too_large');
        if (byte === 0x0d) {
          pendingCR = true;
        } else if (byte === 0x0a) {
          const message = finishLine();
          if (message !== undefined) yield message;
        } else {
          line.push(byte);
        }
      }
    }
  }
  if (pendingCR) throw new SSEProtocolError();
  if (line.length !== 0 || frame.fields !== 0) throw new SSEProtocolError();
}
