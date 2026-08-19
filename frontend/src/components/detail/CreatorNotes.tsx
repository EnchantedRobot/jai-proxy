import { useEffect, useRef, useState } from 'react'
import DOMPurify from 'dompurify'

/**
 * Creator notes, rendered in a sandboxed iframe.
 *
 * Salvage item 4 (docs/UI_REWRITE_PLAN.md §1.3): the ~150 lines that matter out
 * of web/'s 1,056-line creator-notes module — the sandbox attribute set, the
 * height handshake, and the min/max clamp. Not the palette work; the server
 * already strips a card's CSS down to layout (proxy/text/notes_html.py). What
 * stays the client's job is *isolation*: creator notes are untrusted
 * third-party HTML, and putting them in the live DOM would let one card's
 * markup restyle or overlay the whole app.
 *
 * Two boundaries, because one is not enough:
 *
 *  1. DOMPurify strips scripts, event handlers and dangerous tags/protocols
 *     before the HTML is ever written. This is the content boundary.
 *  2. A sandboxed iframe with its own CSP is the frame boundary. It carries
 *     allow-scripts WITHOUT allow-same-origin, so the frame runs its own
 *     measuring script but has an opaque origin — it cannot reach window.parent,
 *     read cookies/storage, submit a form, or navigate the top frame. A link
 *     opens in a new tab, an image loads, and nothing else happens.
 *
 * The height handshake exists because a sandboxed iframe has no intrinsic
 * height — without it the notes would sit in a fixed-height box with a
 * scrollbar. The parent cannot read the opaque-origin iframe's document, so the
 * iframe measures itself and posts its height out; the parent trusts only a
 * number, from this iframe, and grows to fit it exactly, the same as any other
 * prose block on the page (Description, Greetings). There is no upper clamp —
 * a cap silently clips whatever note is long enough to hit it, with no
 * scrollbar and no indication anything is missing.
 */

const MIN_HEIGHT = 60

/** DOMPurify config: permissive for rich styling, closed to anything active. */
const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'p',
    'br',
    'hr',
    'div',
    'span',
    'strong',
    'b',
    'em',
    'i',
    'u',
    's',
    'strike',
    'del',
    'ins',
    'mark',
    'a',
    'img',
    'ul',
    'ol',
    'li',
    'blockquote',
    'pre',
    'code',
    'table',
    'tr',
    'td',
    'th',
    'thead',
    'tbody',
    'tfoot',
    'caption',
    'colgroup',
    'col',
    'center',
    'font',
    'sub',
    'sup',
    'small',
    'big',
    'details',
    'summary',
    'abbr',
    'cite',
    'q',
    'dl',
    'dt',
    'dd',
    'figure',
    'figcaption',
    'article',
    'section',
    'aside',
    'header',
    'footer',
    'nav',
    'main',
    'address',
    'time',
    'ruby',
    'rt',
    'rp',
    'bdi',
    'bdo',
    'wbr',
    'style',
  ],
  ALLOWED_ATTR: [
    'href',
    'src',
    'alt',
    'title',
    'class',
    'id',
    'style',
    'target',
    'width',
    'height',
    'align',
    'valign',
    'border',
    'colspan',
    'rowspan',
    'color',
    'face',
    'size',
    'start',
    'type',
    'value',
    'reversed',
    'dir',
    'lang',
    'rel',
  ],
  FORBID_TAGS: [
    'script',
    'iframe',
    'object',
    'embed',
    'form',
    'input',
    'button',
    'select',
    'textarea',
    'meta',
    'link',
    'base',
    'noscript',
  ],
  ALLOW_DATA_ATTR: true,
  ALLOW_UNKNOWN_PROTOCOLS: false,
}

/** The CSP the iframe document carries: no script anywhere, images/media open. */
const IFRAME_CSP =
  "default-src 'none'; img-src * data: blob:; media-src * data: blob:; " +
  "style-src 'unsafe-inline'; font-src * data:; script-src 'unsafe-inline'; " +
  "form-action 'none'"

/** The self-measuring script that posts the document's height to the parent. */
const MEASURE_SCRIPT = `
  var last = 0;
  function report() {
    var h = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (Math.abs(h - last) > 2) {
      last = h;
      parent.postMessage({ __notesHeight: h }, '*');
    }
  }
  new ResizeObserver(report).observe(document.body);
  addEventListener('load', report);
  Array.prototype.forEach.call(document.images, function (img) {
    if (!img.complete) { img.addEventListener('load', report); img.addEventListener('error', report); }
  });
  report();
`

/** Percent-encodes a URL for `/proxy/{url}`, matching `proxyEncode` in the
 *  legacy web/ frontend (web/library-sections/30-media-localization-feature.js)
 *  -- `encodeURIComponent` alone leaves `!'()*` unescaped, and cors_proxy.py
 *  reads the whole thing back as one path segment. */
function proxyEncode(url: string): string {
  return encodeURIComponent(url).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  )
}

/**
 * Route every embedded image through the server's `/proxy/{url}` passthrough
 * rather than hotlinking the source directly.
 *
 * The notes iframe is sandboxed without `allow-same-origin` (see the module
 * doc above), which gives it an opaque origin -- and some source CDNs (e.g.
 * saucepan.ai) answer with `Cross-Origin-Resource-Policy: same-origin`, which
 * an opaque origin can never satisfy. The browser drops the image outright,
 * no error the iframe can recover from. Routing through our own origin's
 * `/proxy` sidesteps it: cors_proxy.py strips that header off the reply, since
 * it is describing the upstream's policy, not ours.
 */
function proxyImages(html: string): string {
  const container = document.createElement('div')
  container.innerHTML = html
  container
    .querySelectorAll('img[src^="http://"], img[src^="https://"]')
    .forEach((img) => {
      const src = img.getAttribute('src')
      if (src) img.setAttribute('src', `/proxy/${proxyEncode(src)}`)
    })
  return container.innerHTML
}

const BASE_STYLES = `
  html { color-scheme: dark; }
  /* The frame is sized to its content by the measure script below, so it never
     needs to scroll itself. Any scrollbar it does show is therefore an
     artefact -- and under color-scheme:dark an empty dark track reads as a
     stray shadow down the right-hand edge (Stage 6B D2). Suppress the
     scrollbar rather than the overflow, so content a pixel or two wide than
     the measure is still reachable by the page's own scroll. */
  html, body { scrollbar-width: none; -ms-overflow-style: none; }
  html::-webkit-scrollbar, body::-webkit-scrollbar { width: 0; height: 0; }
  html { overflow-y: hidden; }
  body {
    margin: 0; padding: 4px 2px;
    font: 14.5px/1.68 'Figtree', 'Segoe UI', system-ui, sans-serif;
    color: #d2d8da; background: transparent; overflow-wrap: break-word;
  }
  a { color: #57c2a2; text-decoration: none; }
  a:hover { text-decoration: underline; }
  h1, h2, h3, h4, h5, h6 { color: #e9ebec; line-height: 1.3; margin: 18px 0 7px; }
  h1:first-child, h2:first-child, h3:first-child { margin-top: 0; }
  p { margin: 0 0 11px; }
  ul, ol { margin: 0 0 11px 20px; padding: 0; }
  li { margin: 3px 0; }
  img, video { max-width: 100%; height: auto; border-radius: 10px; margin: 8px 0; }
  blockquote { border-left: 2px solid #57c2a2; margin: 14px 0; padding: 2px 0 2px 14px; color: #c3cacd; }
  pre { background: rgba(0,0,0,.3); padding: 10px; border-radius: 8px; overflow-x: auto; white-space: pre-wrap; }
  code { background: rgba(0,0,0,.3); padding: 2px 6px; border-radius: 5px; font-family: 'JetBrains Mono', monospace; font-size: .9em; }
  table { width: 100%; border-collapse: collapse; margin: 10px 0; }
  td, th { padding: 7px 11px; border: 1px solid rgba(255,255,255,.1); }
  [style*="position:fixed"], [style*="position: fixed"],
  [style*="position:sticky"], [style*="position: sticky"] { position: static !important; }
`

/** Build the complete, sandboxed iframe document. `notes` is pre-sanitized. */
function buildDocument(notes: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${IFRAME_CSP}">` +
    `<style>${BASE_STYLES}</style></head>` +
    `<body>${notes}<script>${MEASURE_SCRIPT}</script></body></html>`
  )
}

/** Real HTML tag names only -- matches PURIFY_CONFIG.ALLOWED_TAGS so a hit
 *  here is guaranteed to survive sanitization as a structural element. */
const HTML_TAG_PATTERN = new RegExp(
  `<\\/?(?:${PURIFY_CONFIG.ALLOWED_TAGS.join('|')})(?:[\\s/>]|$)`,
  'i',
)

/**
 * Whether the notes look like HTML or markdown/plain text.
 *
 * Cards from Chub carry real HTML documents; the JanitorAI/saucepan/datacat
 * mappers flatten to markdown. A markdown body dropped into an iframe as-is
 * would show its literal `**` and `#`, so it is escaped and given minimal
 * block/inline formatting first.
 *
 * A naive "contains `<...>`" test false-positives on markdown notes that use
 * angle brackets as plain text -- e.g. JanitorAI creator notes advertising
 * plugin tokens like `<SYMBOLS=943F533B>` or a placeholder `<blank>` --
 * which sent real markdown down the raw-HTML path unconverted. Requiring the
 * bracketed name to be a real tag (from the same whitelist DOMPurify uses)
 * avoids that: those tokens aren't HTML tags, so they fall through to
 * markdownToHtml and render as literal, escaped text instead.
 */
function looksLikeHtml(notes: string): boolean {
  return HTML_TAG_PATTERN.test(notes)
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Just enough markdown to read a note: paragraphs, headings, bold, italics,
 *  links, images. Images must be matched before links -- `![alt](url)`
 *  contains a valid `[alt](url)` link, and the link pattern would otherwise
 *  eat it first and leave a stray `!` beside an anchor instead of a picture.
 *  `html_to_md` (proxy/text/html_md.py) is what produces this syntax for every
 *  source that flattens creator notes to markdown, so an image-bearing note
 *  from any of them depends on this ordering to render at all. */
function markdownToHtml(md: string): string {
  const inline = (line: string) =>
    escapeHtml(line)
      .replace(
        /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g,
        '<img src="$2" alt="$1" loading="lazy">',
      )
      .replace(
        /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
        '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>',
      )
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
  return md
    .split(/\n{2,}/)
    .map((block) => {
      const heading = block.match(/^(#{1,6})\s+(.*)$/)
      if (heading)
        return `<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`
      return `<p>${inline(block).replace(/\n/g, '<br>')}</p>`
    })
    .join('')
}

export function CreatorNotes({ notes }: { notes: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(MIN_HEIGHT)

  const html = looksLikeHtml(notes) ? notes : markdownToHtml(notes)
  const clean = DOMPurify.sanitize(html, PURIFY_CONFIG) as unknown as string
  const srcDoc = buildDocument(proxyImages(clean))

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Trust only a number, and only from our own iframe.
      if (event.source !== frameRef.current?.contentWindow) return
      const reported = (event.data as { __notesHeight?: unknown })
        ?.__notesHeight
      if (typeof reported === 'number' && Number.isFinite(reported)) {
        setHeight(Math.max(MIN_HEIGHT, reported))
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  return (
    <iframe
      ref={frameRef}
      title="Creator notes"
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
      srcDoc={srcDoc}
      className="block w-full rounded-xl border border-line-soft bg-surface"
      style={{ height, boxSizing: 'content-box' }}
    />
  )
}
