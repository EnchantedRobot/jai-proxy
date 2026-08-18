#!/usr/bin/env python
"""Boot-and-browse smoke test for the React archive client.

The successor to `web/tests/smoke.py`, which drove the vendored frontend. Kept
as a real browser gate rather than folded into vitest because that is what it is
for: vitest runs components against MSW, and every regression this file has
actually caught -- a missing route, a thumbnail path that 404s, a static asset
served stale -- lived in the space between the app and the real server, where a
mock would have answered happily.

    python frontend/tests/smoke.py [http://127.0.0.1:8000] [label]

Exits non-zero on any console error, any failed request to our own origin, or
any assertion below.
"""
import json
import re
import sys

from playwright.sync_api import sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000").rstrip("/")
LABEL = sys.argv[2] if len(sys.argv) > 2 else "run"

# Where the app is mounted during the overlap. One line to change at cut-over.
APP = f"{BASE}/next/"

IGNORE = [re.compile(r"favicon")]


def ignored(text: str) -> bool:
    return any(p.search(text) for p in IGNORE)


def foreign(url: str) -> bool:
    """True for a request to somewhere other than the server under test. A card
    portrait is served by us; a creator-notes image on a remote CDN is not, and
    whether that CDN answers is not what this gate is about."""
    return not url.startswith(BASE)


def main() -> int:
    errors: list[str] = []
    failed: list[str] = []
    result: dict = {"label": LABEL}

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1600, "height": 1000})

        page.on("console", lambda m: (
            errors.append(f"{m.type}: {m.text}")
            if m.type in ("error", "warning") and not ignored(m.text) else None))
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.on("requestfailed", lambda r: (
            failed.append(f"{r.url} {r.failure}")
            if not ignored(r.url) and not foreign(r.url) else None))
        page.on("response", lambda r: (
            failed.append(f"HTTP {r.status} {r.url}")
            if r.status >= 400 and not ignored(r.url) and not foreign(r.url) else None))

        try:
            drive(page, result)
        except Exception as exc:  # keep the console log -- it names the cause
            result["ABORTED"] = f"{type(exc).__name__}: {str(exc).splitlines()[0]}"

        browser.close()

    result["console_errors"] = errors
    result["failed_requests"] = sorted(set(failed))
    print(json.dumps(result, indent=2))
    return 1 if errors or failed or result.get("ABORTED") else 0


def tiles(page) -> int:
    return page.eval_on_selector_all("a[href*='/characters/']", "els => els.length")


def drive(page, result: dict) -> None:
    page.goto(APP, wait_until="networkidle", timeout=60_000)
    page.wait_for_selector("a[href*='/characters/']", timeout=60_000)
    page.wait_for_timeout(1200)

    result["shown"] = page.inner_text(".sticky span")
    result["tiles_first_paint"] = tiles(page)

    # Every tile is a link, so a broken portrait is a broken thumbnail route --
    # the one class of failure that is invisible in a screenshot of a dark UI.
    result["thumbs_broken"] = page.evaluate(
        "() => [...document.images].filter(i => i.complete && i.naturalWidth === 0"
        " && i.src && !i.src.startsWith('data:')).length")

    # --- infinite scroll: the second page must arrive on its own ---
    before = tiles(page)
    # The app scrolls its own container, not the document, so the wheel has to
    # land over the grid -- the pointer starts at (0,0), which is the fixed top
    # bar and scrolls nothing.
    page.mouse.move(800, 600)
    page.mouse.wheel(0, 40_000)
    page.wait_for_timeout(2500)
    result["tiles_after_scroll"] = tiles(page)
    result["paged"] = result["tiles_after_scroll"] > before

    # --- a chip filters, and narrows ---
    page.mouse.move(800, 600)
    page.mouse.wheel(0, -60_000)
    page.wait_for_timeout(400)
    page.click("button:text-is('Has a lorebook')")
    page.wait_for_timeout(1200)
    result["filtered_count"] = page.inner_text(".sticky span")
    result["filtered_url"] = page.url
    page.click("button:text-is('All')")
    page.wait_for_timeout(800)

    # --- sort ---
    page.click("button:has-text('Sort')")
    page.wait_for_timeout(300)
    page.click("button:text-is('Recently added')")
    page.wait_for_timeout(1200)
    result["sorted_url"] = page.url

    # --- the tag catalogue behind + Filter ---
    page.click("button:text-is('＋ Filter')")
    page.wait_for_timeout(900)
    result["tag_options"] = page.eval_on_selector_all(
        "[role=dialog] button, [data-radix-popper-content-wrapper] button",
        "els => els.length")
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)

    # --- search overlay ---
    page.keyboard.press("Meta+k")
    page.wait_for_timeout(700)
    page.fill("input[aria-label='Search query']", "abbie")
    page.wait_for_timeout(1500)
    result["search_matches"] = page.inner_text("[role=dialog] >> text=/matches/")
    result["search_results"] = page.eval_on_selector_all(
        "[role=dialog] a[href*='/characters/']", "els => els.length")
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)

    # --- favourites tab ---
    page.click("a:text-is('Favorites')")
    page.wait_for_timeout(1500)
    result["favorites_url"] = page.url
    result["favorites_count"] = page.inner_text(".sticky span")

    # --- deep link: the SPA fallback the old UI never had ---
    page.goto(f"{APP}favorites?sort=-added", wait_until="networkidle", timeout=60_000)
    page.wait_for_timeout(1200)
    result["deep_link_ok"] = "Favorites" in page.inner_text("h1")

    # --- card detail: open the first tile, walk the tabs, page next ---
    page.goto(APP, wait_until="networkidle", timeout=60_000)
    page.wait_for_selector("a[href*='/characters/']", timeout=60_000)
    page.wait_for_timeout(800)
    first = page.get_attribute("main a[href*='/characters/'], a[href*='/characters/']", "href")
    page.click("a[href*='/characters/']")
    page.wait_for_selector("h1", timeout=60_000)
    page.wait_for_timeout(1000)
    result["detail_url"] = page.url
    result["detail_name"] = page.inner_text("h1")
    result["detail_tabs"] = page.eval_on_selector_all(
        "nav button", "els => els.map(e => e.textContent.replace(/\\d+$/,'').trim())")

    # Each content tab must render without a console error (caught globally).
    for tab in ("Greetings", "Lorebook", "Gallery", "Related", "Creator notes", "Info"):
        btn = page.query_selector(f"nav button:has-text('{tab}')")
        if btn:
            btn.click()
            page.wait_for_timeout(500)
    result["info_has_json"] = "chara_card" in page.inner_text("body")

    # The Info tab's card.json and the creator-notes iframe are the two panes a
    # screenshot cannot vouch for; assert the iframe mounted.
    page.query_selector("nav button:has-text('Creator notes')").click()
    page.wait_for_timeout(800)
    result["notes_iframe"] = page.eval_on_selector_all(
        "iframe[title='Creator notes']", "els => els.length")

    # prev/next: J steps to the next card in the browse set.
    page.query_selector("nav button:has-text('Overview')").click()
    page.wait_for_timeout(300)
    before_url = page.url
    page.keyboard.press("j")
    page.wait_for_timeout(1200)
    result["pager_moved"] = page.url != before_url

    # --- writes, all reversible so the real archive is left as it was ---
    # Favourite is the one end-to-end write cheap enough to prove live: star the
    # card, confirm the button flips, then unstar it back. A round trip through
    # POST /favorite that rewrites the PNG and leaves it exactly as found.
    starred = page.query_selector("button:has-text('Favourite')")
    if starred:
        starred.click()
        page.wait_for_selector("button:has-text('Favourited')", timeout=15_000)
        result["favourite_toggled"] = True
        page.click("button:text-is('Favourited')")
        page.wait_for_selector("button:text-is('Favourite')", timeout=15_000)

    # The inline editor opens and cancels without writing: click Edit on a
    # section, confirm a textarea appears, Cancel, confirm it is gone.
    edit = page.query_selector("section:has-text('Description') button:has-text('Edit')")
    if edit:
        edit.click()
        page.wait_for_selector("textarea", timeout=10_000)
        result["editor_opens"] = True
        page.click("button:has-text('Cancel')")
        page.wait_for_timeout(400)
        result["editor_closes"] = page.query_selector("textarea") is None

    # The Import menu opens and offers its live doors (no write).
    page.click("button[title='Import']")
    page.wait_for_timeout(500)
    result["import_menu"] = page.eval_on_selector_all(
        "[data-radix-popper-content-wrapper] button", "els => els.length")
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)

    # deep link straight to a detail route + tab. `first` may already carry the
    # shelf's ?sort=, so drop its query before adding our own -- appending a
    # second ? would fuse them into one malformed sort value.
    if first:
        path = f"{BASE}{first}".split("?", 1)[0]
        page.goto(f"{path}?tab=info", wait_until="networkidle", timeout=60_000)
        page.wait_for_selector("h1", timeout=60_000)
        page.wait_for_timeout(800)
        result["detail_deep_link_ok"] = "chara_card" in page.inner_text("body")

    # --- Tags: the consolidation editor (Stage 4) ---
    # Non-mutating: it surveys the whole archive and reads the stored dictionary
    # delta, but every interaction here (menus, dialogs) is cancelled, so the
    # archive and the settings blob are left exactly as found. The one write path
    # the page owns -- the §3.7 read-modify-write of settings -- is proven
    # deterministically in vitest (use-settings.test.ts) rather than against the
    # live token store.
    page.goto(APP, wait_until="networkidle", timeout=60_000)
    page.wait_for_selector("a[href*='/characters/']", timeout=60_000)
    page.click("a:text-is('Tags')")
    # The survey is the whole archive in one request; give it room.
    page.wait_for_selector("text=renames staged", timeout=60_000)
    page.wait_for_timeout(800)
    result["tags_categories"] = page.eval_on_selector_all("section h3", "els => els.length")
    result["tags_has_stats"] = "cards affected" in page.inner_text("body")
    result["tags_has_buckets"] = (
        "Unassigned" in page.inner_text("body") and "Removed" in page.inner_text("body"))

    # Find narrows the categories shown.
    page.fill("input[placeholder=\"Find a tag or variant…\"]", "romance")
    page.wait_for_timeout(700)
    result["tags_find_categories"] = page.eval_on_selector_all("section h3", "els => els.length")
    page.fill("input[placeholder=\"Find a tag or variant…\"]", "")
    page.wait_for_timeout(500)

    # A variant chip opens its move menu (no move made).
    chip = page.query_selector("section .flex-wrap button:has(span.font-mono)")
    if chip:
        chip.click()
        page.wait_for_timeout(400)
        result["tags_chip_menu"] = page.query_selector(
            "[data-radix-popper-content-wrapper]") is not None
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)

    # The Apply dialog opens and cancels without touching a card.
    apply_btn = page.query_selector("button:has-text('Apply tags')")
    if apply_btn and not apply_btn.is_disabled():
        apply_btn.click()
        page.wait_for_selector("text=Apply tag consolidation?", timeout=10_000)
        result["tags_apply_dialog"] = True
        page.click("button:text-is('Cancel')")
        page.wait_for_timeout(400)


if __name__ == "__main__":
    sys.exit(main())
