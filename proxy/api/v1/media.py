"""`/api/v1` media routes: fetching a card's remote images and video.

The browser discovers the URLs; the server does the fetching (Phase 3C, see
docs/PHASE_3C_PLAN.md). One-shot downloads stream progress back as NDJSON;
longer runs go through the background job store in `_shared`.
"""

from __future__ import annotations

import json
import time

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse

from proxy.api.schemas import (
    MediaBytesOut,
    MediaDownloadIn,
    MediaHaveIn,
    MediaHaveOut,
    MediaJobEventOut,
    MediaJobOut,
    MediaJobStatusOut,
    MediaJobSubmitIn,
    MediaManifestOut,
    MediaStatusEntryOut,
    MediaStatusOut,
)
from proxy.api.v1 import _shared
from proxy.cards import gallery
from proxy.config import settings
from proxy.media import jobs as media_jobs, manifest as media_manifest, writer as media_writer
from proxy.runtime import net

router = APIRouter()

def _job_status_out(job: media_jobs.MediaJob, *, after: int = 0, include_events: bool = True) -> MediaJobStatusOut:
    events = [MediaJobEventOut(**e) for e in job.events[after:]] if include_events else []
    return MediaJobStatusOut(
        job_id=job.id,
        card_id=job.card_id,
        phase=job.phase,
        prefix=job.prefix,
        state=job.state,
        total=job.total,
        done=job.done,
        saved=job.saved,
        skipped=job.skipped,
        errors=job.errors,
        error=job.error_message,
        events=events,
        next_cursor=len(job.events),
    )


@router.get("/media/status", response_model=MediaStatusOut, summary="Media-download status for every card")
def get_media_status() -> MediaStatusOut:
    """docs/PHASE_3C_PLAN.md §3 -- lets Bulk Localize skip characters it already
    finished without one request per card. Cards with no gallery folder on disk
    yet cost one failed `stat`; a folder that exists but was never downloaded
    into has no `.media.json` and costs the same. Only a folder with an actual
    manifest pays for a JSON read, and that file is small."""
    idx = _shared.index()
    cards: dict[str, MediaStatusEntryOut] = {}
    for record in idx.cards():
        folder = gallery.resolve_folder(settings.galleries_dir, gallery.folder_name(record.name, record.gallery_id))
        if not folder:
            continue
        gallery_dir = settings.galleries_dir / folder
        try:
            media_manifest.manifest_path(gallery_dir).stat()
        except OSError:
            continue
        manifest = media_manifest.load_manifest(gallery_dir)
        last_run = manifest["runs"][-1] if manifest["runs"] else None
        cards[record.filename] = MediaStatusEntryOut(
            files=len(manifest["files"]),
            bytes=sum(f.get("size", 0) for f in manifest["files"].values()),
            complete=bool(last_run and last_run.get("errors", 0) == 0),
            dead=len(manifest["dead"]),
            last_run=last_run.get("at") if last_run else None,
        )
    return MediaStatusOut(cards=cards)


@router.get("/characters/{card_id}/media", response_model=MediaManifestOut, summary="A card's media manifest")
def get_character_media(card_id: str) -> MediaManifestOut:
    """The gallery's `.media.json`, verbatim -- which source URLs became which
    local files, which are known permanently gone, and the recent run
    history. 404 only when the card itself doesn't exist; a card with no
    media run yet answers with an empty manifest rather than 404, since
    "never downloaded" is a normal state, not an error."""
    idx = _shared.index()
    record = _shared.require(idx, card_id)
    wanted = gallery.folder_name(record.name, record.gallery_id)
    folder = gallery.resolve_folder(settings.galleries_dir, wanted) or wanted
    manifest = media_manifest.load_manifest(settings.galleries_dir / folder) if folder else media_manifest.empty_manifest()
    return MediaManifestOut(folder=folder, files=manifest["files"], dead=manifest["dead"], runs=manifest["runs"])


@router.post("/characters/{card_id}/media", summary="Download a card's remote media")
def download_character_media(card_id: str, body: MediaDownloadIn) -> StreamingResponse:
    """The one centralized download route -- docs/PHASE_3C_PLAN.md §3.

    The browser keeps discovery (card scan, provider gallery APIs, extractor
    session cookies) and hands over a URL list; everything downstream --
    guard, fetch, sniff, WebP normalization, dedupe, write, thumbnail,
    manifest -- happens here, in `media_writer.download_item`, one call per
    item against a folder resolved from the card's own `gallery_id` so a
    rename mid-run can't miss it.

    Answers NDJSON, streamed: one `{"type": "item", ...}` line per URL as it
    finishes, then a final `{"type": "done", ...}` totals line. The existing
    `onLog`/`onProgress` UI callbacks (all four trigger surfaces named in the
    plan) map onto those events 1:1.
    """
    idx = _shared.index()
    record = _shared.require(idx, card_id)
    folder_name, gallery_dir = _shared.gallery_dir_for_card(idx, record)

    async def generate():
        manifest = media_manifest.load_manifest(gallery_dir)
        ledger = media_manifest.load_dead_ledger()
        index_state = media_writer.GalleryIndex.build(gallery_dir)
        saved = skipped = errors = 0
        # A millisecond timestamp as the starting file index, same scheme the
        # JS loop used -- unique across runs without a persistent counter.
        start_index = int(time.time() * 1000)
        async with net.async_client(
            timeout=30.0, headers={"User-Agent": "Mozilla/5.0"}
        ) as client:
            batch = media_writer.download_batch(
                client,
                gallery_dir,
                folder_name,
                items=[{"url": i.url, "filename": i.filename} for i in body.items],
                prefix=body.prefix,
                start_index=start_index,
                index_state=index_state,
                manifest=manifest,
                ledger=ledger,
                thumbnail_store=_shared.thumbnail_store,
            )
            async for outcome in batch:
                if outcome.status == "saved":
                    saved += 1
                elif outcome.status == "skipped":
                    skipped += 1
                else:
                    errors += 1
                yield (
                    json.dumps(
                        {
                            "type": "item",
                            "url": outcome.url,
                            "status": outcome.status,
                            "file": outcome.file,
                            "reason": outcome.reason,
                            "bytes": outcome.bytes,
                        }
                    )
                    + "\n"
                )

        media_manifest.append_run(
            manifest,
            {
                "at": media_manifest.now_iso(),
                "phase": body.phase,
                "saved": saved,
                "skipped": skipped,
                "errors": errors,
            },
        )
        media_manifest.save_manifest(gallery_dir, manifest)
        media_manifest.save_dead_ledger(ledger)
        yield (
            json.dumps(
                {"type": "done", "saved": saved, "skipped": skipped, "errors": errors, "total": len(body.items)}
            )
            + "\n"
        )

    return StreamingResponse(generate(), media_type="application/x-ndjson")


@router.post("/media/jobs", response_model=MediaJobOut, summary="Queue a background media-download run")
def submit_media_job(body: MediaJobSubmitIn) -> MediaJobOut:
    """docs/PHASE_3C_PLAN.md §7, "3C-2 -- the job runner". Same contract as
    `POST /characters/{id}/media` -- the browser still does discovery and
    hands over a resolved URL list -- but the download itself runs as a
    detached background task instead of over this request's own connection,
    so it survives the tab closing. Poll `GET /media/jobs/{id}` for progress."""
    idx = _shared.index()
    record = _shared.require(idx, body.card_id)
    folder_name, gallery_dir = _shared.gallery_dir_for_card(idx, record)
    items = [{"url": i.url, "filename": i.filename} for i in body.items]
    job = _shared.job_store.submit(gallery_dir, folder_name, items, body.prefix, body.phase, card_id=body.card_id)
    return MediaJobOut(job_id=job.id, state=job.state, total=job.total)


@router.get("/media/jobs/{job_id}", response_model=MediaJobStatusOut, summary="Poll a background media-download job")
def get_media_job(job_id: str, after: int = Query(default=0, ge=0, description="Skip events before this index.")) -> MediaJobStatusOut:
    job = _shared.job_store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return _job_status_out(job, after=after)


@router.post("/media/jobs/{job_id}/cancel", summary="Cancel a queued or running media-download job")
def cancel_media_job(job_id: str) -> dict[str, bool]:
    if not _shared.job_store.cancel(job_id):
        raise HTTPException(status_code=404, detail="job not found or already finished")
    return {"cancelled": True}


@router.get("/media/jobs", response_model=list[MediaJobStatusOut], summary="List recent background media-download jobs")
def list_media_jobs(
    card_id: str | None = Query(default=None),
    active: bool = Query(default=False, description="Only queued/running jobs."),
) -> list[MediaJobStatusOut]:
    jobs = _shared.job_store.list_jobs(card_id=card_id, active_only=active)
    return [_job_status_out(job, include_events=False) for job in jobs]


@router.post("/characters/{card_id}/media/have", response_model=MediaHaveOut, summary="Which of these URLs the gallery already has")
def check_character_media_have(card_id: str, body: MediaHaveIn) -> MediaHaveOut:
    """The local-only skips of `media_writer.download_item` (its manifest hit
    and name index), split out so a caller that has to fetch bytes *itself*
    can ask before paying for them.

    The batch download route gets this for free: it runs both checks before it
    opens a connection. The browser-fetch door (§6) can't -- by the
    time bytes reach `POST .../media/bytes` they've already been downloaded
    and, for MEGA, AES-CTR-decrypted client side. A re-run over an already
    complete MEGA folder therefore re-downloaded and re-decrypted every file
    only to be told "already have this content" 200 times. This route lets
    that caller skip on the name index exactly like the server-fetch path
    does, before a byte moves.

    Recording the match in the manifest mirrors `download_item`'s name-match
    branch: the URL *is* satisfied by that file, and `/media/status` reads the
    manifest, so a skip that goes unrecorded leaves the card looking
    permanently un-downloaded.
    """
    idx = _shared.index()
    record = _shared.require(idx, card_id)
    _folder_name, gallery_dir = _shared.gallery_dir_for_card(idx, record)

    index_state = media_writer.GalleryIndex.build(gallery_dir)
    manifest = media_manifest.load_manifest(gallery_dir)

    have: dict[str, str] = {}
    recorded = False
    for item in body.items:
        # Same two-step as `download_item`: the exact-URL manifest hit first
        # (it catches the URLs whose filenames are too short to index on, e.g.
        # postimg's `1.webp`), then the name index for everything else. A
        # manifest hit is already recorded, by definition -- that is what it
        # is -- so only the name-index branch has anything to write back.
        existing = media_writer.manifest_hit(manifest, index_state, item.url)
        if existing:
            have[item.url] = existing
            continue
        existing = index_state.find_by_name(item.url, item.filename, body.prefix)
        if not existing:
            continue
        have[item.url] = existing
        recorded = True
        media_manifest.record_saved(
            manifest,
            item.url,
            existing,
            index_state.digest_for(existing),
            size=media_writer.size_of(gallery_dir / existing),
        )

    if recorded:
        media_manifest.save_manifest(gallery_dir, manifest)

    return MediaHaveOut(have=have)


@router.post("/characters/{card_id}/media/bytes", response_model=MediaBytesOut, summary="Save one already-fetched media item")
def upload_character_media_bytes(
    card_id: str,
    file: UploadFile = File(description="The media bytes, already fetched by the browser."),
    url: str = Form(description="The source URL -- the manifest's key, and a naming fallback."),
    filename: str | None = Form(default=None, description="Extractor-supplied real filename, if known."),
    prefix: str = Form(default="extgallery"),
) -> MediaBytesOut:
    """The second entry door docs/PHASE_3C_PLAN.md §6 calls for: MEGA's per-file
    AES-CTR decrypt and Pixiv's session-proxied fetch happen in the browser and
    can't move server-side, but everything downstream of having the bytes --
    sniff, WebP-normalize, dedupe, write, thumbnail, manifest -- must still run
    through the one writer, not a second bespoke path. `media_writer.finish_item`
    is exactly the download route's steps 5-10, called here with bytes instead
    of a fetch.

    One item, not a batch -- callers already fetched it one at a time (a
    `downloadFn` per extracted image) -- so a single JSON object is the whole
    response, no NDJSON framing.
    """
    idx = _shared.index()
    record = _shared.require(idx, card_id)
    folder_name, gallery_dir = _shared.gallery_dir_for_card(idx, record)

    payload = file.file.read()
    if not payload:
        raise HTTPException(status_code=422, detail="the upload has no bytes")

    manifest = media_manifest.load_manifest(gallery_dir)
    ledger = media_manifest.load_dead_ledger()
    index_state = media_writer.GalleryIndex.build(gallery_dir)

    outcome = media_writer.finish_item(
        gallery_dir,
        folder_name,
        url=url,
        filename_hint=filename,
        prefix=prefix,
        index=int(time.time() * 1000),
        index_state=index_state,
        manifest=manifest,
        ledger=ledger,
        body=payload,
        content_type=file.content_type,
        thumbnail_store=_shared.thumbnail_store,
    )

    media_manifest.save_manifest(gallery_dir, manifest)
    media_manifest.save_dead_ledger(ledger)

    return MediaBytesOut(status=outcome.status, file=outcome.file, reason=outcome.reason, bytes=outcome.bytes)


