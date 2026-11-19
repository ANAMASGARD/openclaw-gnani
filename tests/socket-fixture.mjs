import WebSocket from "ws";

// Drives the provider's adapter hooks against either a local or live upstream.
export function socketSession(options, endpoint = options.url) {
  let socket;
  let ready = false;
  let closeTimer;
  let fail = () => {};
  const transport = {
    isOpen: () => socket?.readyState === WebSocket.OPEN,
    isReady: () => ready && transport.isOpen(),
    markReady() { ready = true; transport.resolve?.(); },
    failConnect(error) { fail(error); transport.closeNow(); },
    closeNow() { clearTimeout(closeTimer); socket?.terminate(); },
    sendBinary(audio) {
      if (!transport.isOpen()) return false;
      socket.send(audio);
      return true;
    },
    sendJson(value) {
      if (!transport.isOpen()) return false;
      socket.send(JSON.stringify(value));
      return true;
    },
  };
  return {
    async connect() {
      const headers = typeof options.headers === "function" ? await options.headers() : options.headers;
      socket = new WebSocket(endpoint, { headers, handshakeTimeout: 10_000 });
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => transport.failConnect(new Error("STT handshake timed out")), 10_000);
        fail = (error) => {
          clearTimeout(timeout);
          if (!ready) reject(error);
          else options.callbacks.onError?.(error);
        };
        transport.resolve = () => { clearTimeout(timeout); resolve(); };
        socket.on("open", () => options.onOpen?.(transport));
        socket.on("message", (message) => options.onMessage?.(JSON.parse(message.toString()), transport));
        socket.on("error", fail);
        socket.on("close", (code) => {
          clearTimeout(closeTimer);
          if (!ready) fail(new Error(`STT WebSocket closed before ready (${code})`));
          ready = false;
        });
      });
    },
    sendAudio(audio) { options.sendAudio(audio, transport); },
    close() {
      options.onClose?.(transport);
      closeTimer = setTimeout(() => transport.closeNow(), options.closeTimeoutMs ?? 5000);
      closeTimer.unref();
    },
    isConnected: () => transport.isReady(),
  };
}
