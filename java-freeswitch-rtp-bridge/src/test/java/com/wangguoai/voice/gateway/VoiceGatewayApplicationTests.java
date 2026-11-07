package com.wangguoai.voice.gateway;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest
class VoiceGatewayApplicationTests {

    @Autowired
    private FullDuplexVoiceSessionService voiceService;

    @Test
    void shouldRunRealUdpSocketRtpLoopbackAndTrigger60msBargeIn() throws Exception {
        Map<String, Object> report = voiceService.runLiveUdpRtpBenchmark();
        assertThat(report.get("packetsProcessed")).isEqualTo(8);
        assertThat(report.get("droppedOutboundFrames")).isEqualTo(18);
        assertThat(report.get("bargeInConfirmLatencyMs")).isEqualTo(60);
    }
}
