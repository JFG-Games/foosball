import type { ClientMessage, ServerMessage } from "@shared/protocol";

/**
 * A thin, typed wrapper around the game WebSocket.
 *
 * It joins on open, parses inbound frames once, and hands typed messages to
 * handlers — so nothing else in the client touches raw JSON or readyState.
 */
export interface Connection {
  send(message: ClientMessage): void;
  close(): void;
  onMessage(handler: (message: ServerMessage) => void): void;
  onOpen(handler: () => void): void;
  onClose(handler: () => void): void;
  readonly isOpen: boolean;
}

/** `makeJoin` builds the first message, sent as soon as the socket opens. */
export function createConnection(url: string, makeJoin: () => ClientMessage): Connection {
  const socket = new WebSocket(url);

  const messageHandlers: ((message: ServerMessage) => void)[] = [];
  const openHandlers: (() => void)[] = [];
  const closeHandlers: (() => void)[] = [];

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify(makeJoin()));
    for (const handler of openHandlers) handler();
  });

  socket.addEventListener("message", (event) => {
    let message: ServerMessage;
    try {
      message = JSON.parse(String(event.data)) as ServerMessage;
    } catch {
      return; // ignore anything that isn't our JSON protocol
    }
    for (const handler of messageHandlers) handler(message);
  });

  socket.addEventListener("close", () => {
    for (const handler of closeHandlers) handler();
  });
  socket.addEventListener("error", () => {
    // A failed connect also fires "close"; nothing extra to do, but don't leave it unhandled.
  });

  return {
    send(message: ClientMessage): void {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    },
    close(): void {
      socket.close();
    },
    onMessage(handler): void {
      messageHandlers.push(handler);
    },
    onOpen(handler): void {
      openHandlers.push(handler);
    },
    onClose(handler): void {
      closeHandlers.push(handler);
    },
    get isOpen(): boolean {
      return socket.readyState === WebSocket.OPEN;
    },
  };
}
