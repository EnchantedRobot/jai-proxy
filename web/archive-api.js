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
 * WHAT IS DELIBERATELY NOT HERE
 * Phase 1 of the archive is read-only. Every mutating ST endpoint -- card edits,
 * deletes, imports, gallery uploads, world info -- answers 501 with a message
 * the UI can show. A write that silently no-ops is how an archive loses data.
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
        console.warn(`[archive-api] ${what} is not available: the archive API is read-only.`);
        return json({ error: `${what} is not supported by the character archive yet.` }, 501);
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
    // CLIENT-SIDE BLOB STORE  (ST's /user/files)
    // ========================================
    //
    // The frontend persists its own working state -- filter presets, custom CSS,
    // the media-dedup ledger, playlists -- as JSON files under SillyTavern's
    // `user/files/`. None of it is archive data: it is this browser's view of
    // the archive, and it has no business in the cards directory.
    //
    // localStorage is the honest place for it *for now*, and the limitation is
    // real rather than theoretical: the quota is ~5 MB, and the dedup ledger is
    // the one blob that can approach it on a large library. A write that would
    // overflow throws, is caught, and reports failure rather than truncating --
    // silent partial persistence would be worse than none. When this state needs
    // to survive a browser change it wants a real server-side store, and that is
    // a Phase 2 decision, not something to fake here.

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
            // SillyTavern's settings blob. The frontend reads it for one thing
            // it still needs -- the connection-profile proxy table behind the AI
            // features -- and treats a null result as "no profiles", which is
            // the truth here. An empty object rather than a 501 because this is
            // asked for at boot and a failure would log on every load.
            path: '/api/settings/get',
            handler() {
                return json({ settings: {} });
            },
        },

        // ---- gone with SillyTavern -------------------------------------------
        {
            // The helper plugin lived inside SillyTavern's process. Its status
            // probes are all optional-chained in the frontend, which renders a
            // "helper not installed" state -- accurate, so a 404 is the right
            // answer and not an error.
            match: (path) => path.startsWith('/api/plugins/cl-helper/'),
            handler() {
                return new Response(null, { status: 404 });
            },
        },
        {
            path: '/api/extensions/version',
            handler() {
                return new Response(null, { status: 404 });
            },
        },
        {
            match: (path) => path.startsWith('/extras/cl-helper/'),
            handler() {
                return new Response(null, { status: 404 });
            },
        },

        // ---- writes, deliberately refused ------------------------------------
        { path: '/api/characters/edit-attribute', handler: () => notImplemented('Editing a card') },
        { path: '/api/characters/edit-avatar', handler: () => notImplemented('Replacing an avatar') },
        { path: '/api/characters/merge-attributes', handler: () => notImplemented('Editing a card') },
        { path: '/api/characters/create', handler: () => notImplemented('Creating a card') },
        { path: '/api/characters/delete', handler: () => notImplemented('Deleting a card') },
        { path: '/api/characters/import', handler: () => notImplemented('Importing a card') },
        { path: '/api/content/importURL', handler: () => notImplemented('Importing from a URL') },
        { path: '/api/images/upload', handler: () => notImplemented('Uploading a gallery image') },
        { path: '/api/images/delete', handler: () => notImplemented('Deleting a gallery image') },
        {
            match: (path) => path.startsWith('/api/worldinfo/'),
            handler: () => notImplemented('Editing lorebooks'),
        },
        {
            // Chats are out of scope for the archive by decision, not by
            // omission: it never stores, reads or emits them.
            match: (path) => path.startsWith('/api/chats/') || path === '/api/characters/chats',
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
        const rawBody = init?.body;
        if (typeof rawBody === 'string' && rawBody) {
            try {
                body = JSON.parse(rawBody);
            } catch {
                body = null;
            }
        } else if (request && !init?.body) {
            try {
                body = await request.clone().json();
            } catch {
                body = null;
            }
        }

        try {
            return await route.handler({ url, method, body, request, init });
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
