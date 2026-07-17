// ==UserScript==
// @name         Saucepan → Character Card V3 (PNG) Exporter
// @namespace    https://github.com/mjnitz02/saucepan-export
// @version      0.6.0
// @description  Export an open saucepan.ai companion profile as a SillyTavern / AI Character Card V3 PNG (embeds chara + ccv3 tEXt chunks).
// @match        https://saucepan.ai/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      cdn.saucepan.ai
// @connect      saucepan.ai
// ==/UserScript==

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Logging. All output is prefixed so it's easy to filter the console to
  // "[saucepan-export]". log() for normal progress, warn() for recoverable
  // problems (missing optional sections), group()/groupEnd() to nest a phase.
  // ---------------------------------------------------------------------------
  const TAG = "[saucepan-export]";
  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const group = (label) => console.group(TAG + " " + label);
  const groupEnd = () => console.groupEnd();
  // Trim long strings for readable logs; reports length + a head preview.
  const preview = (s, n = 60) =>
    s == null ? "(none)" : `len=${s.length} ${JSON.stringify(String(s).slice(0, n))}`;

  // ---------------------------------------------------------------------------
  // {{user}} restoration.
  //
  // Saucepan substitutes the card's {{user}} macro with the logged-in account
  // handle SERVER-SIDE, so every scraped field carries the literal handle (e.g.
  // "EnchantedRobot") instead of the macro SillyTavern expects. We reverse that:
  // replace whole-word occurrences of the handle with "{{user}}".
  //
  // The handle is read from the page's "You are chatting as:" control (set by
  // detectUserHandle, called at the start of buildCard); USER_HANDLE is only a
  // fallback if that lookup fails. \b boundaries keep possessives
  // ("EnchantedRobot's" -> "{{user}}'s") while avoiding mid-word matches.
  // ---------------------------------------------------------------------------
  const USER_HANDLE = "EnchantedRobot";
  const makeUserRe = (handle) =>
    new RegExp("\\b" + handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "g");
  let userRe = makeUserRe(USER_HANDLE);
  const restoreUser = (s) =>
    typeof s === "string" ? s.replace(userRe, "{{user}}") : s;

  // Read the logged-in handle from the "You are chatting as:" label/button pair
  // in the chat sidebar, so we don't depend on a hard-coded name. Updates the
  // module-level userRe in place; returns the detected handle or null.
  function detectUserHandle() {
    const label = [...document.querySelectorAll("div")].find(
      (d) => d.textContent.trim() === "You are chatting as:"
    );
    const btn = label && label.parentElement
      ? label.parentElement.querySelector("button")
      : null;
    const handle = btn ? btn.textContent.trim() : "";
    if (handle) userRe = makeUserRe(handle);
    return handle || null;
  }

  // ---------------------------------------------------------------------------
  // DOM extraction
  //
  // Anchors on STABLE text/href hooks, never the obfuscated styled-components
  // class names (sc-xxx / hashed), which change on every build:
  //   - Companion Core / Advanced Prompt / Example Dialogue : <h4> label text
  //   - tags          : <a href=".../search/tag/...">
  //   - creator notes : #tab-profile rich-text
  //   - portrait      : largest cdn.saucepan.ai <img>
  // ---------------------------------------------------------------------------

  // Find the section content associated with a label like "Companion Core".
  //
  // The live SPA may render the label as any heading-ish element (h1–h6, or a
  // styled <div>/<span>), and the body text may sit either inside the same
  // parent or in the heading's next sibling. We try, in order:
  //   1. parent's text minus the heading                (snapshot layout)
  //   2. the heading's next element sibling             (split layout)
  //   3. walk up one ancestor and retry (1)
  const HEADINGS = "h1,h2,h3,h4,h5,h6,[class*='title'],[class*='header'],div,span,p";

  // All leaf elements whose text is exactly the label. There may be several
  // (e.g. the real section heading AND a token-count stat chip that reuses the
  // same label) — the caller disambiguates by picking the richest content.
  function findLabelNodes(label) {
    const want = label.toLowerCase();
    return [...document.querySelectorAll(HEADINGS)].filter(
      (el) => el.children.length === 0 && el.textContent.trim().toLowerCase() === want
    );
  }

  function textMinusLabel(container, labelNode) {
    const clone = container.cloneNode(true);
    // Remove the label heading itself (matched by text) from the clone.
    const want = labelNode.textContent.trim().toLowerCase();
    [...clone.querySelectorAll("*")].forEach((el) => {
      if (el.children.length === 0 && el.textContent.trim().toLowerCase() === want) {
        el.remove();
      }
    });
    return clone.textContent.trim();
  }

  // Content for a single label node, trying parent → sibling → grandparent.
  function contentFor(node) {
    if (node.parentElement) {
      const t = textMinusLabel(node.parentElement, node);
      if (t) return t;
    }
    let sib = node.nextElementSibling;
    while (sib) {
      const t = sib.textContent.trim();
      if (t) return t;
      sib = sib.nextElementSibling;
    }
    if (node.parentElement && node.parentElement.parentElement) {
      const t = textMinusLabel(node.parentElement.parentElement, node);
      if (t) return t;
    }
    return "";
  }

  // The token-count stat panel reuses section labels but its body is just a
  // number like "706" or a range like "0 - 822". Never treat that as content.
  function isStatChip(t) {
    return /^\d[\d\s,.\-–—]*$/.test(t.trim());
  }

  function sectionByHeader(label) {
    // Pick the candidate yielding the most text — avoids stat-panel chips that
    // reuse the section label but only contain a token count.
    return findLabelNodes(label)
      .map(contentFor)
      .filter((t) => t && !isStatChip(t))
      .reduce((best, t) => (t.length > best.length ? t : best), "");
  }

  // Full companion title, e.g. "Mindy | The Neighbor Across The Hall".
  // The <h1> is the clean title; document.title appends " - Companion Profile".
  function getFullTitle() {
    const h1 = document.querySelector("h1");
    const fromH1 = h1 ? h1.textContent.trim() : "";
    if (fromH1) return fromH1;
    return (document.title || "").replace(/\s*-\s*Companion Profile\s*$/i, "").trim();
  }

  // Suggested short name: everything before the first "|" (or the whole title
  // if there's none). Only a DEFAULT — the user confirms/edits it at export.
  function getName() {
    const t = getFullTitle().split("|")[0].trim();
    return t || "Unknown";
  }

  function getTags() {
    return [
      ...new Set(
        [...document.querySelectorAll('a[href*="/search/tag/"]')]
          .map((a) => {
            // Prefer the visible label span, fall back to the href slug.
            const spans = a.querySelectorAll("span");
            const txt = spans.length
              ? spans[spans.length - 1].textContent.trim()
              : a.textContent.trim();
            return txt.replace(/^[^\w]+/, "").trim();
          })
          .filter(Boolean)
      ),
    ];
  }

  // Serialize a rich-text node to a clean HTML subset. saucepan's editor wraps
  // everything in rotating sc-*/rich-text-* styled-component classes with inline
  // colors; we keep only the semantic tags (so bold, headings, dividers, small
  // text, line breaks AND — crucially — link hrefs survive) and drop the noise.
  // creator_notes is rendered as HTML by SillyTavern, same as the appended
  // <h1>/<img> blocks, so emitting tags here is consistent with that field.
  function richToHtml(node) {
    if (node.nodeType === 3) return escapeHtml(node.textContent); // text
    if (node.nodeType !== 1) return ""; // comments, etc.
    const tag = node.tagName.toLowerCase();
    const inner = () =>
      [...node.childNodes].map(richToHtml).join("");
    switch (tag) {
      case "br":
        return "<br>\n";
      case "hr":
        return "\n<hr>\n";
      case "img": // gallery images are appended separately; skip inline dupes
        return "";
      case "b":
      case "strong":
        return `<strong>${inner()}</strong>`;
      case "i":
      case "em":
        return `<em>${inner()}</em>`;
      case "u":
        return `<u>${inner()}</u>`;
      case "s":
      case "del":
      case "strike":
        return `<s>${inner()}</s>`;
      case "small":
        return `<small>${inner()}</small>`;
      case "code":
        return `<code>${inner()}</code>`;
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        return `\n<${tag}>${inner()}</${tag}>\n`;
      case "blockquote":
      case "ul":
      case "ol":
        return `\n<${tag}>${inner()}</${tag}>\n`;
      case "li":
        return `<li>${inner()}</li>`;
      case "a": {
        const href = node.getAttribute("href") || "";
        const text = inner();
        return /^https?:\/\//i.test(href)
          ? `<a href="${escapeHtml(href)}">${text}</a>`
          : text;
      }
      case "p":
      case "div": {
        const content = inner();
        if (!content.trim()) return "";
        const centered = /text-align:\s*center/i.test(
          node.getAttribute("style") || ""
        );
        const isPara =
          tag === "p" ||
          (node.classList && node.classList.contains("rich-text-paragraph"));
        if (isPara) {
          return centered
            ? `\n<p style="text-align:center">${content}</p>\n`
            : `\n<p>${content}</p>\n`;
        }
        // Plain wrapper div: only emit a tag if it carries alignment.
        return centered
          ? `\n<div style="text-align:center">${content}</div>\n`
          : content;
      }
      default: // span, font, and any unknown wrapper: keep the contents only
        return inner();
    }
  }

  // Creator notes from the Profile tab. Walk the rich-text DOM (preserving its
  // formatting + link URLs); fall back to plain innerText if the container shape
  // is unrecognized.
  function getCreatorNotes() {
    const profile = document.querySelector("#tab-profile");
    if (!profile) return "";
    const rich = profile.querySelector(".rich-text-container");
    if (!rich) return profile.innerText.trim();
    const html = richToHtml(rich)
      .replace(/[ \t]+\n/g, "\n") // trailing spaces before newlines
      .replace(/\n{3,}/g, "\n\n") // collapse blank-line runs
      .trim();
    // If serialization somehow yielded nothing usable, fall back to text.
    return html || rich.innerText.trim();
  }

  // Author handle from the "by @handle" block under the title. If a card lists
  // multiple creators we keep only the first. Returns the handle without "@".
  function getCreator() {
    const bySpan = [...document.querySelectorAll("span")].find(
      (s) => s.textContent.trim().toLowerCase() === "by"
    );
    const scope = bySpan && bySpan.parentElement ? bySpan.parentElement : document;
    // Only LEAF elements: an ancestor's textContent can fuse the handle with an
    // adjacent button ("@desslok" + "Share" → "@desslokShare"), which still
    // matches the @handle regex and precedes the real leaf in document order.
    const handle = [...scope.querySelectorAll("*")]
      .filter((e) => e.children.length === 0)
      .map((e) => e.textContent.trim())
      .find((t) => /^@[\w.\-]+$/.test(t));
    return handle ? handle.replace(/^@/, "") : "saucepan.ai";
  }

  // All distinct character images hosted on the CDN, as canonical URLs.
  // Cloudflare image delivery serves the same image under several variants
  // (.../public, .../thumbnail, .../highres) — we dedupe by the image id and
  // emit the /public variant. `into` is a Map(id → url) accumulated across the
  // Profile and Details tabs, since each may mount different thumbnails.
  // Two CDN URL schemes seen in the wild:
  //   old: https://cdn.saucepan.ai/images/<id>/<variant>
  //   new: https://saucepan.ai/cdn/<id>/<variant>
  // Group 1 = host+path prefix (used to rebuild the canonical URL on the same
  // scheme), group 2 = image id (used to dedupe across tabs/variants).
  const CDN_IMG_RE = /(cdn\.saucepan\.ai\/images|saucepan\.ai\/cdn)\/([\w-]+)\//;
  const CDN_HOST_RE = /(?:cdn\.saucepan\.ai\/images|saucepan\.ai\/cdn)\//;

  function collectImages(into) {
    // Scope to the character image carousel only. Scanning the whole page also
    // sweeps in comment avatars, related-character cards, and lorebook card
    // images, which we don't want.
    const scopes = document.querySelectorAll(".gallery-container");
    const imgs = scopes.length
      ? [...scopes].flatMap((s) => [...s.querySelectorAll("img")])
      : [];
    for (const img of imgs) {
      const candidates = [img.currentSrc, img.src, ...(img.srcset || "").split(/[\s,]+/)];
      for (const src of candidates) {
        const m = (src || "").match(CDN_IMG_RE);
        if (m && !into.has(m[2])) {
          // Old cdn.saucepan.ai host serves a "public" variant; the new
          // saucepan.ai/cdn host uses "highres".
          const variant = m[1].startsWith("cdn.") ? "public" : "highres";
          into.set(m[2], `https://${m[1]}/${m[2]}/${variant}`);
        }
      }
    }
    return into;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // Render embedded <img> tags to append to (HTML-capable) creator notes, so
  // the gallery images actually display (and scrapers can pull the src URLs).
  function imagesHtml(urls) {
    if (!urls.length) return "";
    const items = urls
      .map((u, i) => `  <img src="${u}" alt="Image ${i + 1}">`)
      .join("\n");
    return `\n\n<p>Images:</p>\n${items}`;
  }

  // Largest portrait image hosted on the CDN.
  function getPortraitUrl() {
    const imgs = [...document.querySelectorAll('img')].filter((i) =>
      CDN_HOST_RE.test(i.currentSrc || i.src || "")
    );
    if (!imgs.length) return null;
    imgs.sort(
      (a, b) =>
        b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight
    );
    return imgs[0].currentSrc || imgs[0].src;
  }

  // A linked lorebook, if this companion has one. The companion profile renders
  // the related lorebook as a real <a href=".../lorebook/<uuid>"> (wrapping both
  // the lorebook card image and its title — same URL twice). Stable anchor, no
  // sc-* classes. Returns {url, id} or null.
  // Match on the relative path "/lorebook/" — the live SPA uses client-side
  // routing with relative hrefs (a saved page rewrites them to absolute, which
  // is why "saucepan.ai/lorebook/" only matched offline). Read the .href
  // PROPERTY (always resolved to absolute) and require a uuid so we skip any
  // generic "Lorebooks" listing link.
  function getLorebookRef() {
    for (const a of document.querySelectorAll('a[href*="/lorebook/"]')) {
      const m = a.href.match(/\/lorebook\/([0-9a-fA-F-]{8,})/);
      if (m) return { url: a.href.split(/[?#]/)[0], id: m[1] };
    }
    return null;
  }

  // The page's "tabs" are a scroll-spy over lazily-mounted sections, so the
  // related-lorebook anchor only exists once the Lore section (#tab-lore) is
  // active/in view. Activate it (by stable data-tab-id, not label text) and
  // wait for the anchor to mount before reading. Confirmed: companions WITHOUT
  // a lorebook have no Lore tab at all, so its absence is a definitive "no
  // lorebook" — we short-circuit (the plain getLorebookRef() read is just a
  // harmless safety net that returns null when no anchor is present).
  async function findLorebookRef() {
    const tab = document.querySelector('[data-tab-id="lore"]');
    if (!tab) {
      log("no [data-tab-id=lore] — treating as no lorebook");
      return getLorebookRef();
    }
    log("lore tab found, activating…");
    tab.click();
    // Lazy mount may key off the section scrolling into view, so nudge it on
    // each poll until the lorebook anchor appears (or we time out).
    const ref = await waitFor(() => {
      const panel = document.querySelector("#tab-lore");
      if (panel) panel.scrollIntoView({ block: "center" });
      return getLorebookRef();
    }, 8000);
    if (!ref) warn("lore tab present but no /lorebook/ anchor mounted within 8s");
    else log("lorebook ref:", ref);
    return ref;
  }

  // ---------------------------------------------------------------------------
  // Tab navigation
  //
  // The profile is split across tabs ("Profile" = creator notes, "Details" =
  // Companion Core / Advanced Prompt / Example Dialogue). React unmounts the
  // inactive tab, so we must activate each tab before reading from it.
  // ---------------------------------------------------------------------------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Activate a tab by its STABLE data-tab-id (profile|details|lore|discussion).
  // Preferred over label text, which carries dynamic count prefixes ("1 Lore",
  // "9 Comments") and could drift in wording. The tabs are a scroll-spy over
  // lazily-mounted sections, so clicking forces the section to mount. Falls back
  // to a visible-label match for older layouts. Returns true if found+clicked.
  function activateTab(tabId, labelFallback) {
    const byId = document.querySelector('[data-tab-id="' + tabId + '"]');
    if (byId) {
      byId.click();
      return true;
    }
    return labelFallback ? clickTab(labelFallback) : false;
  }

  // Click the tab whose label ends with `label` (live labels are prefixed with
  // counts, e.g. "1Lore", "9Comments"; "Profile"/"Details" have no prefix).
  function clickTab(label) {
    const btn = [...document.querySelectorAll("button,[role='tab'],[data-tab-id]")].find(
      (b) => {
        const t = b.textContent.trim();
        return t === label || t.endsWith(label);
      }
    );
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  }

  // Poll until predicate() is truthy (returns its value) or timeout.
  async function waitFor(predicate, timeoutMs = 4000, stepMs = 100) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = predicate();
      if (v) return v;
      if (Date.now() > deadline) return v;
      await sleep(stepMs);
    }
  }

  // ---------------------------------------------------------------------------
  // Starting scenarios → first_mes + alternate_greetings
  //
  // The "View N scenarios" modal renders ONE scenario at a time with Prev/Next
  // navigation ("Scenario X of N"). We open it, walk Next through every
  // scenario capturing each body, then close it. Scenario 1 → first_mes, the
  // rest → alternate_greetings.
  // ---------------------------------------------------------------------------

  // Serialize a rich-text node to Markdown for the chat-message fields
  // (first_mes / alternate_greetings). SillyTavern's message renderer is naive:
  // it reliably handles ONLY three things — *italic*, **bold**, and plain
  // "quotes" (it styles straight-double-quoted runs itself). It mis-renders
  // almost any nesting or combination (bold+italic, or emphasis wrapped around a
  // quote), and advanced Markdown (headings, dividers, lists, links) too. So we
  // deliberately emit only those three, never combine markers, and flatten
  // everything else to bare text + paragraph spacing. (creator_notes is
  // different — ST renders THAT as HTML, see richToHtml.)
  //
  // Strategy: flatten the subtree to a list of runs, each tagged with at most
  // one emphasis ("", "*", "**"). The nearest emphasis ancestor wins (we never
  // stack two), and a quote forces "" so dialogue is never bold/italic — it
  // breaks any surrounding emphasis instead of nesting inside it.
  function mdRuns(node, emph, out) {
    if (node.nodeType === 3) {
      if (node.textContent) out.push({ text: node.textContent, emph });
      return;
    }
    if (node.nodeType !== 1) return; // comments, etc.
    const tag = node.tagName.toLowerCase();
    if (tag === "br") {
      out.push({ text: "\n", emph: "" });
      return;
    }
    if (tag === "img") return; // gallery images aren't part of a greeting
    const cls = node.classList;
    let e = emph;
    if (cls && cls.contains("rich-text-quote")) e = ""; // quotes never emphasized
    else if (tag === "strong" || tag === "b") e = emph || "**"; // outer wins
    else if (tag === "em" || tag === "i") e = emph || "*";
    for (const child of node.childNodes) mdRuns(child, e, out);
    // Block elements end with a paragraph break. Everything advanced (headings,
    // dividers, lists, links, code, underline, strike) is intentionally left as
    // bare text — only the paragraph break and the emphasis above survive.
    const block =
      tag === "p" || tag === "div" || tag === "li" || /^h[1-6]$/.test(tag) ||
      tag === "blockquote" || tag === "hr" || tag === "ul" || tag === "ol";
    if (block) out.push({ text: "\n\n", emph: "" });
  }

  // Wrap text in a Markdown marker, but only if it carries an actual word char
  // (so punctuation-only runs like a trailing "." stay plain) and with any
  // leading/trailing whitespace kept OUTSIDE the marker ("** text **" / "**.**"
  // don't render).
  function emphasize(marker, text) {
    if (!/\w/.test(text)) return text;
    const m = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return m && m[2] ? m[1] + marker + m[2] + marker + m[3] : text;
  }

  // Merge consecutive runs sharing an emphasis, then wrap each merged run. A
  // quote (emph "") between two emphasized runs splits them, so emphasis breaks
  // cleanly around dialogue instead of nesting through it.
  function runsToMarkdown(runs) {
    let out = "";
    for (let i = 0; i < runs.length; ) {
      const e = runs[i].emph;
      let text = "";
      while (i < runs.length && runs[i].emph === e) {
        text += runs[i].text;
        i++;
      }
      out += e ? emphasize(e, text) : text;
    }
    return out;
  }

  function richToMarkdown(root) {
    const runs = [];
    mdRuns(root, "", runs);
    return runsToMarkdown(runs);
  }

  // Normalize smart punctuation to ASCII. Important for quotes specifically:
  // ST's quote styling triggers on the straight " glyph, so curly “ ” would NOT
  // get styled — fold them (and curly apostrophes) down to " and '.
  const normalizeQuotes = (s) =>
    s.replace(/[“”„‟″]/g, '"').replace(/[‘’‛′]/g, "'");

  // Tidy serialized Markdown: straighten quotes, drop spaces before newlines,
  // collapse blank-line runs to a single blank line, trim the ends.
  const tidyMarkdown = (s) =>
    normalizeQuotes(s).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  // The body of the scenario currently shown in the modal panel, as Markdown
  // (bold/italic and paragraph spacing preserved — see richToMarkdown).
  //
  // Modal layout: panel = [header][scrollBody][footer]; scrollBody =
  // [titleRow][greetingBox]. We read the greetingBox (last child of the
  // scroll body) structurally, so scenarios whose body isn't plain
  // rich-text-paragraphs (e.g. "Choose your own adventure!" with nested lists)
  // are still captured. Falls back to the rich-text container if layout shifts,
  // and to plain innerText if serialization yields nothing usable.
  function currentScenarioBody(panel) {
    const scroll = panel.children[1];
    const box = scroll && scroll.lastElementChild;
    const fromBox = box ? tidyMarkdown(richToMarkdown(box)) || box.innerText.trim() : "";
    if (fromBox) return fromBox;
    const para = panel.querySelector(".rich-text-paragraph");
    const wrap = para && para.parentElement;
    return wrap ? tidyMarkdown(richToMarkdown(wrap)) || wrap.innerText.trim() : "";
  }

  async function extractScenarios() {
    // Multi-scenario cards: "View N scenarios". Single-greeting cards instead
    // render "View First Message" (no count, no "scenario" wording).
    const openBtn = [...document.querySelectorAll("button")].find((b) => {
      const t = b.textContent.trim();
      return /^view\s+\d+\s+scenario/i.test(t) || /^view\s+first\s+message/i.test(t);
    });
    if (!openBtn) {
      log('no "View scenarios / first message" button — first_mes will be empty');
      return { first_mes: "", alternate_greetings: [] };
    }
    log("opening greetings modal:", JSON.stringify(openBtn.textContent.trim()));
    openBtn.click();

    // Modal panel = the container two levels up from the modal's <h2>.
    const panel = await waitFor(() => {
      const h2 = [...document.querySelectorAll("h2")].find(
        (h) => h.textContent.trim() === "Choose your starting scenario"
      );
      return h2 && h2.parentElement ? h2.parentElement.parentElement : null;
    });
    if (!panel) {
      warn("scenarios modal never opened — first_mes will be empty");
      return { first_mes: "", alternate_greetings: [] };
    }

    const bodies = [];
    let total = Infinity;
    for (let guard = 0; guard < 40; guard++) {
      await waitFor(() => currentScenarioBody(panel));
      const m = panel.textContent.match(/Scenario\s+(\d+)\s+of\s+(\d+)/i);
      const cur = m ? +m[1] : bodies.length + 1;
      total = m ? +m[2] : total;

      const body = currentScenarioBody(panel);
      log(`scenario ${cur}/${total === Infinity ? "?" : total}:`, preview(body));
      bodies.push(body);
      if (cur >= total) break;

      const next = [...panel.querySelectorAll("button")].find(
        (b) => /next/i.test(b.textContent.trim()) && !b.disabled
      );
      if (!next) {
        warn("no enabled Next button — stopping scenario walk early");
        break;
      }
      next.click();
      await waitFor(() => currentScenarioBody(panel) !== body);
    }

    // Close the modal via the header's X button (first button next to the h2).
    const h2 = [...document.querySelectorAll("h2")].find(
      (h) => h.textContent.trim() === "Choose your starting scenario"
    );
    const closeBtn = h2 && h2.parentElement && h2.parentElement.querySelector("button");
    if (closeBtn) {
      closeBtn.click();
    }

    // Drop blank or placeholder scenarios: the "Choose your own adventure!" /
    // write-your-own option has an empty body, and some authors stub a greeting
    // with junk like "." or "tbd". Anything shorter than MIN_GREETING_CHARS
    // (after trimming) isn't a real opening message, so discard it.
    const MIN_GREETING_CHARS = 10;
    const filled = bodies.filter((b) => b.trim().length >= MIN_GREETING_CHARS);
    return { first_mes: filled[0] || "", alternate_greetings: filled.slice(1) };
  }

  async function buildCard(chosenName) {
    group("buildCard");
    const name = chosenName || getName();
    const fullTitle = getFullTitle();
    log("name:", JSON.stringify(name), "| full title:", JSON.stringify(fullTitle));

    const images = new Map();

    // Profile tab: creator notes (+ tags, which live in the header area).
    log("activating Profile tab…");
    if (!activateTab("profile", "Profile")) warn("Profile tab not found");
    const gotProfile = await waitFor(() => document.querySelector("#tab-profile"));
    if (!gotProfile) warn("#tab-profile never mounted (creator notes may be empty)");
    // The "You are chatting as:" handle control lives in the Profile tab, so
    // detect it now (sets userRe before any field/lore text is restored).
    const handle = detectUserHandle();
    if (handle) log("chatting-as handle (-> {{user}}):", JSON.stringify(handle));
    else warn(`"You are chatting as:" not found; falling back to USER_HANDLE "${USER_HANDLE}"`);

    const baseNotes = getCreatorNotes();
    const tags = getTags();
    collectImages(images);
    log("creator notes:", preview(baseNotes), "| tags:", tags.length, "| images so far:", images.size);

    // Details tab: the three definition sections. Each is collapsed behind a
    // "Show" toggle that must be expanded or the section boxes never mount.
    log("activating Details tab…");
    if (!activateTab("details", "Details")) warn("Details tab not found");
    const gotShow = await waitFor(() =>
      [...document.querySelectorAll("button")].some(
        (b) => b.textContent.trim() === "Show"
      )
    );
    const showBtns = [...document.querySelectorAll("button")].filter(
      (b) => b.textContent.trim() === "Show"
    );
    if (!gotShow) warn('no "Show" toggles found — Details sections may not mount');
    log(`expanding ${showBtns.length} "Show" toggle(s)`);
    showBtns.forEach((b) => b.click());
    if (!(await waitFor(() => sectionByHeader("Companion Core"))))
      warn("Companion Core never appeared after expanding Details");
    collectImages(images);

    // Lead the creator notes with the full companion title as an <h1>, so the
    // descriptive title (e.g. "Mindy | The Neighbor Across The Hall") is visible
    // even though the card's `name` is the short user-chosen handle.
    const titleHtml = fullTitle ? `<h1>${escapeHtml(fullTitle)}</h1>\n\n` : "";
    const creator_notes = titleHtml + baseNotes + imagesHtml([...images.values()]);
    log("total gallery images:", images.size);

    // Capture each starting scenario before reading the (tab-bound) sections,
    // since the modal overlays the page regardless of active tab.
    const description = sectionByHeader("Companion Core");
    const scenario = sectionByHeader("Advanced Prompt");
    const mes_example = sectionByHeader("Example Dialogue");
    if (!description) warn("Companion Core (description) is empty");
    if (!scenario) warn("Advanced Prompt (scenario) is empty");
    if (!mes_example) warn("Example Dialogue (mes_example) is empty");
    log("description:", preview(description));
    log("scenario:", preview(scenario));
    log("mes_example:", preview(mes_example));
    const { first_mes, alternate_greetings } = await extractScenarios();
    log(
      "first_mes:",
      preview(first_mes),
      "| alternate_greetings:",
      alternate_greetings.length
    );
    groupEnd();

    const data = {
      name,
      description: restoreUser(description),
      personality: "",
      scenario: restoreUser(scenario),
      first_mes: restoreUser(first_mes),
      mes_example: restoreUser(mes_example),
      creator_notes: restoreUser(creator_notes),
      system_prompt: "",
      post_history_instructions: "",
      alternate_greetings: alternate_greetings.map(restoreUser),
      tags,
      creator: getCreator(),
      // Source profile URL, e.g. https://saucepan.ai/companion/<uuid> — stored
      // in the standard Character Version field so it travels with the card.
      character_version: window.location.href.split(/[?#]/)[0],
      extensions: {},
      group_only_greetings: [],
    };
    return {
      spec: "chara_card_v3",
      spec_version: "3.0",
      data,
      // V2-compat mirrored top-level fields (some tools read these)
      name: data.name,
      description: data.description,
      personality: data.personality,
      scenario: data.scenario,
      first_mes: data.first_mes,
      mes_example: data.mes_example,
      tags: data.tags,
    };
  }

  // ---------------------------------------------------------------------------
  // Lorebook retrieval → embedded character_book
  //
  // Chapter text is served obfuscated: each chapter's `text_fragments` is a
  // shuffled bag of real fragments + decoys. We port the site's own reassembly
  // function (minified `T0`/`T0t`/`gW` in the app bundle): keep fragments whose
  // FNV-1a-variant `proof` validates, order by (key XOR mask), concatenate.
  //   GET /api/v2/lorebooks/<id>/chapters          -> {chapters:[{index,title}]}
  //   GET /api/v2/lorebooks/<id>/chapters/<index>  -> {title, text_fragments}
  // ---------------------------------------------------------------------------

  function rotl32(e, n) {
    return ((e << n) | (e >>> (32 - n))) >>> 0;
  }

  // 32-bit FNV-1a variant seeded from (mask, r). Mirrors the bundle's T0t; uses
  // utf8Bytes (not TextEncoder) to stay Xray-safe in Firefox.
  function fragProof(mask, r, text) {
    let s = (2166136261 ^ rotl32(mask, 7) ^ rotl32(r, 13)) >>> 0;
    const bytes = utf8Bytes(text);
    for (let i = 0; i < bytes.length; i++) {
      s ^= bytes[i];
      s = Math.imul(s, 16777619) >>> 0;
    }
    return s >>> 0;
  }

  function deobfuscateFragments(tf) {
    const mask = tf.mask;
    return tf.fragments
      .filter((n) => fragProof(mask, (n.key ^ mask) >>> 0, n.text) === n.proof)
      .sort((a, b) => ((a.key ^ mask) >>> 0) - ((b.key ^ mask) >>> 0))
      .map((n) => n.text)
      .join("");
  }

  // Saucepan's /api requests need a bearer JWT plus a constant Cloudflare
  // edge-gate header; without both the API returns 404 (not 401). The JWT is
  // kept in localStorage under "hallucination/auth_token" (sandbox shares the
  // page's localStorage). The edge header name/value are build constants — if a
  // future build rotates them, requests will 404 again and both can be re-read
  // from any authenticated /api/ call in DevTools → Network.
  const SAUCEPAN_EDGE_HEADER = "cf-edge-token-8af3";
  const SAUCEPAN_EDGE_TOKEN = "e3b0c44298fc1c14";

  function saucepanAuthHeaders() {
    let token = localStorage.getItem("hallucination/auth_token");
    if (token && token[0] === '"') {
      try {
        token = JSON.parse(token);
      } catch (e) {
        /* leave as-is */
      }
    }
    const headers = { Accept: "application/json" };
    headers[SAUCEPAN_EDGE_HEADER] = SAUCEPAN_EDGE_TOKEN;
    if (token) headers.Authorization = "Bearer " + token;
    return headers;
  }

  function fetchJson(url) {
    const headers = saucepanAuthHeaders();
    log("GET", url, "(auth:", headers.Authorization ? "bearer" : "NONE", ")");
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        headers,
        onload: (r) => {
          if (r.status >= 200 && r.status < 300) {
            try {
              resolve(JSON.parse(r.responseText));
            } catch (e) {
              reject(new Error("bad JSON from " + url));
            }
          } else {
            // 404 here usually means the auth/edge-token headers were rejected.
            warn("HTTP", r.status, "for", url, "— check bearer token + cf-edge-token");
            reject(new Error("HTTP " + r.status + " for " + url));
          }
        },
        onerror: () => reject(new Error("network error for " + url)),
      });
    });
  }

  // One bare-minimum embedded-format lore entry. Field shape mirrors a real
  // SillyTavern card export (legacy/embedded names: keys, secondary_keys,
  // insertion_order, ...). Only content/keys/comment/name are meaningful here;
  // everything else is left at neutral stock values for an agent to refine
  // later. The single key is the lowercased chapter title.
  function makeLoreEntry(i, title, content) {
    return {
      name: title,
      keys: [title.toLowerCase()],
      secondary_keys: [],
      content,
      enabled: true,
      insertion_order: (i + 1) * 10,
      case_sensitive: false,
      priority: 10,
      id: i + 1,
      comment: title,
      selective: false,
      constant: false,
      position: "",
      extensions: {
        depth: 4,
        linked: false,
        weight: 10,
        addMemo: true,
        embedded: true,
        probability: 100,
        displayIndex: i,
        selectiveLogic: 0,
        useProbability: true,
        characterFilter: null,
        excludeRecursion: true,
      },
      probability: 100,
      selectiveLogic: 0,
    };
  }

  // Fetch every chapter of a lorebook and build a V3 character_book. Each
  // chapter becomes one entry (content = deobfuscated prose, key = title).
  async function buildLorebook(id) {
    group("buildLorebook " + id);
    const base = "https://saucepan.ai/api/v2/lorebooks/" + id;
    const list = await fetchJson(base + "/chapters");
    const chapters = (list && list.chapters) || [];
    log("chapter count:", chapters.length);
    const entries = [];
    for (let i = 0; i < chapters.length; i++) {
      const idx = chapters[i].index;
      const ch = await fetchJson(base + "/chapters/" + idx);
      const title = (ch && ch.title) || "Chapter " + idx;
      const tf = ch && ch.text_fragments;
      const content = tf ? restoreUser(deobfuscateFragments(tf)) : "";
      if (!tf) {
        warn(`chapter ${idx} "${title}" has no text_fragments`);
      } else {
        // How many fragments passed proof validation vs. were dropped as decoys.
        const kept = tf.fragments.filter(
          (n) => fragProof(tf.mask, (n.key ^ tf.mask) >>> 0, n.text) === n.proof
        ).length;
        log(
          `chapter ${idx} "${title}":`,
          preview(content),
          `(${kept}/${tf.fragments.length} frags kept)`
        );
      }
      entries.push(makeLoreEntry(i, title, content));
    }
    groupEnd();
    return {
      name: "",
      description: "",
      scan_depth: 7,
      token_budget: 4000,
      recursive_scanning: false,
      extensions: {},
      entries,
    };
  }

  // ---------------------------------------------------------------------------
  // PNG tEXt chunk embedding (mirrors cardcleaner/main.py, in JS)
  // ---------------------------------------------------------------------------

  const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  // UTF-8 bytes of a string as a SANDBOX-owned Uint8Array.
  // Avoids TextEncoder, whose page-side typed array can't be read across the
  // Firefox Xray boundary. encodeURIComponent→unescape yields a binary
  // (one-byte-per-char) string of the UTF-8 encoding.
  function utf8Bytes(str) {
    const bin = unescape(encodeURIComponent(str));
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      arr[i] = bin.charCodeAt(i);
    }
    return arr;
  }

  // base64 of a UTF-8 JSON string, as the chunk value after "<key>\0".
  function b64utf8(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }

  function makeTextChunk(keyword, value) {
    const body = utf8Bytes(keyword + "\0" + value); // Latin-1 safe (base64)
    const type = utf8Bytes("tEXt");
    const out = new Uint8Array(4 + 4 + body.length + 4);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, body.length);
    out.set(type, 4);
    out.set(body, 8);
    dv.setUint32(8 + body.length, crc32(concat(type, body)));
    return out;
  }

  function concat(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  // Insert tEXt chunks immediately before IEND.
  function embedChunks(pngBytes, textChunks) {
    // Locate IEND chunk (length=0, type "IEND").
    const dv = new DataView(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength);
    let pos = 8; // skip signature
    let iendStart = -1;
    while (pos < pngBytes.length) {
      const len = dv.getUint32(pos);
      const type = String.fromCharCode(
        pngBytes[pos + 4], pngBytes[pos + 5], pngBytes[pos + 6], pngBytes[pos + 7]
      );
      if (type === "IEND") {
        iendStart = pos;
        break;
      }
      pos += 12 + len;
    }
    if (iendStart < 0) throw new Error("IEND not found in PNG");

    const head = pngBytes.slice(0, iendStart);
    const tail = pngBytes.slice(iendStart); // IEND + crc
    let extra = new Uint8Array(0);
    for (const ch of textChunks) extra = concat(extra, ch);
    return concat(concat(head, extra), tail);
  }

  // ---------------------------------------------------------------------------
  // Image fetch + PNG re-encode
  // ---------------------------------------------------------------------------

  function fetchBlob(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: "blob",
        onload: (r) =>
          r.status >= 200 && r.status < 300
            ? resolve(r.response)
            : reject(new Error("HTTP " + r.status)),
        onerror: () => reject(new Error("network error")),
      });
    });
  }

  // Read a Blob's bytes into a SANDBOX-owned Uint8Array.
  // We go via a base64 data URL (a plain string crosses the Xray boundary
  // freely) instead of blob.arrayBuffer(), whose page-side ArrayBuffer cannot
  // be iterated from the userscript sandbox in Firefox.
  function blobToBytes(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => {
        const dataUrl = String(fr.result);
        const bin = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) {
          arr[i] = bin.charCodeAt(i);
        }
        resolve(arr);
      };
      fr.onerror = () => reject(new Error("FileReader failed"));
      fr.readAsDataURL(blob);
    });
  }

  async function blobToPngBytes(blob) {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    const pngBlob = await new Promise((res) =>
      canvas.toBlob(res, "image/png")
    );
    return blobToBytes(pngBlob);
  }

  // Base64 of a sandbox Uint8Array, chunked to stay within call-stack limits.
  function bytesToBase64(bytes) {
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  // Download via a data: URL so no sandbox TypedArray is ever handed to a
  // page-side Blob/URL constructor (which Firefox blocks across Xrays).
  function download(bytes, filename) {
    const a = document.createElement("a");
    a.href = "data:image/png;base64," + bytesToBase64(bytes);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ---------------------------------------------------------------------------
  // Orchestration + UI
  // ---------------------------------------------------------------------------

  async function exportCard() {
    const t0 = Date.now();
    log("=== export started @", new Date().toISOString(), "url:", location.href);
    try {
      // Ask for the character name up front (defaults to the title's first "|"
      // segment). This becomes data.name AND the PNG filename. Cancel aborts.
      const suggested = getName();
      const entered = window.prompt(
        "Enter a name for this character.\n\nSets the card name and the PNG filename. " +
          'The full title is kept as an <h1> at the top of the creator notes.\n\nCancel aborts the export.',
        suggested
      );
      if (entered === null) {
        log("export aborted at name prompt");
        return;
      }
      const name = entered.trim() || suggested;
      log("chosen name:", JSON.stringify(name));

      // Detect a linked lorebook (activates the Lore tab to mount the anchor).
      const lore = await findLorebookRef();
      log("lorebook detected:", lore ? lore.url : "none");

      const card = await buildCard(name);
      log("card assembled:", card);

      // Optionally retrieve + embed the linked lorebook as a character_book.
      if (lore) {
        const proceed = window.confirm(
          "This companion links a lorebook:\n" +
            lore.url +
            "\n\nRetrieve it and embed it in the card? (makes extra requests to saucepan.ai)"
        );
        log("lorebook prompt:", proceed ? "accepted" : "declined");
        if (proceed) {
          try {
            const book = await buildLorebook(lore.id);
            card.data.character_book = book;
            log("embedded lorebook:", book.entries.length, "entries");
          } catch (e) {
            console.error(TAG, "lorebook fetch failed", e);
            if (
              !window.confirm(
                "Lorebook retrieval failed: " + e.message + "\n\nExport the card WITHOUT the lorebook?"
              )
            ) {
              log("aborted by user after lorebook failure");
              return;
            }
            log("continuing export WITHOUT lorebook");
          }
        }
      }

      if (!card.data.description) {
        warn("description empty — prompting before export");
        const proceed = window.confirm(
          "Companion Core (description) came back empty - the profile tab may not be open. Export anyway?"
        );
        if (!proceed) {
          log("aborted by user (empty description)");
          return;
        }
      }
      const portrait = getPortraitUrl();
      if (!portrait) throw new Error("No CDN portrait image found on page.");
      log("portrait:", portrait);

      const blob = await fetchBlob(portrait);
      log("portrait fetched:", blob.size, "bytes,", blob.type);
      const png = await blobToPngBytes(blob);
      log("re-encoded PNG:", png.length, "bytes");

      const json = JSON.stringify(card);
      const value = b64utf8(json);
      log("card JSON:", json.length, "chars →", value.length, "b64 chars");
      const chunks = [
        makeTextChunk("chara", value),
        makeTextChunk("ccv3", value),
      ];
      const out = embedChunks(png, chunks);

      const safe = card.data.name.replace(/[^\w\- ]+/g, "").trim() || "character";
      download(out, `${safe}.png`);
      log(
        "=== export complete:",
        `${safe}.png`,
        out.length,
        "bytes,",
        card.data.character_book ? card.data.character_book.entries.length + " lore entries," : "no lorebook,",
        `${Date.now() - t0}ms`
      );
    } catch (e) {
      console.error(TAG, "export failed:", e);
      alert("Export failed: " + e.message);
    }
  }

  function addButton() {
    if (document.getElementById("saucepan-export-btn")) return;
    const btn = document.createElement("button");
    btn.id = "saucepan-export-btn";
    btn.textContent = "⬇ Export Card V3";
    Object.assign(btn.style, {
      position: "fixed",
      bottom: "16px",
      right: "16px",
      zIndex: 99999,
      padding: "10px 14px",
      borderRadius: "10px",
      border: "none",
      background: "#b5532f",
      color: "#fff",
      fontWeight: "600",
      cursor: "pointer",
      boxShadow: "0 2px 8px rgba(0,0,0,.3)",
    });
    btn.addEventListener("click", exportCard);
    document.body.appendChild(btn);
  }

  // SPA: keep the button alive across client-side navigations.
  log("loaded v0.6.0 — filter the console on \"[saucepan-export]\" to trace a run");
  addButton();
  new MutationObserver(addButton).observe(document.body, {
    childList: true,
    subtree: false,
  });
})();
