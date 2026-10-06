import WebSocket from "ws";

export function rpcCall<T>(origin: string, token: string, tag: string, payload: unknown, timeoutMs = 30_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const url = new URL("/ws", origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` }, handshakeTimeout: timeoutMs });
    let settled = false;
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(ping);
      if (socket.readyState === WebSocket.OPEN) socket.close();
      else socket.terminate();
      if (error) reject(error);
      else resolve(value as T);
    };
    const timer = setTimeout(() => finish(new Error(`T3 RPC ${tag} timed out. The command may still be running; reconcile its IDs before retrying.`)), timeoutMs);
    const ping = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ _tag: "Ping" }));
    }, 5000);
    socket.on("open", () => socket.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] })));
    socket.on("error", (error) => finish(new Error(`T3 RPC ${tag}: ${error.message}`)));
    socket.on("close", () => finish(new Error(`T3 RPC ${tag} disconnected before its result. The command may have been accepted.`)));
    socket.on("message", (data) => {
      try {
        for (const line of data.toString().split("\n").filter(Boolean)) {
          const parsed = JSON.parse(line);
          for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
            if (message._tag === "Pong") continue;
            if (message._tag === "ClientProtocolError" || message._tag === "Defect") {
              finish(new Error(`T3 RPC ${tag}: ${JSON.stringify(message.error ?? message.defect)}`));
            } else if (String(message.requestId) === "1" && message._tag === "Exit") {
              if (message.exit?._tag === "Success") finish(undefined, message.exit.value as T);
              else finish(new Error(`T3 RPC ${tag} rejected: ${JSON.stringify(message.exit?.cause)}. Rejected command IDs cannot be reused.`));
            }
          }
        }
      } catch {
        finish(new Error(`T3 RPC ${tag} returned an invalid response.`));
      }
    });
  });
}
