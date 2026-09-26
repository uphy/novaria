/**
 * ブラウザ側の回線。`/api/versus` に WebSocket でつなぐ。
 * 相手を探しているあいだは何も流れないので、その間に切られないよう時々つつく
 * （Worker 側は `setWebSocketAutoResponse` で、眠ったまま返事する）。
 */
import type { MatchSocket } from './match';

/** 相手待ちのあいだ、回線を切られないようにつつく間隔 */
const PING_MS = 30_000;

class BrowserSocket implements MatchSocket {
  onMessage: ((text: string) => void) | null = null;
  onClose: (() => void) | null = null;
  private readonly ws: WebSocket;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener('message', (e) => {
      if (typeof e.data === 'string') this.onMessage?.(e.data);
    });
    this.ws.addEventListener('close', () => {
      this.stopPing();
      this.onClose?.();
    });
    // つながらなかったときも close が続けて来るので、ここでは何もしない
    this.ws.addEventListener('error', () => {});
    this.timer = setInterval(() => {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send('{"t":"ping"}');
    }, PING_MS);
  }

  send(text: string): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(text);
  }

  close(): void {
    this.stopPing();
    this.ws.close();
  }

  private stopPing(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * 対戦の相手とつなぐ。
 * 合言葉を渡すと同じ言葉を入れた人と、渡さなければいま待っている人とつながる
 */
export function openMatchSocket(name: string, code: string | null): MatchSocket {
  const url = new URL('/api/versus', location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('name', name);
  if (code) url.searchParams.set('code', code);
  return new BrowserSocket(url.toString());
}
