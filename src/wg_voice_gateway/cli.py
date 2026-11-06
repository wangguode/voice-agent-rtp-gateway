"""
wg-voice-gateway 命令行入口 (`wg-voice`)

用法：
    wg-voice demo              # 零配置运行端到端 FreeSWITCH 8kHz ⇄ Pipecat 16kHz 毫秒级打断演练
    wg-voice serve --port 8765 # 启动 FastAPI WebSocket 生产语音网关
"""
from __future__ import annotations

import argparse
import asyncio
import os

import uvicorn
from dotenv import load_dotenv

from wg_voice_gateway.server import create_app, run_end_to_end_barge_in_demo


def main() -> None:
    load_dotenv(override=True)
    parser = argparse.ArgumentParser(
        prog="wg-voice",
        description="生产级中文实时语音智能体网关 (FreeSWITCH RTP/WS + Pipecat 全双工管道)",
    )
    sub = parser.add_subparsers(dest="cmd")

    sub.add_parser("demo", help="零配置运行端到端 FreeSWITCH ⇄ Pipecat 毫秒级打断实测")

    serve_p = sub.add_parser("serve", help="启动 FastAPI WebSocket 生产语音网关")
    serve_p.add_argument("--host", default=os.getenv("GATEWAY_HOST", "0.0.0.0"))
    serve_p.add_argument("--port", type=int, default=int(os.getenv("GATEWAY_PORT", "8765")))
    serve_p.add_argument("--mode", default=os.getenv("RUN_MODE", "mock"), choices=["mock", "cloud"])

    args = parser.parse_args()
    if args.cmd == "serve":
        app = create_app(run_mode=args.mode)
        uvicorn.run(app, host=args.host, port=args.port)
    else:
        asyncio.run(run_end_to_end_barge_in_demo())


if __name__ == "__main__":
    main()
