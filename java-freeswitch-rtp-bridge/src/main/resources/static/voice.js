(function () {
  const state = {
    connected: true,
    agentSpeaking: true,
    bargeInFlushed: false,
    ttsMuted: false,
    micActive: false,
    vadThreshold: 1200,
    confirmFrames: 3,
    tools: [],
    skills: [],
    ws: null,
    tick: 0,
  };

  function el(id) {
    return document.getElementById(id);
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // ==================== 1. 加载网关概览、Tools 与 Skills ====================
  async function loadVoiceCapabilities() {
    try {
      const [ovRes, toolsRes, skillsRes] = await Promise.all([
        fetch('/api/voice/overview'),
        fetch('/api/voice/tools'),
        fetch('/api/voice/skills'),
      ]);
      const ov = await ovRes.json();
      state.tools = await toolsRes.json();
      state.skills = await skillsRes.json();

      state.vadThreshold = ov.vadThresholdRms || 1200;
      state.confirmFrames = ov.bargeInConfirmFrames || 3;

      el('vadRangeInput').value = state.vadThreshold;
      el('vadSliderVal').textContent = String(state.vadThreshold);
      el('framesRangeInput').value = state.confirmFrames;
      el('framesSliderVal').textContent = `${state.confirmFrames} frames (${state.confirmFrames * 20} ms)`;
      el('personaTextarea').value = ov.systemPersona || '';
      el('voiceLlmModel').value = ov.llmModel || 'deepseek-chat';

      renderVoiceTools();
      renderVoiceSkills();
    } catch (e) {
      console.error('loadVoiceCapabilities error:', e);
    }
  }

  function renderVoiceTools() {
    const activeCount = state.tools.filter((t) => t.enabled).length;
    el('hdrActiveToolsCount').textContent = `${activeCount} Mounted`;

    const container = el('voiceToolsContainer');
    container.innerHTML = state.tools
      .map(
        (t) => `
      <div class="cfg-item-card">
        <div style="flex:1;min-width:0;">
          <div class="cfg-item-name">${escapeHtml(t.name)} <span class="mono-tag">(${t.timeoutMs}ms SLA)</span></div>
          <div class="cfg-item-desc">${escapeHtml(t.description)}</div>
        </div>
        <label class="pg-switch" title="启用或禁用语音工具 ${escapeHtml(t.name)}">
          <input type="checkbox" class="js-toggle-vtool" data-name="${escapeHtml(t.name)}" ${t.enabled ? 'checked' : ''} />
          <span class="pg-slider"></span>
        </label>
      </div>
    `
      )
      .join('');

    // 同步更新 RPC 下拉列表
    const rpcSelect = el('rpcToolSelect');
    rpcSelect.innerHTML = state.tools
      .map((t) => `<option value="${escapeHtml(t.name)}">${escapeHtml(t.name)}</option>`)
      .join('');

    container.querySelectorAll('.js-toggle-vtool').forEach((chk) => {
      chk.addEventListener('change', async (ev) => {
        await fetch('/api/voice/tools/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: ev.target.dataset.name, enabled: ev.target.checked }),
        });
        await loadVoiceCapabilities();
      });
    });
  }

  function renderVoiceSkills() {
    const activeSkills = state.skills.filter((s) => s.enabled).length;
    el('skillsActiveCount').textContent = `${activeSkills} Enabled`;

    const container = el('voiceSkillsContainer');
    container.innerHTML = state.skills
      .map(
        (s) => `
      <div class="cfg-item-card">
        <div style="flex:1;min-width:0;">
          <div class="cfg-item-name">${escapeHtml(s.name)}</div>
          <div class="cfg-item-desc">${escapeHtml(s.triggerRule)} · ${escapeHtml(s.promptSnippet)}</div>
        </div>
        <label class="pg-switch" title="启用或禁用语音技能 ${escapeHtml(s.name)}">
          <input type="checkbox" class="js-toggle-vskill" data-name="${escapeHtml(s.name)}" ${s.enabled ? 'checked' : ''} />
          <span class="pg-slider"></span>
        </label>
      </div>
    `
      )
      .join('');

    container.querySelectorAll('.js-toggle-vskill').forEach((chk) => {
      chk.addEventListener('change', async (ev) => {
        await fetch('/api/voice/skills/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: ev.target.dataset.name, enabled: ev.target.checked }),
        });
        await loadVoiceCapabilities();
      });
    });
  }

  // ==================== 2. 渲染 16-Slot 20ms RTP 环形缓冲与发光声波仪 ====================
  function renderRtpRingBuffer() {
    const grid = el('rtpSlotsGrid');
    const slots = [];
    for (let i = 0; i < 16; i++) {
      let cls = 'rtp-slot';
      let label = `F${i + 1}`;
      if (state.bargeInFlushed) {
        cls += ' flushed';
        label = 'CLR';
      } else if (i < 11) {
        cls += ' queued';
        label = '20ms';
      }
      slots.push(`<div class="${cls}">${label}</div>`);
    }
    grid.innerHTML = slots.join('');
    el('ringBufferStatusText').textContent = state.bargeInFlushed
      ? '0/16 Flushed (clearAudio <60ms)'
      : '11/16 Queued (220ms lookahead)';
  }

  function startAudioVisualizerLoop() {
    const canvas = el('audioSpectrumCanvas');
    const ctx = canvas.getContext('2d');
    const bars = 28;

    function draw() {
      state.tick += 0.12;
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      // 背景参考网格与 VAD 阈值红线
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
      ctx.lineWidth = 1;
      for (let y = 24; y < h; y += 28) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      const barGap = 4;
      const barWidth = (w - (bars + 1) * barGap) / bars;

      for (let i = 0; i < bars; i++) {
        const wave =
          Math.sin(state.tick + i * 0.42) * 0.38 +
          Math.cos(state.tick * 1.7 - i * 0.25) * 0.28 +
          0.42;
        const factor = state.bargeInFlushed ? 0.18 : 0.85;
        const barH = Math.max(8, Math.min(h - 18, wave * (h - 20) * factor));
        const x = barGap + i * (barWidth + barGap);
        const y = (h - barH) / 2;

        const grad = ctx.createLinearGradient(0, y, 0, y + barH);
        if (state.bargeInFlushed) {
          grad.addColorStop(0, '#f87171');
          grad.addColorStop(1, '#ef4444');
        } else {
          grad.addColorStop(0, '#22d3ee');
          grad.addColorStop(0.5, '#06b6d4');
          grad.addColorStop(1, '#10b981');
        }
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.roundRect(x, y, barWidth, barH, 3);
        ctx.fill();
      }

      requestAnimationFrame(draw);
    }

    draw();
  }

  // ==================== 3. 全双工语音对话流与 60ms 物理打断模拟 ====================
  function renderInitialConversation() {
    const stream = el('voiceTranscriptStream');
    stream.innerHTML = `
      <div class="v-msg caller">
        <div class="v-msg-head">
          <span class="v-role-badge">CALLER (SIP 8kHz G.711)</span>
          <span>ASR: 72ms · SenseVoice</span>
        </div>
        <div class="v-msg-text">你好，帮我查一下杭州智算中心 ORD-202604 这笔 H20 裸金属集群订单的光模块巡检完了吗？</div>
      </div>

      <div class="v-msg tool-call">
        <div class="v-msg-head">
          <span class="v-role-badge">⚡ VOICE FUNCTION CALL: query_gpu_order</span>
          <span>200 OK · 19.2 ms</span>
        </div>
        <div>args: {"orderId": "ORD-202604", "region": "cn-hangzhou-aidc"} → result: {"opticalInspection": "64/64 端口全部达标", "estimatedDelivery": "今日 16:00 前"}</div>
      </div>

      <div class="v-msg agent">
        <div class="v-msg-head">
          <span class="v-role-badge">WG VOICE AGENT (MiniMax-Speech-02-Turbo)</span>
          <span>LLM TTFT: 210ms · TTS TTFB: 80ms</span>
        </div>
        <div class="v-msg-text">已为您查到订单 ORD-202604，杭州智算中心二期 64 个光模块端口巡检已全部达标，目前正在为您配置默认骨干网路由…… <span class="text-cyan">[Speaking Frame #11/16]</span></div>
      </div>
    `;
  }

  async function triggerBargeInAndReply(utteranceText, toolToCall) {
    state.bargeInFlushed = true;
    renderRtpRingBuffer();
    el('agentStateBadge').className = 'state-pill interrupted';
    el('agentStateBadge').textContent = 'INTERRUPTED (60MS CLEARAUDIO)';
    el('rmsLiveReadout').textContent = `RMS: 4680 > Thr: ${state.vadThreshold} (Barge-In!)`;

    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }

    const stream = el('voiceTranscriptStream');

    // 1. 插入 60ms 物理截断事件卡片
    const bargeCard = document.createElement('div');
    bargeCard.className = 'v-msg barge-event';
    bargeCard.innerHTML = `
      <div class="v-msg-head">
        <span class="v-role-badge">🛑 EDGE VAD BARGE-IN DETECTED (${state.confirmFrames * 20}ms)</span>
        <span>clearAudio Atomic Flush</span>
      </div>
      <div class="v-msg-text">检测到客户高能量插话 (RMS 4680 >= ${state.vadThreshold})，已在 ${state.confirmFrames * 20}ms 内发送 <code>clearAudio</code> 信令清空 FreeSWITCH 下行 11 个残留 RTP 帧！</div>
    `;
    stream.appendChild(bargeCard);

    // 2. 插入客户插话文本
    const callerCard = document.createElement('div');
    callerCard.className = 'v-msg caller';
    callerCard.innerHTML = `
      <div class="v-msg-head">
        <span class="v-role-badge">CALLER BARGE-IN UTTERANCE</span>
        <span>ASR: 68ms</span>
      </div>
      <div class="v-msg-text">${escapeHtml(utteranceText)}</div>
    `;
    stream.appendChild(callerCard);

    // 3. 自动触发匹配的语音 Function Calling 工具
    const chosenTool = toolToCall || (utteranceText.includes('路由') || utteranceText.includes('BGP') ? 'switch_bgp_route' : 'create_noc_ticket');
    const toolRes = await fetch('/api/voice/tools/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: chosenTool, arguments: { popNode: 'shanghai-core-02', orderId: 'ORD-202604' } }),
    });
    const toolData = await toolRes.json();

    const toolCard = document.createElement('div');
    toolCard.className = 'v-msg tool-call';
    toolCard.innerHTML = `
      <div class="v-msg-head">
        <span class="v-role-badge">⚡ VOICE FUNCTION CALL: ${escapeHtml(toolData.toolName)}</span>
        <span>${escapeHtml(toolData.status)} · ${toolData.latencyMs} ms</span>
      </div>
      <div>${escapeHtml(JSON.stringify(toolData.result))}</div>
    `;
    stream.appendChild(toolCard);

    // 4. 插入 Agent 极速恢复播报
    const replyText =
      chosenTool === 'switch_bgp_route'
        ? '收到，已立即中断原播报并为您将上海节点切换至备用低延迟 BGP 路由，当前往返延迟已从 88 毫秒降至 19 毫秒，丢包率归零。'
        : '明白，已为您生成 P1 级机房驻场抢修工单 NOC-992，并正在为您无感桥接 VIP 专线值班专家。';

    const agentCard = document.createElement('div');
    agentCard.className = 'v-msg agent';
    agentCard.innerHTML = `
      <div class="v-msg-head">
        <span class="v-role-badge">WG VOICE AGENT (Polite Barge-In Recovery)</span>
        <span>E2E Recovery: 435ms</span>
      </div>
      <div class="v-msg-text">${escapeHtml(replyText)}</div>
    `;
    stream.appendChild(agentCard);
    stream.scrollTop = stream.scrollHeight;

    if (!state.ttsMuted && window.speechSynthesis) {
      const u = new SpeechSynthesisUtterance(replyText);
      u.lang = 'zh-CN';
      u.rate = 1.12;
      window.speechSynthesis.speak(u);
    }

    setTimeout(() => {
      state.bargeInFlushed = false;
      renderRtpRingBuffer();
      el('agentStateBadge').className = 'state-pill speaking';
      el('agentStateBadge').textContent = 'AGENT SPEAKING';
      el('rmsLiveReadout').textContent = `RMS: 2480 / Thr: ${state.vadThreshold}`;
    }, 1800);
  }

  // ==================== 4. 运行真实 UDP 8-Packet Loopback 压测 ====================
  async function runUdpLoopbackBenchmark() {
    const res = await fetch('/api/voice/rtp-benchmark', { method: 'POST' });
    const data = await res.json();
    el('udpPortBadge').textContent = `UDP 127.0.0.1:${data.udpLocalPort}`;
    el('udpBenchOutput').textContent =
      `[UDP Port ${data.udpLocalPort}] Sent ${data.packetsProcessed} RFC3550 packets | ` +
      `Flushed ${data.droppedOutboundFrames} TTS frames on Seq#6 | ` +
      `Confirm=${data.bargeInConfirmLatencyMs}ms | Socket RTT=${data.totalSocketRoundtripMs}ms`;
  }

  // ==================== 5. 事件绑定 ====================
  function bindEvents() {
    el('btnTriggerBargeIn').addEventListener('click', () => {
      triggerBargeInAndReply(el('voiceUtteranceInput').value.trim(), 'switch_bgp_route');
    });

    el('btnSendUtterance').addEventListener('click', () => {
      triggerBargeInAndReply(el('voiceUtteranceInput').value.trim());
    });

    document.querySelectorAll('.sc-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.sc-chip').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const sc = btn.dataset.sc;
        if (sc === 'order') {
          el('voiceUtteranceInput').value = '等一下先别报光模块了！上海骨干网节点丢包严重，马上切到备用低延迟 BGP 路由！';
          triggerBargeInAndReply(el('voiceUtteranceInput').value, 'switch_bgp_route');
        } else if (sc === 'bgp') {
          el('voiceUtteranceInput').value = '深圳跨境专线延迟飙升到 90ms，立刻执行 BGP 备用路由热切换！';
          triggerBargeInAndReply(el('voiceUtteranceInput').value, 'switch_bgp_route');
        } else {
          el('voiceUtteranceInput').value = '机房告警还没解除，马上建一个 P1 抢修工单并帮我转接人工 VIP 值班长！';
          triggerBargeInAndReply(el('voiceUtteranceInput').value, 'create_noc_ticket');
        }
      });
    });

    el('btnRunUdpBench').addEventListener('click', runUdpLoopbackBenchmark);

    // 新增语音工具
    el('btnToggleAddToolForm').addEventListener('click', () => {
      el('addVoiceToolForm').classList.toggle('hidden');
    });
    el('btnCancelVoiceTool').addEventListener('click', () => {
      el('addVoiceToolForm').classList.add('hidden');
    });
    el('btnSaveVoiceTool').addEventListener('click', async () => {
      await fetch('/api/voice/tools/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: el('newVoiceToolName').value.trim(),
          description: el('newVoiceToolDesc').value.trim(),
          timeoutMs: 120,
        }),
      });
      el('addVoiceToolForm').classList.add('hidden');
      await loadVoiceCapabilities();
    });

    // VAD 滑块与参数保存
    el('vadRangeInput').addEventListener('input', (ev) => {
      el('vadSliderVal').textContent = ev.target.value;
    });
    el('framesRangeInput').addEventListener('input', (ev) => {
      const f = Number(ev.target.value);
      el('framesSliderVal').textContent = `${f} frames (${f * 20} ms)`;
    });

    el('btnSaveVoiceConfig').addEventListener('click', async () => {
      const res = await fetch('/api/voice/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vadThresholdRms: Number(el('vadRangeInput').value),
          bargeInConfirmFrames: Number(el('framesRangeInput').value),
          ttsVoice: el('ttsVoiceSelect').value,
          systemPersona: el('personaTextarea').value,
          model: el('voiceLlmModel').value.trim(),
          apiKey: el('voiceApiKey').value.trim(),
        }),
      });
      const ov = await res.json();
      state.vadThreshold = ov.vadThresholdRms;
      state.confirmFrames = ov.bargeInConfirmFrames;
      el('voiceCfgSaveHint').textContent = `Saved! Confirm=${ov.bargeInConfirmMs}ms`;
    });

    // RPC Tool Call Tester
    async function callSelectedVoiceRpc() {
      const name = el('rpcToolSelect').value;
      const res = await fetch('/api/voice/tools/call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, arguments: { orderId: 'ORD-202604', popNode: 'shanghai-core-02' } }),
      });
      const out = await res.json();
      el('rpcToolOutput').textContent = JSON.stringify(out, null, 2);
    }
    el('btnCallVoiceRpc').addEventListener('click', callSelectedVoiceRpc);

    // FreeSWITCH XML 弹窗
    el('btnOpenFsModal').addEventListener('click', async () => {
      const res = await fetch('/api/voice/freeswitch-config');
      const cfg = await res.json();
      el('fsDialplanPre').textContent = cfg.dialplanXml;
      el('fsEnvPre').textContent = cfg.envTemplate;
      el('fsModalBackdrop').classList.remove('hidden');
    });
    el('btnCloseFsModal').addEventListener('click', () => {
      el('fsModalBackdrop').classList.add('hidden');
    });

    // TTS 静音切换
    el('btnToggleTtsMute').addEventListener('click', () => {
      state.ttsMuted = !state.ttsMuted;
      el('ttsMuteText').textContent = state.ttsMuted ? '🔇 Speaker: MUTED' : '🔊 Speaker: ON';
    });

    // 浏览器麦克风开关
    el('btnToggleMic').addEventListener('click', async () => {
      if (state.micActive) {
        state.micActive = false;
        el('micBtnText').textContent = 'Start Browser Mic';
        return;
      }
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
        state.micActive = true;
        el('micBtnText').textContent = '🎙️ Mic Live (16kHz)';
      } catch (e) {
        el('micBtnText').textContent = 'Mic Simulated (No HW)';
      }
    });
  }

  window.addEventListener('DOMContentLoaded', async () => {
    bindEvents();
    renderRtpRingBuffer();
    renderInitialConversation();
    startAudioVisualizerLoop();
    await loadVoiceCapabilities();
    await runUdpLoopbackBenchmark();
    el('btnCallVoiceRpc').click();
  });
})();
