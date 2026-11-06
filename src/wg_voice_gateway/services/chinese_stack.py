"""
中文语音与大模型服务组装器（支持 Cloud 生产模式 + Mock 零配置开箱体验模式）

核心特性：
    - 生产模式 (`RUN_MODE=cloud`)：直接调用 Pipecat 原生服务栈
      * LLM: `DeepSeekLLMService` (自动关闭 thinking 降低首包延迟) / `QwenLLMService` (通义千问) / `OpenAILLMService`
      * STT: `FunASRSTTService` (阿里 SenseVoiceSmall 本地中文语音识别) / `DeepgramSTTService`
      * TTS: `MiniMaxHttpTTSService` (海螺流式中文语音) / `KokoroTTSService`
    - 离线演示模式 (`RUN_MODE=mock`)：无需任何 API Key，内置真实 Pipecat FrameProcessor 子类，
      驱动完整的 `VAD -> STT -> LLMContext -> Streaming LLM -> Streaming PCM TTS -> Interruption` 闭环！
"""
from __future__ import annotations

import asyncio
import math
import os
from collections.abc import AsyncGenerator
from dataclasses import dataclass

import numpy as np
from loguru import logger

from pipecat.frames.frames import (
    Frame,
    InterruptionFrame,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.llm_service import LLMService
from pipecat.services.settings import LLMSettings, STTSettings, TTSSettings
from pipecat.services.stt_service import SegmentedSTTService
from pipecat.services.tts_service import TTSService
from pipecat.transcriptions.language import Language
from pipecat.utils.time import time_now_iso8601


# ---------------------------------------------------------------------------
# 1. 零配置离线演示服务（100% 遵循 Pipecat FrameProcessor 规范，支持真实打断！）
# ---------------------------------------------------------------------------


class ZeroKeyChineseSTTService(SegmentedSTTService):
    """零配置中文语音识别服务（在 VAD 切分出语音段后输出中文转写帧）。"""

    def __init__(self, scripted_utterances: list[str] | None = None, **kwargs):
        super().__init__(settings=STTSettings(model="sensevoice-mock", language=Language.ZH), **kwargs)
        self._utterances = scripted_utterances or [
            "你好，我想查一下昨天下的云服务器订单状态。",
            "不用查物流了，直接帮我转人工客服或者办理退款吧！",
        ]
        self._turn_idx = 0

    def can_generate_metrics(self) -> bool:
        return True

    async def run_stt(self, audio: bytes) -> AsyncGenerator[Frame | None, None]:
        await self.start_processing_metrics()
        await asyncio.sleep(0.04)  # 模拟本地 SenseVoice 40ms 极速推理
        text = self._utterances[self._turn_idx % len(self._utterances)]
        self._turn_idx += 1
        await self.stop_processing_metrics()
        logger.info(f"🎙️ [STT 识别完成] 用户说: 「{text}」 (音频字节={len(audio)})")
        yield TranscriptionFrame(
            text=text,
            user_id=self._user_id or "pstn-caller",
            timestamp=time_now_iso8601(),
            language=Language.ZH,
        )


class ZeroKeyChineseLLMService(LLMService):
    """零配置流式中文大模型服务（支持流式 Token 吐字与 InterruptionFrame 实时打断中止）。"""

    def __init__(self, **kwargs):
        super().__init__(settings=LLMSettings(model="deepseek-v3-voice-mock"), **kwargs)
        self._interrupted = False

    def can_generate_metrics(self) -> bool:
        return True

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        if isinstance(frame, InterruptionFrame):
            self._interrupted = True
        await super().process_frame(frame, direction)

        if isinstance(frame, LLMContextFrame):
            self._interrupted = False
            messages = frame.context.get_messages()
            last_user = next(
                (m.get("content", "") for m in reversed(messages) if m.get("role") == "user"),
                "",
            )
            await self.push_frame(LLMFullResponseStartFrame())
            await self.start_processing_metrics()
            await self.start_ttfb_metrics()

            if "退款" in str(last_user) or "人工" in str(last_user):
                reply = "好的，已立刻为您中止订单播报，现在为您办理极速退款并同步转接专属坐席。"
            else:
                reply = (
                    "您好，我是智能语音客服。已经帮您查到昨天的云服务器订单，"
                    "订单尾号八八六，当前正在自动开通实例，预计三分钟后交付完成。"
                )

            first = True
            for chunk in reply:
                if self._interrupted:
                    logger.warning("⚡ [LLM 流式生成被用户插话打断] 立即停止后续 Token 输出！")
                    break
                await asyncio.sleep(0.015)
                if first:
                    await self.stop_ttfb_metrics()
                    first = False
                await self._push_llm_text(chunk)

            await self.stop_processing_metrics()
            await self.push_frame(LLMFullResponseEndFrame())
        else:
            await self.push_frame(frame, direction)


class ZeroKeyChineseTTSService(TTSService):
    """零配置流式语音合成服务（将句子合成为 16kHz PCM 正弦语音包络流，支持毫秒级打断）。"""

    def __init__(self, sample_rate: int = 16000, **kwargs):
        super().__init__(
            sample_rate=sample_rate,
            settings=TTSSettings(model="minimax-speech-mock", voice="Calm_Woman", language=Language.ZH),
            **kwargs,
        )

    def can_generate_metrics(self) -> bool:
        return True

    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame | None, None]:
        await self.start_ttfb_metrics()
        await self.start_tts_usage_metrics(text)
        sr = self.sample_rate or 16000
        # 每个汉字生成 40ms 的 440Hz 语音包络，方便在管道和 WebSocket 侧观察流式音频帧与打断效果
        chunk_samples = int(sr * 0.04)
        t = np.arange(chunk_samples, dtype=np.float32) / sr
        tone = (0.25 * np.sin(2 * math.pi * 440.0 * t) * 32767).astype(np.int16).tobytes()

        first = True
        for _ in range(max(3, min(len(text), 12))):
            await asyncio.sleep(0.025)
            if first:
                await self.stop_ttfb_metrics()
                first = False
            yield TTSAudioRawFrame(
                audio=tone,
                sample_rate=sr,
                num_channels=1,
                context_id=context_id,
            )


# ---------------------------------------------------------------------------
# 2. 生产级工厂：根据环境变量自动装配 Cloud 或 Mock 服务栈
# ---------------------------------------------------------------------------


@dataclass
class VoiceServiceBundle:
    stt: SegmentedSTTService
    llm: LLMService
    tts: TTSService
    mode: str


def build_voice_services(run_mode: str | None = None) -> VoiceServiceBundle:
    """根据环境变量组装 STT / LLM / TTS 三大组件。"""
    mode = (run_mode or os.getenv("RUN_MODE", "mock")).lower()
    if mode == "mock":
        logger.info("🧪 当前运行在 RUN_MODE=mock（零配置开箱体验模式，无需 API Key）")
        return VoiceServiceBundle(
            stt=ZeroKeyChineseSTTService(),
            llm=ZeroKeyChineseLLMService(),
            tts=ZeroKeyChineseTTSService(),
            mode="mock",
        )

    # --- 生产云端模式 (RUN_MODE=cloud) ---
    llm_provider = os.getenv("LLM_PROVIDER", "deepseek").lower()
    if llm_provider == "deepseek":
        from pipecat.services.deepseek.llm import DeepSeekLLMService, DeepSeekThinkingConfig

        llm = DeepSeekLLMService(
            api_key=os.environ["DEEPSEEK_API_KEY"],
            settings=DeepSeekLLMService.Settings(
                model=os.getenv("DEEPSEEK_MODEL", "deepseek-chat"),
                thinking=DeepSeekThinkingConfig(type="disabled"),
                system_instruction="你是专业的中文电话语音客服，回答请简洁口语化，控制在两句话以内，不要使用列表或表情符号。",
            ),
        )
    elif llm_provider == "qwen":
        from pipecat.services.qwen.llm import QwenLLMService

        llm = QwenLLMService(
            api_key=os.environ["DASHSCOPE_API_KEY"],
            base_url=os.getenv(
                "DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1"
            ),
            settings=QwenLLMService.Settings(
                model=os.getenv("QWEN_MODEL", "qwen-turbo"),
                system_instruction="你是专业的中文电话语音客服，回答请简洁口语化，控制在两句话以内。",
            ),
        )
    else:
        from pipecat.services.openai.llm import OpenAILLMService

        llm = OpenAILLMService(
            api_key=os.environ["OPENAI_API_KEY"],
            settings=OpenAILLMService.Settings(
                model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
            ),
        )

    stt_provider = os.getenv("STT_PROVIDER", "funasr").lower()
    if stt_provider == "funasr":
        from pipecat.services.funasr.stt import FunASRSTTService

        stt = FunASRSTTService(
            device=os.getenv("FUNASR_DEVICE", "cpu"),
            settings=FunASRSTTService.Settings(
                model=os.getenv("FUNASR_MODEL", "iic/SenseVoiceSmall"),
                language=Language.ZH,
                use_itn=True,
            ),
        )
    else:
        from pipecat.services.deepgram.stt import DeepgramSTTService

        stt = DeepgramSTTService(api_key=os.environ["DEEPGRAM_API_KEY"])

    tts_provider = os.getenv("TTS_PROVIDER", "minimax").lower()
    if tts_provider == "minimax":
        from pipecat.services.minimax.tts import MiniMaxHttpTTSService

        tts = MiniMaxHttpTTSService(
            api_key=os.environ["MINIMAX_API_KEY"],
            group_id=os.environ["MINIMAX_GROUP_ID"],
            settings=MiniMaxHttpTTSService.Settings(
                voice=os.getenv("MINIMAX_VOICE_ID", "Calm_Woman"),
            ),
        )
    else:
        from pipecat.services.kokoro.tts import KokoroTTSService

        tts = KokoroTTSService(
            settings=KokoroTTSService.Settings(
                voice=os.getenv("KOKORO_VOICE", "zf_xiaobei"),
                language=Language.ZH,
            )
        )

    logger.info(f"☁️ 已装配生产云端语音栈: STT={stt_provider}, LLM={llm_provider}, TTS={tts_provider}")
    return VoiceServiceBundle(stt=stt, llm=llm, tts=tts, mode="cloud")
