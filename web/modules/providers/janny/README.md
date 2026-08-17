# janny/ — API layer only

The JannyAI **browse view and provider** were dropped in the archive trim: the
archive holds 54 cards with a `jannyai` link, and JannyAI is not a source it
acquires from.

`janny-api.js` stays because **datacat depends on it**, not because JannyAI is a
provider here. `datacat-api.js` searches through JannyAI's Meili index and maps
its numeric tag ids with `TAG_MAP`. Deleting this file breaks datacat browse.
