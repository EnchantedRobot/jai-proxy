// ==UserScript==
// @name         jai-proxy bridge
// @namespace    https://github.com/EnchantedRobot/jai-proxy
// @version      0.7.0
// @description  Thin bridge: relays JanitorAI chat completions through a local jai-proxy server (which forwards to local MLX), shows a connection pill, and exports a character as a V3 card PNG via JanitorAI's clean JSON API (no DOM scraping). Card assembly lives server-side.
// @match        https://janitorai.com/*
// @match        https://www.janitorai.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      127.0.0.1
// @connect      localhost
// @connect      janitorai.com
// @connect      ella.janitorai.com
// ==/UserScript==
//
// SOURCE LAYOUT — this file is COMPILED. Do not edit jai-proxy-bridge.user.js by
// hand; edit userscript/src/*.js and run `make compile` (see
// scripts/compile_userscript.py). The modules are concatenated, in order, inside
// a single IIFE beneath this banner.
