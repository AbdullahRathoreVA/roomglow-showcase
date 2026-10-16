/**
 * EXTRACT — Roomglow case study.
 *
 * Copied verbatim from the private Roomglow repository, and deliberately incomplete: the
 * modules it imports (the database layer, the HTTP router, the routes, the seed) are not
 * published here, so this will not compile or run on its own. It is here to be read.
 *
 * (c) Abdullah Rathore. All rights reserved.
 */

/**
 * The live-update hub: Server-Sent Events, in process.
 *
 * Why SSE and not WebSockets: this traffic is one-directional. Screens receive; status
 * changes travel up as an ordinary PATCH. SSE is half the code, reconnects on its own by
 * specification, survives proxies as plain HTTP, and needs no library.
 *
 * Two audiences are served from one hub and they get **different payloads, chosen here
 * on the server**: `staff` sees notes and who changed what; `kiosk` — the lobby TV — gets
 * a payload that has no note field and no educator names at all. A test asserts that.
 *
 * On connect, every client is sent a full snapshot before any delta. The board is a
 * couple of kilobytes, so replaying a missed-event log would be more machinery for a
 * weaker guarantee: after a reconnect the client is simply correct, whatever it missed.
 */
import type { ServerResponse } from 'node:http';
import { newId } from './util.ts';

export type Audience = 'staff' | 'kiosk';

interface Client {
  id: string;
  audience: Audience;
  res: ServerResponse;
  /** Set when the connection comes from a room's own tablet, for the presence dot. */
  roomId: string | null;
  openedAt: number;
}

const clients = new Map<string, Client>();
let heartbeat: NodeJS.Timeout | null = null;

const HEARTBEAT_MS = 20_000;

function writeFrame(client: Client, frame: string): boolean {
  try {
    client.res.write(frame);
    return true;
  } catch {
    // The far end went away between our check and our write. Not an error worth logging
    // on a wall display that reboots.
    detach(client.id);
    return false;
  }
}

export interface AttachOptions {
  audience: Audience;
  roomId?: string | null;
}

export function attach(res: ServerResponse, options: AttachOptions): string {
  const client: Client = {
    id: newId(),
    audience: options.audience,
    res,
    roomId: options.roomId ?? null,
    openedAt: Date.now(),
  };

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    // Nginx and some ISP middleboxes buffer streamed responses and the TV then updates
    // in bursts of nothing. This header is honoured by the common ones.
    'x-accel-buffering': 'no',
  });

  // Tell the browser how long to wait before reconnecting, instead of its 3s default.
  res.write('retry: 3000\n\n');

  clients.set(client.id, client);
  res.on('close', () => detach(client.id));
  ensureHeartbeat();
  return client.id;
}

export function detach(id: string): void {
  const client = clients.get(id);
  if (!client) return;
  clients.delete(id);
  try {
    client.res.end();
  } catch {
    /* already closed */
  }
  if (clients.size === 0 && heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

export function sendTo(id: string, event: string, data: unknown): void {
  const client = clients.get(id);
  if (!client) return;
  writeFrame(client, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Publish to everyone. `build` is called at most once per audience, so assembling a
 * board payload costs two queries however many screens are connected.
 */
export function broadcast(event: string, build: (audience: Audience) => unknown): void {
  if (clients.size === 0) return;
  const cache = new Map<Audience, string>();
  const payloadFor = (audience: Audience): string => {
    const cached = cache.get(audience);
    if (cached !== undefined) return cached;
    const frame = `event: ${event}\ndata: ${JSON.stringify(build(audience))}\n\n`;
    cache.set(audience, frame);
    return frame;
  };
  for (const client of [...clients.values()]) writeFrame(client, payloadFor(client.audience));
}

function ensureHeartbeat(): void {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    // A named event, not a comment frame. A comment would keep proxies from closing the
    // stream but `EventSource` cannot see comments, and the screens need to see these:
    // it is how a display tells "nothing has happened" apart from "this connection is
    // dead but still open". No ping for 45 seconds and the TV says so.
    const frame = `event: ping\ndata: {"at":${Date.now()}}\n\n`;
    for (const client of [...clients.values()]) writeFrame(client, frame);
  }, HEARTBEAT_MS);
  // Without unref a single open stream would keep `node --test` alive forever.
  heartbeat.unref?.();
}

export interface Presence {
  total: number;
  staff: number;
  kiosk: number;
  /** room id -> number of connected tablets claiming that room */
  rooms: Record<string, number>;
}

export function presence(): Presence {
  const result: Presence = { total: clients.size, staff: 0, kiosk: 0, rooms: {} };
  for (const client of clients.values()) {
    if (client.audience === 'kiosk') result.kiosk += 1;
    else result.staff += 1;
    if (client.roomId) result.rooms[client.roomId] = (result.rooms[client.roomId] ?? 0) + 1;
  }
  return result;
}

/** Used when the process shuts down, and by tests between cases. */
export function closeAll(): void {
  for (const id of [...clients.keys()]) detach(id);
}
