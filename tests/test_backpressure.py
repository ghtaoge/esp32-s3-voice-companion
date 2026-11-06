import asyncio

from voice_companion.config import Config
from voice_companion.service import Hub, Peer, Recording
from test_service import TestEmotion, TestEngine


class Socket:
    def __init__(self):
        self.closed = False
    async def close(self, **kwargs):
        self.closed = True


def test_audio_backlog_is_bounded_by_duration_not_only_packet_count(tmp_path):
    async def scenario():
        config = Config(root=tmp_path, audio_queue_frames=1)
        hub = Hub(config, engine=TestEngine(), emotion=TestEmotion())
        device = await hub.device("esp32-s3")
        peer = Peer(Socket(), "esp32-s3", "device", asyncio.Queue(8))
        hub.peers.add(peer)
        device.peer = peer
        recording = Recording("esp32-s3", "backlog", peer, asyncio.Queue(8))
        hub.active = recording
        await hub.on_audio(peer, bytes(640))
        # One large packet must not bypass the configured 20ms backlog ceiling.
        await hub.on_audio(peer, bytes(1280))
        assert hub.active is None
        event = peer.queue.get_nowait()
        assert event["type"] == "error" and event["code"] == "audio_overload"
        assert recording.queue.qsize() == 1
        await hub.close()
    asyncio.run(scenario())


def test_slow_subscriber_is_disconnected_without_blocking_publisher():
    async def scenario():
        socket = Socket()
        peer = Peer(socket, "esp32-s3", "client", asyncio.Queue(1))
        assert peer.send({"type": "transcript", "text": "第一句"})
        assert not peer.send({"type": "transcript", "text": "第二句"})
        await asyncio.sleep(0)
        assert socket.closed and not peer.alive
    asyncio.run(scenario())
