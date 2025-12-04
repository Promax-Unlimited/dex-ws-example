import WebSocket from 'ws';

export type DexWebSocketClientOptions = {
  token: string;
  baseUrl: string;
  isStream?: boolean;
  heartbeatIntervalMs?: number;
  onOpen?: () => void;
  onMessage?: (message: unknown, raw: WebSocket.RawData) => void;
  onError?: (error: Error) => void;
  onClose?: (code: number, reason: Buffer) => void;
  onPong?: (data: Buffer) => void;
};

export class DexWebSocketClient {
  private socket?: WebSocket;
  private heartbeatTimer?: NodeJS.Timeout;
  private readonly baseUrl: string;
  private readonly isStream: boolean;
  private readonly token: string;
  private readonly heartbeatIntervalMs: number;
  private readonly handlers: Pick<
    DexWebSocketClientOptions,
    'onOpen' | 'onMessage' | 'onError' | 'onClose' | 'onPong'
  >;

  constructor(options: DexWebSocketClientOptions) {
    console.debug('DexWebSocketClient options:', options);
    this.baseUrl = options.baseUrl;
    this.token = options.token;
    this.isStream = options.isStream ?? false;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    this.handlers = {
      onOpen: options.onOpen,
      onMessage: options.onMessage,
      onError: options.onError,
      onClose: options.onClose,
      onPong: options.onPong,
    };
  }

  connect(): void {
    let url = `${this.baseUrl}?token=${encodeURIComponent(this.token)}`;
    if (this.isStream) {
      url = url.concat('&stream=true');
    }
    this.socket = new WebSocket(url);
    this.socket.on('open', () => {
      if (!this.isStream) {
        this.startHeartbeat();
      }
      this.handlers.onOpen?.();
    });
    this.socket.on('message', (data) => {
      const parsed = tryParseJson(data);
      this.handlers.onMessage?.(parsed ?? data, data);
    });
    this.socket.on('error', (err) => {
      this.handlers.onError?.(normalizeError(err));
    });
    this.socket.on('close', (code, reason) => {
      if (!this.isStream) {
        this.stopHeartbeat();
      }
      this.handlers.onClose?.(code, reason);
    });

    this.socket.on('pong', (data) => {
      this.handlers.onPong?.(data);
    });
  }

  send(payload: string | object): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not open; call connect() and wait for onOpen.');
    }
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.stopHeartbeat();
    this.socket?.close(code, reason);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.ping();
      }
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }
}

function tryParseJson(data: WebSocket.RawData): unknown | null {
  if (typeof data !== 'string' && !Buffer.isBuffer(data)) return null;
  const text = typeof data === 'string' ? data : data.toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(typeof error === 'string' ? error : 'Unknown WebSocket error');
}
