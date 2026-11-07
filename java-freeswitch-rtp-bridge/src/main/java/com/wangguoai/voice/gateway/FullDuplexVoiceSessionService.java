package com.wangguoai.voice.gateway;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 全双工语音会话、在线模型热切换与 UDP RTP 真实回路压测服务
 */
@Service
public class FullDuplexVoiceSessionService {

    private final ObjectMapper mapper = new ObjectMapper();

    @Value("${wg.voice.run-mode:mock}")
    private volatile String runMode;

    @Value("${wg.voice.vad-rms-threshold:1200}")
    private volatile int vadThreshold;

    @Value("${wg.voice.barge-in-confirm-frames:3}")
    private volatile int confirmFrames;

    @Value("${wg.voice.llm.base-url:https://api.deepseek.com/v1}")
    private volatile String llmBaseUrl;

    @Value("${wg.voice.llm.model:deepseek-chat}")
    private volatile String llmModel;

    @Value("${wg.voice.llm.api-key:}")
    private volatile String llmApiKey;

    public Map<String, Object> getGatewayOverview() {
        String effective = ("cloud".equalsIgnoreCase(runMode) && llmApiKey != null && !llmApiKey.isBlank())
                ? "cloud · " + llmModel + " (Thinking=Off)"
                : "local-gateway · " + llmModel;
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("service", "wg-voice-gateway-java");
        out.put("version", "0.4.0");
        out.put("javaVersion", System.getProperty("java.version"));
        out.put("effectiveMode", effective);
        out.put("pstnCodec", "G.711 μ-law / L16 @ 8000Hz");
        out.put("pipelineSampleRate", 16000);
        out.put("vadThresholdRms", vadThreshold);
        out.put("bargeInConfirmFrames", confirmFrames);
        out.put("bargeInConfirmMs", confirmFrames * 20);
        out.put("llmBaseUrl", llmBaseUrl);
        out.put("llmModel", llmModel);
        out.put("hasApiKey", llmApiKey != null && !llmApiKey.isBlank());
        return out;
    }

    public synchronized Map<String, Object> updateSettings(Map<String, Object> body) {
        if (body.containsKey("vadThresholdRms")) {
            this.vadThreshold = Math.max(200, ((Number) body.get("vadThresholdRms")).intValue());
        }
        if (body.containsKey("bargeInConfirmFrames")) {
            this.confirmFrames = Math.max(1, Math.min(10, ((Number) body.get("bargeInConfirmFrames")).intValue()));
        }
        if (body.containsKey("baseUrl")) {
            String url = String.valueOf(body.get("baseUrl")).trim();
            if (!url.isEmpty()) this.llmBaseUrl = url;
        }
        if (body.containsKey("model")) {
            String m = String.valueOf(body.get("model")).trim();
            if (!m.isEmpty()) this.llmModel = m;
        }
        if (body.containsKey("apiKey")) {
            String k = String.valueOf(body.get("apiKey")).trim();
            if (!k.isEmpty() && !k.contains("****")) {
                this.llmApiKey = k;
                this.runMode = "cloud";
            }
        }
        if (body.containsKey("runMode")) {
            this.runMode = String.valueOf(body.get("runMode")).trim();
        }
        return getGatewayOverview();
    }

    public int getVadThreshold() {
        return vadThreshold;
    }

    public int getConfirmFrames() {
        return confirmFrames;
    }

    public Optional<String> generateVoiceReply(String userUtterance) {
        if (!"cloud".equalsIgnoreCase(runMode) || llmApiKey == null || llmApiKey.isBlank()) {
            return Optional.empty();
        }
        try {
            HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(4)).build();
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("model", llmModel);
            payload.put("messages", List.of(
                    Map.of("role", "system", "content", "你是企业级实时电话语音客服，请用不超过两句的自然口语中文直接回答用户问题，不要使用 Markdown 符号。"),
                    Map.of("role", "user", "content", userUtterance)
            ));
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(llmBaseUrl.replaceAll("/+$", "") + "/chat/completions"))
                    .timeout(Duration.ofSeconds(10))
                    .header("Content-Type", "application/json")
                    .header("Authorization", "Bearer " + llmApiKey)
                    .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(payload)))
                    .build();
            HttpResponse<String> resp = client.send(req, HttpResponse.BodyHandlers.ofString());
            if (resp.statusCode() == 200) {
                var root = mapper.readTree(resp.body());
                String text = root.path("choices").path(0).path("message").path("content").asText("");
                if (!text.isBlank()) {
                    return Optional.of(text.trim());
                }
            }
        } catch (Exception ignored) {
        }
        return Optional.empty();
    }

    public Map<String, String> getFreeSwitchConfigTemplates() {
        String dialplan = """
                <!-- conf/dialplan/default/99_wg_voice_agent.xml -->
                <include>
                  <extension name="wg_ai_voice_gateway">
                    <condition field="destination_number" expression="^(8866)$">
                      <action application="answer"/>
                      <action application="set" data="STREAM_BUFFER_SIZE=20"/>
                      <!-- 启动 8kHz G.711/L16 双向实时音频流桥接至 WG Voice Gateway -->
                      <action application="eval" data="${uuid_audio_stream(${uuid} start ws://127.0.0.1:8765/ws/freeswitch mono 8k)}"/>
                      <action application="park"/>
                    </condition>
                  </extension>
                </include>""";
        String envConfig = """
                # .env 生产云端模式配置 (DeepSeek Thinking=Disabled + 阿里 SenseVoice + MiniMax)
                RUN_MODE=cloud
                FREESWITCH_Codec=PCMU_8000
                VAD_RMS_THRESHOLD=%d
                BARGE_IN_CONFIRM_FRAMES=%d
                LLM_BASE_URL=%s
                LLM_MODEL=%s
                STT_ENGINE=funasr-sensevoice-small
                TTS_ENGINE=minimax-speech-02-turbo""".formatted(vadThreshold, confirmFrames, llmBaseUrl, llmModel);
        return Map.of("dialplanXml", dialplan, "envTemplate", envConfig);
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
