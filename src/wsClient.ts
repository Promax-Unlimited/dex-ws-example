import WebSocket from 'ws';

export type DexWebSocketClientOptions = {
  token: string;
  baseUrl: string;
  isStream?: boolean;
  heartbeatIntervalMs?: number;
  messagePollingIntervalMs?: number;
  pongTimeoutMs?: number;
  maxMissedPongs?: number;
  reconnectDelayMs?: number;
  autoReconnect?: boolean;
  reconnectAttempts?: number;
  onOpen?: () => void;
  onMessage?: (message: unknown, raw: WebSocket.RawData) => void;
  onError?: (error: Error) => void;
  onClose?: (code: number, reason: Buffer) => void;
  onPong?: (data: Buffer) => void;
};

export class DexWebSocketClient {
  private socket?: WebSocket;
  private heartbeatTimer?: NodeJS.Timeout;
  private pollingTimer?: NodeJS.Timeout;
  private lastPongAt?: number;
  private missedPongs = 0;
  private reconnectAttempts: number;
  private systemClose = false;
  private readonly baseUrl: string;
  private readonly isStream: boolean;
  private readonly token: string;
  private readonly heartbeatIntervalMs: number;
  private readonly messagePollingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly maxMissedPongs: number;
  private readonly reconnectDelayMs: number;
  private readonly autoReconnect: boolean;
  private readonly handlers: Pick<
    DexWebSocketClientOptions,
    'onOpen' | 'onMessage' | 'onError' | 'onClose' | 'onPong'
  >;

  constructor(options: DexWebSocketClientOptions) {
    this.baseUrl = options.baseUrl;
    this.token = options.token;
    this.isStream = options.isStream ?? false;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 1_000;
    this.messagePollingIntervalMs = options.messagePollingIntervalMs ?? 5_000;
    this.pongTimeoutMs = options.pongTimeoutMs ?? 3_000;
    this.maxMissedPongs = options.maxMissedPongs ?? 2;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1000;
    this.autoReconnect = options.autoReconnect ?? true;
    this.reconnectAttempts = options.reconnectAttempts ?? 3;

    const combinedRecoveryBudget =
      this.heartbeatIntervalMs + this.pongTimeoutMs + this.reconnectDelayMs;
    if (combinedRecoveryBudget > this.messagePollingIntervalMs) {
      throw new Error(
        `messagePollingIntervalMs (${this.messagePollingIntervalMs}ms) must be greater than ` +
        `heartbeatIntervalMs + pongTimeoutMs + reconnectDelayMs`
      );
    }

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
    this.systemClose = false;
    this.socket = new WebSocket(url);
    this.socket.on('open', () => {
      this.missedPongs = 0;
      this.lastPongAt = Date.now();
      this.startHeartbeat();
      this.startPollingTransactions();
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
      this.stopHeartbeat();
      this.stopPollingTransactions();
      this.handlers.onClose?.(code, reason);

      if (!this.systemClose && this.autoReconnect) {
        this.scheduleReconnect();
      }
    });
    this.socket.on('pong', (data) => {
      this.lastPongAt = Date.now();
      this.missedPongs = 0;
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
    this.systemClose = true;
    this.stopHeartbeat();
    this.stopPollingTransactions();
    this.socket?.close(code, reason);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.evaluateConnectionHealth();
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

  private startPollingTransactions(): void {
    if (this.isStream) {
      return;
    }
    this.stopPollingTransactions();
    this.pollingTimer = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.send({});
      }
    }, this.messagePollingIntervalMs);
  }

  private stopPollingTransactions(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;
    }
  }

  private evaluateConnectionHealth(): void {
    if (!this.lastPongAt) {
      return;
    }
    const elapsed = Date.now() - this.lastPongAt;
    if (elapsed <= this.pongTimeoutMs) {
      return;
    }

    this.missedPongs += 1;
    if (this.missedPongs >= this.maxMissedPongs) {
      const reason = `Exceeded ${this.maxMissedPongs} missed pong window(s)`;
      this.handleUnresponsiveConnection(reason);
    }
  }

  private handleUnresponsiveConnection(reason: string): void {
    console.warn(`WebSocket unresponsive: ${reason}. Closing connection.`);
    this.socket?.terminate();
  }

  private scheduleReconnect(): void {
    setTimeout(() => {
      this.reconnectAttempts -= 1;
      if (this.reconnectAttempts <= 0) {
        console.error('Max reconnect attempts reached.');
        return;
      }
      this.connect();
    }, this.reconnectDelayMs);
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
