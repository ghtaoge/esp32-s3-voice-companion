import asyncio

from voice_companion.config import Config
from voice_companion.service import Hub, Peer, Recording
from test_service import TestEmotion, TestEngine


class Socket:
    async def close(self, **kwargs):
        pass


def test_old_cancellation_cannot_resume_emotion_or_overwrite_new_state(tmp_path):
    async def scenario():
        engine, emotion = TestEngine(), TestEmotion()
        hub = Hub(Config(root=tmp_path), engine=engine, emotion=emotion)
        await hub.start()
        device = await hub.device("esp32-s3")
        peer = Peer(Socket(), "esp32-s3", "device", asyncio.Queue(32))
        hub.peers.add(peer)
        device.peer = peer
        old = Recording("esp32-s3", "old", peer, asyncio.Queue(8))
        hub.active = old
        device.state, device.recording_id = "recording", "old"
        cancelled, resume = asyncio.Event(), asyncio.Event()
        async def old_worker():
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.set()
                await resume.wait()
                raise
        old.task = asyncio.create_task(old_worker())
        await asyncio.sleep(0)
        cancelling = asyncio.create_task(hub.abort(old,"cancelled","cancelled"))
        await cancelled.wait()
        await hub.record_start(peer,{"recording_id":"new"})
        new = hub.active
        assert new and emotion.busy
        resume.set()
        await cancelling
        assert hub.active is new and emotion.busy
        assert device.state == "recording" and device.recording_id == "new"
        await hub.close()
    asyncio.run(scenario())
