"use client";

import { useEffect, useRef, useState } from "react";
import TranscriptSocket, { type TranscriptMessage, type TranscriptMessages } from "@/utils/transcriptSocket";

export function useTranscriptStream() {
    const [messages, setMessages] = useState<TranscriptMessage[]>([]);
    const socketRef = useRef<TranscriptSocket | null>(null);

    useEffect(() => {
        socketRef.current = new TranscriptSocket();
        socketRef.current.onMessage((messages: TranscriptMessages) => {
            setMessages(messages);
        });
    }, []);

    const clearMessages = () => setMessages([]);

    return { messages, clearMessages };
}

export default useTranscriptStream;