"use strict";
// Test-only loader for userscript/src_jai/*.js modules.
//
// The modules aren't real CommonJS/ESM -- they're plain source fragments
// authored to be concatenated inside one IIFE (see
// scripts/compile_userscript_jai.py), sharing scope the way the compiled
// .user.js does in the browser. So to unit-test a piece of logic here we
// reproduce that same shape for just the modules it needs: concatenate the
// requested files inside an IIFE, run it in an isolated vm context, and pull
// the requested top-level names out through an epilogue appended inside that
// same scope.
//
// `globals` seeds the sandbox *before* the module code runs, so a test can
// hand a module its dependencies (e.g. bulk.js's `BULK_TAG_FILTER`, normally
// supplied by config.js) without coupling the test to real config content or
// pulling in unrelated modules.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC_DIR = path.join(__dirname, "..", "..", "src_jai");

function loadModules(names, exposeNames, globals = {}) {
  const body = names
    .map((name) => fs.readFileSync(path.join(SRC_DIR, name), "utf8").replace(/\n$/, ""))
    .join("\n\n");
  const epilogue = exposeNames
    .map(
      (name) =>
        `__exports__[${JSON.stringify(name)}] = typeof ${name} === "undefined" ? undefined : ${name};`
    )
    .join("\n");
  const source = `(function () {\n  "use strict";\n\n${body}\n\n${epilogue}\n})();`;

  const sandbox = { __exports__: {}, console, ...globals };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: names.join("+") });
  return sandbox.__exports__;
}

// Objects/arrays a loaded module hands back are native to the vm's own
// realm, so assert.deepStrictEqual's prototype check fails them against an
// identical-looking literal in the test file's realm ("same structure but
// not reference-equal"). Round-tripping through JSON rebuilds the value with
// the test file's own Object/Array before a deepEqual comparison.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = { loadModules, plain, SRC_DIR };
