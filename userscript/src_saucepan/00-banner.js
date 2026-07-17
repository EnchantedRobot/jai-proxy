// ==UserScript==
// @name         saucepan-proxy bridge
// @namespace    https://github.com/EnchantedRobot/jai-proxy
// @version      0.7.0
// @description  Thin bridge: relays Saucepan chat completions through a local saucepan-proxy server (which forwards to local MLX), shows a connection pill, and exports a character as a V3 card PNG via Saucepan's clean JSON API (no DOM scraping). Card assembly lives server-side.
// @match        https://saucepan.ai/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      saucepan.ai
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==
//
// SOURCE LAYOUT — this file is COMPILED. Do not edit saucepan-proxy-bridge.user.js by
// hand; edit userscript/src/*.js and run `make compile` (see
// scripts/compile_userscript.py). The modules are concatenated, in order, inside
// a single IIFE beneath this banner.
