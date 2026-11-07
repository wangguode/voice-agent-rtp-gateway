package com.wangguoai.voice.gateway;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * WG Voice Gateway Console · 企业级全双工实时语音智能体网关（Java 17 + Spring Boot 3）
 *
 * <p>默认监听 {@code http://localhost:8091}，内置：
 * <ul>
 *   <li>实时语音通话与 60ms 毫秒级打断（Barge-in）可视化监控大屏</li>
 *   <li>WebSocket 全双工音频/信令总线（{@code /ws/voice-console}）</li>
 *   <li>RFC 3550 UDP RTP 本地真实 Socket 回路压测器（{@link RtpWebSocketBridge}）</li>
 * </ul>
 */
@SpringBootApplication
public class VoiceGatewayApplication {

    public static void main(String[] args) {
        SpringApplication.run(VoiceGatewayApplication.class, args);
    }
}
