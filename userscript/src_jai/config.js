  // ---------------------------------------------------------------------------
  // User config — hand-edited, not persisted. Controls which cards the BULK
  // "download all open cards" run (creator /profiles/ page) exports. The single
  // ⬇ Export button is NEVER filtered; this only narrows a bulk sweep.
  //
  // Matching is case-insensitive and ignores a tag's leading emoji / "#" prefix,
  // so "female" matches JanitorAI's "👩‍🦰 Female". Both a card's official tags
  // and its free-form custom_tags are checked. Tag names are matched WHOLE (after
  // the emoji prefix): "futa" does NOT match "futanari" — list every variant you
  // want to catch.
  //
  // A card is exported when it has at least one `include` tag (or `include` is
  // empty = no include filter) AND none of the `exclude` tags. The filter runs on
  // the cheap list rows, so excluded cards are skipped before any per-card fetch.
  //
  //   include: []                      → download every open card
  //   include: ["female"]              → only cards tagged Female
  //   exclude: ["futa", "futanari"]    → drop either tag
  // ---------------------------------------------------------------------------
  const BULK_TAG_FILTER = {
    include: [],
    exclude: ["futa", "futanari"],
  };
