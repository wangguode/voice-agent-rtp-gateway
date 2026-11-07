package com.wangguoai.voice.gateway;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 实时语音监控大屏全双工 WebSocket 处理器（支持呼叫演练、随时插话打断与真实麦克风能量联动）
 */
@Component
public class VoiceConsoleWebSocketHandler extends TextWebSocketHandler {

    private final ObjectMapper mapper = new ObjectMapper();
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final Map<String, SessionState> states = new ConcurrentHashMap<>();

    private static final class SessionState {
        final AtomicBoolean botSpeaking = new AtomicBoolean(false);
        final AtomicBoolean bargeInRequested = new AtomicBoolean(false);
        final AtomicInteger outboundQueue = new AtomicInteger(0);
        final AtomicInteger consecutiveHighMic = new AtomicInteger(0);
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) throws Exception {
        states.put(session.getId(), new SessionState());
        sendJson(session, Map.of(
                "type", "CONNECTED",
                "callUuid", "fs-call-" + session.getId().substring(0, Math.min(8, session.getId().length())),
                "state", "IDLE_LISTENING"
        ));
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
        SessionState st = states.computeIfAbsent(session.getId(), k -> new SessionState());
        JsonNode node = mapper.readTree(message.getPayload());
        String action = node.path("action").asText("");

        if ("start_demo_call".equals(action)) {
            boolean autoBarge = node.path("autoBargeIn").asBoolean(true);
            executor.submit(() -> runCallFlow(session, st, autoBarge));
        } else if ("trigger_barge_in".equals(action)) {
            st.bargeInRequested.set(true);
        } else if ("mic_rms".equals(action)) {
            int rms = node.path("rms").asInt(0);
            if (rms >= 1200) {
                int frames = st.consecutiveHighMic.incrementAndGet();
                if (st.botSpeaking.get() && frames >= 3) {
                    st.bargeInRequested.set(true);
                }
            } else {
                st.consecutiveHighMic.set(0);
            }
        }
    }

    private void runCallFlow(WebSocketSession session, SessionState st, boolean autoBarge) {
        try {
            st.bargeInRequested.set(false);
            sendJson(session, Map.of(
                    "type", "CALL_EVENT",
                    "state", "USER_SPEAKING",
                    "title", "FreeSWITCH 入站呼叫建立 (8kHz G.711 μ-law -> SOXR 16kHz PCM)",
                    "detail", "上行 RTP 流进入 VAD 语音段捕获..."
            ));
            for (int f = 1; f <= 3; f++) {
                sendJson(session, Map.of("type", "TELEMETRY", "inboundRms", 2800 + f * 240, "outboundQueue", 0));
                Thread.sleep(20);
            }

            String userTurn1 = "你好，帮我查一下昨天开通的杭州区 GPU 云服务器订单进度。";
            sendJson(session, Map.of(
                    "type", "ASR_FINAL",
                    "state", "LLM_STREAMING",
                    "speaker", "USER",
                    "text", userTurn1,
                    "asrMs", 46
            ));
            Thread.sleep(30);

            st.botSpeaking.set(true);
            st.outboundQueue.set(16);
            String botReply1 = "您好，我是智能语音客服。已为您查到杭州区 GPU 实例订单尾号八八六，当前镜像正在分发，预计三分钟内交付并发送短信通知...";
            sendJson(session, Map.of(
                    "type", "TTS_FIRST_PACKET",
                    "state", "BOT_SPEAKING",
                    "ttfbMs", 76.4,
                    "outboundQueue", 16
            ));

            StringBuilder spokenSoFar = new StringBuilder();
            char[] chars = botReply1.toCharArray();
            boolean interrupted = false;

            for (int i = 0; i < chars.length; i++) {
                if (autoBarge && i == 24) {
                    st.bargeInRequested.set(true);
                }
                if (st.bargeInRequested.get()) {
                    long clearT0 = System.nanoTime();
                    int dropped = st.outboundQueue.getAndSet(0);
                    st.botSpeaking.set(false);
                    double clearMs = Math.max(0.12, Math.round(((System.nanoTime() - clearT0) / 1_000_000.0 + 0.14) * 100.0) / 100.0);
                    sendJson(session, Map.of(
                            "type", "BARGE_IN_CLEAR",
                            "state", "BARGE_IN_INTERRUPTED",
                            "confirmMs", 60,
                            "clearSignalMs", clearMs,
                            "droppedFrames", dropped,
                            "spokenBeforeInterrupt", spokenSoFar.toString(),
                            "clearCommand", "{\"event\":\"clearAudio\",\"reason\":\"edge_vad_3_frames_60ms\"}"
                    ));
                    interrupted = true;
                    break;
                }
                spokenSoFar.append(chars[i]);
                if (i % 3 == 0 && st.outboundQueue.get() > 4) {
                    st.outboundQueue.decrementAndGet();
                }
                sendJson(session, Map.of(
                        "type", "BOT_TOKEN",
                        "partialText", spokenSoFar.toString(),
                        "inboundRms", 90,
                        "outboundQueue", st.outboundQueue.get()
                ));
                Thread.sleep(12);
            }

            if (interrupted) {
                Thread.sleep(30);
                sendJson(session, Map.of("type", "TELEMETRY", "inboundRms", 4450, "outboundQueue", 0));
                String userTurn2 = "不用等分发了，我现在急用，直接帮我切换到现货可用区或者转专属架构师！";
                sendJson(session, Map.of(
                        "type", "ASR_FINAL",
                        "state", "LLM_STREAMING",
                        "speaker", "USER_BARGE_IN",
                        "text", userTurn2,
                        "asrMs", 42
                ));
                Thread.sleep(30);

                String botReply2 = "明白，已立即中止原播报！上海二区当前有现货 A100 实例，我现在为您一键热迁移并同步接通值班架构师。";
                st.botSpeaking.set(true);
                st.outboundQueue.set(10);
                sendJson(session, Map.of(
                        "type", "BOT_FINAL_TURN",
                        "state", "BOT_SPEAKING",
                        "text", botReply2,
                        "ttfbMs", 72.1,
                        "outboundQueue", 10
                ));
                Thread.sleep(40);
                st.outboundQueue.set(6);
                st.botSpeaking.set(false);
            }

            sendJson(session, Map.of(
                    "type", "CALL_IDLE",
                    "state", "COMPLETED_READY",
                    "inboundRms", 60,
                    "outboundQueue", 6
            ));
        } catch (Exception ignored) {
        }
    }

    private synchronized void sendJson(WebSocketSession session, Map<String, Object> payload) {
        try {
            if (session.isOpen()) {
                session.sendMessage(new TextMessage(mapper.writeValueAsString(payload)));
            }
        } catch (Exception ignored) {
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        states.remove(session.getId());
    }
}
