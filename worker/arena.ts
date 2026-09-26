/// <reference types="@cloudflare/workers-types" />
/**
 * オンライン対戦の待ち合わせ場所と中継。Durable Object 1 つで両方をやる。
 *
 * - 合言葉なし … 全員が同じ 1 つ（`lobby`）に入り、先に待っていた人とつながる
 * - 合言葉あり … 言葉ごとに別の Durable Object になるので、同じ言葉の人だけが出会う
 *
 * 中継はそのまま流すだけで、中身は見ない（読み直すのは受け取った端末の仕事）。
 * 盤面の絵も攻撃の数も相手の端末が言ってきたものをそのまま信じる。ランキングと同じで、
 * 1 対 1 の遊びに検算の仕組みまでは持たない。
 */
import { validName } from '../src/scores/model';
import type { ServerMessage } from '../src/online/protocol';

/** 1 つの Durable Object につないでおける人数。混んだら断る */
const MAX_SOCKETS = 200;
/** 相手へ流す 1 通の上限。盤面 1 枚で 400 バイトほど */
const MAX_MESSAGE = 4096;

/** つないだ人 1 人ぶん。眠って起きたあとも読めるよう WebSocket に貼っておく */
interface Seat {
  name: string;
  /** 組になった相手を探すための印。まだ相手がいなければ null */
  match: string | null;
}

function read(ws: WebSocket): Seat {
  return (ws.deserializeAttachment() as Seat | null) ?? { name: '相手', match: null };
}

function send(ws: WebSocket, message: ServerMessage): void {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    /* 切れた相手に書いても、片付けは close のほうでやる */
  }
}

export class Arena implements DurableObject {
  /** 組の対応表。眠って起きると空になるので、そのときは貼ってある印から引き直す */
  private partners = new Map<WebSocket, WebSocket>();

  constructor(private readonly ctx: DurableObjectState) {
    // 相手待ちのあいだ端末がつついてくるぶんには、起きずに返事だけする
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket でつなぐ', { status: 426 });
    }
    const url = new URL(request.url);
    const name = url.searchParams.get('name') ?? '';
    if (!validName(name)) return new Response('名前が正しくない', { status: 400 });

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ name, match: null } satisfies Seat);

    if (this.ctx.getWebSockets().length > MAX_SOCKETS) {
      // 断る理由を伝えてから切る。端末は「混んでいる」と出す
      send(server, { t: 'busy' });
      server.close(1013, '混んでいる');
    } else {
      this.seat(server, url.searchParams.get('code'));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /** 待っている人がいればその場で組にし、いなければ待たせる */
  private seat(ws: WebSocket, code: string | null): void {
    const waiting = this.ctx
      .getWebSockets()
      .find((other) => other !== ws && read(other).match === null);
    if (!waiting) {
      send(ws, { t: 'waiting', code });
      return;
    }

    const match = crypto.randomUUID();
    // 降ってくる隕石の順番は両者で同じにする。腕以外のところで差が付かないように
    const seed = (crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff) || 1;
    const host = read(waiting);
    const guest = read(ws);
    waiting.serializeAttachment({ ...host, match } satisfies Seat);
    ws.serializeAttachment({ ...guest, match } satisfies Seat);
    this.partners.set(ws, waiting);
    this.partners.set(waiting, ws);
    send(waiting, { t: 'start', seed, name: guest.name });
    send(ws, { t: 'start', seed, name: host.name });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== 'string' || message.length > MAX_MESSAGE) return;
    const partner = this.partnerOf(ws);
    if (!partner) return;
    try {
      partner.send(message);
    } catch {
      /* 相手が切れていれば close のほうで片付く */
    }
  }

  webSocketClose(ws: WebSocket): void {
    this.drop(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.drop(ws);
  }

  /** 片方が切れたら、組になっていた相手にも知らせて終わりにする */
  private drop(ws: WebSocket): void {
    const partner = this.partnerOf(ws);
    this.partners.delete(ws);
    if (!partner) return;
    this.partners.delete(partner);
    send(partner, { t: 'left' });
    try {
      partner.close(1000, '相手が切れた');
    } catch {
      /* もう閉じていれば何もしない */
    }
  }

  private partnerOf(ws: WebSocket): WebSocket | null {
    const cached = this.partners.get(ws);
    if (cached) return cached;
    const { match } = read(ws);
    if (!match) return null;
    const found =
      this.ctx.getWebSockets().find((other) => other !== ws && read(other).match === match) ?? null;
    if (found) {
      this.partners.set(ws, found);
      this.partners.set(found, ws);
    }
    return found;
  }
}
