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

export function createConnection(url: string, sessionToken: string): Connection {
  const socket = new WebSocket(url);

  const messageHandlers: ((message: ServerMessage) => void)[] = [];
  const openHandlers: (() => void)[] = [];
  const closeHandlers: (() => void)[] = [];

  socket.addEventListener("open", () => {
    const join: ClientMessage = { t: "join", sessionToken };
    socket.send(JSON.stringify(join));
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
