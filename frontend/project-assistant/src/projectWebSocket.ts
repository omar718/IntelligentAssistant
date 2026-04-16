import * as vscode from 'vscode';

type EventHandler = (data: any) => void;

export class ProjectWebSocket {
  private ws: WebSocket | null = null;
  private handlers: Map<string, EventHandler[]> = new Map();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly projectId: string,
    private readonly wsBaseUrl: string,   // e.g. "ws://localhost:8000"
    private readonly authToken?: string,
  ) {}

  on(event: string, handler: EventHandler): this {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);
    }
    this.handlers.get(event)!.push(handler);
    return this;
  }

  private emit(event: string, payload: any): void {
    const eventHandlers = this.handlers.get(event) ?? [];
    eventHandlers.forEach((h) => h(payload));
  }

  connect(): void {
    this.closed = false;
    this._connect();
  }

  private _connect(): void {
    const baseUrl = `${this.wsBaseUrl}/ws/projects/${this.projectId}`;
    const query = this.authToken
      ? `?token=${encodeURIComponent(this.authToken)}&access_token=${encodeURIComponent(this.authToken)}`
      : '';
    const url = `${baseUrl}${query}`;
    const redactedUrl = this.authToken ? `${baseUrl}?access_token=***` : baseUrl;
    this.emit('__connecting', { url: redactedUrl, projectId: this.projectId });
    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      console.error('[ProjectWebSocket] Failed to create WebSocket:', err);
      this.emit('__error', { message: String(err) });
      return;
    }

    this.ws.onopen = () => {
      console.log(`[ProjectWebSocket] Connected for project ${this.projectId}`);
      this.emit('__open', { projectId: this.projectId });
    };

    this.ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        const { event: eventName, data } = payload;
        const eventHandlers = this.handlers.get(eventName) ?? [];
        eventHandlers.forEach(h => h(data));
      } catch (err) {
        console.error('[ProjectWebSocket] Failed to parse message:', err);
      }
    };

    this.ws.onerror = (err) => {
      console.error('[ProjectWebSocket] Error:', err);
      const eventType = (err as any)?.type ?? 'unknown';
      const readyState = this.ws?.readyState;
      this.emit('__error', {
        message: `type=${eventType}, readyState=${readyState}`,
      });
    };

    this.ws.onclose = (event) => {
      this.emit('__close', {
        projectId: this.projectId,
        closedByClient: this.closed,
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });
      if (this.closed) return;
      // Reconnect after 3s if not intentionally closed
      this.reconnectTimer = setTimeout(() => this._connect(), 3000);
    };
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}