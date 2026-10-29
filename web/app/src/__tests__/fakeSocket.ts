/**
 * A WebSocket that connects to nothing, installed for every test in place of
 * jsdom's real one (`vitest.setup.ts`), so a page that follows the tracker's
 * event feed never reaches for a server. It stays connecting until a test
 * drives it: `open()`, `send()` a frame as the server, `drop()` it.
 */

export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  /** Every socket made since the test began, oldest first. */
  static made: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.made.push(this);
  }

  /** The newest socket still open or connecting. */
  static live(): FakeWebSocket | undefined {
    return FakeWebSocket.made.filter((s) => s.readyState <= FakeWebSocket.OPEN).at(-1);
  }

  /** The server accepts. */
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  /** The server sends one frame (an object is sent as its JSON). */
  send(frame: unknown): void {
    const data = typeof frame === 'string' ? frame : JSON.stringify(frame);
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  /** The server goes away. */
  drop(code = 1012): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code }));
  }

  /** The page closes it. */
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
}
