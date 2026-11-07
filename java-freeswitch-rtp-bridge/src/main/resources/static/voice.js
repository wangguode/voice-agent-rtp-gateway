(() => {
  const $ = (id) => document.getElementById(id);
  let ws = null;
  let activeBotTurnEl = null;
  let micStream = null;
  let micTimer = null;

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

  $("btn-theme").addEventListener("click", () => {
    const html = document.documentElement;
    const next = html.getAttribute("data-theme") === "dark" ? "light" : "dark";
    html.setAttribute("data-theme", next);
    $("btn-theme").textContent = next === "dark" ? "亮色模式" : "暗色模式";
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
      if (msg.state) $("call-state").textContent = msg.state;

      if (msg.type === "TELEMETRY") {
        $("queue-depth-text").textContent = `积压: ${msg.outboundQueue} 帧 | 上行 RMS: ${msg.inboundRms}`;
        renderRingQueue(msg.outboundQueue);
      } else if (msg.type === "CALL_EVENT") {
        $("dialogue-list").innerHTML = "";
        activeBotTurnEl = null;
        appendDialogue("user", "SIP/RTP CALL INBOUND", `${msg.title} — ${msg.detail}`);
      } else if (msg.type === "ASR_FINAL") {
        const tag = msg.speaker === "USER_BARGE_IN" ? "用户插话 (Barge-in Utterance) · ASR " + msg.asrMs + "ms" : "主叫用户 · SenseVoice ASR " + msg.asrMs + "ms";
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
        $("kpi-barge-ms").textContent = `${msg.confirmMs} ms`;
        $("kpi-clear-ms").textContent = `${msg.clearSignalMs} ms`;
        $("kpi-dropped").textContent = `${msg.droppedFrames} 帧`;
        renderRingQueue(0, true);
        if (activeBotTurnEl) {
          activeBotTurnEl.querySelector(".turn-text").textContent = msg.spokenBeforeInterrupt + " [已由边缘打断瞬时截断]";
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
      } else if (msg.type === "CALL_IDLE") {
        renderRingQueue(0);
        $("queue-depth-text").textContent = `积压: 0 帧 | 上行 RMS: ${msg.inboundRms}`;
      }
    };
  }

  $("btn-start-call").addEventListener("click", () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action: "start_demo_call", autoBargeIn: true }));
    }
  });

  $("btn-manual-barge").addEventListener("click", () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action: "trigger_barge_in" }));
    }
  });

  // 浏览器真实麦克风 WebAudio RMS 采集联动
  $("btn-mic-toggle").addEventListener("click", async () => {
    if (micStream) {
      clearInterval(micTimer);
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
      $("btn-mic-toggle").textContent = "开启浏览器麦克风 VAD 实测";
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
      $("btn-mic-toggle").textContent = "停止麦克风采集 (开口说话即可触发打断)";
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
      alert("当前环境无法打开麦克风，可直接使用左侧「启动全双工来电」与「立即插话打断」按钮测试！");
    }
  });

  async function loadOverviewAndUdpBench() {
    const ov = await (await fetch("/api/voice/overview")).json();
    $("mode-label").textContent = `${ov.effectiveMode} · Java ${ov.javaVersion}`;
    const bench = await (await fetch("/api/voice/rtp-benchmark", { method: "POST" })).json();
    $("udp-output").textContent = JSON.stringify(bench, null, 2);
  }

  $("btn-udp-bench").addEventListener("click", loadOverviewAndUdpBench);

  // 预渲染一轮默认演示快照，随后由实时 WebSocket 覆盖刷新
  appendDialogue("user", "主叫用户 · SenseVoice ASR 46ms", "你好，帮我查一下昨天开通的杭州区 GPU 云服务器订单进度。");
  appendDialogue("bot", "AI 语音客服 · 首包 TTFB=76.4ms", "您好，我是智能语音客服。已为您查到杭州区 GPU 实例订单尾号八八六 [已由边缘打断瞬时截断]");
  appendDialogue("barge", "BARGE-IN INTERRUPT · 确认=60ms | 信令清空=0.16ms | 丢弃未播报 RTP=12帧", "向 FreeSWITCH 下发控制指令: {\"event\":\"clearAudio\",\"reason\":\"edge_vad_3_frames_60ms\"}");
  appendDialogue("barge", "用户插话 (Barge-in Utterance) · ASR 42ms", "不用等分发了，我现在急用，直接帮我切换到现货可用区或者转专属架构师！");
  appendDialogue("bot", "AI 语音客服 (打断后无缝响应) · TTFB=72.1ms", "明白，已立即中止原播报！上海二区当前有现货 A100 实例，我现在为您一键热迁移并同步接通值班架构师。");
  renderRingQueue(6);

  loadOverviewAndUdpBench();
  connectWs();
})();
