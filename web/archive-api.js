/**
 * archive-api.js -- the seam between the vendored Character Library frontend and
 * the archive server.
 *
 * The frontend was written as a SillyTavern extension: it addresses characters
 * at `POST /api/characters/all`, avatars at `/thumbnail?type=avatar&file=`,
 * galleries at `/user/images/<folder>/<file>`, and so on. The archive speaks its
 * own contract at `/api/v1` instead, and deliberately so -- teaching FastAPI to
 * answer `/characters/edit-attribute` would relocate the compatibility burden
 * rather than end it, which is the one thing this whole migration exists to
 * avoid.
 *
 * So the translation happens *here*, on the client, in a file we own. That
 * matters: the server contract stays clean and the ST-shaped knowledge is
 * confined to one deletable module. As the frontend gets reworked, routes come
 * out of the table below one at a time and nothing else has to move.
 *
 * WHY A FETCH INTERCEPTOR, AND NOT EDITS TO library.js
 * library.js is 29,700 lines with ~30 raw `fetch()` sites and an `apiRequest()`
 * helper on top. Rewriting them means owning a diff against a file we want to
 * keep re-vendoring from upstream. Wrapping `fetch` costs one file and leaves
 * the vendored tree byte-identical apart from the handful of changes listed in
 * VENDORED.md. The cost is that a request's true destination is not visible at
 * its call site -- which is why every route below names what it maps to, and
 * why unmapped ST endpoints fail loudly (see NOT_IMPLEMENTED) instead of
 * quietly reaching a server that isn't there.
 *
 * WRITES
 * Card edits, deletes, avatar replacement and gallery writes map onto the
 * archive's own write endpoints (see the WRITES section below). What is still
 * refused -- acquiring a card from a provider, importing from a URL, standalone
 * world-info files -- answers 501 with a message the UI can show, because a
 * write that silently no-ops is how an archive loses data.
 *
 * Two ST behaviours deliberately do NOT survive the translation:
 *
 *   - **A rename does not move the card file.** SillyTavern never renamed an
 *     avatar on a field write either, and the filename is what the frontend, the
 *     DOM and the thumbnail cache all key on. See the PUT endpoint's docstring.
 *   - **A rename does not move the gallery folder.** The archive resolves a
 *     gallery by its `gallery_id`, not by the folder's name, so the frontend's
 *     file-by-file folder rename has nothing left to do and is short-circuited
 *     in library.js.
 */
(function () {
    'use strict';

    const API = '/api/v1';
    const nativeFetch = window.fetch.bind(window);

    // Loaded once and shared: the frontend asks for the whole archive up front
    // (it filters and sorts client-side), and several call sites re-ask during a
    // session. `?include=extensions` is what keeps provider links, gallery ids
    // and version uids alive in the grid -- without it every card would look
    // like it came from nowhere.
    const CHARACTERS_URL = `${API}/characters?limit=0&health=all&include=extensions`;

    // ========================================
    // RESPONSES
    // ========================================

    function json(body, status = 200) {
        return new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    /**
     * The answer for an ST endpoint the archive has no equivalent for.
     *
     * 501 rather than 404 on purpose: 404 reads as "wrong URL" and sends whoever
     * is debugging looking for a typo, while 501 says the route was recognised
     * and the capability is absent. The frontend surfaces the message in its
     * error toasts, so a user clicking Delete in a read-only build is told why
     * instead of watching nothing happen.
     */
    function notImplemented(what) {
        // The status goes in the message on purpose: this is the one console
        // line the app emits that is *expected*, and the smoke test filters it
        // by that "501" so a genuine warning stays visible next to it.
        console.warn(`[archive-api] 501 ${what}: not supported by the character archive.`);
        return json({ error: `${what} is not supported by the character archive yet.` }, 501);
    }

    /**
     * Pass an archive-side failure back in the shape the frontend reads.
     *
     * The vendored code checks `response.ok` and puts the body text in a toast,
     * so a 422 explaining that a card lost its name has to arrive as a 422 with
     * that sentence in it -- not as a generic failure, and not as a 200 the
     * caller then treats as a successful save.
     */
    async function relayError(resp, what) {
        let detail = '';
        try {
            const body = await resp.clone().json();
            detail = body?.detail || body?.error || '';
        } catch {
            detail = await resp.clone().text().catch(() => '');
        }
        console.error(`[archive-api] ${what} failed (HTTP ${resp.status}):`, detail);
        return json({ error: detail || `${what} failed (HTTP ${resp.status})` }, resp.status);
    }

    /** base64 -> Blob, without inflating the string through a data: URL. */
    function base64ToBlob(b64, type) {
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new Blob([bytes], { type });
    }

    // ========================================
    // CHARACTER SHAPE
    // ========================================

    /**
     * One `/api/v1` card as the frontend's character object.
     *
     * The frontend keys everything off `avatar`, which for SillyTavern is the
     * card's filename -- and the archive made the filename its id for the same
     * reason, so the two agree with no mapping table.
     *
     * `shallow` is left unset on purpose. Setting it makes the frontend believe
     * extensions were stripped and kick off a recovery pass that fetches all
     * 3,839 cards one at a time; we ship the extensions in the list instead, so
     * there is nothing to recover.
     */
    function toCharacter(card) {
        const extensions = card.extensions || {};
        return {
            avatar: card.id,
            name: card.name,
            creator: card.creator,
            character_version: card.character_version,
            tags: card.tags,
            // SillyTavern keeps the favourite flag in extensions, not on the
            // card root, and so does every card in this archive.
            fav: Boolean(extensions.fav),
            // When the card was acquired, off `extensions.jai.linkedAt`, which
            // every card in the archive carries. The file's mtime is the
            // obvious-looking choice and the wrong one: the bulk repair passes
            // rewrote 84% of the archive within a single day, so sorting on it
            // collapses "recently added" into alphabetical order. mtime is the
            // fallback for a card from outside this tool.
            //
            // There is no `create_date` to use instead -- not one card in the
            // corpus has the field -- so anything finer would be invented.
            date_added: Date.parse(card.linked_at || card.modified) || 0,
            // Prose the list payload does not carry. Empty, not absent: the
            // frontend's search folds `creator_notes` into its lowercase index
            // and `undefined` would throw. See "known gaps" in VENDORED.md --
            // notes search is the one browse feature this costs.
            creator_notes: '',
            // Computed server-side from the same five prompt fields the frontend
            // would sum if it held them (see prepareCharacterKeys in library.js,
            // and the VENDORED.md note about the one line that reads this).
            token_estimate: Math.round((card.prompt_chars || 0) / 4),
            data: {
                name: card.name,
                creator: card.creator,
                tags: card.tags,
                creator_notes: '',
                character_version: card.character_version,
                extensions,
            },
            // The archive's own view of the card, under one key so it cannot
            // collide with a field the frontend expects to own.
            _archive: {
                source_kind: card.source_kind,
                source_url: card.source_url,
                page_name: card.page_name,
                card_id: card.card_id,
                greetings: card.greetings,
                lore_entries: card.lore_entries,
                description_chars: card.description_chars,
                size: card.size,
                error: card.error || null,
            },
        };
    }

    /**
     * A full card from `/api/v1/characters/{id}` as the frontend's character
     * object: the same envelope as `toCharacter`, with the embedded card's own
     * `data` underneath and the V2 root aliases the frontend still reads.
     */
    function toFullCharacter(detail) {
        const base = toCharacter(detail);
        const data = detail.card || {};
        return {
            ...base,
            ...{
                // V2 root-level aliases. The frontend reads `char.description`
                // as readily as `char.data.description`, because SillyTavern
                // serves both, and getCharField() tries the root first.
                description: data.description || '',
                personality: data.personality || '',
                scenario: data.scenario || '',
                first_mes: data.first_mes || '',
                mes_example: data.mes_example || '',
                creator_notes: data.creator_notes || '',
                system_prompt: data.system_prompt || '',
                post_history_instructions: data.post_history_instructions || '',
                alternate_greetings: data.alternate_greetings || [],
                character_book: data.character_book || undefined,
                talkativeness: data.extensions?.talkativeness,
                spec: detail.spec,
                spec_version: detail.spec_version,
            },
            data,
            // Root `tags` wins over `data.tags` in the frontend's getTags(), so
            // keep them the same object rather than letting the two drift.
            tags: data.tags || detail.tags || [],
        };
    }

    // ========================================
    // THE UI'S OWN SETTINGS  (ST's /api/settings/{get,save})
    // ========================================
    //
    // Provider credentials, followed creators, display preferences. These live
    // server-side in `data/settings.json`, reached through `/api/v1/settings`.
    //
    // They used to live in `localStorage`, which was a genuine hazard rather
    // than merely untidy: localStorage is keyed by *origin*, SillyTavern's own
    // stock port is 8000, and the archive serves 8000 -- so the standalone app
    // was reading a bucket SillyTavern had filled while running there earlier.
    // It appeared to remember a Chub token and 19 followed creators that no
    // code here had ever stored, and all of it would have vanished the moment
    // the port or host changed. Which is what containerizing does.
    //
    // The frontend saves on every settings change, including per-keystroke in
    // the custom-CSS box, so writes are coalesced here rather than hitting the
    // disk each time. The handler answers immediately; a failed flush is
    // reported to the console because the UI has already moved on by then.

    const SETTINGS_URL = `${API}/settings`;
    // The key the vendored frontend stores itself under inside SillyTavern's
    // `extension_settings`. Must match SETTINGS_KEY in library.js.
    const CL_SETTINGS_KEY = 'SillyTavernCharacterGallery';
    const SAVE_DEBOUNCE_MS = 400;

    let pendingSettings = null;
    let settingsTimer = null;

    function flushSettings(unloading) {
        if (pendingSettings === null) return;
        const body = JSON.stringify(pendingSettings);
        pendingSettings = null;
        if (settingsTimer) {
            clearTimeout(settingsTimer);
            settingsTimer = null;
        }
        nativeFetch(SETTINGS_URL, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body,
            // Lets the last write survive the page going away. The blob is ~6 KB,
            // well inside the 64 KB keepalive ceiling.
            keepalive: unloading === true,
        })
            .then((resp) => {
                if (!resp.ok) {
                    console.error('[archive-api] settings were NOT saved: HTTP', resp.status);
                }
            })
            .catch((e) => {
                console.error('[archive-api] settings were NOT saved:', e?.message || e);
            });
    }

    // A tab closed or hidden mid-debounce must not drop the pending write.
    // pagehide covers close and navigation; visibilitychange covers the mobile
    // case where a backgrounded tab is frozen and pagehide never arrives.
    window.addEventListener('pagehide', () => flushSettings(true));
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushSettings(true);
    });

    // ========================================
    // CLIENT-SIDE BLOB STORE  (ST's /user/files)
    // ========================================
    //
    // The frontend also persists bulkier working state -- filter presets,
    // playlists -- as JSON files under SillyTavern's `user/files/`. None of
    // it is archive data: it is this browser's view of the archive, and it
    // has no business in the cards directory. (The media dedup/dead-URL
    // ledger that used to live here moved server-side in Phase 3C step 5.)
    //
    // This is still localStorage, unlike the settings above. The quota is
    // ~5 MB; a write that would overflow throws, is caught, and reports
    // failure rather than truncating. What used to be the one blob that could
    // approach that quota -- the media dedup/dead-URL ledger -- is gone from
    // here now, so this store is far from the limit in practice.

    const BLOB_PREFIX = 'cl_userfile:';

    function readBlob(name) {
        try {
            return localStorage.getItem(BLOB_PREFIX + name);
        } catch {
            return null;
        }
    }

    function writeBlob(name, text) {
        try {
            localStorage.setItem(BLOB_PREFIX + name, text);
            return true;
        } catch (e) {
            console.error(`[archive-api] could not persist ${name}:`, e?.message || e);
            return false;
        }
    }

    /** base64 -> text, tolerating the UTF-8 the frontend encodes into it. */
    function decodeBase64(b64) {
        const binary = atob(b64);
        const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
        return new TextDecoder().decode(bytes);
    }

    // ========================================
    // ROUTES
    // ========================================
    //
    // Matched in order against the request's pathname. Each handler gets
    // ({ url, method, body, request }) and returns a Response -- or a promise
    // for one. `body` is the parsed JSON payload, since every ST endpoint the
    // frontend calls POSTs JSON.

    const routes = [
        // ---- characters -----------------------------------------------------
        {
            path: '/api/characters/all',
            async handler() {
                const resp = await nativeFetch(CHARACTERS_URL);
                if (!resp.ok) return resp;
                const page = await resp.json();
                return json(page.items.map(toCharacter));
            },
        },
        {
            path: '/api/characters/get',
            async handler({ body }) {
                const id = body?.avatar_url;
                if (!id) return json({ error: 'avatar_url is required' }, 400);
                const resp = await nativeFetch(`${API}/characters/${encodeURIComponent(id)}`);
                if (!resp.ok) return resp;
                return json(toFullCharacter(await resp.json()));
            },
        },
        {
            // The card PNG itself. SillyTavern serves these as static files off
            // `/characters/<file>`; the frontend uses it for exports and for
            // reading a card's bytes back, so it must stay byte-identical.
            match: (path) => path.startsWith('/characters/') && path.endsWith('.png'),
            handler({ url }) {
                const id = decodeURIComponent(url.pathname.slice('/characters/'.length));
                return nativeFetch(`${API}/characters/${encodeURIComponent(id)}/png`);
            },
        },
        {
            // Kept for completeness, though the frontend no longer builds this
            // URL: its three avatar-URL helpers were repointed at the archive
            // directly, because their results become <img src> attributes and
            // an <img> never goes through fetch(). See web/VENDORED.md.
            path: '/thumbnail',
            handler({ url }) {
                const file = url.searchParams.get('file');
                if (!file) return json({ error: 'file is required' }, 400);
                return nativeFetch(`${API}/characters/${encodeURIComponent(file)}/thumb`);
            },
        },

        // ---- galleries ------------------------------------------------------
        {
            path: '/api/images/folders',
            async handler() {
                const resp = await nativeFetch(`${API}/galleries`);
                if (!resp.ok) return resp;
                const folders = await resp.json();
                return json(folders.map((f) => f.folder));
            },
        },
        {
            path: '/api/images/list',
            async handler({ body }) {
                const folder = body?.folder;
                if (!folder) return json([]);
                const resp = await nativeFetch(`${API}/galleries/${encodeURIComponent(folder)}`);
                // A folder that isn't there is an empty gallery to the caller.
                // SillyTavern returned 200 [] here because it *created* the
                // directory on the way past; the archive 404s instead of
                // littering, so the emptiness is synthesised at this seam.
                if (resp.status === 404) return json([]);
                if (!resp.ok) return resp;
                const listing = await resp.json();
                return json(listing.items.map((f) => f.name));
            },
        },
        {
            match: (path) => path.startsWith('/user/images/'),
            handler({ url }) {
                const rest = url.pathname.slice('/user/images/'.length);
                const slash = rest.indexOf('/');
                if (slash < 0) return json({ error: 'expected <folder>/<file>' }, 400);
                const folder = decodeURIComponent(rest.slice(0, slash));
                const file = decodeURIComponent(rest.slice(slash + 1));
                return nativeFetch(
                    `${API}/galleries/${encodeURIComponent(folder)}/files/${encodeURIComponent(file)}`
                );
            },
        },
        {
            // The one cl-helper route worth keeping. Everything else that plugin
            // did is gone, but gallery thumbnails are not optional -- a folder of
            // 400 full-size images is hundreds of megabytes -- and the archive
            // inherited its 3,446-folder cache, so this maps to a real endpoint
            // rather than a 501.
            match: (path) => path.startsWith('/api/plugins/cl-helper/gallery-thumb/'),
            handler({ url }) {
                const rest = url.pathname.slice('/api/plugins/cl-helper/gallery-thumb/'.length);
                const slash = rest.indexOf('/');
                if (slash < 0) return json({ error: 'expected <folder>/<file>' }, 400);
                const folder = decodeURIComponent(rest.slice(0, slash));
                const file = decodeURIComponent(rest.slice(slash + 1));
                const size = url.searchParams.get('s');
                const target = new URL(
                    `${API}/galleries/${encodeURIComponent(folder)}/files/${encodeURIComponent(file)}/thumb`,
                    window.location.origin
                );
                if (size) target.searchParams.set('size', size);
                return nativeFetch(target.href);
            },
        },

        // ---- the frontend's own state ---------------------------------------
        {
            match: (path) => path.startsWith('/user/files/'),
            handler({ url }) {
                const name = decodeURIComponent(url.pathname.slice('/user/files/'.length));
                const stored = readBlob(name);
                if (stored === null) return new Response(null, { status: 404 });
                return new Response(stored, {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            },
        },
        {
            path: '/api/files/upload',
            handler({ body }) {
                if (!body?.name) return json({ error: 'name is required' }, 400);
                let text;
                try {
                    text = decodeBase64(body.data || '');
                } catch (e) {
                    return json({ error: `data is not valid base64: ${e.message}` }, 400);
                }
                if (!writeBlob(body.name, text)) {
                    return json({ error: `browser storage rejected ${body.name} (quota)` }, 507);
                }
                return json({ path: `user/files/${body.name}` });
            },
        },
        {
            path: '/api/files/delete',
            handler({ body }) {
                const name = String(body?.path || '').replace(/^user\/files\//, '');
                try {
                    localStorage.removeItem(BLOB_PREFIX + name);
                } catch { /* already unreachable; nothing to undo */ }
                return json({ ok: true });
            },
        },
        {
            // Settings in, wearing the shape loadGallerySettings() looks for:
            // it reads `settings.extension_settings[SETTINGS_KEY]`, which is
            // where the blob sat when the frontend ran inside SillyTavern.
            //
            // NOTE the deliberate absence of `world_info_settings`. That is
            // where getAllCharLore() looks for the per-character additional-
            // lorebook map, and the bundle exporter keys destructive-vs-safe
            // manifest semantics off whether that read succeeds: unreadable
            // means "omit auxWorlds", while readable-and-empty writes
            // `auxWorlds: []` -- which tells an importing SillyTavern to restore
            // NO lorebooks and strips the links off the cards it lands on.
            //
            // Serving real settings at all therefore re-arms that trap, because
            // any object here makes the charLore read *succeed*. getAllCharLore()
            // is patched to return null unconditionally for exactly this reason
            // (see web/VENDORED.md); leaving world_info_settings out is the
            // second layer, so a future re-vendor that loses the patch still has
            // to actively add the key back to do damage.
            path: '/api/settings/get',
            async handler() {
                const resp = await nativeFetch(SETTINGS_URL);
                if (!resp.ok) return resp;
                const blob = await resp.json();
                return json({ settings: { extension_settings: { [CL_SETTINGS_KEY]: blob } } });
            },
        },
        {
            // Settings out. The frontend has no HTTP save path of its own --
            // saveGallerySettings() wrote SillyTavern's in-memory context and
            // localStorage and nothing else -- so the call reaching this route
            // comes from a patched line in library.js (see web/VENDORED.md).
            //
            // Answers OK before the write lands. The frontend's save is
            // fire-and-forget and it never surfaces a result, so blocking on the
            // disk would buy nothing; the flush logs loudly on failure instead.
            path: '/api/settings/save',
            handler({ body }) {
                const blob = body?.settings;
                if (!blob || typeof blob !== 'object' || Array.isArray(blob)) {
                    return json({ error: 'settings must be an object' }, 400);
                }
                pendingSettings = blob;
                if (settingsTimer) clearTimeout(settingsTimer);
                settingsTimer = setTimeout(() => flushSettings(false), SAVE_DEBOUNCE_MS);
                return json({ ok: true });
            },
        },

        // ---- gone with SillyTavern -------------------------------------------
        {
            path: '/api/extensions/version',
            handler() {
                return new Response(null, { status: 404 });
            },
        },

        // ---- WRITES ----------------------------------------------------------
        {
            // The frontend's one card-write path. It sends the *whole* `data`
            // object every time (writeCardFields hydrates first precisely so it
            // can), which is why the archive endpoint is a replace rather than a
            // patch -- there is nothing partial to express.
            //
            // No renaming happens here. ST never renamed an avatar file on a
            // field write either, and `char.avatar` is the key the grid, the DOM
            // and every URL in the app hold; moving it mid-save would 404 the
            // card the user is looking at.
            path: '/api/characters/merge-attributes',
            async handler({ body }) {
                const id = body?.avatar;
                const card = body?.data;
                if (!id) return json({ error: 'avatar is required' }, 400);
                if (!card || typeof card !== 'object') {
                    return json({ error: 'data must be the card object' }, 400);
                }
                const resp = await nativeFetch(`${API}/characters/${encodeURIComponent(id)}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ card }),
                });
                if (!resp.ok) return relayError(resp, 'Saving the card');
                return json({ ok: true });
            },
        },
        {
            // Multipart in, multipart on: `avatar` is the new image and
            // `avatar_url` names the card. The archive re-runs intake's pixel
            // pipeline and puts the existing card back on top, so nothing but
            // the image changes.
            path: '/api/characters/edit-avatar',
            async handler({ form }) {
                const id = form?.get('avatar_url');
                const file = form?.get('avatar');
                if (!id || !file) return json({ error: 'avatar and avatar_url are required' }, 400);
                const payload = new FormData();
                payload.append('image', file);
                const resp = await nativeFetch(
                    `${API}/characters/${encodeURIComponent(id)}/avatar`,
                    { method: 'PUT', body: payload }
                );
                if (!resp.ok) return relayError(resp, 'Replacing the image');
                return json({ ok: true });
            },
        },
        {
            // `delete_chats` is ignored: the archive stores none. The gallery is
            // kept, matching what the caller expects -- the delete modal deletes
            // the images itself first, one call per file, when the user asks it
            // to.
            path: '/api/characters/delete',
            async handler({ body }) {
                const id = body?.avatar_url;
                if (!id) return json({ error: 'avatar_url is required' }, 400);
                const resp = await nativeFetch(
                    `${API}/characters/${encodeURIComponent(id)}?gallery=keep`,
                    { method: 'DELETE' }
                );
                if (!resp.ok) return relayError(resp, 'Deleting the card');
                return json({ ok: true });
            },
        },
        {
            // base64 in, multipart out. The frontend encodes every upload as
            // base64 JSON because that is what SillyTavern took; the archive
            // takes the bytes, so the inflation is undone here rather than
            // carried through the API contract.
            path: '/api/images/upload',
            async handler({ body }) {
                const folder = body?.ch_name;
                if (!folder) return json({ error: 'ch_name is required' }, 400);
                const format = String(body?.format || 'png').replace(/^\./, '');
                const name = `${body?.filename || 'image'}.${format}`;
                let blob;
                try {
                    // A data: URL prefix rides along on some of the extractor
                    // paths; strip it rather than letting atob throw on the comma.
                    const raw = String(body?.image || '').replace(/^data:[^,]*,/, '');
                    blob = base64ToBlob(raw, `image/${format}`);
                } catch (e) {
                    return json({ error: `image is not valid base64: ${e.message}` }, 400);
                }
                const payload = new FormData();
                payload.append('file', blob, name);
                const resp = await nativeFetch(
                    `${API}/galleries/${encodeURIComponent(folder)}/files`,
                    { method: 'POST', body: payload }
                );
                if (!resp.ok) return relayError(resp, 'Uploading the file');
                // Callers read `path` back and store it as the local media path.
                const written = await resp.json();
                return json({ path: written.path });
            },
        },
        {
            path: '/api/images/delete',
            async handler({ body }) {
                const parts = String(body?.path || '').replace(/^\/?user\/images\//, '');
                const slash = parts.indexOf('/');
                if (slash < 0) return json({ error: 'expected user/images/<folder>/<file>' }, 400);
                const folder = encodeURIComponent(parts.slice(0, slash));
                const file = encodeURIComponent(parts.slice(slash + 1));
                const resp = await nativeFetch(`${API}/galleries/${folder}/files/${file}`, {
                    method: 'DELETE',
                });
                // Already gone is the outcome the caller wanted. The dedup and
                // gallery-rename passes both retry over lists that can go stale
                // mid-run, and failing those is noise, not information.
                if (!resp.ok && resp.status !== 404) return relayError(resp, 'Deleting the file');
                return json({ ok: true });
            },
        },

        // ---- writes the archive does not do ----------------------------------
        //
        // Acquiring a card is deliberately still refused: an import has to run
        // the intake pipeline (macro sanitize, avatar crop and resize, pngquant,
        // provenance stamping) rather than storing whatever the browser embedded,
        // and that is the next slice of work rather than this one.
        { path: '/api/characters/create', handler: () => notImplemented('Creating a card') },
        { path: '/api/characters/import', handler: () => notImplemented('Importing a card') },
        { path: '/api/content/importURL', handler: () => notImplemented('Importing from a URL') },
        {
            // Standalone World Info *files* are a SillyTavern concept and the
            // archive has no store for them -- its lorebooks live inside cards,
            // as `character_book`, and are edited through the card write above.
            // Kept as a route so it stays a clear refusal rather than a 404 that
            // reads like a typo.
            match: (path) => path.startsWith('/api/worldinfo/'),
            handler: () => notImplemented('Standalone lorebook files'),
        },
        {
            // Listing a character's chats. The archive stores none, so the
            // honest answer is an empty list, not a 501: every card really does
            // have zero chats here. The distinction is not cosmetic -- the
            // bundle exporter treats an unreadable chat list as a per-character
            // *failure* and reports "N file(s) failed" at the end of a run that
            // was in fact completely clean. The other two callers (the delete
            // modal's chat-count line, the duplicate view's chat badge) both
            // read 0 and render correctly.
            path: '/api/characters/chats',
            handler: () => json([]),
        },
        {
            // Everything else chat-shaped: reading one back, saving, renaming.
            // Out of scope for the archive by decision, not by omission -- it
            // never stores, reads or emits a chat file. Unreachable in practice
            // now that the list above is empty, and kept so it stays that way.
            match: (path) => path.startsWith('/api/chats/'),
            handler: () => notImplemented('Chats'),
        },
    ];

    function matchRoute(pathname) {
        for (const route of routes) {
            if (route.path ? route.path === pathname : route.match(pathname)) return route;
        }
        return null;
    }

    // ========================================
    // THE INTERCEPTOR
    // ========================================

    /**
     * Only same-origin requests are candidates. The frontend also fetches card
     * sources on the open internet (nine providers, ten gallery extractors), and
     * those must pass through untouched.
     */
    function requestUrl(input) {
        const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
        if (!raw) return null;
        try {
            return new URL(raw, window.location.href);
        } catch {
            return null;
        }
    }

    window.fetch = async function (input, init) {
        const url = requestUrl(input);
        if (!url || url.origin !== window.location.origin) {
            return nativeFetch(input, init);
        }
        const route = matchRoute(url.pathname);
        if (!route) return nativeFetch(input, init);

        const request = input instanceof Request ? input : null;
        const method = (init?.method || request?.method || 'GET').toUpperCase();

        let body = null;
        let form = null;
        const rawBody = init?.body;
        if (typeof rawBody === 'string' && rawBody) {
            try {
                body = JSON.parse(rawBody);
            } catch {
                body = null;
            }
        } else if (typeof FormData !== 'undefined' && rawBody instanceof FormData) {
            // Avatar replacement is the one multipart caller. Handed over as-is
            // rather than parsed: the parts are Files, and re-reading a File
            // into memory only to hand it straight back would double the peak
            // for a large image.
            form = rawBody;
        } else if (request && !init?.body) {
            try {
                body = await request.clone().json();
            } catch {
                body = null;
            }
        }

        try {
            return await route.handler({ url, method, body, form, request, init });
        } catch (e) {
            console.error(`[archive-api] ${url.pathname} failed:`, e);
            return json({ error: String(e?.message || e) }, 500);
        }
    };

    // Nothing here stubs the SillyTavern globals. library.js's own
    // getHostWindow() already resolves to null when the page has no opener and
    // no parent frame -- which is exactly a standalone tab -- and every one of
    // its 16 host call sites is optional-chained behind that. An override here
    // would be overwritten by library.js anyway, and would suggest a bridge
    // exists where there is none.

    console.info('[archive-api] serving the Character Library from the archive API at', API);
})();
