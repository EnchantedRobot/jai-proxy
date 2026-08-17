# saucepan/ — API layer only

The saucepan **browse view and provider** were dropped in the archive trim.
Saucepan export lives server-side in this repo (`proxy/saucepan_mapper.py`,
`POST /build-saucepan`) and never went through this UI.

`saucepan-api.js` stays because **datacat depends on it**: a datacat hit can be
sourced from saucepan rather than JanitorAI, and `datacat-browse.js` calls
`fetchSaucepanCompanion` / `fetchSaucepanCompanionsOfUser` to fill those in.
Deleting this file breaks datacat browse.
