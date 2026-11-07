package com.wangguoai.voice.gateway;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

@Configuration
@EnableWebSocket
public class VoiceConsoleWebSocketConfig implements WebSocketConfigurer {

    private final VoiceConsoleWebSocketHandler handler;

    public VoiceConsoleWebSocketConfig(VoiceConsoleWebSocketHandler handler) {
        this.handler = handler;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(handler, "/ws/voice-console").setAllowedOrigins("*");
    }
}
