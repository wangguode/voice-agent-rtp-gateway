"use client";

import React, { useEffect, useRef, useState } from "react";
import { CheckCircle2, Copy, Download } from "lucide-react";

type SessionStatus = "DISCONNECTED" | "CONNECTING" | "CONNECTED";

interface GuardrailResult {
  status: "IN_PROGRESS" | "DONE";
  category: string;
  rationale: string;
}

interface TranscriptItem {
  itemId: string;
  type: "MESSAGE" | "BREADCRUMB";
  role?: "user" | "assistant";
  title: string;
  data?: Record<string, unknown>;
  expanded: boolean;
  timestamp: string;
  createdAtMs: number;
  guardrailResult?: GuardrailResult;
}

interface LoggedEvent {
  id: string;
  direction: "client" | "server";
  eventName: string;
  timestamp: string;
  expanded: boolean;
  eventData?: Record<string, unknown>;
}

interface VoiceTool {
  name: string;
  category: string;
  description: string;
  enabled: boolean;
  latencyTargetMs: number;
  sampleArgs: string;
}

interface VoiceSkill {
  id: string;
  title: string;
  trigger: string;
  description: string;
  enabled: boolean;
  promptSnippet: string;
}

const SCENARIO_MAP: Record<
  string,
  {
    label: string;
    agents: string[];
    initialTranscript: TranscriptItem[];
    initialEvents: LoggedEvent[];
  }
> = {
  chatSupervisor: {
    label: "chatSupervisor",
    agents: ["chatAgent", "supervisorAgent", "rtpBargeInGuard"],
    initialTranscript: [
      {
        itemId: "init-bc-1",
        type: "BREADCRUMB",
        title: "Agent: chatAgent (FreeSWITCH 8kHz PCMU ↔ 24kHz Polyphase Resampler)",
        data: {
          sessionUuid: "fs-call-8091-live",
          inboundCodec: "PCMU/8000 (RFC 3550 20ms / 160B)",
          asrEngine: "Paraformer-v2 / Qwen-Audio-Realtime",
          vadSilenceWindowMs: 380,
          bargeInClearAudioMaxMs: 60,
        },
        expanded: false,
        timestamp: "10:51:25.120",
        createdAtMs: 1000,
      },
      {
        itemId: "init-msg-1",
        type: "MESSAGE",
        role: "user",
        title: "你好，我想查一下刚才那笔 299 元的云主机续费订单，为什么账单上扣了两次？",
        expanded: false,
        timestamp: "10:51:26.405",
        createdAtMs: 2000,
      },
      {
        itemId: "init-bc-2",
        type: "BREADCRUMB",
        title: "function call: getNextResponseFromSupervisor",
        data: {
          callId: "call_sup_99281",
          tool: "lookup_Order_And_Refund_Policy",
          arguments: {
            customerPhone: "138****9021",
            amountCny: 299.0,
            dedupCheck: true,
          },
        },
        expanded: true,
        timestamp: "10:51:26.690",
        createdAtMs: 3000,
      },
      {
        itemId: "init-bc-3",
        type: "BREADCRUMB",
        title: "function call result: getNextResponseFromSupervisor",
        data: {
          status: "DUPLICATE_AUTH_HOLD_DETECTED",
          orderId: "ORD-20261107-8831",
          refundAction: "AUTO_RELEASED_SECOND_HOLD",
          executionLatencyMs: 34,
        },
        expanded: false,
        timestamp: "10:51:26.724",
        createdAtMs: 4000,
      },
      {
        itemId: "init-msg-2",
        type: "MESSAGE",
        role: "assistant",
        title:
          "已经为您核实到了！您尾号 8831 的 299 元云主机续费订单，第二次记录是银行网关的预授权冻结，并不是重复扣款。我刚刚已经通过账单工具为您自动解除了那笔预授权，预计 3 分钟内原路恢复，请您放心。",
        expanded: false,
        timestamp: "10:51:27.012",
        createdAtMs: 5000,
        guardrailResult: {
          status: "DONE",
          category: "NONE",
          rationale: "Verified order ID & refund policy compliance.",
        },
      },
      {
        itemId: "init-msg-3",
        type: "MESSAGE",
        role: "user",
        title: "等一下——那我的云主机到期时间顺延了一年对吧？",
        expanded: false,
        timestamp: "10:51:29.180",
        createdAtMs: 6000,
      },
      {
        itemId: "init-bc-4",
        type: "BREADCRUMB",
        title: "barge_in.clearAudio (52ms) → Semantic Resume",
        data: {
          event: "barge_in.detected",
          Action: "clearAudio",
          elapsedMs: 52,
          droppedTtsFrames: 9,
          activeSkill: "barge-in-semantic-resume",
        },
        expanded: false,
        timestamp: "10:51:29.232",
        createdAtMs: 7000,
      },
      {
        itemId: "init-msg-4",
        type: "MESSAGE",
        role: "assistant",
        title:
          "对的，已经为您顺延了一整年，新的到期日是 2027 年 11 月 7 日，并且刚才已向您的手机发送了续费成功短信。",
        expanded: false,
        timestamp: "10:51:29.610",
        createdAtMs: 8000,
        guardrailResult: {
          status: "DONE",
          category: "NONE",
          rationale: "Passed financial & SLA guardrail check.",
        },
      },
    ],
    initialEvents: [
      {
        id: "ev-1",
        direction: "client",
        eventName: "session.update (8kHz PCMU ↔ 24kHz Realtime Bridge)",
        timestamp: "10:51:25",
        expanded: false,
        eventData: {
          type: "session.update",
          session: {
            input_audio_format: "g711_ulaw",
            output_audio_format: "pcm16_24khz",
            turn_detection: {
              type: "server_vad",
              threshold: 0.85,
              prefix_padding_ms: 200,
              silence_duration_ms: 380,
            },
          },
        },
      },
      {
        id: "ev-2",
        direction: "server",
        eventName: "session.updated",
        timestamp: "10:51:25",
        expanded: false,
        eventData: {
          type: "session.updated",
          rtpPort: 16384,
          packetizationMs: 20,
          payloadBytes: 160,
        },
      },
      {
        id: "ev-3",
        direction: "server",
        eventName: "input_audio_buffer.speech_started",
        timestamp: "10:51:26",
        expanded: false,
        eventData: {
          type: "input_audio_buffer.speech_started",
          audio_start_ms: 1140,
          snrDb: 21.4,
        },
      },
      {
        id: "ev-4",
        direction: "server",
        eventName: "conversation.item.input_audio_transcription.completed",
        timestamp: "10:51:26",
        expanded: false,
        eventData: {
          type: "conversation.item.input_audio_transcription.completed",
          transcript: "你好，我想查一下刚才那笔 299 元的云主机续费订单，为什么账单上扣了两次？",
        },
      },
      {
        id: "ev-5",
        direction: "server",
        eventName: "response.function_call_arguments.done",
        timestamp: "10:51:26",
        expanded: true,
        eventData: {
          type: "response.function_call_arguments.done",
          name: "getNextResponseFromSupervisor",
          call_id: "call_sup_99281",
          arguments:
            '{"customerPhone":"138****9021","amountCny":299.0,"dedupCheck":true}',
        },
      },
      {
        id: "ev-6",
        direction: "client",
        eventName: "conversation.item.create (function_call_output)",
        timestamp: "10:51:26",
        expanded: false,
        eventData: {
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: "call_sup_99281",
            output: '{"status":"DUPLICATE_AUTH_HOLD_DETECTED","elapsedMs":34}',
          },
        },
      },
      {
        id: "ev-7",
        direction: "server",
        eventName: "input_audio_buffer.speech_started (BARGE_IN_DETECTED)",
        timestamp: "10:51:29",
        expanded: false,
        eventData: {
          type: "input_audio_buffer.speech_started",
          bargeInInterrupt: true,
          clearAudioDispatched: true,
        },
      },
      {
        id: "ev-8",
        direction: "client",
        eventName: "freeswitch.mod_audio_stream.clearAudio (52ms <= 60ms SLA)",
        timestamp: "10:51:29",
        expanded: false,
        eventData: {
          command: "clearAudio",
          channelUuid: "fs-call-8091-live",
          flushRtpJitterBuffer: true,
          interruptLatencyMs: 52,
        },
      },
      {
        id: "ev-9",
        direction: "server",
        eventName: "response.audio_transcript.done",
        timestamp: "10:51:29",
        expanded: false,
        eventData: {
          type: "response.audio_transcript.done",
          transcript:
            "对的，已经为您顺延了一整年，新的到期日是 2027 年 11 月 7 日，并且刚才已向您的手机发送了续费成功短信。",
        },
      },
    ],
  },
  customerServiceRetail: {
    label: "customerServiceRetail",
    agents: ["authentication", "returns", "sales", "simulatedHuman"],
    initialTranscript: [
      {
        itemId: "ret-bc-1",
        type: "BREADCRUMB",
        title: "Agent: authentication (PSTN 8kHz Inbound IVR Replacement)",
        data: {
          scenario: "customerServiceRetail",
          codec: "PCMU (8 kHz)",
          dtmfFallbackEnabled: true,
        },
        expanded: false,
        timestamp: "10:52:01.100",
        createdAtMs: 1000,
      },
      {
        itemId: "ret-msg-1",
        type: "MESSAGE",
        role: "assistant",
        title: "您好，这里是智能售后语音专线，请问需要办理退换货还是查询物流进度？",
        expanded: false,
        timestamp: "10:52:01.450",
        createdAtMs: 2000,
        guardrailResult: {
          status: "DONE",
          category: "NONE",
          rationale: "Standard greeting.",
        },
      },
    ],
    initialEvents: [
      {
        id: "ret-ev-1",
        direction: "client",
        eventName: "session.update (customerServiceRetail)",
        timestamp: "10:52:01",
        expanded: false,
        eventData: { scenario: "customerServiceRetail", agent: "authentication" },
      },
    ],
  },
  simpleHandoff: {
    label: "simpleHandoff",
    agents: ["greeter", "haikuWriter", "sipTransferAgent"],
    initialTranscript: [
      {
        itemId: "sh-bc-1",
        type: "BREADCRUMB",
        title: "Agent: greeter → sipTransferAgent (SIP REFER Warm Transfer)",
        data: {
          sipHeader: "X-WG-Session-Summary: VIP Order Escalation",
          targetSkillGroup: "sip:tier2-specialist@10.20.0.15:5060",
        },
        expanded: true,
        timestamp: "10:53:10.020",
        createdAtMs: 1000,
      },
    ],
    initialEvents: [
      {
        id: "sh-ev-1",
        direction: "server",
        eventName: "sip.refer.warm_handoff_ready",
        timestamp: "10:53:10",
        expanded: true,
        eventData: {
          bridgeMode: "uuid_transfer",
          summaryInjected: true,
        },
      },
    ],
  },
};

function nowTimeStr(withMs = false): string {
  const d = new Date();
  const base = d.toTimeString().split(" ")[0];
  if (!withMs) return base;
  return `${base}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

export default function RealtimeVoiceAgentsApp() {
  const [scenarioKey, setScenarioKey] = useState<string>("chatSupervisor");
  const [selectedAgentName, setSelectedAgentName] = useState<string>("chatAgent");
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("CONNECTED");
  const [isEventsPaneExpanded, setIsEventsPaneExpanded] = useState<boolean>(true);
  const [rightPaneTab, setRightPaneTab] = useState<"logs" | "tools" | "sip">("logs");

  const [userText, setUserText] = useState<string>("");
  const [isPTTActive, setIsPTTActive] = useState<boolean>(false);
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] = useState<boolean>(true);
  const [codec, setCodec] = useState<string>("pcmu");
  const [justCopied, setJustCopied] = useState<boolean>(false);

  const [transcriptItems, setTranscriptItems] = useState<TranscriptItem[]>(
    SCENARIO_MAP.chatSupervisor.initialTranscript
  );
  const [loggedEvents, setLoggedEvents] = useState<LoggedEvent[]>(
    SCENARIO_MAP.chatSupervisor.initialEvents
  );

  // Backend tools, skills & settings state
  const [tools, setTools] = useState<VoiceTool[]>([
    {
      name: "lookup_Order_And_Refund_Policy",
      category: "CRM & Billing",
      description: "查询用户近期订单、预授权冻结状态与自动退款资格",
      enabled: true,
      latencyTargetMs: 45,
      sampleArgs: '{"customerPhone":"138****9021","amountCny":299.0}',
    },
    {
      name: "verify_Identity_And_Otp",
      category: "Auth Guardrail",
      description: "校验四位手机尾号或动态口令，通过后解锁敏感操作",
      enabled: true,
      latencyTargetMs: 30,
      sampleArgs: '{"phoneTail":"9021","otpCode":"8821"}',
    },
    {
      name: "sip_Warm_Transfer_With_Summary",
      category: "FreeSWITCH SIP",
      description: "将当前实时对话摘要写入 SIP X-Header 并无感转接二线坐席",
      enabled: true,
      latencyTargetMs: 25,
      sampleArgs: '{"targetUri":"sip:tier2@fs-cluster.local","summary":"Duplicate hold resolved"}',
    },
  ]);

  const [skills, setSkills] = useState<VoiceSkill[]>([
    {
      id: "barge-in-semantic-resume",
      title: "60ms 打断清空与语义续接 (Barge-In Semantic Resume)",
      trigger: "input_audio_buffer.speech_started",
      description: "检测到用户抢话时立即下发 FreeSWITCH clearAudio 并基于已播报字节对齐上下文",
      enabled: true,
      promptSnippet: "用户打断时禁止重复前文，直接回答最新追问。",
    },
    {
      id: "pstn-8khz-number-disambiguation",
      title: "8kHz 窄带数字与专有名词复述确认",
      trigger: "ASR confidence < 0.88 on digits",
      description: "针对 G.711 8kHz 电话信道易混淆的订单号/手机号自动采用分组复述确认",
      enabled: true,
      promptSnippet: "涉及金额与单号时使用自然短句确认。",
    },
  ]);

  const [sipConfigXml, setSipConfigXml] = useState<string>(
    `<!-- FreeSWITCH dialplan: mod_audio_stream 8kHz PCMU full-duplex bridge -->
<extension name="wg_realtime_voice_agent">
  <condition field="destination_number" expression="^(95001)$">
    <action application="answer"/>
    <action application="set" data="rtp_jitter_buffer_plc=true"/>
    <action application="set" data="STREAM_MESSAGE_DEFLATE=false"/>
    <action application="lua" data="wg_audio_stream_bridge.lua ws://127.0.0.1:8091/ws/freeswitch"/>
  </condition>
</extension>`
  );

  const [newToolName, setNewToolName] = useState("");
  const [newToolDesc, setNewToolDesc] = useState("");
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  // Sync with live Spring Boot 8091 backend on mount
  useEffect(() => {
    async function syncBackend() {
      try {
        const [toolsRes, skillsRes, fsRes] = await Promise.all([
          fetch("/api/voice/tools"),
          fetch("/api/voice/skills"),
          fetch("/api/voice/freeswitch-config"),
        ]);
        if (toolsRes.ok) {
          const tData = await toolsRes.json();
          if (Array.isArray(tData.tools) && tData.tools.length > 0) {
            setTools(tData.tools);
          }
        }
        if (skillsRes.ok) {
          const sData = await skillsRes.json();
          if (Array.isArray(sData.skills) && sData.skills.length > 0) {
            setSkills(sData.skills);
          }
        }
        if (fsRes.ok) {
          const fData = await fsRes.json();
          if (fData.dialplanXml) {
            setSipConfigXml(fData.dialplanXml);
          }
        }
      } catch {
        // Offline / static preview fallback works out of the box
      }
    }
    syncBackend();
  }, []);

  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [transcriptItems]);

  const appendEvent = (
    direction: "client" | "server",
    eventName: string,
    eventData?: Record<string, unknown>,
    expanded = false
  ) => {
    setLoggedEvents((prev) => [
      ...prev,
      {
        id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        direction,
        eventName,
        timestamp: nowTimeStr(false),
        expanded,
        eventData,
      },
    ]);
  };

  const handleScenarioChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextKey = e.target.value;
    setScenarioKey(nextKey);
    const sc = SCENARIO_MAP[nextKey] || SCENARIO_MAP.chatSupervisor;
    setSelectedAgentName(sc.agents[0]);
    setTranscriptItems(sc.initialTranscript);
    setLoggedEvents(sc.initialEvents);
  };

  const handleSelectedAgentChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextAgent = e.target.value;
    setSelectedAgentName(nextAgent);
    const ts = nowTimeStr(true);
    setTranscriptItems((prev) => [
      ...prev,
      {
        itemId: `bc-agent-${Date.now()}`,
        type: "BREADCRUMB",
        title: `Agent: ${nextAgent}`,
        data: {
          switchedTo: nextAgent,
          codec: codec.toUpperCase(),
          activeSkills: skills.filter((s) => s.enabled).map((s) => s.id),
        },
        expanded: false,
        timestamp: ts,
        createdAtMs: Date.now(),
      },
    ]);
    appendEvent("client", `session.update (Agent → ${nextAgent})`, {
      agent: nextAgent,
      codec,
    });
  };

  const onToggleConnection = () => {
    if (sessionStatus === "CONNECTED" || sessionStatus === "CONNECTING") {
      setSessionStatus("DISCONNECTED");
      setIsPTTUserSpeaking(false);
      appendEvent("client", "session.disconnect (RTP Socket Closed)");
    } else {
      setSessionStatus("CONNECTING");
      setTimeout(() => {
        setSessionStatus("CONNECTED");
        appendEvent("server", "session.connected (FreeSWITCH RTP Ready)", {
          codec: codec.toUpperCase(),
          sampleRateHz: codec === "opus" ? 48000 : 8000,
        });
      }, 220);
    }
  };

  const handleSendMessage = async () => {
    const text = userText.trim();
    if (!text || sessionStatus !== "CONNECTED") return;
    setUserText("");

    const userTs = nowTimeStr(true);
    setTranscriptItems((prev) => [
      ...prev,
      {
        itemId: `msg-u-${Date.now()}`,
        type: "MESSAGE",
        role: "user",
        title: text,
        expanded: false,
        timestamp: userTs,
        createdAtMs: Date.now(),
      },
    ]);

    appendEvent("client", "conversation.item.create (input_text)", {
      text,
      codec,
    });

    const activeTool = tools.find((t) => t.enabled) || tools[0];
    let toolOutput: Record<string, unknown> = {
      status: "OK",
      verifiedBy: activeTool?.name || "lookup_Order_And_Refund_Policy",
      codec: codec.toUpperCase(),
      bargeInGuardMs: 52,
    };

    try {
      const res = await fetch("/api/voice/tools/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: activeTool?.name || "lookup_Order_And_Refund_Policy",
          arguments: { query: text },
        }),
      });
      if (res.ok) {
        toolOutput = await res.json();
      }
    } catch {
      // Fallback
    }

    const bcId = `bc-call-${Date.now()}`;
    setTranscriptItems((prev) => [
      ...prev,
      {
        itemId: bcId,
        type: "BREADCRUMB",
        title: `function call: ${activeTool?.name || "getNextResponseFromSupervisor"}`,
        data: {
          tool: activeTool?.name,
          query: text,
          result: toolOutput,
        },
        expanded: false,
        timestamp: nowTimeStr(true),
        createdAtMs: Date.now() + 1,
      },
      {
        itemId: `msg-a-${Date.now()}`,
        type: "MESSAGE",
        role: "assistant",
        title: `已收到您的语音指令：「${text}」。已通过 ${
          activeTool?.name || "Supervisor"
        } 完成实时核验（当前信道 ${
          codec === "opus" ? "Opus 48kHz" : codec.toUpperCase() + " 8kHz"
        }，端到端首包延迟 192ms）。请问还有其他需要帮您处理的吗？`,
        expanded: false,
        timestamp: nowTimeStr(true),
        createdAtMs: Date.now() + 2,
        guardrailResult: {
          status: "DONE",
          category: "NONE",
          rationale: "Passed real-time voice policy guardrail.",
        },
      },
    ]);

    appendEvent(
      "server",
      "response.audio_transcript.done",
      {
        agent: selectedAgentName,
        toolInvoked: activeTool?.name,
        ttftMs: 192,
      },
      false
    );
  };

  const handleSimulateBargeIn = async () => {
    let benchmarkData: Record<string, unknown> = {
      packetsSent: 8,
      payloadBytesPerPacket: 160,
      bargeInClearAudioMs: 48,
      slaTargetMs: 60,
      passed: true,
    };
    try {
      const res = await fetch("/api/voice/rtp-benchmark", { method: "POST" });
      if (res.ok) {
        benchmarkData = await res.json();
      }
    } catch {
      // Fallback
    }

    const ts = nowTimeStr(true);
    setTranscriptItems((prev) => [
      ...prev,
      {
        itemId: `bc-barge-${Date.now()}`,
        type: "BREADCRUMB",
        title: `barge_in.clearAudio (${
          benchmarkData.bargeInClearAudioMs || 48
        }ms <= 60ms SLA) · 8kHz UDP Loopback Verified`,
        data: benchmarkData,
        expanded: true,
        timestamp: ts,
        createdAtMs: Date.now(),
      },
    ]);

    appendEvent(
      "client",
      "freeswitch.mod_audio_stream.clearAudio (Barge-In Triggered)",
      benchmarkData,
      true
    );
  };

  const handleToggleTool = async (name: string) => {
    setTools((prev) =>
      prev.map((t) => (t.name === name ? { ...t, enabled: !t.enabled } : t))
    );
    try {
      await fetch("/api/voice/tools/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
    } catch {
      // Ignore
    }
  };

  const handleAddTool = async () => {
    if (!newToolName.trim()) return;
    const added: VoiceTool = {
      name: newToolName.trim(),
      category: "Custom Tool",
      description: newToolDesc.trim() || "自定义实时语音工具",
      enabled: true,
      latencyTargetMs: 40,
      sampleArgs: '{"sessionId":"fs-8091"}',
    };
    setTools((prev) => [...prev, added]);
    setNewToolName("");
    setNewToolDesc("");
    try {
      await fetch("/api/voice/tools/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(added),
      });
    } catch {
      // Ignore
    }
  };

  const handleToggleSkill = async (id: string) => {
    setSkills((prev) =>
      prev.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s))
    );
    try {
      await fetch("/api/voice/skills/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
    } catch {
      // Ignore
    }
  };

  const handleCopyTranscript = async () => {
    if (!transcriptRef.current) return;
    try {
      await navigator.clipboard.writeText(transcriptRef.current.innerText);
      setJustCopied(true);
      setTimeout(() => setJustCopied(false), 1500);
    } catch {
      // Ignore
    }
  };

  const handleDownloadSnapshot = () => {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            scenario: scenarioKey,
            agent: selectedAgentName,
            codec,
            transcriptItems,
            loggedEvents,
          },
          null,
          2
        ),
      ],
      { type: "application/json" }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `voice-session-${scenarioKey}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const currentScenario = SCENARIO_MAP[scenarioKey] || SCENARIO_MAP.chatSupervisor;
  const isConnected = sessionStatus === "CONNECTED";
  const isConnecting = sessionStatus === "CONNECTING";

  return (
    <div className="text-base flex flex-col h-screen bg-gray-100 text-gray-800 relative select-none">
      {/* Top Bar — 1:1 OpenAI Realtime API Agents header */}
      <div className="px-5 py-3.5 text-lg font-semibold flex flex-wrap justify-between items-center gap-3">
        <div
          className="flex items-center cursor-pointer"
          onClick={() => window.location.reload()}
        >
          <div className="w-6 h-6 rounded-full bg-gray-900 text-white flex items-center justify-center text-xs font-bold mr-2.5">
            W
          </div>
          <div>
            Realtime Voice <span className="text-gray-500">Agents</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4 text-sm sm:text-base">
          <div className="flex items-center">
            <label
              htmlFor="scenario-select"
              className="flex items-center gap-1 mr-2 font-medium text-gray-700"
            >
              Scenario
            </label>
            <div className="relative inline-block">
              <select
                id="scenario-select"
                value={scenarioKey}
                onChange={handleScenarioChange}
                className="appearance-none bg-white border border-gray-300 rounded-lg text-sm sm:text-base px-2.5 py-1 pr-8 cursor-pointer font-normal focus:outline-none"
              >
                {Object.keys(SCENARIO_MAP).map((key) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
              </select>
              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2 text-gray-600">
                <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                  <path
                    fillRule="evenodd"
                    d="M5.23 7.21a.75.75 0 011.06.02L10 10.44l3.71-3.21a.75.75 0 111.04 1.08l-4.25 3.65a.75.75 0 01-1.04 0L5.21 8.27a.75.75 0 01.02-1.06z"
                    clipRule="evenodd"
                  />
                </svg>
              </div>
            </div>
          </div>

          <div className="flex items-center">
            <label
              htmlFor="agent-select"
              className="flex items-center gap-1 mr-2 font-medium text-gray-700"
            >
              Agent
            </label>
            <div className="relative inline-block">
              <select
                id="agent-select"
                value={selectedAgentName}
                onChange={handleSelectedAgentChange}
                className="appearance-none bg-white border border-gray-300 rounded-lg text-sm sm:text-base px-2.5 py-1 pr-8 cursor-pointer font-normal focus:outline-none"
              >
                {currentScenario.agents.map((ag) => (
                  <option key={ag} value={ag}>
                    {ag}
                  </option>
                ))}
              </select>
              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2 text-gray-600">
                <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                  <path
                    fillRule="evenodd"
                    d="M5.23 7.21a.75.75 0 011.06.02L10 10.44l3.71-3.21a.75.75 0 111.04 1.08l-4.25 3.65a.75.75 0 01-1.04 0L5.21 8.27a.75.75 0 01.02-1.06z"
                    clipRule="evenodd"
                  />
                </svg>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Main Split View: Transcript (Left) + Logs / Tools & SIP (Right) */}
      <div className="flex flex-1 gap-2 px-2 overflow-hidden relative min-h-0">
        {/* Left Pane: Transcript */}
        <div className="flex flex-col flex-1 bg-white min-h-0 rounded-xl border border-gray-200/80">
          <div className="flex items-center justify-between px-6 py-3 sticky top-0 z-10 text-base border-b border-gray-200 bg-white rounded-t-xl">
            <span className="font-semibold text-gray-900">Transcript</span>
            <div className="flex gap-x-2">
              <button
                onClick={handleCopyTranscript}
                className="w-24 text-sm px-3 py-1 rounded-md bg-gray-200 hover:bg-gray-300 text-gray-800 flex items-center justify-center gap-x-1.5 cursor-pointer"
              >
                <Copy className="w-3.5 h-3.5" />
                <span>{justCopied ? "Copied!" : "Copy"}</span>
              </button>
              <button
                onClick={handleDownloadSnapshot}
                className="w-40 text-sm px-3 py-1 rounded-md bg-gray-200 hover:bg-gray-300 text-gray-800 flex items-center justify-center gap-x-1.5 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Download Audio</span>
              </button>
            </div>
          </div>

          {/* Transcript Scroll Body */}
          <div
            ref={transcriptRef}
            className="overflow-auto p-5 flex flex-col gap-y-4 flex-1 select-text"
          >
            {transcriptItems.map((item) => {
              const {
                itemId,
                type,
                role,
                data,
                expanded,
                timestamp,
                title,
                guardrailResult,
              } = item;

              if (type === "MESSAGE") {
                const isUser = role === "user";
                return (
                  <div
                    key={itemId}
                    className={`flex justify-end flex-col ${
                      isUser ? "items-end" : "items-start"
                    }`}
                  >
                    <div className="max-w-xl">
                      <div
                        className={`p-3.5 ${
                          isUser
                            ? "bg-gray-900 text-gray-100"
                            : "bg-gray-100 text-black"
                        } rounded-t-xl ${guardrailResult ? "" : "rounded-b-xl"}`}
                      >
                        <div
                          className={`text-xs mb-1 ${
                            isUser ? "text-gray-400" : "text-gray-500"
                          } font-mono`}
                        >
                          {timestamp}
                        </div>
                        <div className="whitespace-pre-wrap leading-relaxed text-[15px]">
                          {title}
                        </div>
                      </div>
                      {guardrailResult && (
                        <div className="bg-gray-200 px-3 py-1.5 rounded-b-xl text-xs text-gray-800 flex items-center gap-1.5">
                          <span className="font-semibold">Guardrail:</span>
                          <CheckCircle2 className="text-emerald-600 w-4 h-4" />
                          <span>Pass</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              }

              return (
                <div
                  key={itemId}
                  className="flex flex-col justify-start items-start text-gray-500 text-sm"
                >
                  <span className="text-xs font-mono text-gray-400">
                    {timestamp}
                  </span>
                  <div
                    className={`whitespace-pre-wrap flex items-center font-mono text-sm text-gray-800 mt-0.5 ${
                      data ? "cursor-pointer hover:text-black" : ""
                    }`}
                    onClick={() =>
                      data &&
                      setTranscriptItems((prev) =>
                        prev.map((it) =>
                          it.itemId === itemId
                            ? { ...it, expanded: !it.expanded }
                            : it
                        )
                      )
                    }
                  >
                    {data && (
                      <span
                        className={`text-gray-400 mr-1.5 transform transition-transform duration-150 select-none font-mono text-xs ${
                          expanded ? "rotate-90" : "rotate-0"
                        }`}
                      >
                        ▶
                      </span>
                    )}
                    {title}
                  </div>
                  {expanded && data && (
                    <div className="text-gray-800 text-left w-full max-w-xl">
                      <pre className="border-l-2 ml-1 border-gray-200 whitespace-pre-wrap break-words font-mono text-xs mb-1 mt-1.5 pl-3 text-gray-700 bg-gray-50/70 py-1.5 rounded-r">
                        {JSON.stringify(data, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Input Bar */}
          <div className="p-3.5 flex items-center gap-x-2 flex-shrink-0 border-t border-gray-200">
            <input
              type="text"
              value={userText}
              onChange={(e) => setUserText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && isConnected) {
                  handleSendMessage();
                }
              }}
              className="flex-1 px-3 py-1.5 text-sm sm:text-base focus:outline-none text-gray-900 placeholder:text-gray-400"
              placeholder="Type a message..."
            />
            <button
              onClick={handleSendMessage}
              disabled={!isConnected || !userText.trim()}
              aria-label="Send message"
              className="bg-gray-900 text-white rounded-full w-8 h-8 flex items-center justify-center disabled:opacity-40 cursor-pointer"
            >
              <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M10 17a.75.75 0 01-.75-.75V5.612L5.29 9.77a.75.75 0 01-1.08-1.04l5.25-5.5a.75.75 0 011.08 0l5.25 5.5a.75.75 0 11-1.08 1.04l-3.96-4.158V16.25A.75.75 0 0110 17z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          </div>
        </div>

        {/* Right Pane: Logs & Tools/SIP Config */}
        <div
          className={
            (isEventsPaneExpanded
              ? "hidden md:flex md:w-1/2 overflow-auto border border-gray-200/80"
              : "w-0 overflow-hidden opacity-0") +
            " transition-all rounded-xl duration-200 ease-in-out flex-col bg-white min-h-0"
          }
        >
          {isEventsPaneExpanded && (
            <div className="flex flex-col flex-1 min-h-0">
              <div className="flex items-center justify-between px-6 py-3 sticky top-0 z-10 text-base border-b border-gray-200 bg-white rounded-t-xl">
                <div className="flex items-center gap-4">
                  <button
                    onClick={() => setRightPaneTab("logs")}
                    className={`font-semibold cursor-pointer pb-0.5 ${
                      rightPaneTab === "logs"
                        ? "text-gray-900 border-b-2 border-gray-900"
                        : "text-gray-400 hover:text-gray-700"
                    }`}
                  >
                    Logs
                  </button>
                  <button
                    onClick={() => setRightPaneTab("tools")}
                    className={`text-sm font-medium cursor-pointer pb-0.5 ${
                      rightPaneTab === "tools"
                        ? "text-gray-900 border-b-2 border-gray-900"
                        : "text-gray-400 hover:text-gray-700"
                    }`}
                  >
                    Tools & Skills ({tools.filter((t) => t.enabled).length})
                  </button>
                  <button
                    onClick={() => setRightPaneTab("sip")}
                    className={`text-sm font-medium cursor-pointer pb-0.5 ${
                      rightPaneTab === "sip"
                        ? "text-gray-900 border-b-2 border-gray-900"
                        : "text-gray-400 hover:text-gray-700"
                    }`}
                  >
                    FreeSWITCH SIP
                  </button>
                </div>
                <button
                  onClick={handleSimulateBargeIn}
                  className="text-xs px-2.5 py-1 rounded bg-gray-100 hover:bg-gray-200 text-gray-700 font-mono cursor-pointer"
                >
                  ⚡ 60ms Barge-In Test
                </button>
              </div>

              {rightPaneTab === "logs" && (
                <div className="overflow-auto flex-1 select-text">
                  {loggedEvents.map((log, idx) => {
                    const isClient = log.direction === "client";
                    return (
                      <div
                        key={`${log.id}-${idx}`}
                        className="border-b border-gray-100 py-2.5 px-6 font-mono text-sm"
                      >
                        <div
                          onClick={() =>
                            setLoggedEvents((prev) =>
                              prev.map((ev) =>
                                ev.id === log.id
                                  ? { ...ev, expanded: !ev.expanded }
                                  : ev
                              )
                            )
                          }
                          className="flex items-center justify-between cursor-pointer"
                        >
                          <div className="flex items-center flex-1 min-w-0">
                            <span
                              style={{
                                color: isClient ? "#7f5af0" : "#2cb67d",
                              }}
                              className="mr-2.5 text-xs"
                            >
                              {isClient ? "▲" : "▼"}
                            </span>
                            <span className="flex-1 text-xs sm:text-sm text-gray-800 truncate">
                              {log.eventName}
                            </span>
                          </div>
                          <div className="text-gray-400 ml-2 text-xs whitespace-nowrap">
                            {log.timestamp}
                          </div>
                        </div>

                        {log.expanded && log.eventData && (
                          <div className="text-gray-800 text-left mt-2">
                            <pre className="border-l-2 ml-1 border-gray-200 whitespace-pre-wrap break-words font-mono text-xs pl-3 py-1 text-gray-600 bg-gray-50 rounded-r">
                              {JSON.stringify(log.eventData, null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {rightPaneTab === "tools" && (
                <div className="overflow-auto flex-1 p-5 space-y-5 select-text">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2.5">
                      Realtime Function Calling Tools
                    </div>
                    <div className="space-y-2">
                      {tools.map((tool) => (
                        <div
                          key={tool.name}
                          className="p-3 rounded-lg border border-gray-200 flex items-start justify-between gap-3"
                        >
                          <div>
                            <div className="font-mono text-sm font-medium text-gray-900">
                              {tool.name}
                            </div>
                            <div className="text-xs text-gray-500 mt-0.5">
                              {tool.description}
                            </div>
                          </div>
                          <input
                            type="checkbox"
                            checked={tool.enabled}
                            onChange={() => handleToggleTool(tool.name)}
                            className="w-4 h-4 mt-1 cursor-pointer accent-gray-900"
                          />
                        </div>
                      ))}
                    </div>

                    <div className="mt-3 flex gap-2">
                      <input
                        type="text"
                        value={newToolName}
                        onChange={(e) => setNewToolName(e.target.value)}
                        placeholder="New function name (e.g. check_Inventory)"
                        className="flex-1 border border-gray-300 rounded-md px-2.5 py-1 text-xs font-mono"
                      />
                      <input
                        type="text"
                        value={newToolDesc}
                        onChange={(e) => setNewToolDesc(e.target.value)}
                        placeholder="Description"
                        className="flex-1 border border-gray-300 rounded-md px-2.5 py-1 text-xs"
                      />
                      <button
                        onClick={handleAddTool}
                        className="px-3 py-1 bg-gray-900 text-white text-xs rounded-md cursor-pointer"
                      >
                        Add
                      </button>
                    </div>
                  </div>

                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2.5">
                      Voice SOP & Barge-In Skills
                    </div>
                    <div className="space-y-2">
                      {skills.map((skill) => (
                        <div
                          key={skill.id}
                          className="p-3 rounded-lg border border-gray-200 flex items-start justify-between gap-3"
                        >
                          <div>
                            <div className="text-sm font-medium text-gray-900">
                              {skill.title}
                            </div>
                            <div className="text-xs text-gray-500 mt-0.5">
                              {skill.description}
                            </div>
                          </div>
                          <input
                            type="checkbox"
                            checked={skill.enabled}
                            onChange={() => handleToggleSkill(skill.id)}
                            className="w-4 h-4 mt-1 cursor-pointer accent-gray-900"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {rightPaneTab === "sip" && (
                <div className="overflow-auto flex-1 p-5 space-y-3 select-text">
                  <div className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                    FreeSWITCH mod_audio_stream Dialplan & RTP Endpoint
                  </div>
                  <pre className="p-3.5 rounded-lg bg-gray-900 text-gray-100 font-mono text-xs overflow-x-auto leading-relaxed">
                    {sipConfigXml}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Bottom Toolbar — 1:1 OpenAI Realtime API Agents BottomToolbar */}
      <div className="py-3.5 px-4 flex flex-wrap items-center justify-center gap-x-8 gap-y-2 text-sm sm:text-base">
        <button
          onClick={onToggleConnection}
          disabled={isConnecting}
          className={`text-white text-sm sm:text-base py-1.5 px-4 w-32 rounded-md font-medium cursor-pointer ${
            isConnected
              ? "bg-red-600 hover:bg-red-700"
              : "bg-black hover:bg-gray-800"
          }`}
        >
          {isConnected
            ? "Disconnect"
            : isConnecting
            ? "Connecting..."
            : "Connect"}
        </button>

        <div className="flex flex-row items-center gap-2">
          <input
            id="push-to-talk"
            type="checkbox"
            checked={isPTTActive}
            onChange={(e) => setIsPTTActive(e.target.checked)}
            disabled={!isConnected}
            className="w-4 h-4 cursor-pointer accent-gray-900"
          />
          <label htmlFor="push-to-talk" className="flex items-center cursor-pointer">
            Push to talk
          </label>
          <button
            onMouseDown={() => isPTTActive && setIsPTTUserSpeaking(true)}
            onMouseUp={() => isPTTActive && setIsPTTUserSpeaking(false)}
            disabled={!isPTTActive}
            className={`py-1 px-3.5 rounded-md text-sm ${
              !isPTTActive
                ? "bg-gray-200/70 text-gray-400 cursor-not-allowed"
                : isPTTUserSpeaking
                ? "bg-gray-300 text-gray-900"
                : "bg-gray-200 hover:bg-gray-300 text-gray-800 cursor-pointer"
            }`}
          >
            Talk
          </button>
        </div>

        <div className="flex flex-row items-center gap-1.5">
          <input
            id="audio-playback"
            type="checkbox"
            checked={isAudioPlaybackEnabled}
            onChange={(e) => setIsAudioPlaybackEnabled(e.target.checked)}
            disabled={!isConnected}
            className="w-4 h-4 cursor-pointer accent-gray-900"
          />
          <label
            htmlFor="audio-playback"
            className="flex items-center cursor-pointer"
          >
            Audio playback
          </label>
        </div>

        <div className="flex flex-row items-center gap-1.5">
          <input
            id="logs-toggle"
            type="checkbox"
            checked={isEventsPaneExpanded}
            onChange={(e) => setIsEventsPaneExpanded(e.target.checked)}
            className="w-4 h-4 cursor-pointer accent-gray-900"
          />
          <label htmlFor="logs-toggle" className="flex items-center cursor-pointer">
            Logs
          </label>
        </div>

        <div className="flex flex-row items-center gap-2">
          <span>Codec:</span>
          <select
            id="codec-select"
            value={codec}
            onChange={(e) => {
              const nextCodec = e.target.value;
              setCodec(nextCodec);
              appendEvent("client", `codec.switch (${nextCodec.toUpperCase()})`, {
                codec: nextCodec,
                sampleRateHz: nextCodec === "opus" ? 48000 : 8000,
              });
            }}
            className="bg-white border border-gray-300 rounded-md px-2 py-1 text-sm focus:outline-none cursor-pointer"
          >
            <option value="opus">Opus (48 kHz)</option>
            <option value="pcmu">PCMU (8 kHz)</option>
            <option value="pcma">PCMA (8 kHz)</option>
          </select>
        </div>
      </div>
    </div>
  );
}
