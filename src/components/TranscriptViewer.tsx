"use client";

import { useMemo } from "react";
import { useTranscriptStream } from "@/hooks/useTranscriptStream";
import type { TranscriptMessage } from "@/utils/transcriptSocket";

function formatTime(time: string) {
    try {
        const date = new Date(time);
        if (Number.isNaN(date.getTime())) {
            return time;
        }
        return new Intl.DateTimeFormat(undefined, {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        }).format(date);
    } catch {
        return time;
    }
}

    function renderMessage(message: TranscriptMessage) {
        const isUser = message.type === "user";
        return (
            <div
                key={`${message.time}-${message.type}-${message.message.slice(0, 10)}`}
                className={`rounded-lg px-4 py-3 border ${
                    isUser
                        ? "bg-blue-50 border-blue-100 text-blue-900 self-end"
                        : "bg-green-50 border-green-100 text-green-900 self-start"
                }`}
            >
                <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide mb-1">
                    <span>{isUser ? "You" : "Bot"}</span>
                    <span className="text-gray-400">•</span>
                    <span className="text-gray-500">{formatTime(message.time)}</span>
                </div>
                <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
                    {message.message}
                </p>
            </div>
        );
    }

    export default function TranscriptViewer() {
        const { messages, clearMessages } = useTranscriptStream();
        const sortedMessages = useMemo(() => {
            return [...messages].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
        }, [messages]);

        return (
            <section className="flex flex-col h-full bg-white rounded-lg shadow-md border border-gray-200">
                <header className="flex items-center justify-between border-b border-gray-200 px-5 py-4">
                    <h2 className="text-xl font-semibold text-gray-900">Live Transcript</h2>
                    {sortedMessages.length > 0 && (
                        <button
                            type="button"
                            onClick={clearMessages}
                            className="text-xs font-medium text-gray-500 hover:text-gray-700"
                        >
                            Clear
                        </button>
                    )}
                </header>
                <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-3">
                    {sortedMessages.length === 0 ? (
                        <div className="text-sm text-gray-400 text-center mt-8">Awaiting transcript messages...</div>
                    ) : (
                        sortedMessages.map(renderMessage)
                    )}
                </div>
                </section>
            );
}