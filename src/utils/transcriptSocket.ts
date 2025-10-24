export type TranscriptMessage = {
    type: "user" | "bot";
    message: string;
    time: string;
};

export type TranscriptMessages = TranscriptMessage[];

export default class TranscriptSocket {
    private socket: WebSocket | null = null;
    private onMessageCallback: ((messages: TranscriptMessages) => void) | null = null;
    private onOpenCallback: (() => void) | null = null;
    private onCloseCallback: (() => void) | null = null;
    private onErrorCallback: ((event: Event) => void) | null = null;

    constructor() {
        this.socket = new WebSocket("wss://dms.consainsights.com/api/transcription");
        this.socket.onopen = () => this.onOpenCallback?.();
        this.socket.onclose = () => this.onCloseCallback?.();
        this.socket.onerror = (event) => this.onErrorCallback?.(event);
        this.socket.onmessage = (event: MessageEvent) => {
            if (!event.data) return;
            try {
                const messages = JSON.parse(event.data) as TranscriptMessages;
                this.onMessageCallback?.(messages);
            } catch {
                // Ignore malformed messages
            }
        };
    }

    onMessage(callback: (messages: TranscriptMessages) => void) {
        this.onMessageCallback = callback;
    }

    onOpen(callback: () => void) {
        this.onOpenCallback = callback;
    }

    onClose(callback: () => void) {
        this.onCloseCallback = callback;
    }

    onError(callback: (event: Event) => void) {
        this.onErrorCallback = callback;
    }

    close() {
        this.socket?.close();
    }

    isConnected() {
        return this.socket?.readyState === WebSocket.OPEN;
    }
}