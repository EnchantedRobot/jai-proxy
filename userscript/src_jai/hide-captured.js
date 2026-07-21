  // ---------------------------------------------------------------------------
  // HideCaptured — a browse-page toggle that folds away character cards not
  // worth showing, so scrolling a creator's catalogue only surfaces cards worth
  // downloading. A card is folded away when EITHER:
  //   • it's already exported to disk, OR
  //   • the include/exclude tag filter (BULK_TAG_FILTER) would skip it — the
  //     same filter the bulk sweep uses to pick cards. Tag pre-filtering runs
  //     on creator profile pages only (the list endpoint is creator-scoped).
  //
  // Every rendered card links to /characters/<uuid>_<slug> via
  // a.profile-character-card-stack-link-component, so the card UUIDs are read
  // straight from the DOM: we can only hide cards that are actually rendered,
  // and the rendered DOM already carries every id we need. Disk membership goes
  // through the SAME `POST /existing` id-fragment check the bulk sweep uses (it
  // matches the `_<id8>` filename fragment) — no new server endpoint. The tag
  // verdict comes from the cheap creator list rows (JanitorClient.listCharacters,
  // reused from the bulk sweep), which already carry every tag; a filtered-out
  // card is hidden up front and never touches /existing.
  //
  // Hiding is class-only and fully reversible: a folded card's wrapper gets
  // `jai-captured` (on disk) or `jai-filtered` (tag-filtered), and while the
  // toggle is on `html.jai-hide-captured` drives the real `display:none` via CSS
  // — JAI's own inline styles are never touched. Both verdicts are memoized per
  // id, and re-scanning on the scheduler tick folds in cards infinite-scroll adds.
  // ---------------------------------------------------------------------------
  const CARD_LINK_SEL = "a.profile-character-card-stack-link-component";
  const CARD_WRAP_SEL = ".profile-character-card-wrapper";
  const CARD_LIST_SEL = ".pp-cc-list-container"; // direct parent of the wrappers
  const HIDE_ACTIVE_CLASS = "jai-hide-captured"; // on <html> while the toggle is on
  const CARD_SAVED_CLASS = "jai-captured";       // on a wrapper whose card is on disk
  const CARD_FILTERED_CLASS = "jai-filtered";    // on a wrapper the tag filter skips
  const CARD_ID_ATTR = "data-jai-id";            // memoized resolved id on a wrapper

  // The character UUID from a card link's href
  // (https://janitorai.com/characters/<uuid>_<slug>). Mirrors the scheduler's
  // currentCharacterId(), but reads an arbitrary href instead of the URL bar.
  function cardIdFromHref(href) {
    const m = String(href || "").match(/\/characters?\/([0-9a-f-]{36})/i);
    return m ? m[1].toLowerCase() : null;
  }

  const HideCaptured = {
    _btn: null,
    _active: false,
    _checked: new Map(),   // id -> bool (true = already on disk); memoized /existing
    _busy: false,
    _filtered: new Map(),  // id -> bool (true = tag filter would skip it)
    _filterBusy: false,    // a creator-list enumeration is in flight
    _filterCreator: null,  // creator whose catalogue is cached in _filtered
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

    // Map every rendered card to its wrapper + id, stamping the id on the
    // wrapper once so repeat scans stay cheap. Returns [{ id, wrap }].
    _scan() {
      const out = [];
      for (const link of document.querySelectorAll(CARD_LINK_SEL)) {
        const wrap = link.closest(CARD_WRAP_SEL);
        if (!wrap) continue;
        let id = wrap.getAttribute(CARD_ID_ATTR);
        if (!id) {
          id = cardIdFromHref(link.getAttribute("href"));
          if (!id) continue;
          wrap.setAttribute(CARD_ID_ATTR, id);
        }
        out.push({ id, wrap });
      }
      return out;
    },

    // Creator pages only: enumerate the catalogue once (the same cheap list
    // rows the bulk sweep pages through) and record which ids the include/
    // exclude tag filter would skip. Runs in the background — the caller does
    // NOT await it, so a multi-page walk never stalls the scheduler tick; each
    // later tick re-applies markers as _filtered fills in. Cached per creator,
    // and a no-op when no filter is configured or we're off a creator page.
    async _ensureFilter() {
      const creator = currentCreatorId();
      if (!creator) return;                             // creator profile pages only
      if (!_INCLUDE.length && !_EXCLUDE.length) return; // no filter → nothing to skip
      if (this._filterBusy || this._filterCreator === creator) return;
      this._filterBusy = true;
      try {
        let seen = 0;
        for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
          const res = await JanitorClient.listCharacters(creator, page);
          const data = Array.isArray(res.data) ? res.data : [];
          for (const row of data) {
            if (!row || !row.id) continue;
            seen += 1;
            this._filtered.set(String(row.id).toLowerCase(), !passesTagFilter(row));
          }
          const total = Number(res.total) || 0;
          if (!data.length || seen >= total) break;
          await sleep(LIST_PAGE_DELAY_MS);
        }
        this._filterCreator = creator;
      } catch (err) {
        warn("hide-captured: tag pre-filter failed", err);
      } finally {
        this._filterBusy = false;
      }
    },

    // Fold away cards not worth showing: tag-filtered ones hide up front (and
    // skip the disk check), and the rest are classified via /existing (memoized)
    // and hidden when already saved. Safe to call every tick; the /existing
    // guard keeps overlapping ticks from double-firing, and unclassified ids are
    // simply retried on the next scan.
    async _sync() {
      const cards = this._scan();

      // Kick off (or reuse) the creator-catalogue tag pre-filter in the
      // background; markers below use whatever it has resolved so far.
      this._ensureFilter();

      // Disk-check only cards the filter KEEPS (or hasn't classified yet); a
      // filtered-out card is hidden by its tag verdict alone.
      const unknown = [
        ...new Set(
          cards
            .map((c) => c.id)
            .filter((id) => !this._filtered.get(id) && !this._checked.has(id))
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

      for (const { id, wrap } of cards) {
        if (this._filtered.get(id)) wrap.classList.add(CARD_FILTERED_CLASS);
        else if (this._checked.get(id)) wrap.classList.add(CARD_SAVED_CLASS);
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
