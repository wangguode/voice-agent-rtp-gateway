package com.wangguoai.voice.gateway;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/voice")
public class VoiceGatewayController {

    private final FullDuplexVoiceSessionService voiceService;

    public VoiceGatewayController(FullDuplexVoiceSessionService voiceService) {
        this.voiceService = voiceService;
    }

    @GetMapping("/overview")
    public Map<String, Object> overview() {
        return voiceService.getGatewayOverview();
    }

    @PostMapping("/settings")
    public Map<String, Object> updateSettings(@RequestBody Map<String, Object> body) {
        return voiceService.updateSettings(body);
    }

    @GetMapping("/tools")
    public List<FullDuplexVoiceSessionService.VoiceTool> listTools() {
        return voiceService.listVoiceTools();
    }

    @PostMapping("/tools/toggle")
    public FullDuplexVoiceSessionService.VoiceTool toggleTool(@RequestBody Map<String, Object> body) {
        String name = String.valueOf(body.getOrDefault("name", ""));
        boolean enabled = Boolean.TRUE.equals(body.get("enabled"));
        return voiceService.toggleVoiceTool(name, enabled);
    }

    @PostMapping("/tools/add")
    public FullDuplexVoiceSessionService.VoiceTool addTool(@RequestBody Map<String, Object> body) {
        return voiceService.addVoiceTool(body);
    }

    @PostMapping("/tools/call")
    @SuppressWarnings("unchecked")
    public Map<String, Object> callTool(@RequestBody Map<String, Object> body) {
        String name = String.valueOf(body.getOrDefault("name", "query_gpu_order"));
        Map<String, Object> args = (Map<String, Object>) body.getOrDefault("arguments", Map.of());
        return voiceService.invokeVoiceTool(name, args);
    }

    @GetMapping("/skills")
    public List<FullDuplexVoiceSessionService.VoiceSkill> listSkills() {
        return voiceService.listVoiceSkills();
    }

    @PostMapping("/skills/toggle")
    public FullDuplexVoiceSessionService.VoiceSkill toggleSkill(@RequestBody Map<String, Object> body) {
        String name = String.valueOf(body.getOrDefault("name", ""));
        boolean enabled = Boolean.TRUE.equals(body.get("enabled"));
        return voiceService.toggleVoiceSkill(name, enabled);
    }

    @GetMapping("/freeswitch-config")
    public Map<String, String> freeswitchConfig() {
        return voiceService.getFreeSwitchConfigTemplates();
    }

    @PostMapping("/rtp-benchmark")
    public Map<String, Object> rtpBenchmark() throws Exception {
        return voiceService.runLiveUdpRtpBenchmark();
    }
}
