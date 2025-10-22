"use client";

import { useRef, useState } from "react";
import AudioRecorder, { type AudioRecorderHandle } from "@/components/AudioRecorder";
import TranscriptViewer from "@/components/TranscriptViewer";

export default function Home() {
    const [voiceConnected, setVoiceConnected] = useState(false);
    const [isConnecting, setIsConnecting] = useState(false);
    const [connectError, setConnectError] = useState<string | null>(null);

    const audioRecorderRef = useRef<AudioRecorderHandle | null>(null);

    const handleConnect = async () => {
        if (!audioRecorderRef.current) {
            setConnectError("Recorder not ready. Please try again.");
            return;
        }

        setIsConnecting(true);
        setConnectError(null);

        try {
            await audioRecorderRef.current.connect();
            setVoiceConnected(true);
        } catch (error) {
            setVoiceConnected(false);
            setConnectError(
                error instanceof Error
                    ? error.message
                    : "Failed to connect voice WebSocket."
            );
        } finally {
            setIsConnecting(false);
        }
    };

    const handleVoiceConnected = () => {
        setVoiceConnected(true);
    };

    const handleVoiceDisconnected = () => {
        setVoiceConnected(false);
    };

    return (
        <main className="min-h-screen bg-gray-100">
            <div className="mx-auto flex w-full flex-col gap-6 px-6 py-10 lg:max-w-7xl lg:flex-row">
                <div className="flex w-full flex-col gap-6 lg:w-1/2">
                    <section className="rounded-lg bg-white p-6 shadow-md">
                        <header className="mb-6">
                            <h1 className="text-2xl font-semibold text-gray-900">
                                Voice Recorder
                            </h1>
                            <p className="text-sm text-gray-500">
                                Connect to WebSocket and start recording audio.
                            </p>
                        </header>

                        <div className="flex gap-4">
                            <button
                                onClick={handleConnect}
                                disabled={isConnecting || voiceConnected}
                                className="rounded-md bg-blue-600 px-5 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:cursor-not-allowed disabled:bg-blue-400"
                            >
                                {isConnecting ? "Connecting..." : voiceConnected ? "Connected" : "Connect"}
                            </button>
                        </div>

                        {connectError && (
                            <p className="mt-4 text-sm text-red-600">{connectError}</p>
                        )}

                        {voiceConnected && (
                            <p className="mt-4 text-sm text-green-600">
                                WebSocket connected. You can now start recording.
                            </p>
                        )}
                    </section>

                    <div className="flex-1">
                        <AudioRecorder
                            ref={audioRecorderRef}
                            onVoiceSocketConnected={handleVoiceConnected}
                            onVoiceSocketDisconnected={handleVoiceDisconnected}
                        />
                    </div>
                </div>

                <div className="flex w-full lg:w-1/2">
                    <TranscriptViewer />
                </div>
            </div>
        </main>
    );
}
