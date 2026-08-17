"use strict";
// Load one `web/library-sections/*.js` file into an isolated sandbox.
//
// Those files are classic scripts that share one global scope in the browser
// (see the split note in library-sections/), so there is nothing to require.
// Running one in a `vm` context gives its top-level declarations back as
// properties of that context -- enough to unit-test a pure helper without a
// DOM. References to globals another section owns are fine as long as the
// function under test does not call them.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SECTIONS = path.join(__dirname, "..", "..", "library-sections");

function loadSection(fileName, extraGlobals = {}) {
  const context = {
    console,
    window: {},
    document: {},
    setTimeout,
    clearTimeout,
    fetch: () => {
      throw new Error("no network in these tests");
    },
    ...extraGlobals,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(SECTIONS, fileName), "utf8"), context);
  return context;
}

module.exports = { loadSection };
