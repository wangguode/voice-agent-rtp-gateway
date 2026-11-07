package com.wangguoai.voice.gateway;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

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

    @GetMapping("/freeswitch-config")
    public Map<String, String> freeswitchConfig() {
        return voiceService.getFreeSwitchConfigTemplates();
    }

    @PostMapping("/rtp-benchmark")
    public Map<String, Object> rtpBenchmark() throws Exception {
        return voiceService.runLiveUdpRtpBenchmark();
    }
}
