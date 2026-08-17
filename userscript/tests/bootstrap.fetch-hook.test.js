"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadModules } = require("./helpers/load-src");

// bootstrap.js's FetchHook.install() runs at load time and calls
// client-server.js's log(), and boot() reaches for Overlay/scheduleTick from
// other modules we don't need here -- so pull in client-server.js (for
// log/warn) and keep readyState "loading" so boot() itself is deferred to a
// DOMContentLoaded listener that's never fired. window/XHR just need to exist
// for FetchHook.install() to patch them without throwing.
//
// SERVER is seeded rather than loaded: it lives in config.js now (persisted,
// since the server can be remote). Seeding it is what keeps the probe
// assertions below about the *matching rule* rather than about config content.
function load(server = "http://127.0.0.1:8000") {
  function XHRStub() {}
  return loadModules(
    ["client-server.js", "bootstrap.js"],
    ["looksLikeChatCompletion", "looksLikeModelsProbe"],
    {
      document: { readyState: "loading", addEventListener() {} },
      window: { XMLHttpRequest: XHRStub },
      SERVER: server,
    }
  );
}

test("looksLikeChatCompletion matches on URL alone", () => {
  const { looksLikeChatCompletion } = load();
  assert.equal(looksLikeChatCompletion("https://janitorai.com/chat/completions", null), true);
  assert.equal(looksLikeChatCompletion("https://janitorai.com/chat/completions", undefined), true);
});

test("looksLikeChatCompletion falls back to sniffing a messages[] + model body", () => {
  const { looksLikeChatCompletion } = load();
  const body = JSON.stringify({ model: "gpt", messages: [{ role: "user", content: "hi" }] });
  assert.equal(looksLikeChatCompletion("https://example.com/anything", body), true);
});

test("looksLikeChatCompletion rejects a body missing messages[] or model", () => {
  const { looksLikeChatCompletion } = load();
  assert.equal(
    looksLikeChatCompletion("https://example.com/x", JSON.stringify({ model: "gpt" })),
    false
  );
  assert.equal(
    looksLikeChatCompletion(
      "https://example.com/x",
      JSON.stringify({ messages: "not-an-array", model: "gpt" })
    ),
    false
  );
});

test("looksLikeChatCompletion rejects unrelated URLs with no/invalid body", () => {
  const { looksLikeChatCompletion } = load();
  assert.equal(looksLikeChatCompletion("https://example.com/x", null), false);
  assert.equal(looksLikeChatCompletion("https://example.com/x", "not json"), false);
});

test("looksLikeModelsProbe matches a GET against our own server's /models", () => {
  const { looksLikeModelsProbe } = load();
  assert.equal(looksLikeModelsProbe("GET", "http://127.0.0.1:8000/v1/models"), true);
  assert.equal(looksLikeModelsProbe(undefined, "http://127.0.0.1:8000/v1/models"), true); // defaults to GET
});

test("looksLikeModelsProbe rejects non-GET methods", () => {
  const { looksLikeModelsProbe } = load();
  assert.equal(looksLikeModelsProbe("POST", "http://127.0.0.1:8000/v1/models"), false);
});

test("looksLikeModelsProbe follows SERVER to a remote host", () => {
  // The probe is matched with url.startsWith(SERVER), so pointing the bridge
  // at a container elsewhere means the URL configured in JanitorAI's provider
  // settings has to move with it -- a mismatch stops the probe being
  // intercepted, silently. This is the case that catches that coupling.
  const { looksLikeModelsProbe } = load("http://192.168.1.50:8000");
  assert.equal(looksLikeModelsProbe("GET", "http://192.168.1.50:8000/v1/models"), true);
  assert.equal(looksLikeModelsProbe("GET", "http://127.0.0.1:8000/v1/models"), false);
});

test("looksLikeModelsProbe never shadows JanitorAI's own unrelated /models calls", () => {
  const { looksLikeModelsProbe } = load();
  assert.equal(looksLikeModelsProbe("GET", "https://janitorai.com/some/models"), false);
  assert.equal(looksLikeModelsProbe("GET", ""), false);
});
