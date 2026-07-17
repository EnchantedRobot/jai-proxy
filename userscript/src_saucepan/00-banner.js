// ==UserScript==
// @name         saucepan-proxy bridge
// @namespace    https://github.com/EnchantedRobot/jai-proxy
// @version      0.8.0
// @description  Thin bridge: exports a Saucepan companion as a V3 card PNG via Saucepan's clean JSON API (no DOM scraping) and shows a local jai-proxy connection pill. Card assembly lives server-side.
// @match        https://saucepan.ai/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      saucepan.ai
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==
//
// SOURCE LAYOUT — this file is COMPILED. Do not edit saucepan-proxy-bridge.user.js
// by hand; edit userscript/src_saucepan/*.js and run `make compile` (see
// scripts/compile_userscript_saucepan.py). The modules are concatenated, in
// order, inside a single IIFE beneath this banner.
