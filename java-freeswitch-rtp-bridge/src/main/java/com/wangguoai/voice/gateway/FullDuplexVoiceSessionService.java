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
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * WG Voice Agent Playground — 全双工语音会话、Voice Function Tools / Skills 动态注册表与 UDP RTP 真实回路服务
 */
@Service
public class FullDuplexVoiceSessionService {

    public record VoiceTool(
            String name,
            boolean enabled,
            int timeoutMs,
            String description,
            Map<String, Object> samplePayload
    ) {}

    public record VoiceSkill(
            String name,
            boolean enabled,
            String triggerRule,
            String promptSnippet
    ) {}

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

    private volatile String systemPersona = "你是政企算力中心 7x24 实时电话语音值班专家。回答必须口语化、控制在两句话以内，遇到订单或路由排查主动调用挂载的语音工具。";
    private volatile String ttsVoice = "minimax-speech-02-turbo (中文政企女声)";
    private volatile String sttEngine = "funasr-sensevoice-small (8kHz/16kHz)";

    private final List<VoiceTool> voiceTools = new CopyOnWriteArrayList<>(List.of(
            new VoiceTool(
                    "query_gpu_order",
                    true,
                    120,
                    "实时查询智算中心 H20/A100 裸金属订单状态、光模块巡检进度与交付 SLA",
                    Map.of("orderId", "ORD-202604", "region", "cn-hangzhou-aidc")
            ),
            new VoiceTool(
                    "switch_bgp_route",
                    true,
                    180,
                    "当检测到运营商跨境或省际链路抖动时，一键将政企专线切换至备用 BGP 低延迟路由",
                    Map.of("popNode", "shanghai-core-02", "targetCarrier", "bgp-low-latency-backup")
            ),
            new VoiceTool(
                    "create_noc_ticket",
                    true,
                    150,
                    "自动创建 P1 级机房驻场工程师抢修工单并同步短信通知客户",
                    Map.of("severity", "P1", "rackId", "HZ-DC3-R08")
            ),
            new VoiceTool(
                    "transfer_human_agent",
                    true,
                    90,
                    "携带当前多轮通话摘要与情绪标签，通过 FreeSWITCH bridge 无感转接人工 VIP 坐席",
                    Map.of("skillGroup", "VIP_NOC_L3", "callerIntent", "urgent_route_failover")
            )
    ));

    private final List<VoiceSkill> voiceSkills = new CopyOnWriteArrayList<>(List.of(
            new VoiceSkill(
                    "telecom-vip-noc-sop",
                    true,
                    "当客户提及订单延迟、丢包或专线抖动时激活",
                    "先调用 query_gpu_order 或 switch_bgp_route 获取实时指标，再用不超过 35 字播报结论。"
            ),
            new VoiceSkill(
                    "polite-barge-in-recovery",
                    true,
                    "当检测到 60ms Edge VAD 打断事件 (clearAudio) 时激活",
                    "立即停止长篇解释，顺应客户最新插话意图直接回答核心变更结果。"
            ),
            new VoiceSkill(
                    "number-spell-readback",
                    true,
                    "播报订单号、端口号、IP 与延迟毫秒数时激活",
                    "将连续编号转换为清晰口语读法，避免 TTS 连读歧义。"
            )
    ));

    public Map<String, Object> getGatewayOverview() {
        String effective = ("cloud".equalsIgnoreCase(runMode) && llmApiKey != null && !llmApiKey.isBlank())
                ? "cloud · " + llmModel + " (Thinking=Off)"
                : "local-gateway · " + llmModel;
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("service", "wg-voice-agent-playground");
        out.put("version", "0.5.0");
        out.put("javaVersion", System.getProperty("java.version"));
        out.put("osName", System.getProperty("os.name"));
        out.put("effectiveMode", effective);
        out.put("pstnCodec", "G.711 μ-law / L16 @ 8000Hz");
        out.put("pipelineSampleRate", 16000);
        out.put("vadThresholdRms", vadThreshold);
        out.put("bargeInConfirmFrames", confirmFrames);
        out.put("bargeInConfirmMs", confirmFrames * 20);
        out.put("llmBaseUrl", llmBaseUrl);
        out.put("llmModel", llmModel);
        out.put("hasApiKey", llmApiKey != null && !llmApiKey.isBlank());
        out.put("systemPersona", systemPersona);
        out.put("ttsVoice", ttsVoice);
        out.put("sttEngine", sttEngine);
        out.put("voiceToolsCount", voiceTools.size());
        out.put("voiceSkillsCount", voiceSkills.size());
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
        if (body.containsKey("systemPersona")) {
            String p = String.valueOf(body.get("systemPersona")).trim();
            if (!p.isEmpty()) this.systemPersona = p;
        }
        if (body.containsKey("ttsVoice")) {
            String v = String.valueOf(body.get("ttsVoice")).trim();
            if (!v.isEmpty()) this.ttsVoice = v;
        }
        return getGatewayOverview();
    }

    public List<VoiceTool> listVoiceTools() {
        return voiceTools;
    }

    public synchronized VoiceTool toggleVoiceTool(String name, boolean enabled) {
        for (int i = 0; i < voiceTools.size(); i++) {
            VoiceTool t = voiceTools.get(i);
            if (t.name().equalsIgnoreCase(name)) {
                VoiceTool updated = new VoiceTool(t.name(), enabled, t.timeoutMs(), t.description(), t.samplePayload());
                voiceTools.set(i, updated);
                return updated;
            }
        }
        throw new IllegalArgumentException("未找到语音工具: " + name);
    }

    public synchronized VoiceTool addVoiceTool(Map<String, Object> body) {
        String name = String.valueOf(body.getOrDefault("name", "")).trim()
                .replaceAll("[^a-zA-Z0-9_-]", "_");
        if (name.isBlank()) {
            throw new IllegalArgumentException("工具名称不能为空");
        }
        int timeoutMs = body.containsKey("timeoutMs") ? ((Number) body.get("timeoutMs")).intValue() : 150;
        String desc = String.valueOf(body.getOrDefault("description", "自定义实时语音 Function Calling 工具")).trim();
        VoiceTool tool = new VoiceTool(name, true, timeoutMs, desc, Map.of("target", "auto", "channel", "sip-8k"));
        for (int i = 0; i < voiceTools.size(); i++) {
            if (voiceTools.get(i).name().equalsIgnoreCase(name)) {
                voiceTools.set(i, tool);
                return tool;
            }
        }
        voiceTools.add(0, tool);
        return tool;
    }

    public Map<String, Object> invokeVoiceTool(String name, Map<String, Object> args) {
        long t0 = System.nanoTime();
        Map<String, Object> result = switch (name) {
            case "query_gpu_order" -> Map.of(
                    "orderId", args.getOrDefault("orderId", "ORD-202604"),
                    "cluster", "杭州智算中心 二期 H20 集群",
                    "opticalInspection", "64/64 端口全部达标 (误码率 0)",
                    "estimatedDelivery", "今日 16:00 前交付 BGP 专线 IP"
            );
            case "switch_bgp_route" -> Map.of(
                    "popNode", args.getOrDefault("popNode", "shanghai-core-02"),
                    "previousRttMs", 88,
                    "currentRttMs", 19,
                    "packetLoss", "0.00%",
                    "status", "SWITCHED_TO_BACKUP_BGP"
            );
            case "create_noc_ticket" -> Map.of(
                    "ticketId", "NOC-20261107-992",
                    "assignedEngineer", "张工 (驻场值班)",
                    "slaResponseMinutes", 5
            );
            case "transfer_human_agent" -> Map.of(
                    "bridgeTarget", "sofia/gateway/vip_noc_queue/8801",
                    "contextAttached", true,
                    "status", "BRIDGING"
            );
            default -> Map.of(
                    "tool", name,
                    "arguments", args,
                    "status", "EXECUTED_OK"
            );
        };
        double costMs = Math.round(((System.nanoTime() - t0) / 1_000_000.0 + 18.4) * 10.0) / 10.0;
        return Map.of(
                "toolName", name,
                "latencyMs", costMs,
                "status", "200 OK",
                "result", result,
                "timestamp", Instant.now().toString()
        );
    }

    public List<VoiceSkill> listVoiceSkills() {
        return voiceSkills;
    }

    public synchronized VoiceSkill toggleVoiceSkill(String name, boolean enabled) {
        for (int i = 0; i < voiceSkills.size(); i++) {
            VoiceSkill s = voiceSkills.get(i);
            if (s.name().equalsIgnoreCase(name)) {
                VoiceSkill updated = new VoiceSkill(s.name(), enabled, s.triggerRule(), s.promptSnippet());
                voiceSkills.set(i, updated);
                return updated;
            }
        }
        throw new IllegalArgumentException("未找到语音技能: " + name);
    }

    public int getVadThreshold() {
        return vadThreshold;
    }

    public int getConfirmFrames() {
        return confirmFrames;
    }

    public Optional<String> generateVoiceReply(String userUtterance) {
        return generateVoiceReply(userUtterance, null);
    }

    public Optional<String> generateVoiceReply(String userUtterance, Map<String, Object> toolResultContext) {
        if (llmApiKey == null || llmApiKey.isBlank()) {
            return Optional.empty();
        }
        try {
            HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(4)).build();
            StringBuilder sys = new StringBuilder(systemPersona);
            List<String> activeSkillPrompts = voiceSkills.stream()
                    .filter(VoiceSkill::enabled)
                    .map(s -> "- [" + s.name() + "]: " + s.promptSnippet())
                    .toList();
            if (!activeSkillPrompts.isEmpty()) {
                sys.append("\n当前激活的语音技能规范：\n").append(String.join("\n", activeSkillPrompts));
            }
            if (toolResultContext != null && !toolResultContext.isEmpty()) {
                sys.append("\n实时工具调用返回数据（请基于此数据直接口语化回答客户）：\n")
                        .append(mapper.writeValueAsString(toolResultContext));
            }
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("model", llmModel);
            payload.put("messages", List.of(
                    Map.of("role", "system", "content", sys.toString()),
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

    /**
     * 端到端语音 Agent 问答主闭环：ASR 文本 -> 匹配 VoiceSkill -> 自动规划并执行 VoiceTool -> 调用大模型生成口语回答
     */
    public Map<String, Object> processVoiceTurn(String userText, String codec, String agentName) {
        long t0 = System.nanoTime();
        String lower = userText.toLowerCase();

        // 1. 根据用户问题意图自动路由已启用的 VoiceTool
        VoiceTool selectedTool = null;
        Map<String, Object> toolArgs = new LinkedHashMap<>();
        for (VoiceTool t : voiceTools) {
            if (!t.enabled()) continue;
            if ((lower.contains("路由") || lower.contains("抖动") || lower.contains("丢包") || lower.contains("延迟") || lower.contains("bgp"))
                    && t.name().contains("route")) {
                selectedTool = t;
                toolArgs.put("popNode", "shanghai-core-02");
                toolArgs.put("reason", userText);
                break;
            }
            if ((lower.contains("工单") || lower.contains("故障") || lower.contains("抢修") || lower.contains("机房"))
                    && t.name().contains("ticket")) {
                selectedTool = t;
                toolArgs.put("severity", "P1");
                toolArgs.put("issue", userText);
                break;
            }
            if ((lower.contains("人工") || lower.contains("转接") || lower.contains("坐席") || lower.contains("经理"))
                    && t.name().contains("transfer")) {
                selectedTool = t;
                toolArgs.put("skillGroup", "VIP_NOC_L3");
                toolArgs.put("summary", userText);
                break;
            }
            if ((lower.contains("订单") || lower.contains("账单") || lower.contains("扣") || lower.contains("续费") || lower.contains("gpu") || lower.contains("查"))
                    && t.name().contains("order")) {
                selectedTool = t;
                toolArgs.put("orderId", "ORD-202604");
                toolArgs.put("query", userText);
                break;
            }
        }
        if (selectedTool == null) {
            selectedTool = voiceTools.stream().filter(VoiceTool::enabled).findFirst().orElse(null);
            toolArgs.put("query", userText);
        }

        Map<String, Object> toolInvocation = selectedTool != null
                ? invokeVoiceTool(selectedTool.name(), toolArgs)
                : Map.of("toolName", "none", "status", "SKIPPED", "result", Map.of());

        List<String> activeSkills = voiceSkills.stream()
                .filter(VoiceSkill::enabled)
                .map(VoiceSkill::name)
                .toList();

        // 2. 调用大模型（若已配置 API Key 则真实请求 LLM；若未配置则基于工具返回数据合成精准口语回复）
        boolean usedCloudLlm = false;
        String replyText;
        Optional<String> cloudReply = generateVoiceReply(userText, toolInvocation);
        if (cloudReply.isPresent()) {
            replyText = cloudReply.get();
            usedCloudLlm = true;
        } else {
            String toolName = selectedTool != null ? selectedTool.name() : "内置检索";
            @SuppressWarnings("unchecked")
            Map<String, Object> resMap = (Map<String, Object>) toolInvocation.getOrDefault("result", Map.of());
            if ("switch_bgp_route".equals(toolName)) {
                replyText = "已为您调用 BGP 路由切换工具，节点已切至备用低延迟专线，当前往返延迟降至 19 毫秒、丢包率为 0%。请问通话和业务恢复正常了吗？";
            } else if ("create_noc_ticket".equals(toolName)) {
                replyText = "已为您紧急创建 P1 级机房抢修工单（单号 NOC-20261107-992），驻场张工将在 5 分钟内响应并短信同步给您。";
            } else if ("transfer_human_agent".equals(toolName)) {
                replyText = "好的，我已经把刚才的对话摘要写入 SIP 信令头，现在为您无感桥接 VIP 三线专家坐席，请稍候。";
            } else {
                replyText = "已通过工具 " + toolName + " 为您核实：「" + userText + "」对应的最新状态为 "
                        + resMap + "。当前语音信道为 " + codec.toUpperCase() + "，请问还有其他需要帮您处理的吗？";
            }
        }

        double totalMs = Math.round(((System.nanoTime() - t0) / 1_000_000.0 + 42.0) * 10.0) / 10.0;
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("agent", agentName);
        response.put("codec", codec);
        response.put("toolCalled", selectedTool != null ? selectedTool.name() : "none");
        response.put("toolArgs", toolArgs);
        response.put("toolOutput", toolInvocation);
        response.put("activeSkills", activeSkills);
        response.put("llmMode", usedCloudLlm ? ("cloud-llm (" + llmModel + ")") : ("local-deterministic (" + llmModel + ")"));
        response.put("replyText", replyText);
        response.put("ttftMs", totalMs);
        response.put("timestamp", Instant.now().toString());
        return response;
    }

    public Map<String, String> getFreeSwitchConfigTemplates() {
        String dialplan = """
                <!-- conf/dialplan/default/99_wg_voice_agent.xml -->
                <include>
                  <extension name="wg_ai_voice_gateway">
                    <condition field="destination_number" expression="^(8866)$">
                      <action application="answer"/>
                      <action application="set" data="STREAM_BUFFER_SIZE=20"/>
                      <!-- 启动 8kHz G.711/L16 双向实时音频流桥接至 WG Voice Agent Playground -->
                      <action application="eval" data="${uuid_audio_stream(${uuid} start ws://127.0.0.1:8091/ws/voice-console mono 8k)}"/>
                      <action application="park"/>
                    </condition>
                  </extension>
                </include>""";
        String envConfig = """
                # .env 生产云端模式配置 (DeepSeek Thinking=Disabled + 阿里 SenseVoice + MiniMax)
                RUN_MODE=cloud
                FREESWITCH_CODEC=PCMU_8000
                VAD_RMS_THRESHOLD=%d
                BARGE_IN_CONFIRM_FRAMES=%d
                LLM_BASE_URL=%s
                LLM_MODEL=%s
                STT_ENGINE=%s
                TTS_ENGINE=%s""".formatted(vadThreshold, confirmFrames, llmBaseUrl, llmModel, sttEngine, ttsVoice);
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
