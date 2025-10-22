"use client";

import {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useRef,
    useState,
} from "react";
import RecordRTC from "recordrtc";
import VoiceSocket, {
    type LogLevel,
    type OutgoingAudioPayload,
    type ServerMessage,
} from "@/utils/voicesocket";

type AudioRecorderProps = {
    onVoiceSocketConnected?: () => void;
    onVoiceSocketDisconnected?: () => void;
};

export type AudioRecorderHandle = {
    connect: () => Promise<void>;
    disconnect: () => void;
    isConnected: () => boolean;
};

const AudioRecorder = forwardRef<AudioRecorderHandle, AudioRecorderProps>(
    function AudioRecorder(
        { onVoiceSocketConnected, onVoiceSocketDisconnected }: AudioRecorderProps,
        ref
    ) {
        const [isConnected, setIsConnected] = useState(false);
        const [isRecording, setIsRecording] = useState(false);
        const [isTransmitting, setIsTransmitting] = useState(false);
        const [status, setStatus] = useState<string>("Idle");
        const [messages, setMessages] = useState<
            { id: number; text: string; level: LogLevel }[]
        >([]);

        const recorderRef = useRef<RecordRTC | null>(null);
        const streamRef = useRef<MediaStream | null>(null);
        const socketRef = useRef<VoiceSocket | null>(null);
        const isTransmittingRef = useRef(false);
        const audioContextRef = useRef<AudioContext | null>(null);
        const chunksSentRef = useRef(0);
        const messageIdRef = useRef(0);
        const connectInFlightRef = useRef<Promise<void> | null>(null);
        const connectedRef = useRef(false);
        const currentSessionIdRef = useRef<string | null>(null);

        const ensureAudioContext = useCallback(() => {
            if (typeof window === "undefined") {
                return null;
            }

            if (
                !audioContextRef.current ||
                audioContextRef.current.state === "closed"
            ) {
                const AudioContextCtor =
                    window.AudioContext ||
                    (window as typeof window & {
                        webkitAudioContext?: typeof AudioContext;
                    }).webkitAudioContext;

                if (!AudioContextCtor) {
                    console.warn("Web Audio API is not supported in this browser.");
                    return null;
                }

                audioContextRef.current = new AudioContextCtor({
                    sampleRate: 16000,
                });
            }

            return audioContextRef.current;
        }, []);

        const encodePCMToBase64 = useCallback((pcmData: Int16Array) => {
            const uint8View = new Uint8Array(pcmData.buffer);
            let binary = "";
            const chunkSize = 0x8000;

            for (let i = 0; i < uint8View.length; i += chunkSize) {
                const chunk = uint8View.subarray(i, i + chunkSize);
                binary += String.fromCharCode(...chunk);
            }

            return btoa(binary);
        }, []);

        const addMessage = useCallback((text: string, level: LogLevel = "info") => {
            messageIdRef.current += 1;
            setMessages((prev) => [
                { id: messageIdRef.current, text, level },
                ...prev.slice(0, 99),
            ]);
        }, []);

        const computeRms = useCallback((samples: Float32Array) => {
            if (samples.length === 0) {
                return 0;
            }

            let sumSquares = 0;
            for (let i = 0; i < samples.length; i++) {
                sumSquares += samples[i] * samples[i];
            }

            return Math.sqrt(sumSquares / samples.length);
        }, []);

        const updateTransmittingState = useCallback((value: boolean) => {
            isTransmittingRef.current = value;
            setIsTransmitting(value);
        }, []);

        const stopTransmission = useCallback(() => {
            updateTransmittingState(false);
            chunksSentRef.current = 0;
        }, [updateTransmittingState]);

        const stopRecording = useCallback(() => {
            if (recorderRef.current) {
                recorderRef.current.stopRecording(() => {
                    recorderRef.current = null;
                });
            }

            if (streamRef.current) {
                streamRef.current.getTracks().forEach((track) => track.stop());
                streamRef.current = null;
            }

            const audioContext = audioContextRef.current;
            if (audioContext && audioContext.state !== "closed") {
                audioContext
                    .close()
                    .catch((error) =>
                        console.warn("Failed to close audio context:", error)
                    );
            }
            audioContextRef.current = null;

            setIsRecording(false);
        }, []);

        const processAudioChunk = useCallback(
            async (blob: Blob) => {
                if (
                    !isTransmittingRef.current ||
                    !socketRef.current?.isConnected() ||
                    blob.size === 0
                ) {
                    return;
                }

                try {
                    const audioContext = ensureAudioContext();
                    if (!audioContext) {
                        return;
                    }

                    const arrayBuffer = await blob.arrayBuffer();
                    const audioBuffer = await audioContext.decodeAudioData(
                        arrayBuffer.slice(0)
                    );
                    const channelData = audioBuffer.getChannelData(0);

                    if (channelData.length === 0) {
                        return;
                    }

                    const noiseGateThreshold = 0.015;
                    const smoothingFactor = 0.12;

                    const denoised = new Float32Array(channelData.length);
                    let prev = 0;

                    for (let i = 0; i < channelData.length; i++) {
                        const raw = channelData[i];
                        const smooth = prev + smoothingFactor * (raw - prev);
                        denoised[i] =
                            Math.abs(smooth) < noiseGateThreshold ? 0 : smooth;
                        prev = smooth;
                    }

                    const rms = computeRms(denoised);

                    const pcmData = new Int16Array(denoised.length);
                    for (let i = 0; i < denoised.length; i++) {
                        const sample = denoised[i];
                        pcmData[i] = Math.max(
                            -32768,
                            Math.min(32767, sample * 32768)
                        );
                    }

                    const base64 = encodePCMToBase64(pcmData);

                    const audioPayload: OutgoingAudioPayload = {
                        type: "audio",
                        data: base64,
                        sample_rate: 16000,
                        channels: 1,
                    };

                    socketRef.current.send(audioPayload);

                    chunksSentRef.current += 1;
                    if (chunksSentRef.current % 50 === 0) {
                        console.log(
                            `Sent chunk #${chunksSentRef.current}, RMS: ${rms.toFixed(
                                4
                            )}`
                        );
                    }
                } catch (error) {
                    console.error("Failed to process audio chunk:", error);
                }
            },
            [computeRms, encodePCMToBase64, ensureAudioContext]
        );

        const startRecording = useCallback(async () => {
            if (recorderRef.current) {
                return;
            }

            chunksSentRef.current = 0;

            try {
                const stream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true,
                        sampleRate: 16000,
                        channelCount: 1,
                    },
                });

                const audioContext = ensureAudioContext();
                if (!audioContext) {
                    throw new Error("Web Audio API is not supported.");
                }

                streamRef.current = stream;

                const recorder = new RecordRTC(stream, {
                    type: "audio",
                    mimeType: "audio/webm;codecs=pcm",
                    recorderType: RecordRTC.StereoAudioRecorder,
                    numberOfAudioChannels: 1,
                    desiredSampRate: 16000,
                    bufferSize: 4096,
                    disableLogs: true,
                    timeSlice: 50,
                    ondataavailable: (blob) => {
                        void processAudioChunk(blob);
                    },
                });

                recorderRef.current = recorder;
                recorder.startRecording();
                setIsRecording(true);
            } catch (error) {
                console.error("Error accessing microphone:", error);
                alert("Could not access microphone. Please check permissions.");
            }
        }, [ensureAudioContext, processAudioChunk]);

        const startTransmission = useCallback(async () => {
            if (!isConnected) {
                addMessage(
                    "Cannot start transmission: voice socket is not connected.",
                    "error"
                );
                return;
            }

            if (!isRecording) {
                try {
                    await startRecording();
                } catch (error) {
                    console.error("Failed to start recording:", error);
                    return;
                }
            }

            if (!socketRef.current?.isConnected()) {
                console.warn("Cannot start transmission: socket not connected.");
                return;
            }

            updateTransmittingState(true);
        }, [addMessage, isConnected, isRecording, startRecording, updateTransmittingState]);

        const disconnectSocket = useCallback(() => {
            currentSessionIdRef.current = null;

            if (socketRef.current) {
                socketRef.current.close(1000, "Client closing connection");
                socketRef.current = null;
                return;
            }

            if (connectedRef.current) {
                connectedRef.current = false;
                setIsConnected(false);
                setStatus("Disconnected");
                onVoiceSocketDisconnected?.();
            }

            stopTransmission();
            stopRecording();
        }, [onVoiceSocketDisconnected, stopRecording, stopTransmission]);

        const connectSocket = useCallback(
            () => {
                if (
                    connectedRef.current &&
                    socketRef.current?.isConnected()
                ) {
                    return Promise.resolve();
                }

                if (connectInFlightRef.current) {
                    return connectInFlightRef.current;
                }

                if (socketRef.current) {
                    socketRef.current.close(1000, "Reconnecting");
                    socketRef.current = null;
                }

                setStatus("Connecting");
                addMessage(
                    "Connecting voice socket",
                    "info"
                );

                const socket = new VoiceSocket();
                socketRef.current = socket;

                connectInFlightRef.current = new Promise<void>((resolve, reject) => {
                    let settled = false;

                    socket.onOpen(() => {
                        settled = true;
                        connectInFlightRef.current = null;
                        connectedRef.current = true;
                        setIsConnected(true);
                        setStatus("Connected");
                        addMessage("Voice socket connected", "success");
                        onVoiceSocketConnected?.();
                        resolve();
                    });

                    socket.onClose((event) => {
                        connectInFlightRef.current = null;
                        connectedRef.current = false;
                        setIsConnected(false);
                        setStatus("Disconnected");
                        addMessage(
                            `Voice socket disconnected: ${
                                event?.code ?? "unknown"
                            } ${event?.reason ?? ""}`.trim(),
                            "info"
                        );
                        stopTransmission();
                        stopRecording();
                        onVoiceSocketDisconnected?.();
                        currentSessionIdRef.current = null;

                        if (!settled) {
                            settled = true;
                            reject(
                                new Error(
                                    `Voice socket closed before establishing connection (${event?.code ?? "unknown"})`
                                )
                            );
                        }
                    });

                    socket.onError((event) => {
                        const message =
                            event instanceof ErrorEvent
                                ? event.message
                                : "Voice socket encountered an error.";
                        setStatus("Error");
                        addMessage(message, "error");

                        if (!settled) {
                            settled = true;
                            connectInFlightRef.current = null;
                            reject(new Error(message));
                        }
                    });

                    socket.onState((value) => {
                        setStatus(value || "Unknown");
                    });

                    socket.onLog((message, level) => {
                        addMessage(message, level);
                    });

                    socket.onMessage((data: ServerMessage) => {
                        if (data.type !== "state" && data.type !== "audio") {
                            console.log("Received from server:", data);
                        }
                    });

                    socket.init();
                }).finally(() => {
                    connectInFlightRef.current = null;
                });

                return connectInFlightRef.current;
            },
            [
                addMessage,
                onVoiceSocketConnected,
                onVoiceSocketDisconnected,
                stopRecording,
                stopTransmission,
            ]
        );

        useImperativeHandle(
            ref,
            () => ({
                connect: connectSocket,
                disconnect: disconnectSocket,
                isConnected: () => connectedRef.current,
            }),
            [connectSocket, disconnectSocket]
        );

        useEffect(() => {
            return () => {
                stopTransmission();
                stopRecording();
                if (socketRef.current) {
                    socketRef.current.close(1000, "Component unmounting");
                    socketRef.current = null;
                }
            };
        }, [stopRecording, stopTransmission]);

        return (
            <section className="flex h-full flex-col rounded-lg bg-white p-6 shadow-md">
                <header className="flex flex-col gap-2 border-b border-gray-200 pb-4">
                    <div className="flex items-center justify-between">
                        <h2 className="text-2xl font-semibold text-gray-900">
                            Voice Recorder
                        </h2>
                        <div
                            className={`flex items-center space-x-2 rounded-full px-3 py-1 text-sm font-medium ${
                                isConnected ? "bg-green-100" : "bg-gray-100"
                            }`}
                        >
                            <span
                                className={`h-2.5 w-2.5 rounded-full ${
                                    isConnected ? "bg-green-500" : "bg-gray-400"
                                }`}
                            ></span>
                            <span
                                className={
                                    isConnected ? "text-green-700" : "text-gray-600"
                                }
                            >
                                {isConnected ? "Connected" : "Disconnected"}
                            </span>
                        </div>
                    </div>
                    <div className="flex items-center justify-between text-sm text-gray-500">
                        <span>Status: {status}</span>
                        <span>
                            Session:{" "}
                            {currentSessionIdRef.current ?? (
                                <span className="text-gray-400">None</span>
                            )}
                        </span>
                    </div>
                </header>

                <div className="mt-6 space-y-4">
                    <div className="flex flex-wrap gap-3">
                        <button
                            onClick={() => {
                                void startTransmission();
                            }}
                            disabled={!isConnected || isTransmitting}
                            className="flex-1 min-w-[160px] rounded-lg bg-green-500 px-4 py-3 text-sm font-medium text-white transition hover:bg-green-600 disabled:cursor-not-allowed disabled:bg-gray-300"
                        >
                            {isTransmitting ? "Audio Active" : "Start Audio"}
                        </button>
                        <button
                            onClick={stopTransmission}
                            disabled={!isTransmitting}
                            className="flex-1 min-w-[160px] rounded-lg bg-orange-500 px-4 py-3 text-sm font-medium text-white transition hover:bg-orange-600 disabled:cursor-not-allowed disabled:bg-gray-300"
                        >
                            Stop Audio
                        </button>
                        <button
                            onClick={disconnectSocket}
                            disabled={!isConnected && !isRecording && !isTransmitting}
                            className="flex-1 min-w-[160px] rounded-lg bg-red-500 px-4 py-3 text-sm font-medium text-white transition hover:bg-red-600 disabled:cursor-not-allowed disabled:bg-gray-300"
                        >
                            Disconnect
                        </button>
                    </div>

                    {!isConnected && (
                        <p className="text-sm text-gray-500">
                            Use the Connect button above the page to establish the voice
                            WebSocket before starting audio transmission.
                        </p>
                    )}

                    {isConnected && !isTransmitting && (
                        <p className="text-sm text-gray-500">
                            Press &amp;quot;Start Audio&amp;quot; to begin recording and streaming
                            microphone input to the server.
                        </p>
                    )}

                    {isTransmitting && (
                        <p className="text-sm font-medium text-green-600">
                            🎤 Recording and transmitting audio…
                        </p>
                    )}

                    {isRecording && (
                        <div className="flex justify-center">
                            <div className="flex space-x-1">
                                <div className="h-4 w-1 animate-pulse bg-red-500"></div>
                                <div className="h-6 w-1 animate-pulse bg-red-500 delay-75"></div>
                                <div className="h-8 w-1 animate-pulse bg-red-500 delay-100"></div>
                                <div className="h-6 w-1 animate-pulse bg-red-500 delay-75"></div>
                                <div className="h-4 w-1 animate-pulse bg-red-500"></div>
                            </div>
                        </div>
                    )}
                </div>

                <div className="mt-6 flex-1">
                    <h3 className="text-lg font-semibold text-gray-700">Event Log</h3>
                    <div className="mt-2 max-h-48 overflow-y-auto rounded-md border border-gray-200 bg-gray-50 p-3 text-left">
                        {messages.length === 0 ? (
                            <p className="text-sm text-gray-500">
                                Events will appear here.
                            </p>
                        ) : (
                            messages.map((message) => {
                                const color =
                                    message.level === "error"
                                        ? "text-red-600"
                                        : message.level === "success"
                                        ? "text-green-600"
                                        : "text-gray-700";
                                return (
                                    <p key={message.id} className={`text-sm ${color}`}>
                                        {message.text}
                                    </p>
                                );
                            })
                        )}
                    </div>
                </div>
            </section>
        );
    }
);

AudioRecorder.displayName = "AudioRecorder";

export default AudioRecorder;
