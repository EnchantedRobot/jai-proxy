"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadModules, plain } = require("./helpers/load-src");

// GM_xmlhttpRequest is only referenced inside ServerClient._request (never at
// load time), so client-server.js needs nothing else at load; `respond` is
// handed the captured options and decides how the "network" answers. SERVER is
// seeded rather than loaded: it lives in config.js now (it is persisted, since
// the server can be remote), and these tests are about the request shape, not
// about where it is addressed -- see config.server-url.test.js for that.
function load(respond) {
  const calls = [];
  const GM_xmlhttpRequest = (opts) => {
    calls.push(opts);
    respond(opts);
  };
  const { ServerClient } = loadModules(["client-server.js"], ["ServerClient"], {
    GM_xmlhttpRequest,
    SERVER: "http://127.0.0.1:8000",
  });
  return { ServerClient, calls };
}

test("health() GETs /health, sends JSON headers + the 15s default timeout, and parses the body", async () => {
  const { ServerClient, calls } = load((opts) => {
    opts.onload({ status: 200, responseText: JSON.stringify({ status: "ok" }) });
  });
  const result = await ServerClient.health();
  assert.deepEqual(plain(result), { status: "ok" });
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].url, "http://127.0.0.1:8000/health");
  assert.equal(calls[0].headers["Content-Type"], "application/json");
  assert.equal(calls[0].timeout, 15000);
});

test("relay() POSTs the chat body to /v1/chat/completions with a 120s timeout and returns raw text", async () => {
  const { ServerClient, calls } = load((opts) => {
    opts.onload({ status: 200, responseText: "not-json-on-purpose" });
  });
  const body = { model: "gpt", messages: [] };
  const text = await ServerClient.relay(body);
  assert.equal(text, "not-json-on-purpose");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "http://127.0.0.1:8000/v1/chat/completions");
  assert.equal(calls[0].data, JSON.stringify(body));
  assert.equal(calls[0].timeout, 120000);
});

test("existing() posts ids to /existing and returns the existing array", async () => {
  const { ServerClient, calls } = load((opts) => {
    opts.onload({ status: 200, responseText: JSON.stringify({ existing: ["a", "b"] }) });
  });
  const ids = await ServerClient.existing(["a", "b", "c"]);
  assert.deepEqual(plain(ids), ["a", "b"]);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "http://127.0.0.1:8000/existing");
  assert.equal(calls[0].data, JSON.stringify({ ids: ["a", "b", "c"] }));
});

test("existing() falls back to an empty array when the response omits the field", async () => {
  const { ServerClient } = load((opts) => {
    opts.onload({ status: 200, responseText: JSON.stringify({}) });
  });
  assert.deepEqual(plain(await ServerClient.existing(["x"])), []);
});

test("captureStatus() URL-encodes the character name into the query string", async () => {
  const { ServerClient, calls } = load((opts) => {
    opts.onload({ status: 200, responseText: JSON.stringify({ system: true, greetings: true }) });
  });
  await ServerClient.captureStatus("Foo & Bar/Baz");
  assert.equal(
    calls[0].url,
    "http://127.0.0.1:8000/capture-status?name=" + encodeURIComponent("Foo & Bar/Baz")
  );
  assert.equal(calls[0].method, "GET");
});

test("_request rejects with the status and body text on a non-2xx response", async () => {
  const { ServerClient } = load((opts) => {
    opts.onload({ status: 404, responseText: "not found" });
  });
  await assert.rejects(ServerClient.health(), /HTTP 404: not found/);
});

test("_request rejects on a transport error", async () => {
  const { ServerClient } = load((opts) => opts.onerror());
  await assert.rejects(ServerClient.health(), /network error/);
});

test("_request rejects on timeout", async () => {
  const { ServerClient } = load((opts) => opts.ontimeout());
  await assert.rejects(ServerClient.health(), /timeout/);
});
