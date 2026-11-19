// The isolated Gateway uses HTTPS CONNECT for HTTP fixtures. Route only the
// Gnani WebSocket handshake to the same fixture TLS server.
import https from "node:https";
import { readFileSync } from "node:fs";

const origin = "api.vachana.ai";
const request = https.request;
const ca = readFileSync(process.env.GNANI_FIXTURE_CERT);
https.request = function routeGnani(options, ...tail) {
  if (options?.hostname === origin || options?.host === origin) {
    return request.call(this, { ...options, hostname: "127.0.0.1", host: "127.0.0.1",
      port: Number(process.env.GNANI_FIXTURE_TLS_PORT), servername: origin, ca, agent: false }, ...tail);
  }
  return request.call(this, options, ...tail);
};
