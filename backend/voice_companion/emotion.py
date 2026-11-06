from __future__ import annotations

import asyncio
import contextlib
import multiprocessing as mp
import os
import queue
from pathlib import Path
from typing import Callable


def _worker(root: str, requests, responses) -> None:
    """Separate, low-priority, one-thread ORT process; no torch or cloud."""
    os.environ["OMP_NUM_THREADS"] = "1"
    os.environ["OPENBLAS_NUM_THREADS"] = "1"
    os.environ["MKL_NUM_THREADS"] = "1"
    import psutil

    current = psutil.Process()
    with contextlib.suppress(psutil.Error, OSError):
        current.nice(psutil.BELOW_NORMAL_PRIORITY_CLASS if os.name == "nt" else 10)
    try:
        from .models import EmotionRecognizer
        model = EmotionRecognizer(Path(root), threads=1)
        responses.put((None, {"worker_state": "ready"}))
    except Exception as exc:
        responses.put((None, {"worker_state": "error", "error": type(exc).__name__}))
        return
    while True:
        item = requests.get()
        if item is None:
            return
        key, pcm = item
        try:
            result = model.analyze(pcm)
            result["status"] = "ready"
        except Exception as exc:
            result = {"label": "unknown", "event": "unknown", "status": "error", "error": type(exc).__name__}
        responses.put((key, result))


class EmotionService:
    def __init__(self, model_root: Path, enabled: bool):
        self.model_root = model_root
        self.enabled = enabled
        self.state = "disabled" if not enabled else "loading"
        self.process = None
        self.monitor = None
        self.busy = False
        self.suspended = False
        self.pending: list[tuple[tuple[str, str, int], bytes]] = []
        self.active_key = None
        self.callback: Callable | None = None
        self.requests = self.responses = None
        self.closing = False

    def start(self, callback: Callable) -> None:
        self.callback = callback
        if not self.enabled:
            return
        context = mp.get_context("spawn")
        self.requests = context.Queue(maxsize=1)
        self.responses = context.Queue(maxsize=4)
        self.process = context.Process(target=_worker, args=(str(self.model_root), self.requests, self.responses), daemon=True, name="sensevoice-emotion")
        self.process.start()
        self.monitor = asyncio.create_task(self._monitor())

    def set_asr_busy(self, busy: bool) -> None:
        self.busy = busy
        if not self.process or not self.process.is_alive():
            return
        # Preempt only our isolated analysis child, never the ASR process. This is
        # important on four-core laptops: a new PTT must not wait for an SER clip.
        import psutil
        try:
            process = psutil.Process(self.process.pid)
            if busy and not self.suspended:
                process.suspend()
                self.suspended = True
            elif not busy and self.suspended:
                process.resume()
                self.suspended = False
        except (psutil.Error, OSError):
            # If platform cannot preempt, below-normal priority + 1 ORT thread still
            # limits interference. Do not fail recording for an optional feature.
            pass
        if not busy:
            self._dispatch()

    def enqueue(self, key: tuple[str, str, int], pcm: bytes) -> bool:
        if not self.enabled or self.state == "error":
            return False
        if len(self.pending) >= 12:
            return False
        self.pending.append((key, pcm))
        self._dispatch()
        return True

    def _dispatch(self) -> None:
        if self.closing or self.busy or self.active_key is not None or self.state != "ready" or not self.pending:
            return
        item = self.pending.pop(0)
        try:
            self.requests.put_nowait(item)
            self.active_key = item[0]
        except queue.Full:
            self.pending.insert(0, item)

    async def _monitor(self) -> None:
        while True:
            await asyncio.sleep(.05)
            try:
                while True:
                    key, result = self.responses.get_nowait()
                    if key is None:
                        self.state = result.get("worker_state", "error")
                        if self.state == "error":
                            for queued_key, _ in self.pending:
                                await self.callback(queued_key, {"label": "unknown", "event": "unknown", "status": "error"})
                            self.pending.clear()
                    else:
                        self.active_key = None
                        await self.callback(key, result)
            except queue.Empty:
                pass
            if not self.process.is_alive() and self.state != "error":
                self.state = "error"
                if self.active_key is not None:
                    await self.callback(self.active_key, {"label": "unknown", "event": "unknown", "status": "error"})
                    self.active_key = None
                for key, _ in self.pending:
                    await self.callback(key, {"label": "unknown", "event": "unknown", "status": "error"})
                self.pending.clear()
            self._dispatch()

    async def close(self) -> None:
        self.closing = True
        self.pending.clear()
        if self.monitor:
            self.monitor.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.monitor
        if self.process:
            self.set_asr_busy(False)
            if self.process.is_alive():
                self.process.terminate()
            await asyncio.to_thread(self.process.join, 3)
            if self.process.is_alive():
                self.process.kill()
                await asyncio.to_thread(self.process.join, 1)
            # A terminated consumer may leave a partially written PCM buffer.
            # Never let multiprocessing's feeder-thread join hang shutdown.
            self.requests.cancel_join_thread()
            self.responses.cancel_join_thread()
            self.requests.close()
            self.responses.close()
