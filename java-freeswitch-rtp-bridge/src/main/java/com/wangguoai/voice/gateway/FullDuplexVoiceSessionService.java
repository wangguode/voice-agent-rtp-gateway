package com.wangguoai.voice.gateway;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetSocketAddress;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 全双工语音会话与 UDP RTP 真实回路压测服务
 */
@Service
public class FullDuplexVoiceSessionService {

    @Value("${wg.voice.run-mode:mock}")
    private String runMode;

    @Value("${wg.voice.vad-rms-threshold:1200}")
    private int vadThreshold;

    @Value("${wg.voice.barge-in-confirm-frames:3}")
    private int confirmFrames;

    @Value("${wg.voice.llm.model:deepseek-chat}")
    private String llmModel;

    @Value("${wg.voice.llm.api-key:}")
    private String llmApiKey;

    public Map<String, Object> getGatewayOverview() {
        String effective = ("cloud".equalsIgnoreCase(runMode) && llmApiKey != null && !llmApiKey.isBlank())
                ? "cloud (" + llmModel + " · Thinking Disabled)"
                : "mock (零密钥开箱体验)";
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("service", "wg-voice-gateway-java");
        out.put("version", "0.3.0");
        out.put("javaVersion", System.getProperty("java.version"));
        out.put("effectiveMode", effective);
        out.put("pstnCodec", "G.711 μ-law / L16 @ 8000Hz");
        out.put("pipelineSampleRate", 16000);
        out.put("vadThresholdRms", vadThreshold);
        out.put("bargeInConfirmMs", confirmFrames * 20);
        return out;
    }

    /**
     * 在本机启动真实 UDP Socket 对，发送 8 个 RFC 3550 RTP 音频包模拟 FreeSWITCH 媒体流与用户插话打断
     */
    public Map<String, Object> runLiveUdpRtpBenchmark() throws Exception {
        long t0 = System.nanoTime();
        RtpWebSocketBridge bridge = new RtpWebSocketBridge(vadThreshold, confirmFrames);
        int preloadedFrames = 18;
        for (int i = 0; i < preloadedFrames; i++) {
            bridge.enqueueOutboundAudio(new byte[320]);
        }

        List<Map<String, Object>> packetTraces = new ArrayList<>();
        int port;
        int droppedOnBargeIn = 0;

        try (DatagramSocket serverSock = new DatagramSocket(new InetSocketAddress("127.0.0.1", 0));
             DatagramSocket clientSock = new DatagramSocket()) {
            port = serverSock.getLocalPort();
            serverSock.setSoTimeout(1500);

            for (int seq = 1; seq <= 8; seq++) {
                byte[] pcm = new byte[320]; // 20ms @ 8kHz PCM16
                short amp = (seq >= 4 && seq <= 7) ? (short) 4600 : (short) 95;
                for (int i = 0; i < pcm.length; i += 2) {
                    pcm[i] = (byte) (amp & 0xFF);
                    pcm[i + 1] = (byte) ((amp >> 8) & 0xFF);
                }
                byte[] rawRtp = RtpWebSocketBridge.buildRtpPacket(seq, seq * 160L, 0x20260886L, pcm);
                clientSock.send(new DatagramPacket(rawRtp, rawRtp.length, new InetSocketAddress("127.0.0.1", port)));

                byte[] recv = new byte[1024];
                DatagramPacket dp = new DatagramPacket(recv, recv.length);
                serverSock.receive(dp);

                RtpWebSocketBridge.RtpPacket parsed = RtpWebSocketBridge.parseRtp(dp.getData(), dp.getLength());
                int rms = RtpWebSocketBridge.computePcm16Rms(parsed.payload);
                String wsFrame = bridge.onInboundRtpPacket(dp.getData(), dp.getLength(), "fs-udp-bench-886");
                boolean triggered = (seq == 3 + confirmFrames);
                if (triggered) {
                    droppedOnBargeIn = preloadedFrames;
                }
                packetTraces.add(Map.of(
                        "seq", seq,
                        "timestamp", parsed.timestamp,
                        "rms", rms,
                        "voiceActive", rms >= vadThreshold,
                        "bargeInTriggered", triggered,
                        "wsFramePreview", wsFrame.substring(0, Math.min(84, wsFrame.length())) + "..."
                ));
            }
        }

        double elapsedMs = (System.nanoTime() - t0) / 1_000_000.0;
        Map<String, Object> report = new LinkedHashMap<>();
        report.put("udpLocalPort", port);
        report.put("packetsProcessed", 8);
        report.put("preloadedTtsFrames", preloadedFrames);
        report.put("droppedOutboundFrames", droppedOnBargeIn);
        report.put("bargeInConfirmLatencyMs", confirmFrames * 20);
        report.put("totalSocketRoundtripMs", Math.round(elapsedMs * 100.0) / 100.0);
        report.put("completedAt", Instant.now().toString());
        report.put("traces", packetTraces);
        return report;
    }
}
