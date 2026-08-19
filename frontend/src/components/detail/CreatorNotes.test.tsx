import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { CreatorNotes } from './CreatorNotes'

/**
 * `srcDoc` is asserted directly rather than by inspecting the mounted iframe's
 * document -- jsdom does not execute `srcDoc` navigation, so the frame's own
 * content is never reachable from the test. The string it was built from is
 * exactly what the browser would render, so it is the right thing to check.
 */
function srcDoc(notes: string): string {
  const { container } = render(<CreatorNotes notes={notes} />)
  return container.querySelector('iframe')!.getAttribute('srcdoc')!
}

describe('CreatorNotes', () => {
  it('renders markdown image syntax as an <img>, not a mangled link', () => {
    // This is the shape proxy/text/html_md.py's `rich_to_md` produces for every
    // source that flattens creator notes to markdown (JanitorAI, saucepan,
    // datacat, JannyAI) -- the common case, not an edge case.
    const doc = srcDoc(
      'Look at this:\n\n![a portrait](https://example.com/a.png)',
    )
    expect(doc).toContain(
      '<img src="/proxy/https%3A%2F%2Fexample.com%2Fa.png" alt="a portrait"',
    )
    expect(doc).not.toContain('<a href="https://example.com/a.png"')
  })

  it('still renders a plain markdown link as an <a>', () => {
    const doc = srcDoc('See [the source](https://example.com/page).')
    expect(doc).toContain('<a href="https://example.com/page"')
  })

  it('passes a real <img> through untouched when the notes are already HTML, except for routing it through the proxy', () => {
    const doc = srcDoc('<p>hi</p><img src="https://example.com/b.png" alt="b">')
    expect(doc).toContain(
      '<img src="/proxy/https%3A%2F%2Fexample.com%2Fb.png" alt="b">',
    )
  })

  it('routes an embedded image through /proxy so a CDN that blocks cross-origin embedding (Cross-Origin-Resource-Policy: same-origin) still renders inside the sandboxed, opaque-origin iframe', () => {
    const doc = srcDoc('![a](https://saucepan.ai/cdn/x/card)')
    expect(doc).toContain(
      'src="/proxy/https%3A%2F%2Fsaucepan.ai%2Fcdn%2Fx%2Fcard"',
    )
  })

  it("leaves a link's href alone -- only <img src> is proxied", () => {
    const doc = srcDoc(
      '[link](https://example.com/page) and ![img](https://example.com/a.png)',
    )
    expect(doc).toContain('<a href="https://example.com/page"')
    expect(doc).toContain('<img src="/proxy/https%3A%2F%2Fexample.com%2Fa.png"')
  })

  it('still renders markdown bold/images when the notes contain angle-bracket text that is not a real tag', () => {
    // Real JanitorAI creator notes (dezea's cards) advertise LoreBary plugin
    // tokens like `<SYMBOLS=943F533B>` and a `<blank>` scenario placeholder.
    // Neither is an HTML tag; a naive "has a <...>" sniff misread the whole
    // note as HTML and skipped markdown conversion entirely, leaving the
    // literal `**` and `![]()` on the page.
    const doc = srcDoc(
      'Scenario 10: <blank>\n\n**Akane Kujo:**\n\n![a](https://example.com/a.png)\n\n<SYMBOLS=943F533B> more text',
    )
    expect(doc).toContain('&lt;blank&gt;')
    expect(doc).toContain('<strong>Akane Kujo:</strong>')
    expect(doc).toContain(
      '<img src="/proxy/https%3A%2F%2Fexample.com%2Fa.png" alt="a"',
    )
    expect(doc).toContain('&lt;SYMBOLS=943F533B&gt;')
  })
})
