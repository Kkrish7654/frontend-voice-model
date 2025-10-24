type OutgoingAudioPayload = {
    type: "audio";
    data: string;
    sample_rate: number;
    channels: number;
};

type ServerMessageBase = {
    type: string;
    [key: string]: unknown;
};

type StateMessage = ServerMessageBase & {
    type: "state";
    value?: string;
};

type AudioMessage = ServerMessageBase & {
    type: "audio";
    data?: string;
    sample_rate?: number;
    channels?: number;
};

export type ServerMessage = StateMessage | AudioMessage | ServerMessageBase;
export type LogLevel = "info" | "success" | "error";

class VoiceSocket {
    private socket: WebSocket | null = null;
    private sessionId: string | null = null;
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 5;
    private reconnectDelay = 1000;
    private messageQueue: OutgoingAudioPayload[] = [];
    private isClosing = false;
    private onOpenCallback: (() => void) | null = null;
    private onCloseCallback: ((event?: CloseEvent) => void) | null = null;
    private onMessageCallback: ((data: ServerMessage) => void) | null = null;
    private onStateCallback: ((value: string) => void) | null = null;
    private onLogCallback: ((message: string, level: LogLevel) => void) | null = null;
    private onErrorCallback: ((event: Event) => void) | null = null;
    private playbackContext: AudioContext | null = null;
    private playbackClock = 0;

    public init() {
        this.isClosing = false;
        this.reconnectAttempts = 0;
        this.messageQueue = [];
        this.connect();
    }

    public onOpen(callback: () => void) {
        this.onOpenCallback = callback;

        if (this.socket?.readyState === WebSocket.OPEN) {
            callback();
        }
    }

    public onClose(callback: (event?: CloseEvent) => void) {
        this.onCloseCallback = callback;
    }

    public onMessage(callback: (data: ServerMessage) => void) {
        this.onMessageCallback = callback;
    }

    public onState(callback: (value: string) => void) {
        this.onStateCallback = callback;
    }

    public onLog(callback: (message: string, level: LogLevel) => void) {
        this.onLogCallback = callback;
    }

    public onError(callback: (event: Event) => void) {
        this.onErrorCallback = callback;
    }

    private connect() {
        if (typeof window === "undefined") {
            return;
        }

        // Use direct WebSocket URL as requested
        const wsUrl = "wss://dms.consainsights.com/api/ws";

        try {
            this.socket = new WebSocket(wsUrl);

            this.socket.onopen = () => {
                this.log("WebSocket connected", "success");
                this.reconnectAttempts = 0;
                this.flushMessageQueue();
                this.onOpenCallback?.();
            };

            this.socket.onclose = (event) => {
                this.log(
                    `WebSocket disconnected: ${event.code} ${event.reason ?? ""}`.trim(),
                    "info"
                );

                this.onCloseCallback?.(event);
                void this.teardownPlayback();

                if (
                    !this.isClosing &&
                    event.code !== 1000 &&
                    this.reconnectAttempts < this.maxReconnectAttempts
                ) {
                    setTimeout(() => {
                        this.reconnectAttempts++;
                        this.log(
                            `Attempting to reconnect... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`,
                            "info"
                        );
                        this.connect();
                    }, this.reconnectDelay * this.reconnectAttempts);
                } else if (this.isClosing) {
                    this.isClosing = false;
                }
            };

            this.socket.onerror = (event) => {
                this.log(`WebSocket error: ${String(event)}`, "error");
                this.onErrorCallback?.(event as Event);
            };

            this.socket.onmessage = (event) => {
                if (!event.data) {
                    return;
                }

                try {
                    const parsed = JSON.parse(event.data) as ServerMessage;

                    if (parsed.type === "state") {
                        const value = typeof parsed.value === "string" ? parsed.value : "";
                        if (value) {
                            this.log(`State: ${value}`, "success");
                            this.onStateCallback?.(value);
                        }
                    } else if (parsed.type === "audio" && typeof parsed.data === "string") {
                        this.handleAudioPlayback(parsed as AudioMessage);
                    } else {
                        this.log(`Received: ${JSON.stringify(parsed)}`, "info");
                    }

                    this.onMessageCallback?.(parsed);
                } catch (error) {
                    const message =
                        error instanceof Error ? error.message : String(error);
                    this.log(`Failed to parse WebSocket message: ${message}`, "error");
                    this.log(`Received: ${event.data}`, "info");
                }
            };
        } catch (error) {
            this.log(`Failed to create WebSocket connection: ${String(error)}`, "error");
        }
    }

    public send(data: OutgoingAudioPayload) {
        if (this.socket?.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify(data));
        } else {
            this.messageQueue.push(data);
            if (!this.socket) {
                console.warn("WebSocket is not connected. Queuing message.");
            }
        }
    }

    private flushMessageQueue() {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            return;
        }

        while (this.messageQueue.length > 0) {
            const payload = this.messageQueue.shift();
            if (payload) {
                this.socket.send(JSON.stringify(payload));
            }
        }
    }

    public close(code = 1000, reason = "Client closing connection") {
        this.isClosing = true;
        if (this.socket) {
            this.socket.close(code, reason);
            this.socket = null;
        }
        void this.teardownPlayback();
        this.messageQueue = [];
    }

    public isConnected(): boolean {
        return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
    }

    private ensurePlaybackContext(): AudioContext | null {
        if (typeof window === "undefined") {
            return null;
        }

        if (!this.playbackContext || this.playbackContext.state === "closed") {
            const AudioContextCtor =
                window.AudioContext ||
                (window as typeof window & { webkitAudioContext?: typeof AudioContext })
                    .webkitAudioContext;

            if (!AudioContextCtor) {
                this.log("Web Audio API is not supported in this browser.", "error");
                return null;
            }

            this.playbackContext = new AudioContextCtor();
            this.playbackClock = this.playbackContext.currentTime;
        }

        return this.playbackContext;
    }

    private handleAudioPlayback(payload: AudioMessage) {
        if (!payload.data) {
            return;
        }

        const playbackContext = this.ensurePlaybackContext();
        if (!playbackContext) {
            return;
        }

        try {
            const sampleRate = payload.sample_rate ?? 24000;
            const byteStr = atob(payload.data);
            const buffer = new ArrayBuffer(byteStr.length);
            const bytes = new Uint8Array(buffer);

            for (let i = 0; i < byteStr.length; i++) {
                bytes[i] = byteStr.charCodeAt(i);
            }

            const view = new DataView(buffer);
            const sampleCount = byteStr.length / 2;
            const float32 = new Float32Array(sampleCount);

            for (let i = 0; i < sampleCount; i++) {
                const sample = view.getInt16(i * 2, true);
                float32[i] = sample / 32768;
            }

            const audioBuffer = playbackContext.createBuffer(1, float32.length, sampleRate);
            audioBuffer.copyToChannel(float32, 0);

            const source = playbackContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(playbackContext.destination);

            const now = playbackContext.currentTime;
            if (this.playbackClock < now + 0.05) {
                this.playbackClock = now + 0.1;
            }

            source.start(this.playbackClock);
            this.playbackClock += audioBuffer.duration;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.log(`Audio playback error: ${message}`, "error");
        }
    }

    private async teardownPlayback() {
        if (!this.playbackContext) {
            return;
        }

        try {
            if (this.playbackContext.state !== "closed") {
                await this.playbackContext.close();
            }
        } catch (error) {
            this.log(`Failed to close playback context: ${String(error)}`, "error");
        } finally {
            this.playbackContext = null;
            this.playbackClock = 0;
        }
    }

    private log(message: string, level: LogLevel = "info") {
        switch (level) {
            case "error":
                console.error(message);
                break;
            case "success":
                console.info(message);
                break;
            default:
                console.log(message);
                break;
        }

        this.onLogCallback?.(message, level);
    }
}

export type { OutgoingAudioPayload };

export default VoiceSocket;
