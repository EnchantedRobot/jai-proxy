  // ---------------------------------------------------------------------------
  // HideCaptured — a browse-page toggle that folds away character cards not
  // worth showing, so scrolling a listing only surfaces cards worth downloading.
  // A card is folded away when EITHER:
  //   • it's already exported to disk, OR
  //   • the include/exclude tag filter (BULK_TAG_FILTER) would skip it — the
  //     same filter the bulk sweep uses to pick cards.
  //
  // This works on EVERY surface that renders the shared card tile — the
  // logged-in homepage (/), search, tag browse, creator profiles — because both
  // verdicts are read off the rendered tile itself rather than from any
  // page-specific list endpoint:
  //   • the character UUID comes from the tile's link href
  //     (/characters/<uuid>_<slug>), and
  //   • the tag set comes from the tile's own tag chips, which carry every
  //     official tag AND custom tag verbatim — verified chip-for-chip against
  //     the homepage's own /hampter/characters JSON (34/34 cards, nothing
  //     truncated, `#custom` and "👩‍🦰 Female" both normalizing cleanly).
  // So we can only judge cards that are actually rendered — but the rendered
  // DOM already carries everything needed to judge them, with no extra request
  // and no assumption about which query produced the listing. The "Limitless"
  // quality badge shares the chip container but carries neither the -regular nor
  // the -custom class, so it is deliberately not read as a tag.
  //
  // Disk membership goes through the SAME `POST /existing` id-fragment check the
  // bulk sweep uses (it matches the `_<id8>` filename fragment) — no new server
  // endpoint. A tag-filtered card is hidden up front and never touches it.
  // Only the /existing verdicts are memoized (they cost a round trip); the tag
  // verdict is re-derived every scan, so a wrapper React recycles for a
  // different card can never keep a stale marker.
  //
  // Hiding is class-only and fully reversible: a folded card's wrapper gets
  // `jai-captured` (on disk) or `jai-filtered` (tag-filtered), and while the
  // toggle is on `html.jai-hide-captured` drives the real `display:none` via CSS
  // — JAI's own inline styles are never touched. Re-scanning on the scheduler
  // tick folds in cards infinite-scroll adds.
  // ---------------------------------------------------------------------------
  const CARD_LINK_SEL = "a.profile-character-card-stack-link-component";
  const CARD_WRAP_SEL = ".profile-character-card-wrapper";
  const CARD_LIST_SEL = ".pp-cc-list-container"; // direct parent of the wrappers
  const CARD_TAGS_SEL = ".profile-character-card-tags"; // chip container on a tile
  const CARD_TAG_SEL =
    ".profile-character-card-tags-wrap-regular, .profile-character-card-tags-wrap-custom";
  const HIDE_ACTIVE_CLASS = "jai-hide-captured"; // on <html> while the toggle is on
  const CARD_SAVED_CLASS = "jai-captured";       // on a wrapper whose card is on disk
  const CARD_FILTERED_CLASS = "jai-filtered";    // on a wrapper the tag filter skips
  const CARD_ID_ATTR = "data-jai-id";            // resolved id, stamped for debugging

  // The character UUID from a card link's href
  // (https://janitorai.com/characters/<uuid>_<slug>). Mirrors the scheduler's
  // currentCharacterId(), but reads an arbitrary href instead of the URL bar.
  function cardIdFromHref(href) {
    const m = String(href || "").match(/\/characters?\/([0-9a-f-]{36})/i);
    return m ? m[1].toLowerCase() : null;
  }

  // A rendered tile's tags, shaped as a list row so passesTagFilter() (from
  // bulk.js) can judge it unchanged — one filter implementation for both the
  // bulk sweep and this toggle. rowTagSet() normalizes `tags[].name` and
  // `custom_tags` identically (normTag drops the leading emoji / "#"), so every
  // chip can go in one bucket regardless of which kind it is.
  //
  // Returns null when the tile has no chip container at all, meaning its tags
  // aren't rendered yet — the caller then leaves the card visible rather than
  // guessing. An EMPTY container is a real answer (a card genuinely without
  // tags) and yields an empty row, which an `include` filter correctly rejects.
  function tagRowFromWrapper(wrap) {
    const box = wrap.querySelector(CARD_TAGS_SEL);
    if (!box) return null;
    return {
      custom_tags: [...box.querySelectorAll(CARD_TAG_SEL)].map((el) => el.textContent),
    };
  }

  const HideCaptured = {
    _btn: null,
    _active: false,
    _checked: new Map(),   // id -> bool (true = already on disk); memoized /existing
    _busy: false,
    _observer: null,       // watches the card grid for page changes
    _observed: null,       // the list container currently observed
    _debounce: null,       // coalesces a burst of grid mutations into one _sync

    setButton(btn) {
      this._btn = btn;
      this._render();
    },

    // Show the toggle only where cards actually render; hide it elsewhere.
    _toggleButton(show) {
      if (this._btn) this._btn.style.display = show ? "block" : "none";
    },

    _render() {
      if (!this._btn) return;
      if (this._active) {
        const n = document.querySelectorAll(
          `${CARD_WRAP_SEL}.${CARD_SAVED_CLASS}, ${CARD_WRAP_SEL}.${CARD_FILTERED_CLASS}`
        ).length;
        this._btn.textContent = `👁 Show hidden (${n})`;
      } else {
        this._btn.textContent = "🙈 Hide saved";
      }
      this._btn.classList.toggle("jai-on", this._active);
    },

    // Map every rendered card to its wrapper, id and tag verdict. The id is
    // stamped on the wrapper purely so a card's identity is visible in devtools;
    // both it and the verdict are re-derived here every scan so nothing can go
    // stale. Returns [{ id, wrap, filtered }].
    _scan() {
      const out = [];
      for (const link of document.querySelectorAll(CARD_LINK_SEL)) {
        const wrap = link.closest(CARD_WRAP_SEL);
        if (!wrap) continue;
        const id = cardIdFromHref(link.getAttribute("href"));
        if (!id) continue;
        wrap.setAttribute(CARD_ID_ATTR, id);
        const row = tagRowFromWrapper(wrap);
        out.push({ id, wrap, filtered: row ? !passesTagFilter(row) : false });
      }
      return out;
    },

    // Fold away cards not worth showing: tag-filtered ones hide on their chips
    // alone (and skip the disk check), and the rest are classified via
    // /existing (memoized) and hidden when already saved. Safe to call every
    // tick; the /existing guard keeps overlapping ticks from double-firing, and
    // ids left unclassified are simply retried on the next scan.
    async _sync() {
      const cards = this._scan();

      // Disk-check only cards the tag filter KEEPS; a filtered-out card is
      // hidden by its chips alone and never costs a round trip.
      const unknown = [
        ...new Set(
          cards.filter((c) => !c.filtered && !this._checked.has(c.id)).map((c) => c.id)
        ),
      ];
      if (unknown.length && !this._busy) {
        this._busy = true;
        try {
          const saved = new Set(await ServerClient.existing(unknown));
          for (const id of unknown) this._checked.set(id, saved.has(id));
        } catch (err) {
          warn("hide-captured: existing check failed", err);
          return; // leave unknowns unclassified; retried on the next scan
        } finally {
          this._busy = false;
        }
      }

      for (const { id, wrap, filtered } of cards) {
        wrap.classList.toggle(CARD_FILTERED_CLASS, filtered);
        wrap.classList.toggle(CARD_SAVED_CLASS, !filtered && this._checked.get(id) === true);
      }
      this._render();
    },

    // While active, watch the card grid so a pagination click (prev/next or a
    // page button) reapplies the hide state immediately instead of waiting for
    // the next 5s tick. The wrappers are direct children of CARD_LIST_SEL, so
    // childList there fires exactly when JAI swaps in a new page's cards — after
    // React has rendered them, sidestepping any fetch-vs-render race. The
    // container is replaced across SPA nav, so re-attach when it changes and
    // disconnect when the toggle goes off. A short debounce coalesces the
    // remove-old/add-new mutation burst into a single re-sync.
    _watch() {
      const container = this._active ? document.querySelector(CARD_LIST_SEL) : null;
      if (this._observed === container) return; // no change (covers both null)
      if (this._observer) {
        this._observer.disconnect();
        this._observer = null;
      }
      this._observed = container;
      if (!container) return;
      this._observer = new MutationObserver(() => {
        clearTimeout(this._debounce);
        this._debounce = setTimeout(() => this._sync(), 150);
      });
      this._observer.observe(container, { childList: true });
    },

    // Scheduler hook: keep the button scoped to listing surfaces and, while
    // active, fold in cards that infinite-scroll has appended since last tick.
    // Also (re)binds the pagination watcher as the SPA swaps the grid in/out.
    async refresh() {
      this._toggleButton(!!document.querySelector(CARD_LINK_SEL));
      this._watch();
      if (this._active) await this._sync();
    },

    async onClick() {
      this._active = !this._active;
      document.documentElement.classList.toggle(HIDE_ACTIVE_CLASS, this._active);
      this._watch();
      this._render();
      if (this._active) await this._sync();
    },
  };
