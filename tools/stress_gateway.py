"""Real TCP WebSocket/ONNX stress test, including new PTT during emotion work.

Replays an official WAV at real-time pace; reports timing, queue, memory and
event-loop responsiveness. It does not simulate physical I2S/Wi-Fi hardware.
"""
from __future__ import annotations

import argparse
import asyncio
from collections import deque
import contextlib
import json
from pathlib import Path
import secrets
import socket
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


async def run(args):
    import numpy as np
    import psutil
    import soundfile as sf
    import uvicorn
    from websockets.asyncio.client import connect
    from voice_companion.config import Config
    from voice_companion.service import create_app

    wave, rate = sf.read(args.wav, dtype="int16")
    if rate != 16000 or wave.ndim != 1:
        raise ValueError("Use a nonempty 16kHz mono WAV")
    if args.long:
        # Repeated speech with natural pauses, still inside one held button.
        pieces = [np.concatenate((wave, np.zeros(16000, dtype="int16"))) for _ in range(8)]
        wave = np.concatenate(pieces)[:59*16000]
    pcm = wave.astype("<i2").tobytes()
    if not pcm or len(pcm)>60*32000:
        raise ValueError("Audio must be 0..60 seconds")
    config = Config(token=secrets.token_urlsafe(24), asr_threads=args.threads,
                    emotion_enabled=not args.no_emotion, allowed_devices={"perf-s3"})
    app = create_app(config)
    hub = app.state.hub
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level="error", access_log=False,
        ws="websockets", ws_max_size=8192, ws_max_queue=8, ws_per_message_deflate=False))
    server_task = asyncio.create_task(server.serve(sockets=[listener]))
    tasks = []
    try:
        async with asyncio.timeout(90):
            while not server.started:
                if server_task.done():
                    await server_task
                    raise RuntimeError("Server did not start")
                await asyncio.sleep(.05)
        if not hub.engine.ready:
            raise RuntimeError(hub.engine.error)
        if not args.no_emotion:
            async with asyncio.timeout(45):
                while hub.emotion.state == "loading":
                    await asyncio.sleep(.05)
            if hub.emotion.state != "ready":
                raise RuntimeError("Real emotion model did not become ready")
        ready, done, captions, emotions = {}, {}, {}, {}
        ping_sent, pings, jitters, memory = deque(), [], [], []
        process = psutil.Process()
        current_id = [None]
        root_url = f"ws://127.0.0.1:{port}/ws"
        async with connect(f"{root_url}/device/perf-s3?token={config.token}", compression=None) as board, connect(f"{root_url}/client/perf-s3?token={config.token}", compression=None, max_size=512*1024) as phone:
            async def receive(ws, role):
                async for raw in ws:
                    event = json.loads(raw)
                    kind, rid = event.get("type"), event.get("recording_id")
                    if kind == "error":
                        raise RuntimeError(f"Gateway error: {event.get('code')}")
                    if kind == "record_ready" and role == "board" and rid in ready:
                        ready[rid].set_result(time.perf_counter())
                    if kind == "recording_done" and role == "board" and rid in done:
                        done[rid].set_result(event)
                    if kind == "transcript" and event.get("final"):
                        captions[(role,rid,event["segment_id"])] = event["text"]
                    if kind == "emotion" and role == "board":
                        emotions[(rid,event["segment_id"])] = event
                    if kind == "pong" and role == "phone" and ping_sent:
                        pings.append((time.perf_counter()-ping_sent.popleft())*1000)
            async def probe():
                while True:
                    ping_sent.append(time.perf_counter())
                    await phone.send('{"type":"ping"}')
                    await asyncio.sleep(.2)
            async def monitor():
                next_memory = 0.0
                child = psutil.Process(hub.emotion.process.pid) if hub.emotion.process else None
                while True:
                    before = time.perf_counter()
                    await asyncio.sleep(.01)
                    jitters.append(max(0,(time.perf_counter()-before-.01)*1000))
                    if time.perf_counter() >= next_memory:
                        # Avoid system-wide process enumeration in a 100Hz probe:
                        # measuring performance must not become the main workload.
                        child_rss = child.memory_info().rss if child and child.is_running() else 0
                        memory.append((time.perf_counter(),process.memory_info().rss/1024/1024,child_rss/1024/1024))
                        next_memory = time.perf_counter()+.25
            tasks = [asyncio.create_task(receive(board,"board")),asyncio.create_task(receive(phone,"phone")),asyncio.create_task(probe()),asyncio.create_task(monitor())]
            await board.send('{"type":"hello","protocol":1}')
            cpu_before = process.cpu_times()
            wall_before = time.perf_counter()
            rounds = []
            for _ in range(args.rounds):
                rid = "perf-"+uuid.uuid4().hex
                current_id[0] = rid
                ready[rid] = asyncio.get_running_loop().create_future()
                done[rid] = asyncio.get_running_loop().create_future()
                request_at = time.perf_counter()
                await board.send(json.dumps({"type":"record_start","recording_id":rid}))
                ack_at = await asyncio.wait_for(ready[rid],5)
                start = time.perf_counter()
                for offset in range(0,len(pcm),640):
                    for task in tasks:
                        if task.done():
                            await task
                    await board.send(pcm[offset:offset+640])
                    await asyncio.sleep(max(0,start+min(offset+640,len(pcm))/32000-time.perf_counter()))
                await board.send(json.dumps({"type":"record_stop","recording_id":rid}))
                result = await asyncio.wait_for(done[rid],15)
                rounds.append({"ready_ms":round((ack_at-request_at)*1000,1),"final_ms":result["final_latency_ms"],
                    "first_partial_ms":result.get("first_partial_ms"),
                    "segments":result["segments"],"queue_peak_ms":result.get("audio_queue_peak_ms"),"worker_calls":result.get("worker_calls")})
                print(json.dumps(rounds[-1]),flush=True)
                # Intentionally let analysis start, then interrupt it with new PTT.
                await asyncio.sleep(.05)
            cpu_after = process.cpu_times()
            paced_cpu = ((cpu_after.user+cpu_after.system)-(cpu_before.user+cpu_before.system))/(time.perf_counter()-wall_before)*100
            if not args.no_emotion:
                count = sum(item["segments"] for item in rounds)
                async with asyncio.timeout(45):
                    while len(emotions) < count:
                        for task in tasks:
                            if task.done():
                                await task
                        await asyncio.sleep(.05)
            await asyncio.sleep(.2)
            left = {(rid,seg):text for (role,rid,seg),text in captions.items() if role=="board"}
            right = {(rid,seg):text for (role,rid,seg),text in captions.items() if role=="phone"}
            assert left == right and left, "Subscribers did not converge on final text"
            assert all(item["segments"] for item in rounds), "An entire real utterance was lost"
            if args.expected_text:
                assert all(text == args.expected_text for text in left.values()), f"Transcription changed: {list(left.values())}"
            results = {"audio_ms_per_round":len(pcm)/32,"rounds":rounds,"emotion_enabled":not args.no_emotion,
                "threads":args.threads,"same_final_on_both_clients":True,"completed_emotions":len(emotions),
                "texts":list(left.values()),
                "parent_cpu_one_core_pct":round(paced_cpu,1),
                "ping_p95_ms":round(float(np.percentile(pings,95)),1),"ping_max_ms":round(max(pings),1),
                "event_loop_jitter_p95_ms":round(float(np.percentile(jitters,95)),1),"event_loop_jitter_max_ms":round(max(jitters),1),
                "parent_rss_start_mib":round(memory[0][1],1),"parent_rss_end_mib":round(memory[-1][1],1),
                "parent_rss_max_mib":round(max(item[1] for item in memory),1),"emotion_rss_max_mib":round(max(item[2] for item in memory),1),
                "source":"real TCP WebSockets and local ONNX; no physical board or phone"}
            args.output.parent.mkdir(parents=True,exist_ok=True)
            args.output.write_text(json.dumps(results,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
            print(json.dumps(results,ensure_ascii=False,indent=2))
    finally:
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks,return_exceptions=True)
        server.should_exit = True
        await asyncio.wait_for(server_task,15)
        listener.close()


if __name__ == "__main__":
    if hasattr(sys.stdout,"reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wav",type=Path,default=ROOT/"models/_samples/asr_example.wav")
    parser.add_argument("--rounds",type=int,default=5)
    parser.add_argument("--threads",type=int,default=3)
    parser.add_argument("--no-emotion",action="store_true")
    parser.add_argument("--long",action="store_true")
    parser.add_argument("--expected-text",default="")
    parser.add_argument("--output",type=Path,default=ROOT/".local/gateway-stress.json")
    asyncio.run(run(parser.parse_args()))
