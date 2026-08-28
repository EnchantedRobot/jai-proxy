import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import userEvent from '@testing-library/user-event'
import { screen } from '@testing-library/react'
import { server } from '@/test/msw-server'
import { renderApp } from '@/test/render'
import { MediaUpload } from './MediaUpload'

const FOLDER = 'Abbie_kzbYR2QbpncC'

function file(name: string, type = 'image/png') {
  return new File(['pretend these are pixels'], name, { type })
}

/** The hidden `<input type=file>` behind *Choose files*. */
function picker() {
  return document.querySelector('input[type="file"]') as HTMLInputElement
}

/**
 * Handlers key on how many requests have arrived rather than on the uploaded
 * filename: jsdom's `fetch` serialises every multipart part as `blob`, so the
 * name the real server reads is not visible from here.
 */
function written(name: string, replaced = false) {
  return { folder: FOLDER, name, size: 10, path: '', url: '', replaced }
}

describe('MediaUpload', () => {
  it('posts loose files one at a time and reports what landed', async () => {
    let calls = 0
    server.use(
      http.post('*/api/v1/galleries/:folder/files', () => {
        calls += 1
        return HttpResponse.json(written(`file${calls}.webp`, calls === 2), {
          status: 201,
        })
      }),
    )
    renderApp(<MediaUpload kind="galleries" folder={FOLDER} />)

    await userEvent.upload(picker(), [file('one.png'), file('two.png')])

    expect(await screen.findByText('1 added · 1 replaced.')).toBeInTheDocument()
    expect(calls).toBe(2)
  })

  it('names a refused file instead of failing the whole drop', async () => {
    let calls = 0
    server.use(
      http.post('*/api/v1/galleries/:folder/files', () => {
        calls += 1
        if (calls === 2)
          return HttpResponse.json(
            { detail: 'not a readable image' },
            { status: 422 },
          )
        return HttpResponse.json(written('one.webp'), { status: 201 })
      }),
    )
    renderApp(<MediaUpload kind="galleries" folder={FOLDER} />)

    await userEvent.upload(picker(), [file('one.png'), file('broken.png')])

    expect(await screen.findByText('1 added · 1 skipped.')).toBeInTheDocument()
    expect(screen.getByText('broken.png')).toBeInTheDocument()
    expect(screen.getByText(/not a readable image/)).toBeInTheDocument()
  })

  it('sends a .zip to the zip route and folds its report in', async () => {
    server.use(
      http.post('*/api/v1/expressions/:folder/zip', () =>
        HttpResponse.json(
          {
            folder: FOLDER,
            written: [written('joy.webp')],
            skipped: [{ name: 'smugness.png', reason: 'not one of the 28' }],
          },
          { status: 201 },
        ),
      ),
    )
    renderApp(<MediaUpload kind="expressions" folder={FOLDER} zip />)

    await userEvent.upload(picker(), [file('pack.zip', 'application/zip')])

    expect(await screen.findByText('1 added · 1 skipped.')).toBeInTheDocument()
    expect(screen.getByText('smugness.png')).toBeInTheDocument()
  })
})
