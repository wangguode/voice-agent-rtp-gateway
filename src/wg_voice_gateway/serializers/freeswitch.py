"""
FreeSWITCH 音频流协议序列化器 (FreeSwitchAudioSerializer)

面向企业级电话外呼/呼入中心场景（对接 FreeSWITCH `mod_audio_stream` 或 Java RTP-WS Bridge）：
    1. 支持两种传输模式：
       - 二进制帧 (Binary PCM/PCMU)：直接收发 8kHz 16-bit 线性 PCM 或 G.711 μ-law 原始音频帧（超低开销）
       - JSON 事件帧 (JSON Media Event)：兼容 `{ "event": "media", "media": { "payload": "<base64>" } }`
         以及 DTMF 按键帧 `{ "event": "dtmf", "dtmf": { "digit": "1" } }`
    2. 内置双向上采样/下采样流式重采样器（8kHz PSTN ⇄ 16kHz AI 管道）
    3. 毫秒级打断联动：当管道内产生 `InterruptionFrame` 时，立即向 FreeSWITCH 下发
       `{"event": "clearAudio", "callUuid": ...}` 指令，瞬間清空 PBX 侧下行播放缓冲区！
"""
from __future__ import annotations

import base64
import json
from typing import Literal

from loguru import logger
from pydantic import BaseModel

from pipecat.audio.dtmf.types import KeypadEntry
from pipecat.audio.utils import create_stream_resampler, pcm_to_ulaw, ulaw_to_pcm
from pipecat.frames.frames import (
    AudioRawFrame,
    CancelFrame,
    EndFrame,
    Frame,
    InputAudioRawFrame,
    InputDTMFFrame,
    InterruptionFrame,
)
from pipecat.processors.frame_processor import FrameProcessorSetup
from pipecat.serializers.base_serializer import FrameSerializer


class FreeSwitchAudioSerializer(FrameSerializer):
    """对接 FreeSWITCH 实时音频流与打断控制指令的双向序列化器。"""

    class InputParams(FrameSerializer.InputParams):
        """FreeSWITCH 序列化配置参数。

        Parameters:
            freeswitch_sample_rate: FreeSWITCH 侧采样率，PSTN 电话线默认 8000Hz。
            pipeline_sample_rate: AI 管道内部采样率，默认 16000Hz（适配 SileroVAD 与 SenseVoice）。
            encoding: 音频编码格式，支持 ``"pcm16"`` (L16 原始字节) 或 ``"pcmu"`` (G.711 μ-law)。
            wire_mode: 传输封装格式，``"json"``（JSON + Base64）或 ``"binary"``（纯二进制音频流 + 文本控制帧）。
        """

        freeswitch_sample_rate: int = 8000
        pipeline_sample_rate: int = 16000
        encoding: Literal["pcm16", "pcmu"] = "pcm16"
        wire_mode: Literal["json", "binary"] = "json"

    def __init__(
        self,
        call_uuid: str = "fs-call-default",
        params: InputParams | None = None,
        **kwargs,
    ):
        params = params or FreeSwitchAudioSerializer.InputParams()
        super().__init__(params, **kwargs)
        self._params: FreeSwitchAudioSerializer.InputParams = params
        self._call_uuid = call_uuid
        self._fs_rate = self._params.freeswitch_sample_rate
        self._pipe_rate = self._params.pipeline_sample_rate

        # 独立维护上行（8k -> 16k）与下行（24k/16k -> 8k）流式重采样器
        self._in_resampler = create_stream_resampler(
            clear_after_secs=self._params.resampler_clear_after_secs
        )
        self._out_resampler = create_stream_resampler(
            clear_after_secs=self._params.resampler_clear_after_secs
        )
        self._interruption_count = 0

    @property
    def interruption_count(self) -> int:
        return self._interruption_count

    async def setup(self, setup: FrameProcessorSetup):
        if setup.audio_in_sample_rate:
            self._pipe_rate = setup.audio_in_sample_rate

    async def serialize(self, frame: Frame) -> str | bytes | None:
        """将管道内部帧序列化为发往 FreeSWITCH 的报文。"""
        if self.should_ignore_frame(frame):
            return None

        # 1. 毫秒级打断核心：一旦检测到用户插话产生 InterruptionFrame，立即通知 FreeSWITCH 清空播放缓冲
        if isinstance(frame, InterruptionFrame):
            self._interruption_count += 1
            clear_msg = {
                "event": "clearAudio",
                "callUuid": self._call_uuid,
                "seq": self._interruption_count,
                "reason": "user_barge_in",
            }
            logger.info(f"⚡ [FreeSWITCH Barge-in] 下发清空下行音频缓冲指令: {clear_msg}")
            return json.dumps(clear_msg, ensure_ascii=False)

        # 2. 会话结束通知
        if isinstance(frame, (EndFrame, CancelFrame)):
            return json.dumps(
                {"event": "hangup", "callUuid": self._call_uuid},
                ensure_ascii=False,
            )

        # 3. 下行 TTS 音频流：重采样至 8kHz 并按需编码为 PCM16 或 G.711 μ-law
        if isinstance(frame, AudioRawFrame):
            pcm_bytes = frame.audio
            if self._params.encoding == "pcmu":
                out_bytes = await pcm_to_ulaw(
                    pcm_bytes, frame.sample_rate, self._fs_rate, self._out_resampler
                )
            else:
                out_bytes = await self._out_resampler.resample(
                    pcm_bytes, frame.sample_rate, self._fs_rate
                )

            if not out_bytes:
                return None

            if self._params.wire_mode == "binary":
                return out_bytes

            return json.dumps(
                {
                    "event": "media",
                    "callUuid": self._call_uuid,
                    "media": {
                        "sampleRate": self._fs_rate,
                        "encoding": self._params.encoding,
                        "payload": base64.b64encode(out_bytes).decode("ascii"),
                    },
                }
            )

        return None

    async def deserialize(self, data: str | bytes) -> Frame | None:
        """将来自 FreeSWITCH 的二进制 RTP 载荷或 JSON 报文反序列化为 Pipecat 音频/按键帧。"""
        # 模式 A：直接收到二进制音频流（如 mod_audio_stream binary 模式或 Java Netty Bridge）
        if isinstance(data, (bytes, bytearray)):
            raw_bytes = bytes(data)
            if self._params.encoding == "pcmu":
                pcm_16k = await ulaw_to_pcm(
                    raw_bytes, self._fs_rate, self._pipe_rate, self._in_resampler
                )
            else:
                pcm_16k = await self._in_resampler.resample(
                    raw_bytes, self._fs_rate, self._pipe_rate
                )
            if not pcm_16k:
                return None
            return InputAudioRawFrame(
                audio=pcm_16k, num_channels=1, sample_rate=self._pipe_rate
            )

        # 模式 B：JSON 控制与媒体事件
        try:
            msg = json.loads(data)
        except json.JSONDecodeError:
            logger.warning(f"无法解析 FreeSWITCH JSON 报文: {data[:80]!r}")
            return None

        event = msg.get("event")
        if event == "start":
            self._call_uuid = msg.get("callUuid", self._call_uuid)
            logger.info(f"📞 [FreeSWITCH Call Start] callUuid={self._call_uuid}")
            return None

        if event == "media":
            b64 = msg.get("media", {}).get("payload")
            if not b64:
                return None
            raw = base64.b64decode(b64)
            if self._params.encoding == "pcmu":
                pcm_16k = await ulaw_to_pcm(
                    raw, self._fs_rate, self._pipe_rate, self._in_resampler
                )
            else:
                pcm_16k = await self._in_resampler.resample(
                    raw, self._fs_rate, self._pipe_rate
                )
            if not pcm_16k:
                return None
            return InputAudioRawFrame(
                audio=pcm_16k, num_channels=1, sample_rate=self._pipe_rate
            )

        if event == "dtmf":
            digit = str(msg.get("dtmf", {}).get("digit", ""))
            try:
                return InputDTMFFrame(KeypadEntry(digit))
            except ValueError:
                return None

        return None
