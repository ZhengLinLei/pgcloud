import type { WebSocket } from 'ws';
import type { ClusterEvent, WsMessage } from '../shared/types.js';
import { addEvent } from './db.js';

// Fan-out of real-time messages to every connected browser.

const clients = new Set<WebSocket>();

export function addClient(ws: WebSocket): void {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
}

export function broadcast(msg: WsMessage): void {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

export function emitEvent(level: ClusterEvent['level'], message: string, nodeId: string | null = null): void {
  broadcast({ type: 'event', event: addEvent(level, message, nodeId) });
}
