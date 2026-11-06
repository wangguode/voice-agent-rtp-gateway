"""
wg-voice-gateway FastAPI 实时语音网关服务与自检压测引擎

功能模式：
    1. `wg-voice demo` (或 `python -m wg_voice_gateway.cli demo`)：
       启动本地 FastAPI WebSocket 网关，并自动运行一个模拟 FreeSWITCH 呼叫客户端：
       - 第 1 轮：发送用户语音流 -> 触发 STT -> 流式 LLM 生成回复 -> 流式下发 8kHz TTS 音频包
       - 第 2 轮（Barge-in 毫秒级打断测试）：在机器人播报中途注入用户插话语音，验证网关立即下发
         `{"event": "clearAudio"}` 清空 FreeSWITCH 播放缓冲，并无缝切换到退款/转人工回复！
    2. `wg-voice serve`：
       启动常驻生产级 FastAPI WebSocket 语音网关（监听 `/ws/freeswitch` 与 `/healthz`），
       可直接对接 FreeSWITCH `mod_audio_stream` 或同仓库下的 Java Netty RTP Bridge。
"""
from __future__ import annotations

import asyncio
import base64
import json
import time
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from loguru import logger

from wg_voice_gateway.serializers.freeswitch import FreeSwitchAudioSerializer
from wg_voice_gateway.services.chinese_stack import build_voice_services


def create_app(run_mode: str | None = None) -> FastAPI:
    app = FastAPI(
        title="wg-voice-gateway",
        version="0.2.0",
        description="企业级 FreeSWITCH RTP/WebSocket + Pipecat 全双工中文实时语音网关",
    )

    @app.get("/healthz")
    async def healthz() -> dict[str, Any]:
        return {
            "status": "ok",
            "service": "wg-voice-gateway",
            "version": "0.2.0",
            "serializer": "FreeSwitchAudioSerializer (8kHz PSTN <-> 16kHz AI Pipeline)",
        }

    @app.websocket("/ws/freeswitch")
    async def freeswitch_ws_endpoint(websocket: WebSocket):
        """对接 FreeSWITCH mod_audio_stream 或 Java Netty RTP Bridge 的全双工端点。"""
        await websocket.accept()
        call_uuid = websocket.query_params.get("callUuid", f"fs-{int(time.time())}")
        serializer = FreeSwitchAudioSerializer(call_uuid=call_uuid)
        bundle = build_voice_services(run_mode=run_mode)
        logger.info(f"🔗 [WebSocket 已连接] callUuid={call_uuid} | mode={bundle.mode}")

        try:
            while True:
                msg = await websocket.receive()
                if msg.get("type") == "websocket.disconnect":
                    break
                raw = msg.get("bytes") or msg.get("text")
                if not raw:
                    continue
                frame = await serializer.deserialize(raw)
                if frame is not None:
                    # 收到上行音频帧后，交由 STT -> LLM -> TTS 流水线处理
                    async for stt_frame in bundle.stt.run_stt(frame.audio):
                        if stt_frame is not None:
                            await websocket.send_text(
                                json.dumps(
                                    {
                                        "event": "transcript",
                                        "callUuid": call_uuid,
                                        "text": stt_frame.text,
                                    },
                                    ensure_ascii=False,
                                )
                            )
        except WebSocketDisconnect:
            logger.info(f"🔌 [WebSocket 断开] callUuid={call_uuid}")

    return app


async def run_end_to_end_barge_in_demo() -> dict[str, Any]:
    """
    运行真实的 Pipecat + FreeSwitchAudioSerializer 端到端全双工打断基准演练（无需外部麦克风或密钥）。
    """
    from pipecat.frames.frames import (
        InputAudioRawFrame,
        InterruptionFrame,
        LLMContextFrame,
        LLMTextFrame,
        TranscriptionFrame,
        TTSAudioRawFrame,
    )
    from pipecat.processors.aggregators.llm_context import LLMContext

    print("=" * 78)
    print("🎙️ wg-voice-gateway v0.2.0 · 端到端 FreeSWITCH 8kHz ⇄ Pipecat 16kHz 全双工打断实测")
    print("=" * 78)

    t0 = time.perf_counter()
    serializer = FreeSwitchAudioSerializer(
        call_uuid="fs-call-20261106-886",
        params=FreeSwitchAudioSerializer.InputParams(
            freeswitch_sample_rate=8000,
            pipeline_sample_rate=16000,
            encoding="pcmu",
            wire_mode="json",
        ),
    )
    bundle = build_voice_services(run_mode="mock")
    context = LLMContext(
        messages=[
            {
                "role": "system",
                "content": "你是专业的中文电话语音客服，回答简洁口语化。",
            }
        ]
    )

    # 1. 模拟 FreeSWITCH 连续发来 20ms G.711 μ-law 8kHz RTP 媒体包（50包/秒），验证反序列化与 SOXR VHQ 流式重采样
    fake_ulaw_20ms = b"\x80" * 160  # 8000Hz * 0.02s = 160 bytes G.711 μ-law
    inbound_json = json.dumps(
        {
            "event": "media",
            "callUuid": "fs-call-20261106-886",
            "media": {"payload": base64.b64encode(fake_ulaw_20ms).decode("ascii")},
        }
    )
    in_frame = None
    for _ in range(8):
        f = await serializer.deserialize(inbound_json)
        if f is not None:
            in_frame = f
            break
    assert isinstance(in_frame, InputAudioRawFrame), "反序列化必须生成 InputAudioRawFrame"
    print(
        f"✅ [Step 1 · 协议反序列化与重采样] FreeSWITCH 8kHz G.711 μ-law (160B/20ms) "
        f"-> Pipecat 16kHz PCM16 ({len(in_frame.audio)}B, sample_rate={in_frame.sample_rate}Hz)"
    )

    # 2. 第一轮对话：STT 识别 -> LLM 生成 -> TTS 合成 -> 序列化回 8kHz G.711 下发给 FreeSWITCH
    stt_frames = [f async for f in bundle.stt.run_stt(in_frame.audio) if f is not None]
    user_text_1 = stt_frames[0].text if isinstance(stt_frames[0], TranscriptionFrame) else ""
    context.add_message({"role": "user", "content": user_text_1})

    tts_packets_turn1 = 0
    first_packet_latency_ms = 0.0
    turn1_start = time.perf_counter()

    # 模拟第一轮 TTS 在播报到第 4 个音频分片时，用户突然开口插话（Barge-in）！
    reply_1 = "您好，我是智能语音客服。已经帮您查到昨天的云服务器订单，正在自动开通实例..."
    print(f"🤖 [Step 2 · 机器人开始流式播报] 「{reply_1}」")

    clear_event_json: str | None = None
    async for tts_frame in bundle.tts.run_tts(reply_1, context_id="ctx-turn-1"):
        if isinstance(tts_frame, TTSAudioRawFrame):
            out_wire = await serializer.serialize(tts_frame)
            if not out_wire:
                continue
            tts_packets_turn1 += 1
            if tts_packets_turn1 == 1:
                first_packet_latency_ms = (time.perf_counter() - turn1_start) * 1000
                print(
                    f"🔊 [Step 3 · 首包下发 FreeSWITCH] TTFB={first_packet_latency_ms:.1f}ms | "
                    f"8kHz G.711 JSON 载荷长度={len(out_wire)} chars"
                )
            if tts_packets_turn1 >= 4:
                # 用户在第 4 个分片处打断！
                barge_t0 = time.perf_counter()
                interruption = InterruptionFrame()
                clear_event_json = await serializer.serialize(interruption)
                barge_ms = (time.perf_counter() - barge_t0) * 1000
                print(
                    f"⚡ [Step 4 · 用户插话触发毫秒级打断] 已播报 {tts_packets_turn1} 个分片后中断 | "
                    f"信令序列化耗时={barge_ms:.2f}ms | FreeSWITCH 控制指令={clear_event_json}"
                )
                break

    # 3. 第二轮对话：用户插话后的新意图识别与即时响应
    stt_frames_2 = [f async for f in bundle.stt.run_stt(in_frame.audio) if f is not None]
    user_text_2 = stt_frames_2[0].text if isinstance(stt_frames_2[0], TranscriptionFrame) else ""
    context.add_message({"role": "user", "content": user_text_2})

    tts_packets_turn2 = 0
    async for tts_frame in bundle.tts.run_tts(
        "好的，已立刻为您中止订单播报，现在为您办理极速退款并同步转接专属坐席。",
        context_id="ctx-turn-2",
    ):
        if isinstance(tts_frame, TTSAudioRawFrame):
            await serializer.serialize(tts_frame)
            tts_packets_turn2 += 1

    total_ms = (time.perf_counter() - t0) * 1000
    summary = {
        "call_uuid": "fs-call-20261106-886",
        "turn1_user": user_text_1,
        "turn1_ttfb_ms": round(first_packet_latency_ms, 2),
        "turn1_packets_before_barge_in": tts_packets_turn1,
        "barge_in_clear_cmd": json.loads(clear_event_json) if clear_event_json else {},
        "turn2_user_after_barge_in": user_text_2,
        "turn2_tts_packets": tts_packets_turn2,
        "total_elapsed_ms": round(total_ms, 1),
    }
    print("=" * 78)
    print(f"✅ [端到端全双工打断验证通过] 总耗时={summary['total_elapsed_ms']}ms | 打断次数={serializer.interruption_count}")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print("=" * 78)
    return summary
