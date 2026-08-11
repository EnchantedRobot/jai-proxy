"use strict";
// Test harness for web/archive-api.js.
//
// The adapter is a browser IIFE that replaces window.fetch, so testing it means
// giving it a window to install into and a fetch to wrap. Both are fakes here,
// and that is the whole point: what the tests assert is the *translation* --
// which /api/v1 URL an ST-shaped call turns into, and what shape comes back --
// which is exactly the part a live server would hide behind real data.
//
// Node's own Response/Headers/TextDecoder are used as-is; they are the same
// WHATWG classes the browser gives the adapter.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ADAPTER = path.join(__dirname, "..", "..", "archive-api.js");
const ORIGIN = "http://archive.test";

/**
 * Load the adapter with a stubbed origin and a scripted upstream.
 *
 * `responses` maps a URL (path + query, exactly as the adapter builds it) to
 * either a Response or a plain object that becomes a JSON 200. Anything the
 * adapter requests that is not in the map is a test failure, recorded in
 * `calls` so the assertion can say what was asked for instead of just what
 * came back.
 */
function loadAdapter(responses = {}) {
  const calls = [];
  // The same requests as `calls`, with the method and body kept. Writes are the
  // reason: a route that translates a POST into a PUT or a DELETE is only
  // half-tested by asserting the URL, and a body sent as multipart has to be
  // inspected to know the right part names went out.
  const requests = [];
  const store = new Map();

  const nativeFetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const relative = url.startsWith(ORIGIN) ? url.slice(ORIGIN.length) : url;
    calls.push(relative);
    requests.push({
      url: relative,
      method: (init?.method || "GET").toUpperCase(),
      body: init?.body,
    });
    const canned = responses[relative];
    if (canned === undefined) {
      return new Response(JSON.stringify({ error: `unstubbed: ${relative}` }), {
        status: 599,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (canned instanceof Response) return canned;
    return new Response(JSON.stringify(canned), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  // Listeners the adapter registers, so a test can fire the lifecycle events it
  // flushes pending settings on rather than waiting out a real timer.
  const listeners = { window: {}, document: {} };
  const record = (bag) => (event, fn) => {
    (bag[event] ||= []).push(fn);
  };

  const window = {
    fetch: nativeFetch,
    location: { origin: ORIGIN, href: `${ORIGIN}/index.html` },
    localStorage,
    addEventListener: record(listeners.window),
  };
  window.window = window;

  const document = {
    visibilityState: "visible",
    addEventListener: record(listeners.document),
  };

  const errors = [];
  const sandbox = {
    window,
    document,
    localStorage,
    console: { info() {}, warn() {}, log() {}, error: (...a) => errors.push(a.join(" ")) },
    Response,
    Request,
    Headers,
    URL,
    TextDecoder,
    // The write routes build multipart bodies: replacing an avatar forwards the
    // File it was handed, and a gallery upload turns the frontend's base64 back
    // into bytes. Node's own WHATWG classes, same as the browser's.
    FormData,
    Blob,
    File,
    Uint8Array,
    setTimeout,
    clearTimeout,
    atob: (b64) => Buffer.from(b64, "base64").toString("binary"),
    btoa: (bin) => Buffer.from(bin, "binary").toString("base64"),
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(ADAPTER, "utf8"), sandbox, { filename: "archive-api.js" });

  /** Fire a registered lifecycle event, e.g. fire("window", "pagehide"). */
  const fire = (target, event) => {
    for (const fn of listeners[target][event] || []) fn();
  };

  return { fetch: window.fetch, calls, requests, store, origin: ORIGIN, fire, document, errors };
}

/** POST the way library.js's apiRequest() does: JSON body, JSON content type. */
function post(fetch, path, body) {
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

/** One `/api/v1` card, with only the fields a test cares about overridden. */
function card(overrides = {}) {
  return {
    id: "Abbie_0d162f5f.png",
    name: "Abbie",
    creator: "KornyPony",
    page_name: "Offer You Can't Refuse | Abbie",
    tags: ["Female", "Vampire"],
    source_kind: "janitor_core",
    source_url: "https://janitorai.com/characters/0d162f5f",
    card_id: "0d162f5f-86ab-4fdd-a2c2-3912adf24960",
    fragment: "0d162f5f",
    gallery_id: "kzbYR2QbpncC",
    character_version: "1",
    greetings: 3,
    lore_entries: 33,
    description_chars: 2000,
    prompt_chars: 4000,
    has_creator_notes: true,
    has_example_dialogue: false,
    size: 812345,
    modified: "2026-07-17T12:00:00Z",
    linked_at: "2026-07-17T12:00:00Z",
    thumb_url: "/api/v1/characters/Abbie_0d162f5f.png/thumb",
    png_url: "/api/v1/characters/Abbie_0d162f5f.png/png",
    extensions: { gallery_id: "kzbYR2QbpncC", jai: { id: "0d162f5f", pageName: "Abbie" } },
    error: null,
    ...overrides,
  };
}

module.exports = { loadAdapter, post, card, ORIGIN };
