import type { NatsConnection } from "nats";

// The raw core-NATS connection handle, set by server.ts's initNats. JetStream (outbox events)
// stays in server.ts; this exists so other modules can core-subscribe to ephemeral subjects
// (runner progress on run.<id>) without importing server.ts (cycle) or opening a second socket.

let conn: NatsConnection | null = null;

export function setNatsConnection(nc: NatsConnection | null): void {
  conn = nc;
}

export function getNatsConnection(): NatsConnection | null {
  return conn;
}
