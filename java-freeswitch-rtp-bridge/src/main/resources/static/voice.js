(() => {
  const $ = (id) => document.getElementById(id);
  let ws = null;
  let activeBotTurnEl = null;
  let currentScene = "gpu_order";
  let micStream = null;
  let micTimer = null;
  const frameLogs = [];

  // 初始化 16 个环形缓冲区槽位
  const slotsContainer = $("ring-slots");
  for (let i = 0; i < 16; i++) {
    const s = document.createElement("div");
    s.className = "ring-slot";
    slotsContainer.appendChild(s);
  }

  function renderRingQueue(depth, flushed = false) {
    const children = slotsContainer.children;
    for (let i = 0; i < children.length; i++) {
      children[i].className = "ring-slot" + (flushed ? " flushed" : i < depth ? " filled" : "");
    }
    if (flushed) {
      setTimeout(() => renderRingQueue(0, false), 320);
    }
  }

  function logWsFrame(direction, payload) {
    const line = `[${new Date().toISOString().slice(11, 23)}] ${direction} ${JSON.stringify(payload)}`;
    frameLogs.unshift(line);
    if (frameLogs.length > 30) frameLogs.pop();
    const box = $("ws-frame-log");
    if (box) box.textContent = frameLogs.join("\n\n");
  }

  function speakBrowserTts(text) {
    if (!$("chk-browser-tts").checked || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "zh-CN";
    u.rate = 1.1;
    window.speechSynthesis.speak(u);
  }

  function stopBrowserTts() {
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }

  $("btn-theme").addEventListener("click", () => {
    const html = document.documentElement;
    const next = html.getAttribute("data-theme") === "dark" ? "light" : "dark";
    html.setAttribute("data-theme", next);
    $("btn-theme").textContent = next === "dark" ? "亮色模式" : "暗色模式";
  });

  document.querySelectorAll(".drawer-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".drawer-tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".drawer-pane").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      $(tab.getAttribute("data-tab")).classList.add("active");
    });
  });

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function appendDialogue(kind, meta, text) {
    const box = document.createElement("div");
    box.className = `turn-box ${kind}`;
    box.innerHTML = `<div class="turn-meta"><span>${escapeHtml(meta)}</span></div><div class="turn-text">${escapeHtml(
      text
    )}</div>`;
    $("dialogue-list").appendChild(box);
    $("dialogue-list").scrollTop = $("dialogue-list").scrollHeight;
    return box;
  }

  function connectWs() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/ws/voice-console`);
    ws.onopen = () => {
      $("call-state").textContent = "WS_READY · BARGE-IN ARMED";
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      logWsFrame("<-", msg);
      if (msg.state) $("call-state").textContent = msg.state;

      if (msg.type === "TELEMETRY") {
        $("queue-depth-text").textContent = `积压: ${msg.outboundQueue} 帧 | 上行 RMS: ${msg.inboundRms}`;
        renderRingQueue(msg.outboundQueue);
      } else if (msg.type === "CALL_EVENT") {
        $("dialogue-list").innerHTML = "";
        activeBotTurnEl = null;
        appendDialogue("user", "SIP/RTP CALL INBOUND", `${msg.title} — ${msg.detail}`);
      } else if (msg.type === "ASR_FINAL") {
        const tag =
          msg.speaker === "USER_BARGE_IN"
            ? `用户实时插话 (Barge-in Utterance) · SenseVoice ASR ${msg.asrMs}ms`
            : `主叫用户 · SenseVoice ASR ${msg.asrMs}ms`;
        appendDialogue(msg.speaker === "USER_BARGE_IN" ? "barge" : "user", tag, msg.text);
        activeBotTurnEl = null;
      } else if (msg.type === "TTS_FIRST_PACKET") {
        $("kpi-ttfb").textContent = `${msg.ttfbMs} ms`;
        renderRingQueue(msg.outboundQueue);
        activeBotTurnEl = appendDialogue("bot", `AI 语音客服 · 首包 TTFB=${msg.ttfbMs}ms (流式播报中...)`, "");
      } else if (msg.type === "BOT_TOKEN") {
        if (activeBotTurnEl) {
          activeBotTurnEl.querySelector(".turn-text").textContent = msg.partialText + " ▍";
        }
        $("queue-depth-text").textContent = `积压: ${msg.outboundQueue} 帧 | 上行 RMS: ${msg.inboundRms}`;
        renderRingQueue(msg.outboundQueue);
      } else if (msg.type === "BARGE_IN_CLEAR") {
        stopBrowserTts();
        $("kpi-barge-ms").textContent = `${msg.confirmMs} ms`;
        $("kpi-clear-ms").textContent = `${msg.clearSignalMs} ms`;
        $("kpi-dropped").textContent = `${msg.droppedFrames} 帧`;
        renderRingQueue(0, true);
        if (activeBotTurnEl && msg.spokenBeforeInterrupt) {
          activeBotTurnEl.querySelector(".turn-text").textContent =
            msg.spokenBeforeInterrupt + " [已由边缘打断瞬时截断]";
        }
        appendDialogue(
          "barge",
          `BARGE-IN INTERRUPT · 确认=${msg.confirmMs}ms | 信令清空=${msg.clearSignalMs}ms | 丢弃未播报 RTP=${msg.droppedFrames}帧`,
          `向 FreeSWITCH 下发控制指令: ${msg.clearCommand}`
        );
      } else if (msg.type === "BOT_FINAL_TURN") {
        $("kpi-ttfb").textContent = `${msg.ttfbMs} ms`;
        renderRingQueue(msg.outboundQueue);
        appendDialogue("bot", `AI 语音客服 (打断后无缝响应) · TTFB=${msg.ttfbMs}ms`, msg.text);
        speakBrowserTts(msg.text);
      } else if (msg.type === "CALL_IDLE") {
        renderRingQueue(msg.outboundQueue || 0);
        $("queue-depth-text").textContent = `积压: ${msg.outboundQueue || 0} 帧 | 上行 RMS: ${msg.inboundRms}`;
      }
    };
  }

  function startSceneCall(scene, autoBargeIn = true) {
    currentScene = scene;
    document.querySelectorAll(".session-item").forEach((b) => {
      b.classList.toggle("active", b.getAttribute("data-scene") === scene);
    });
    if (ws && ws.readyState === WebSocket.OPEN) {
      const payload = { action: "start_demo_call", scene, autoBargeIn };
      logWsFrame("->", payload);
      ws.send(JSON.stringify(payload));
    }
  }

  document.querySelectorAll(".session-item").forEach((item) => {
    item.addEventListener("click", () => startSceneCall(item.getAttribute("data-scene"), true));
  });

  $("btn-start-call").addEventListener("click", () => startSceneCall(currentScene, true));

  $("btn-manual-barge").addEventListener("click", () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const payload = { action: "trigger_barge_in", text: $("barge-input").value.trim() };
      logWsFrame("->", payload);
      ws.send(JSON.stringify(payload));
      $("barge-input").value = "";
    }
  });

  $("btn-send-barge").addEventListener("click", () => {
    const text = $("barge-input").value.trim() || "我现在急用，请立即中止当前播报并帮我转接值班架构师！";
    if (ws && ws.readyState === WebSocket.OPEN) {
      const payload = { action: "custom_utterance", text };
      logWsFrame("->", payload);
      ws.send(JSON.stringify(payload));
      $("barge-input").value = "";
    }
  });

  $("barge-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("btn-send-barge").click();
    }
  });

  // 浏览器真实麦克风 WebAudio RMS 采集联动
  $("btn-mic-toggle").addEventListener("click", async () => {
    if (micStream) {
      clearInterval(micTimer);
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
      $("btn-mic-toggle").textContent = "开启麦克风 VAD 实测";
      return;
    }
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(micStream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      $("btn-mic-toggle").textContent = "停止麦克风 (说话即打断)";
      micTimer = setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.round(Math.sqrt(sum / buf.length) * 32767);
        $("queue-depth-text").textContent = `麦克风实时 RMS: ${rms}`;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ action: "mic_rms", rms }));
        }
      }, 25);
    } catch (err) {
      alert("当前环境未授权麦克风，可直接使用下方插话输入框或「立即插话打断」按钮测试！");
    }
  });

  // 右侧 UDP 压测与 FreeSWITCH 配置加载
  async function loadOverviewAndUdpBench() {
    const [ov, bench, fsCfg] = await Promise.all([
      (await fetch("/api/voice/overview")).json(),
      (await fetch("/api/voice/rtp-benchmark", { method: "POST" })).json(),
      (await fetch("/api/voice/freeswitch-config")).json(),
    ]);
    $("mode-label").textContent = ov.effectiveMode;
    $("v-cfg-rms").value = ov.vadThresholdRms;
    $("v-cfg-frames").value = ov.bargeInConfirmFrames;

    $("bench-summary").innerHTML = `
      <div class="b-card"><span>UDP 端口</span><strong>:${bench.udpLocalPort}</strong></div>
      <div class="b-card"><span>丢弃旧帧</span><strong>${bench.droppedOutboundFrames} 帧</strong></div>
      <div class="b-card"><span>回路耗时</span><strong>${bench.totalSocketRoundtripMs} ms</strong></div>
    `;

    $("packet-list").innerHTML = (bench.traces || [])
      .map(
        (t) => `
      <div class="pkt-row ${t.bargeInTriggered ? "barge" : ""}">
        <span>SEQ #${t.seq} (ts=${t.timestamp})</span>
        <span>RMS=${t.rms}</span>
        <span>${t.bargeInTriggered ? "BARGE-IN FLUSH" : t.voiceActive ? "VOICE_ACTIVE" : "SILENCE"}</span>
      </div>`
      )
      .join("");

    $("udp-output").textContent = JSON.stringify(bench, null, 2);
    $("fs-xml-box").textContent = fsCfg.dialplanXml;
    $("fs-env-box").textContent = fsCfg.envTemplate;
  }

  $("btn-udp-bench").addEventListener("click", loadOverviewAndUdpBench);
  $("btn-copy-xml").addEventListener("click", () => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText($("fs-xml-box").textContent);
      $("btn-copy-xml").textContent = "已复制";
      setTimeout(() => ($("btn-copy-xml").textContent = "复制 XML"), 1200);
    }
  });

  // 设置弹窗
  $("btn-open-settings").addEventListener("click", () => $("voice-settings-modal").classList.remove("hidden"));
  $("btn-close-settings").addEventListener("click", () => $("voice-settings-modal").classList.add("hidden"));
  $("btn-cancel-settings").addEventListener("click", () => $("voice-settings-modal").classList.add("hidden"));

  $("btn-save-settings").addEventListener("click", async () => {
    const res = await fetch("/api/voice/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vadThresholdRms: Number($("v-cfg-rms").value),
        bargeInConfirmFrames: Number($("v-cfg-frames").value),
        baseUrl: $("v-cfg-baseurl").value,
        model: $("v-cfg-model").value,
        apiKey: $("v-cfg-apikey").value,
      }),
    });
    const ov = await res.json();
    $("mode-label").textContent = ov.effectiveMode;
    $("kpi-barge-ms").textContent = `${ov.bargeInConfirmMs} ms`;
    $("voice-settings-modal").classList.add("hidden");
  });

  // 首屏同步预渲染完整 5 步双轮打断实录
  appendDialogue("user", "主叫用户 · SenseVoice ASR 46ms", "你好，帮我查一下昨天开通的杭州区 GPU 云服务器订单进度。");
  appendDialogue("bot", "AI 语音客服 · 首包 TTFB=76.4ms", "您好，我是智能语音客服。已为您查到杭州区 GPU 实例订单尾号八八六 [已由边缘打断瞬时截断]");
  appendDialogue(
    "barge",
    "BARGE-IN INTERRUPT · 确认=60ms | 信令清空=0.16ms | 丢弃未播报 RTP=12帧",
    '向 FreeSWITCH 下发控制指令: {"event":"clearAudio","callUuid":"fs-call-886","reason":"edge_vad_60ms"}'
  );
  appendDialogue(
    "barge",
    "用户实时插话 (Barge-in Utterance) · SenseVoice ASR 42ms",
    "不用等分发了，我现在急用，直接帮我切换到现货可用区或者转专属架构师！"
  );
  appendDialogue(
    "bot",
    "AI 语音客服 (打断后无缝响应) · TTFB=72.1ms",
    "明白，已立即中止原播报！上海二区当前有现货 A100 实例，我现在为您一键热迁移并同步接通值班架构师。"
  );
  renderRingQueue(6);
  logWsFrame("<-", {
    type: "BARGE_IN_CLEAR",
    confirmMs: 60,
    clearSignalMs: 0.16,
    droppedFrames: 12,
    clearCommand: '{"event":"clearAudio","callUuid":"fs-call-886","reason":"edge_vad_60ms"}',
  });

  loadOverviewAndUdpBench();
  connectWs();
})();
