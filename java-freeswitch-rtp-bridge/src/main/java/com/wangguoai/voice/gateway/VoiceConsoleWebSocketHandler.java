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
 * 实时语音工作台全双工 WebSocket 处理器（支持呼叫演练、随时插话打断、任意自定义语音指令与真实麦克风能量联动）
 */
@Component
public class VoiceConsoleWebSocketHandler extends TextWebSocketHandler {

    private final FullDuplexVoiceSessionService voiceService;
    private final ObjectMapper mapper = new ObjectMapper();
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final Map<String, SessionState> states = new ConcurrentHashMap<>();

    public VoiceConsoleWebSocketHandler(FullDuplexVoiceSessionService voiceService) {
        this.voiceService = voiceService;
    }

    private static final class SessionState {
        final AtomicBoolean botSpeaking = new AtomicBoolean(false);
        final AtomicBoolean bargeInRequested = new AtomicBoolean(false);
        final AtomicInteger outboundQueue = new AtomicInteger(0);
        final AtomicInteger consecutiveHighMic = new AtomicInteger(0);
        volatile String customBargeInText = "";
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) throws Exception {
        states.put(session.getId(), new SessionState());
        sendJson(session, Map.of(
                "type", "CONNECTED",
                "callUuid", "fs-call-" + session.getId().substring(0, Math.min(8, session.getId().length())),
                "state", "WS_READY · BARGE-IN ARMED"
        ));
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
        SessionState st = states.computeIfAbsent(session.getId(), k -> new SessionState());
        JsonNode node = mapper.readTree(message.getPayload());
        String action = node.path("action").asText("");

        if ("start_demo_call".equals(action)) {
            boolean autoBarge = node.path("autoBargeIn").asBoolean(true);
            String scene = node.path("scene").asText("gpu_order");
            executor.submit(() -> runCallFlow(session, st, autoBarge, scene));
        } else if ("trigger_barge_in".equals(action)) {
            String customText = node.path("text").asText("");
            if (!customText.isBlank()) {
                st.customBargeInText = customText;
            }
            if (st.botSpeaking.get()) {
                st.bargeInRequested.set(true);
            } else {
                executor.submit(() -> runCustomUtteranceTurn(session, st,
                        customText.isBlank() ? "我现在直接插话：请立刻帮我切到备用高可用线路并转人工坐席！" : customText));
            }
        } else if ("custom_utterance".equals(action)) {
            String text = node.path("text").asText("").trim();
            if (!text.isEmpty()) {
                st.customBargeInText = text;
                if (st.botSpeaking.get()) {
                    st.bargeInRequested.set(true);
                } else {
                    executor.submit(() -> runCustomUtteranceTurn(session, st, text));
                }
            }
        } else if ("mic_rms".equals(action)) {
            int rms = node.path("rms").asInt(0);
            if (rms >= voiceService.getVadThreshold()) {
                int frames = st.consecutiveHighMic.incrementAndGet();
                if (st.botSpeaking.get() && frames >= voiceService.getConfirmFrames()) {
                    st.bargeInRequested.set(true);
                }
            } else {
                st.consecutiveHighMic.set(0);
            }
        }
    }

    private void runCustomUtteranceTurn(WebSocketSession session, SessionState st, String userText) {
        try {
            int confirmMs = voiceService.getConfirmFrames() * 20;
            int dropped = Math.max(8, st.outboundQueue.getAndSet(0));
            sendJson(session, Map.of(
                    "type", "BARGE_IN_CLEAR",
                    "state", "BARGE_IN_INTERRUPTED",
                    "confirmMs", confirmMs,
                    "clearSignalMs", 0.15,
                    "droppedFrames", dropped,
                    "spokenBeforeInterrupt", "",
                    "clearCommand", "{\"event\":\"clearAudio\",\"callUuid\":\"fs-live-886\",\"reason\":\"user_utterance_barge_in\"}"
            ));
            Thread.sleep(25);
            sendJson(session, Map.of(
                    "type", "ASR_FINAL",
                    "state", "LLM_STREAMING",
                    "speaker", "USER_BARGE_IN",
                    "text", userText,
                    "asrMs", 39
            ));
            Thread.sleep(30);

            String reply = voiceService.generateVoiceReply(userText).orElse(
                    "收到您的插话指令：「" + userText + "」。已为您清空旧播报队列并即时执行该操作，请问还有其他需要协助的吗？"
            );
            st.botSpeaking.set(true);
            st.outboundQueue.set(12);
            sendJson(session, Map.of(
                    "type", "BOT_FINAL_TURN",
                    "state", "BOT_SPEAKING",
                    "text", reply,
                    "ttfbMs", 68.5,
                    "outboundQueue", 12
            ));
            Thread.sleep(40);
            st.botSpeaking.set(false);
            st.outboundQueue.set(4);
        } catch (Exception ignored) {
        }
    }

    private void runCallFlow(WebSocketSession session, SessionState st, boolean autoBarge, String scene) {
        try {
            st.bargeInRequested.set(false);
            st.customBargeInText = "";
            int confirmMs = voiceService.getConfirmFrames() * 20;

            sendJson(session, Map.of(
                    "type", "CALL_EVENT",
                    "state", "USER_SPEAKING",
                    "title", "FreeSWITCH SIP 入站建立 (8kHz G.711 μ-law ⇄ SOXR VHQ 16kHz PCM)",
                    "detail", "上行 20ms/帧 RTP 音频流进入边缘 VAD 实时监测..."
            ));
            for (int f = 1; f <= 3; f++) {
                sendJson(session, Map.of("type", "TELEMETRY", "inboundRms", 2800 + f * 240, "outboundQueue", 0));
                Thread.sleep(18);
            }

            String userTurn1 = "billing".equals(scene)
                    ? "你好，我们公司上个月的智能语音网关账单为什么多了一笔并发扩容费？"
                    : "incident".equals(scene)
                    ? "紧急故障！华东区 SIP 中继出现单通，帮我查一下 RTP 媒体端口状态。"
                    : "你好，帮我查一下昨天开通的杭州区 GPU 云服务器订单进度。";

            sendJson(session, Map.of(
                    "type", "ASR_FINAL",
                    "state", "LLM_STREAMING",
                    "speaker", "USER",
                    "text", userTurn1,
                    "asrMs", 46
            ));
            Thread.sleep(25);

            st.botSpeaking.set(true);
            st.outboundQueue.set(16);
            String botReply1 = "billing".equals(scene)
                    ? "您好，已为您核对账单明细。上月十八号晚八点您的外呼并发峰值达到了两千四百线，自动触发了弹性媒体集群扩容..."
                    : "incident".equals(scene)
                    ? "正在为您检测华东区 FreeSWITCH 媒体节点。发现防火墙放行段缺少一万六千至两万端口映射，正在生成修复脚本..."
                    : "您好，我是智能语音客服。已为您查到杭州区 GPU 实例订单尾号八八六，当前镜像正在分发，预计三分钟内交付并发送短信通知...";

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
                if (autoBarge && i == 25) {
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
                            "confirmMs", confirmMs,
                            "clearSignalMs", clearMs,
                            "droppedFrames", dropped,
                            "spokenBeforeInterrupt", spokenSoFar.toString(),
                            "clearCommand", "{\"event\":\"clearAudio\",\"callUuid\":\"fs-call-886\",\"reason\":\"edge_vad_" + confirmMs + "ms\"}"
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
                Thread.sleep(10);
            }

            if (interrupted) {
                Thread.sleep(25);
                sendJson(session, Map.of("type", "TELEMETRY", "inboundRms", 4450, "outboundQueue", 0));
                String userTurn2 = !st.customBargeInText.isBlank()
                        ? st.customBargeInText
                        : ("billing".equals(scene)
                        ? "不用念明细了，直接帮我把并发上限锁定在一千线，并导出发票发我邮箱！"
                        : "incident".equals(scene)
                        ? "别生成脚本了，立刻把华东流量切到华北双活热备集群！"
                        : "不用等分发了，我现在急用，直接帮我切换到现货可用区或者转专属架构师！");

                sendJson(session, Map.of(
                        "type", "ASR_FINAL",
                        "state", "LLM_STREAMING",
                        "speaker", "USER_BARGE_IN",
                        "text", userTurn2,
                        "asrMs", 42
                ));
                Thread.sleep(25);

                String defaultReply2 = "billing".equals(scene)
                        ? "好的，已立即中止播报！已将您的弹性并发硬上限锁定为 1000 线，增值税专用发票已发送至您的绑定邮箱。"
                        : "incident".equals(scene)
                        ? "明白，已秒级执行 BGP 宣告切换！华东呼入流量已 100% 切入华北热备 FreeSWITCH 集群，通话全部恢复正常。"
                        : "明白，已立即中止原播报！上海二区当前有现货 A100 实例，我现在为您一键热迁移并同步接通值班架构师。";

                String botReply2 = voiceService.generateVoiceReply(userTurn2).orElse(defaultReply2);
                st.botSpeaking.set(true);
                st.outboundQueue.set(10);
                sendJson(session, Map.of(
                        "type", "BOT_FINAL_TURN",
                        "state", "BOT_SPEAKING",
                        "text", botReply2,
                        "ttfbMs", 72.1,
                        "outboundQueue", 10
                ));
                Thread.sleep(30);
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
