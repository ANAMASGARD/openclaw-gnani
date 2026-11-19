import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { connect as tcpConnect } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import WebSocket, { WebSocketServer } from "ws";

const state = process.env.GNANI_E2E_OPENCLAW_STATE;
if (!state) throw new Error("Set GNANI_E2E_OPENCLAW_STATE to the isolated OpenClaw state directory with the npm archive installed.");
const target = resolve(state);
assert.match(target, /^\/tmp\/gnani-openclaw\.[a-zA-Z0-9]+$/, "Use a dedicated /tmp/gnani-openclaw.* test profile");
const temp = await mkdtemp(join(tmpdir(), "gnani-gateway-fixture-"));
const keyPath = join(temp, "key.pem");
const certPath = join(temp, "cert.pem");
const configPath = join(target, "openclaw.json");
const installingConfig = JSON.parse(await readFile(configPath, "utf8"));
const cli = process.env.OPENCLAW_BIN || "openclaw";
const token = "gnani-gateway-fixture-token";
const live = process.env.GNANI_E2E_LIVE === "1";
assert.ok(!live || process.env.GNANI_API_KEY && process.env.GNANI_E2E_AUDIO, "Live Gateway tests require GNANI_API_KEY and GNANI_E2E_AUDIO");
const testVoiceCall = !live && process.env.GNANI_E2E_VOICE_CALL === "1";
const testChannelTargets = !live && process.env.GNANI_E2E_CHANNEL_TARGETS === "1";
const expectedTranscript = new RegExp(process.env.GNANI_E2E_EXPECT ?? "communication channels?", "iu");
const fixtureSid = "AC" + "a".repeat(32);
const fixtureAuth = "voice-call-fixture-secret";
const publicWebhook = "https://call-fixture.example/voice/webhook";
const model = "fixture-chat";
let active = undefined;
const reports = [];
const inbound = "fixture weather report";
const reply = "I received the fixture weather report.";
const bot = { id: 737373, is_bot: true, first_name: "Fixture", username: "gnani_fixture_bot", can_join_groups: true };
const chat = { id: 424242, type: "private", first_name: "Fixture" };
const sender = { id: chat.id, is_bot: false, first_name: "Fixture" };
const certify = promisify(execFile);
const servers = [];
let gateway;
let logs = "";

function sample(formatArgs) {
  return execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    ...formatArgs, "-"], { maxBuffer: 1024 * 1024 });
}

const ogg = live
  ? execFileSync("ffmpeg", ["-v", "error", "-i", process.env.GNANI_E2E_AUDIO, "-c:a", "libopus", "-ar", "48000", "-ac", "1", "-f", "ogg", "-"], { maxBuffer: 1024 * 1024 })
  : sample(["-c:a", "libopus", "-ar", "48000", "-f", "ogg"]);
const mp3 = sample(["-ar", "24000", "-f", "mp3"]);
const raw = sample(["-ar", "8000", "-ac", "1", "-f", "s16le"]);

async function listen(server) {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function bytes(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function json(res, value) {
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(value));
}

function handle(fn) {
  return (req, res) => {
    void fn(req, res).catch((error) => {
      if (active) active.errors.push(error.message);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  };
}

const httpHandler = handle(async (req, res) => {
  assert.ok(active, "unexpected request before a test case");
  const path = new URL(req.url, "http://localhost").pathname;
  if (path === "/stt/v3") {
    assert.equal(req.headers["x-api-key-id"], "fixture-key");
    const multipart = await new Response(await bytes(req), { headers: { "Content-Type": req.headers["content-type"] } }).formData();
    assert.equal(multipart.get("model"), active.stt);
    const file = multipart.get("audio_file");
    assert.ok(file.size > 1000);
    active.sttRequests++;
    json(res, { success: true, model: active.stt, transcript: inbound });
    return;
  }
  if (path.startsWith("/api/v1/tts/")) {
    assert.equal(req.headers["x-api-key-id"], "fixture-key");
    const request = JSON.parse((await bytes(req)).toString());
    assert.equal(request.model, active.tts);
    assert.ok(typeof request.text === "string");
    const config = request.audio_config;
    if (path.endsWith("/sse")) {
      active.sseRequests++;
      const isCancel = request.text.includes("cancel");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.on("close", () => { if (isCancel) active.sseCancelled++; });
      res.write('event: start\ndata: {}\n\n');
      const first = mp3.subarray(0, 900).toString("base64");
      res.write(`event: chunk\ndata: ${JSON.stringify({ chunk_index: 1, audio: first, is_final: false })}\n\n`);
      if (isCancel) return;
      await sleep(65);
      res.write(`event: chunk\ndata: ${JSON.stringify({ chunk_index: 2, audio: mp3.subarray(900).toString("base64"), is_final: false })}\n\n`);
      res.end('event: complete\ndata: {"is_final":true,"audio":""}\n\n');
      return;
    }
    if (config.container === "raw") {
      assert.equal(config.sample_rate, 8000);
      active.telephonyRequests++;
      res.writeHead(200, { "Content-Type": "application/octet-stream" }).end(raw);
    } else if (config.container === "ogg") {
      assert.ok(request.text.includes("weather report"), request.text);
      active.noteRequests++;
      res.writeHead(200, { "Content-Type": "audio/ogg" }).end(ogg);
    } else {
      res.writeHead(200, { "Content-Type": "audio/mpeg" }).end(mp3);
    }
    return;
  }
  if (path.endsWith("/chat/completions")) {
    const request = JSON.parse((await bytes(req)).toString());
    assert.equal(request.model, model);
    const conversation = JSON.stringify(request.messages);
    assert.ok(live ? expectedTranscript.test(conversation) : conversation.includes(inbound),
      "agent did not receive the Prisma transcript");
    active.agentRequests++;
    const response = { id: "fixture-turn", created: 1, model };
    if (request.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const [delta, finish_reason] of [[{ role: "assistant", content: reply }, null], [{}, "stop"]]) {
        res.write(`data: ${JSON.stringify({ ...response, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      }
      res.end("data: [DONE]\n\n");
    } else {
      json(res, { ...response, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }] });
    }
    return;
  }
  if (path.includes("/file/bot")) {
    res.writeHead(200, { "Content-Type": "audio/ogg", "Content-Length": ogg.length }).end(ogg);
    return;
  }
  const method = path.split("/").at(-1);
  const send = (result) => json(res, { ok: true, result });
  const content = await bytes(req);
  switch (method) {
    case "getMe": send(bot); break;
    case "getFile": send({ file_id: "fixture-voice-input", file_unique_id: "fixture-id", file_size: ogg.length, file_path: "voice/fixture.ogg" }); break;
    case "getUpdates": {
      await sleep(150);
      if (active.sentUpdate) {
        send([]);
      } else {
        active.sentUpdate = true;
        send([{ update_id: active.update, message: {
          message_id: active.update, from: sender, chat, date: Math.floor(Date.now() / 1000),
          voice: { duration: 1, mime_type: "audio/ogg", file_id: "fixture-voice-input", file_unique_id: "fixture-id", file_size: ogg.length },
        } }]);
      }
      break;
    }
    case "sendVoice":
    case "sendAudio":
    case "sendDocument": {
      const offset = content.indexOf(Buffer.from("OggS"));
      assert.equal(method, "sendVoice", "Telegram should receive a voice note");
      assert.ok(offset >= 0, "Telegram did not receive Ogg bytes");
      if (live) {
        const form = await new Response(content, { headers: { "Content-Type": req.headers["content-type"] } }).formData();
        const pointer = form.get("voice");
        const voice = typeof pointer === "string" && pointer.startsWith("attach://")
          ? form.get(pointer.slice("attach://".length)) : pointer;
        assert.ok(voice instanceof Blob && voice.size > 1000);
        const path = join(temp, "outbound.ogg");
        await writeFile(path, Buffer.from(await voice.arrayBuffer()));
        const metadata = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries",
          "stream=codec_name,sample_rate,channels:format=duration", "-of", "json", path], { encoding: "utf8" }));
        const [{ codec_name, sample_rate, channels }] = metadata.streams;
        assert.equal(codec_name, "opus");
        assert.equal(sample_rate, "48000");
        assert.equal(channels, 1);
        assert.ok(Number(metadata.format.duration) > 0.5);
        active.audio = { codec: codec_name, rate: Number(sample_rate), channels, seconds: Number(metadata.format.duration) };
      } else {
        assert.deepEqual(content.subarray(offset, offset + ogg.length), ogg);
      }
      active.voiceDeliveries++;
      send({ message_id: 9000 + active.update, chat, date: Math.floor(Date.now() / 1000), voice: { file_id: "delivered", file_unique_id: "out", duration: 1 } });
      break;
    }
    case "sendMessage":
      active.messages.push(content.toString().slice(0, 500));
      send({ message_id: 9000 + active.update, chat, date: Math.floor(Date.now() / 1000), text: reply });
      break;
    case "getWebhookInfo": send({ url: "", has_custom_certificate: false, pending_update_count: 0 }); break;
    case "getMyCommands": send([]); break;
    default: send(true); break;
  }
});
const httpPort = await listen(createServer(httpHandler));

execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
  "-subj", "/CN=api.vachana.ai", "-keyout", keyPath, "-out", certPath], { stdio: "ignore" });
const tlsServer = createHttpsServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, httpHandler);
const websockets = new WebSocketServer({ server: tlsServer });
const tlsPort = await listen(tlsServer);
const proxySockets = new Set();
const proxy = createServer((_req, res) => res.writeHead(403).end());
proxy.on("connect", (req, socket, head) => {
  if (req.url !== "api.vachana.ai:443") {
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  const upstream = tcpConnect(tlsPort, "127.0.0.1", () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(socket).pipe(upstream);
  });
  for (const connection of [socket, upstream]) {
    proxySockets.add(connection);
    connection.once("close", () => proxySockets.delete(connection));
  }
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
  socket.on("end", () => upstream.end());
});
const proxyPort = await listen(proxy);
websockets.on("connection", (socket, req) => {
  assert.equal(req.headers["x-api-key-id"], "fixture-key");
  const scenario = active;
  scenario.wsOpened++;
  socket.once("close", () => scenario.wsClosed++);
  if (req.url === "/stt/v3/stream") {
    assert.equal(req.headers.model, scenario.stt);
    socket.send('{"type":"connected"}');
    let frames = 0;
    socket.on("message", (message, binary) => {
      if (binary) {
        assert.equal(message.length, 1024);
        scenario.sttFrames++;
        frames++;
        if (frames === 2) socket.send('{"type":"transcript","segment_id":"fixture-turn","text":"fixture weather report","is_final":true}');
      } else if (JSON.parse(message.toString()).type === "commit") {
        socket.send('{"type":"transcript","segment_id":"fixture","text":"fixture weather report","is_final":true}');
      }
    });
    return;
  }
  assert.equal(req.url, "/api/v1/tts");
  socket.on("message", (message) => {
    const body = JSON.parse(message.toString());
    assert.equal(body.model, scenario.tts);
    const cancellation = body.text.includes("cancel");
    socket.send('{"type":"start"}');
    const send = (type, data) => {
      if (socket.readyState === 1) socket.send(JSON.stringify({ type, data }));
    };
    send("audio", { chunk_index: 1, audio: mp3.subarray(0, 900).toString("base64"), is_final: false });
    if (cancellation) return;
    send("audio", { chunk_index: 2, audio: mp3.subarray(900).toString("base64"), is_final: false });
    send("complete", { chunk_index: 3, audio: "", is_final: true });
  });
});

const rpcPlugin = join(temp, "speech-probe");
await mkdir(rpcPlugin);
await writeFile(join(rpcPlugin, "package.json"), JSON.stringify({
  name: "gnani-e2e-probe", version: "0.0.1", type: "module", openclaw: { extensions: ["./index.js"] },
}));
await writeFile(join(rpcPlugin, "openclaw.plugin.json"), JSON.stringify({
  id: "gnani-e2e-probe", name: "Offline speech runtime test probe", activation: { onStartup: true },
  configSchema: { type: "object", additionalProperties: false, properties: {} },
}));
await writeFile(join(rpcPlugin, "index.js"), `
export default {
  id: "gnani-e2e-probe",
  register(api) {
    api.registerGatewayMethod("gnani-e2e-probe.speech", async ({ params, respond }) => {
      const cfg = api.config;
      const overrides = { provider: "gnani", providerOverrides: { gnani: { streamTransport: params.transport } } };
      try {
        if (params.channel) {
          const result = await api.runtime.tts.textToSpeech({ text: "fixture weather report", cfg, overrides, channel: params.channel });
          respond(result.success, { provider: result.provider, target: result.target,
            voiceCompatible: result.voiceCompatible, audioPath: result.audioPath, error: result.error });
          return;
        }
        if (params.telephony) {
          const result = await api.runtime.tts.textToSpeechTelephony({ text: "fixture telephony", cfg, overrides });
          respond(result.success, { provider: result.provider, bytes: result.audioBuffer?.length,
            format: result.outputFormat, sampleRate: result.sampleRate, error: result.error });
          return;
        }
        const result = await api.runtime.tts.textToSpeechStream({ text: params.cancel ? "cancel fixture stream" : "fixture stream", cfg, overrides });
        if (!result.success) { respond(false, { error: result.error }); return; }
        const reader = result.audioStream.getReader();
        let bytes = 0;
        let chunks = 0;
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            bytes += next.value.length;
            chunks++;
            if (params.cancel) { await reader.cancel(); break; }
          }
        } finally {
          reader.releaseLock();
          await result.release?.();
        }
        respond(true, { provider: result.provider, chunks, bytes });
      } catch (error) {
        respond(false, { error: String(error) });
      }
    }, { scope: "operator.admin" });
  },
};
`);

const baseEnv = {
  ...process.env,
  OPENCLAW_STATE_DIR: target,
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_GATEWAY_TOKEN: token,
  ...(live ? {} : {
  GNANI_API_KEY: "fixture-key",
  HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
  https_proxy: `http://127.0.0.1:${proxyPort}`,
  HTTP_PROXY: "",
  http_proxy: "",
  NO_PROXY: "localhost,127.0.0.1",
  no_proxy: "localhost,127.0.0.1",
  NODE_EXTRA_CA_CERTS: certPath,
  GNANI_FIXTURE_TLS_PORT: String(tlsPort),
  GNANI_FIXTURE_CERT: certPath,
  NODE_OPTIONS: `--import=${resolve("tests/gateway-preload.mjs")}`,
  }),
};

async function command(args, extra = {}) {
  return (await certify(cli, args, { env: baseEnv, timeout: 30_000, maxBuffer: 1024 * 1024, ...extra })).stdout;
}

async function until(predicate, label, timeout = 25_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}`);
    if (gateway && (gateway.exitCode !== null || gateway.signalCode !== null)) throw new Error(`Gateway exited while waiting for ${label}`);
    await sleep(150);
  }
}

async function stop() {
  if (gateway && gateway.exitCode === null && gateway.signalCode === null) {
    gateway.kill("SIGTERM");
    await Promise.race([once(gateway, "exit"), sleep(15_000, undefined, { ref: false })]);
    if (gateway.exitCode === null && gateway.signalCode === null) {
      gateway.kill("SIGKILL");
      await once(gateway, "exit");
    }
  }
  gateway = undefined;
}

try {
  let update = Math.floor(Date.now() / 1000);
  for (const stt of ["prisma-v2.5", "prisma-v3.0"]) {
    for (const tts of ["timbre-v2.5", "timbre-v3.0"]) {
      if (process.env.GNANI_E2E_PAIR && process.env.GNANI_E2E_PAIR !== `${stt}/${tts}`) continue;
      const portServer = createServer();
      const port = await listen(portServer);
      await new Promise((done) => portServer.close(done));
      const voicePortServer = createServer();
      const voicePort = await listen(voicePortServer);
      await new Promise((done) => voicePortServer.close(done));
      const config = {
        ...installingConfig,
        gateway: { mode: "local", port, bind: "loopback", auth: { mode: "token" } },
        plugins: {
          ...installingConfig.plugins,
          load: { paths: [rpcPlugin] },
          allow: ["gnani", "telegram", "gnani-e2e-probe", ...(testVoiceCall ? ["voice-call"] : []),
            ...(testChannelTargets ? ["whatsapp", "slack"] : [])],
          entries: { ...installingConfig.plugins?.entries, gnani: { enabled: true },
            telegram: { enabled: true }, "gnani-e2e-probe": { enabled: true },
            ...(testChannelTargets ? { whatsapp: { enabled: true }, slack: { enabled: true } } : {}),
            ...(testVoiceCall ? { "voice-call": { enabled: true, config: {
              provider: "twilio",
              twilio: { accountSid: fixtureSid, authToken: fixtureAuth },
              fromNumber: "+15550001000", toNumber: "+15550002000",
              inboundPolicy: "allowlist", allowFrom: ["+15550002000"],
              publicUrl: publicWebhook, serve: { bind: "127.0.0.1", port: voicePort, path: "/voice/webhook" },
              webhookSecurity: { allowedHosts: ["call-fixture.example"] },
              streaming: { enabled: true, streamPath: "/voice/stream", provider: "gnani",
                providers: { gnani: { model: stt, language: "en-IN" } } },
            } } } : installingConfig.plugins?.entries?.["voice-call"] ? { "voice-call": { enabled: false } } : {}) },
        },
        agents: { defaults: { model: { primary: `fixture/${model}` }, workspace: join(temp, "agent"), skipBootstrap: true } },
        models: { providers: { fixture: {
          baseUrl: `http://127.0.0.1:${httpPort}/v1`, apiKey: "fixture-llm", api: "openai-completions",
          models: [{ id: model, name: "Fixture Chat", input: ["text"], contextWindow: 64000, maxTokens: 1024 }],
        } } },
        channels: { telegram: {
          enabled: true,
          botToken: "737373:fixture-fake-telegram-token",
          apiRoot: `http://127.0.0.1:${httpPort}`,
          network: { dangerouslyAllowPrivateNetwork: true },
          dmPolicy: "allowlist", allowFrom: [String(chat.id)],
        } },
        tools: { media: { audio: { enabled: true }, models: [{ provider: "gnani", model: stt, capabilities: ["audio"] }] } },
        tts: { auto: "inbound", provider: "gnani", providers: { gnani: {
          modelId: tts, speakerVoice: tts === "timbre-v2.5" ? "Kaveri" : "Shivani",
          language: "en-IN", timeoutMs: 5000,
        } } },
      };
      await writeFile(configPath, JSON.stringify(config, null, 2));
      logs = "";
      active = { stt, tts, update: update++, errors: [], messages: [], sentUpdate: false,
        voiceDeliveries: 0, sttRequests: 0, agentRequests: 0, noteRequests: 0,
        telephonyRequests: 0, sseRequests: 0, sseCancelled: 0, wsOpened: 0, wsClosed: 0, sttFrames: 0 };
      try {
        await command(["config", "validate", "--json"]);
        gateway = spawn(cli, ["gateway", "--port", String(port), "--bind", "loopback"], { env: baseEnv, stdio: ["ignore", "pipe", "pipe"] });
        for (const stream of [gateway.stdout, gateway.stderr]) stream.on("data", (chunk) => { logs += chunk.toString(); });
        await until(() => /\[gateway\] ready/.test(logs), "Gateway readiness");
        await command(["gateway", "health", "--port", String(port), "--json"]);
        if (logs.includes("channel autostart suppressed by crash-loop breaker")) {
          await command(["gateway", "call", "channels.start", "--port", String(port),
            "--params", JSON.stringify({ channel: "telegram" }), "--json"]);
        }
        await until(() => active.voiceDeliveries > 0 || active.errors.length > 0, "Telegram voice reply");
        assert.deepEqual(active.errors, []);
        assert.equal(active.voiceDeliveries, 1);
        assert.ok(active.agentRequests > 0);
        if (live) {
          assert.ok(active.audio, "Telegram did not receive playable live Timbre audio");
          reports.push({ stt, tts, status: "PASS", telegramVoice: active.voiceDeliveries, textTurns: active.agentRequests, audio: active.audio });
          continue;
        }
        assert.equal(active.sttRequests, 1);
        assert.equal(active.noteRequests, 1);

        const rpc = async (params) => JSON.parse(await command(["gateway", "call", "gnani-e2e-probe.speech", "--port", String(port),
          "--params", JSON.stringify(params), "--json"]));
        for (const transport of ["sse", "websocket"]) {
          const progressive = await rpc({ transport });
          assert.deepEqual(progressive, { provider: "gnani", chunks: 2, bytes: mp3.length });
          const cancelled = await rpc({ transport, cancel: true });
          assert.deepEqual(cancelled, { provider: "gnani", chunks: 1, bytes: 900 });
        }
        await until(() => active.sseCancelled === 1 && active.wsOpened === active.wsClosed, "stream cleanup");
        assert.deepEqual(await rpc({ telephony: true }), { provider: "gnani", bytes: raw.length, format: "pcm", sampleRate: 8000 });
        assert.equal(active.telephonyRequests, 1);
        const channels = {};
        const targets = testChannelTargets ? [["whatsapp", "voice-note", "opus"], ["slack", "audio-file", "mp3"]] : [];
        for (const [channel, target, codec] of targets) {
          const media = await rpc({ channel });
          assert.equal(media.provider, "gnani");
          assert.equal(media.target, target);
          const output = execFileSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries",
            "stream=codec_name", "-of", "csv=p=0", media.audioPath], { encoding: "utf8" }).trim();
          assert.equal(output, codec);
          channels[channel] = { target, codec };
        }
        if (testVoiceCall) {
          await until(() => /Media stream WebSocket on/i.test(logs), "Voice Call stream listener");
          const callSid = `CA${String(active.update).padStart(32, "0")}`;
          const params = new URLSearchParams({
            AccountSid: fixtureSid, CallSid: callSid, CallStatus: "ringing",
            Direction: "inbound", From: "+15550002000", To: "+15550001000",
          });
          const sendWebhook = (body, query = "") => {
            const payload = publicWebhook + query + [...body].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => key + value).join("");
            const signature = createHmac("sha1", fixtureAuth).update(payload).digest("base64");
            return fetch(`http://127.0.0.1:${voicePort}/voice/webhook${query}`, {
              method: "POST", body, headers: { "X-Twilio-Signature": signature },
            });
          };
          const response = await sendWebhook(params);
          const twiml = await response.text();
          assert.equal(response.status, 200, twiml);
          const streamToken = /<Parameter name="token" value="([^"]+)"/.exec(twiml)?.[1];
          assert.ok(streamToken, twiml);
          const streamSid = "MZ" + "f".repeat(32);
          const carrier = new WebSocket(`ws://127.0.0.1:${voicePort}/voice/stream`, { handshakeTimeout: 5000 });
          try {
            await once(carrier, "open");
            carrier.on("message", (message) => {
              const frame = JSON.parse(message.toString());
              if (frame.event === "mark") carrier.send(JSON.stringify({ event: "mark", streamSid, mark: frame.mark }));
            });
            carrier.send(JSON.stringify({ event: "start", streamSid, start: { callSid, customParameters: { token: streamToken } } }));
            const mulaw = Buffer.alloc(160, 0xff).toString("base64");
            for (let i = 0; i < 10; i++) {
              carrier.send(JSON.stringify({ event: "media", streamSid, media: { payload: mulaw } }));
              await sleep(20);
            }
            await until(() => active.sttFrames >= 2 && logs.includes(`Transcript received ${callSid}`), "Voice Call transcript");
            carrier.send(JSON.stringify({ event: "stop", streamSid }));
            await until(() => active.wsOpened === active.wsClosed, "Voice Call session cleanup");
          } finally {
            carrier.terminate();
            params.set("CallStatus", "completed");
            const ended = await sendWebhook(params, "?type=status");
            assert.equal(ended.status, 200, await ended.text());
          }
        }
        reports.push({ stt, tts, status: "PASS", telegramVoice: active.voiceDeliveries,
          gnaniSTT: active.sttRequests, textTurns: active.agentRequests, gnaniTTS: active.noteRequests,
          streamSSE: active.sseRequests, wsClosed: active.wsClosed, telephony: active.telephonyRequests, voiceCallFrames: active.sttFrames, channels });
      } catch (error) {
        const diagnostic = [error.message, error.stdout, error.stderr].filter(Boolean).join("\n").slice(0, 1800);
        const redacted = (text) => live ? text.replaceAll(process.env.GNANI_API_KEY, "[redacted]") : text;
        reports.push({ stt, tts, status: "FAIL", error: redacted(diagnostic), errors: active.errors.map(redacted), messages: active.messages.map(redacted) });
        await mkdir(".clawhub-validation", { recursive: true });
        const safeLogs = live ? logs.replaceAll(process.env.GNANI_API_KEY, "[redacted]") : logs;
        await writeFile(`.clawhub-validation/${live ? "live-" : ""}${stt}-${tts}.log`, safeLogs);
      } finally {
        console.log(JSON.stringify(reports.at(-1)));
        await stop();
      }
    }
  }
} finally {
  await stop();
  for (const socket of websockets.clients) socket.terminate();
  for (const socket of proxySockets) socket.destroy();
  websockets.close();
  for (const server of servers) {
    server.closeAllConnections?.();
    server.close();
  }
  await writeFile(configPath, JSON.stringify(installingConfig, null, 2));
  await mkdir(".clawhub-validation", { recursive: true });
  const results = `.clawhub-validation/gateway-${live ? "live-" : ""}results.json`;
  const previous = process.env.GNANI_E2E_PAIR ? JSON.parse(await readFile(results, "utf8").catch(() => "[]")) : [];
  const combined = new Map([...previous, ...reports].map((row) => [`${row.stt}/${row.tts}`, row]));
  await writeFile(results, JSON.stringify([...combined.values()], null, 2) + "\n");
  await rm(temp, { recursive: true, force: true });
}
if (reports.some(({ status }) => status !== "PASS")) process.exitCode = 1;
