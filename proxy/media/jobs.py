"""3C-2 -- the job runner (docs/PHASE_3C_PLAN.md §7).

`media_writer.download_item` and the manifest it writes are already correct
(3C-1); the thing that was missing was a way to run a batch of them that
doesn't die when the browser tab that started it closes. `POST
/characters/{id}/media` still exists and is still correct -- it streams
NDJSON over the request's own connection, so the run is only as long-lived as
that connection. `JobStore` runs the identical per-item loop as a detached
asyncio task instead: the request that submits a job returns immediately with
a job id, and the download keeps going on the server regardless of what the
browser does next.

One worker, not a pool. `GalleryIndex` and the manifest dict are built once
per run and mutated in place across every item in it (docs/PHASE_3C_PLAN.md
§3's "Dedup is a scandir") -- exactly the reason
`web/modules/media-download-queue.js` already runs its own jobs strictly
serially. A single background coroutine draining one queue preserves that
invariant without a lock: two jobs against the same gallery folder can never
overlap.

Job state (this module) is a live-progress cache, not a record of what
actually happened -- that's the manifest and dead ledger, written by `_run`
exactly like the synchronous route writes them. A job lost to a server
restart mid-run leaves the manifest showing whatever finished; nothing here
needs to survive a restart for the archive to stay correct.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

import httpx

from proxy.archive import thumbs
from proxy.media import manifest as media_manifest, writer as media_writer
from proxy.config import settings

logger = logging.getLogger("jai_proxy.media.jobs")

JobState = Literal["queued", "running", "done", "error", "cancelled"]


@dataclass
class MediaJob:
    id: str
    card_id: str
    prefix: str
    phase: str
    total: int
    created_at: str
    state: JobState = "queued"
    done: int = 0
    saved: int = 0
    skipped: int = 0
    errors: int = 0
    events: list[dict[str, Any]] = field(default_factory=list)
    error_message: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    cancel_requested: bool = False


class JobStore:
    """Bound to the running event loop at app startup (`bind`). `submit` is
    called from a FastAPI threadpool thread (the sync-`def` house style --
    see the module docstring in `proxy/api/v1/`) and hands the item list
    to the worker via `run_coroutine_threadsafe`; it must never be called
    from the loop's own thread, or the `.result()` wait deadlocks."""

    def __init__(self, thumbnail_store: thumbs.ThumbnailStore, max_history: int = 200) -> None:
        self._thumbnail_store = thumbnail_store
        self.max_history = max_history
        self._jobs: dict[str, MediaJob] = {}
        self._order: deque[str] = deque()
        self._queue: asyncio.Queue | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._worker_task: asyncio.Task | None = None

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        # A fresh loop means a fresh process (or, in tests, a fresh
        # TestClient lifespan) -- any prior job history belongs to a loop
        # that no longer exists, so start clean rather than leak across runs.
        self._jobs.clear()
        self._order.clear()
        self._loop = loop
        self._queue = asyncio.Queue()
        self._worker_task = loop.create_task(self._worker())

    def submit(
        self,
        gallery_dir: Path,
        folder_name: str,
        items: list[dict[str, Any]],
        prefix: str,
        phase: str,
        card_id: str,
    ) -> MediaJob:
        if self._loop is None or self._queue is None:
            raise RuntimeError("JobStore.bind() must run before the first submission")
        job = MediaJob(
            id=uuid.uuid4().hex,
            card_id=card_id,
            prefix=prefix,
            phase=phase,
            total=len(items),
            created_at=media_manifest.now_iso(),
        )
        self._jobs[job.id] = job
        self._order.append(job.id)
        self._evict_finished()
        asyncio.run_coroutine_threadsafe(
            self._queue.put((job.id, gallery_dir, folder_name, items)), self._loop
        ).result()
        return job

    def get(self, job_id: str) -> MediaJob | None:
        return self._jobs.get(job_id)

    def cancel(self, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if job is None or job.state not in ("queued", "running"):
            return False
        job.cancel_requested = True
        return True

    def list_jobs(self, *, card_id: str | None = None, active_only: bool = False) -> list[MediaJob]:
        out = [self._jobs[jid] for jid in self._order if jid in self._jobs]
        if card_id is not None:
            out = [j for j in out if j.card_id == card_id]
        if active_only:
            out = [j for j in out if j.state in ("queued", "running")]
        return out

    def _evict_finished(self) -> None:
        while len(self._order) > self.max_history:
            oldest = self._order[0]
            job = self._jobs.get(oldest)
            if job is None or job.state in ("done", "error", "cancelled"):
                self._order.popleft()
                self._jobs.pop(oldest, None)
            else:
                # Oldest entry is still active -- history grows past
                # max_history rather than evicting live progress.
                break

    async def _worker(self) -> None:
        assert self._queue is not None
        while True:
            job_id, gallery_dir, folder_name, items = await self._queue.get()
            job = self._jobs.get(job_id)
            if job is None:
                self._queue.task_done()
                continue
            job.state = "running"
            job.started_at = media_manifest.now_iso()
            try:
                await self._run(job, gallery_dir, folder_name, items)
                if job.state == "running":
                    job.state = "done"
            except Exception as exc:  # one bad job must not kill the worker
                job.state = "error"
                job.error_message = str(exc)
                logger.exception("media job %s failed", job.id)
            finally:
                job.finished_at = media_manifest.now_iso()
                self._queue.task_done()

    async def _run(self, job: MediaJob, gallery_dir: Path, folder_name: str, items: list[dict[str, Any]]) -> None:
        manifest = media_manifest.load_manifest(gallery_dir)
        ledger = media_manifest.load_dead_ledger()
        index_state = media_writer.GalleryIndex.build(gallery_dir)
        # Same scheme the synchronous route uses: a millisecond timestamp as
        # the starting file index, unique across runs with no persistent counter.
        start_index = int(time.time() * 1000)
        async with httpx.AsyncClient(
            timeout=30.0, proxy=settings.http_proxy or None, headers={"User-Agent": "Mozilla/5.0"}
        ) as client:
            for i, item in enumerate(items):
                if job.cancel_requested:
                    job.state = "cancelled"
                    break
                outcome = await media_writer.download_item(
                    client,
                    gallery_dir,
                    folder_name,
                    url=item["url"],
                    filename_hint=item.get("filename"),
                    prefix=job.prefix,
                    index=start_index + i,
                    index_state=index_state,
                    manifest=manifest,
                    ledger=ledger,
                    thumbnail_store=self._thumbnail_store,
                )
                if outcome.status == "saved":
                    job.saved += 1
                elif outcome.status == "skipped":
                    job.skipped += 1
                else:
                    job.errors += 1
                job.done += 1
                job.events.append(
                    {
                        "url": outcome.url,
                        "status": outcome.status,
                        "file": outcome.file,
                        "reason": outcome.reason,
                        "bytes": outcome.bytes,
                    }
                )

        media_manifest.append_run(
            manifest,
            {
                "at": media_manifest.now_iso(),
                "phase": job.phase,
                "saved": job.saved,
                "skipped": job.skipped,
                "errors": job.errors,
            },
        )
        media_manifest.save_manifest(gallery_dir, manifest)
        media_manifest.save_dead_ledger(ledger)
