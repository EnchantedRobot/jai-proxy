#!/usr/bin/env python
"""Boot-and-browse smoke test for the vendored web/ frontend.

Loads the app against a running server, exercises the surfaces that must keep
working through the trim, and reports every console error / failed request.

    python smoke.py [http://127.0.0.1:8002] [label]
"""
import json
import re
import sys
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8002"
LABEL = sys.argv[2] if len(sys.argv) > 2 else "run"

# Noise we expect and do not want to fail on.
IGNORE = [
    re.compile(r"501"),                      # archive API is read-only
    re.compile(r"favicon"),
]


def ignored(text):
    return any(p.search(text) for p in IGNORE)


def main():
    errors, failed = [], []
    result = {"label": LABEL}

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1600, "height": 1000})

        page.on("console", lambda m: (
            errors.append(f"{m.type}: {m.text}")
            if m.type in ("error", "warning") and not ignored(m.text) else None))
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.on("requestfailed", lambda r: (
            failed.append(f"{r.url} {r.failure}")
            if not ignored(r.url) else None))
        page.on("response", lambda r: (
            failed.append(f"HTTP {r.status} {r.url}")
            if r.status >= 400 and not ignored(r.url) else None))

        try:
            drive(page, result)
        except Exception as exc:  # keep the console log — it names the cause
            result["ABORTED"] = f"{type(exc).__name__}: {str(exc).splitlines()[0]}"

        browser.close()

    result["console_errors"] = errors
    result["failed_requests"] = sorted(set(failed))
    print(json.dumps(result, indent=2))
    return 1 if errors or failed or result.get("ABORTED") else 0


def drive(page, result):
        page.goto(BASE, wait_until="networkidle", timeout=120_000)
        page.wait_for_selector(".character-card, .char-card", timeout=120_000)
        page.wait_for_timeout(2500)

        result["cards_rendered"] = page.eval_on_selector_all(
            ".character-card, .char-card", "els => els.length")
        result["total_characters"] = page.evaluate(
            "() => (window.allCharacters || []).length")
        result["thumbs_broken"] = page.evaluate(
            "() => [...document.images].filter(i => i.complete && "
            "i.naturalWidth === 0 && i.src && !i.src.startsWith('data:')).length")

        # --- detail modal ---
        page.eval_on_selector(".character-card, .char-card", "el => el.click()")
        page.wait_for_selector("#charModal:not(.hidden)", timeout=30_000)
        page.wait_for_timeout(1500)
        result["modal_tabs"] = page.eval_on_selector_all(
            "#charModal .tab-btn:not(.hidden)", "els => els.map(e => e.dataset.tab)")
        result["portrait_ok"] = page.evaluate(
            "() => { const i = document.querySelector('#charModal img'); "
            "return !!i && i.naturalWidth > 0; }")

        # --- gallery tab ---
        tab = page.query_selector("#charModal .tab-btn[data-tab='gallery']")
        if tab:
            tab.click()
            page.wait_for_timeout(2500)
            result["gallery_imgs"] = page.eval_on_selector_all(
                "#charModal img", "els => els.length")
        page.keyboard.press("Escape")
        page.wait_for_timeout(800)

        # --- settings modal ---
        page.click("#moreOptionsBtn")
        page.wait_for_timeout(400)
        page.click("#gallerySettingsBtn")
        page.wait_for_timeout(1500)
        result["settings_sections"] = page.eval_on_selector_all(
            ".settings-nav-item", "els => els.map(e => e.dataset.section)")
        result["settings_panels"] = page.eval_on_selector_all(
            ".settings-panel", "els => els.length")
        # click through every section: a panel that throws only does so on open
        for sec in result["settings_sections"]:
            page.click(f".settings-nav-item[data-section='{sec}']")
            page.wait_for_timeout(600)
        page.keyboard.press("Escape")
        page.wait_for_timeout(500)

        # --- help modal, every section ---
        page.click("#moreOptionsBtn")
        page.wait_for_timeout(400)
        page.click("#galleryInfoBtn")
        page.wait_for_timeout(1000)
        result["help_sections"] = page.eval_on_selector_all(
            ".help-nav-item", "els => els.map(e => e.dataset.section)")
        for sec in result["help_sections"]:
            page.click(f".help-nav-item[data-section='{sec}']")
            page.wait_for_timeout(300)
        page.keyboard.press("Escape")
        page.wait_for_timeout(500)

        # --- toolbar surface ---
        result["toolbar_buttons"] = page.eval_on_selector_all(
            ".filter-area#filterArea > *, .filter-area#filterArea button[id]",
            "els => els.map(e => e.id || e.className).filter(Boolean)")
        result["multiselect_btn"] = page.evaluate(
            "() => !!document.getElementById('multiSelectToggleBtn')")
        result["views"] = page.eval_on_selector_all(
            ".view-toggle-btn", "els => els.map(e => e.dataset.view)")
        result["menu_items"] = page.eval_on_selector_all(
            "#moreOptionsMenu .dropdown-item",
            "els => els.map(e => e.id).filter(Boolean)")
        result["modules"] = page.evaluate(
            "() => Object.keys(window.ModuleLoader?.modules || {}).sort()")
        result["providers"] = page.evaluate(
            "() => (window.ProviderRegistry?.getAllProviders() || [])"
            ".map(p => p.id).sort()")


if __name__ == "__main__":
    sys.exit(main())
