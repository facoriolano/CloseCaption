

import React, { useState, useRef, useEffect, useCallback } from 'react';
// FIX: Removed non-exported `LiveSession` and added `LiveServerMessage` and `Modality` for proper typing.
import { GoogleGenAI, Blob, LiveServerMessage, Modality } from '@google/genai';
import { PlayIcon, StopIcon, EyeIcon, EyeOffIcon, MaximizeIcon, MinimizeIcon, ArrowDownIcon } from './components/icons';

// Helper functions for audio encoding as per Gemini API documentation
function encode(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function createBlob(data: Float32Array): Blob {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    int16[i] = data[i] < 0 ? data[i] * 32768 : data[i] * 32767;
  }
  return {
    data: encode(new Uint8Array(int16.buffer)),
    mimeType: 'audio/pcm;rate=16000',
  };
}

const App: React.FC = () => {
    const [isCapturing, setIsCapturing] = useState(false);
    const [transcripts, setTranscripts] = useState<string[]>([]);
    const [currentTranscript, setCurrentTranscript] = useState('');
    const [showControls, setShowControls] = useState(true);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [isScrolledUp, setIsScrolledUp] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // FIX: Replaced `LiveSession` with an inline type definition for the session object, as `LiveSession` is not exported.
    const sessionPromiseRef = useRef<Promise<{ sendRealtimeInput(input: { media: Blob }): void; close(): void; }> | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);

    const handleFullscreenChange = useCallback(() => {
        setIsFullscreen(!!document.fullscreenElement);
    }, []);

    useEffect(() => {
        document.addEventListener('fullscreenchange', handleFullscreenChange);
        return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
    }, [handleFullscreenChange]);

    useEffect(() => {
        if (scrollContainerRef.current && !isScrolledUp) {
            scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
        }
    }, [transcripts, currentTranscript, isScrolledUp]);

    const startCapture = useCallback(async () => {
        setTranscripts([]);
        setCurrentTranscript('');
        setError(null);
        setIsCapturing(true);

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;

            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY as string });
            // FIX: Added explicit cast to `any` to handle vendor-prefixed `webkitAudioContext` which may not be in default TS types.
            audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });

            sessionPromiseRef.current = ai.live.connect({
                model: 'gemini-2.5-flash-native-audio-preview-09-2025',
                callbacks: {
                    onopen: () => {
                        if (!audioContextRef.current || !streamRef.current) return;
                        const source = audioContextRef.current.createMediaStreamSource(streamRef.current);
                        scriptProcessorRef.current = audioContextRef.current.createScriptProcessor(4096, 1, 1);
                        
                        scriptProcessorRef.current.onaudioprocess = (audioProcessingEvent) => {
                            const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
                            const pcmBlob = createBlob(inputData);
                            sessionPromiseRef.current?.then((session) => {
                                session.sendRealtimeInput({ media: pcmBlob });
                            });
                        };
                        
                        source.connect(scriptProcessorRef.current);
                        scriptProcessorRef.current.connect(audioContextRef.current.destination);
                    },
                    // FIX: Added `LiveServerMessage` type to the onmessage callback parameter.
                    onmessage: (message: LiveServerMessage) => {
                        if (message.serverContent?.inputTranscription) {
                            const text = message.serverContent.inputTranscription.text;
                            setCurrentTranscript(prev => prev + text);
                        }
                        if (message.serverContent?.turnComplete) {
                            setCurrentTranscript(prevCurrent => {
                                if (prevCurrent.trim()) {
                                    setTranscripts(prevHistory => [...prevHistory, prevCurrent.trim()]);
                                }
                                return '';
                            });
                        }
                    },
                    // FIX: Added `ErrorEvent` type to the onerror callback parameter.
                    onerror: (e: ErrorEvent) => {
                        console.error('Gemini API Error:', e);
                        setError('An API error occurred. Please try again.');
                        stopCapture();
                    },
                    // FIX: Added `CloseEvent` type to the onclose callback parameter.
                    onclose: (_e: CloseEvent) => {
                        // Connection closed
                    },
                },
                // FIX: Added `responseModalities` to comply with Live API rules.
                config: {
                    responseModalities: [Modality.AUDIO],
                    inputAudioTranscription: {},
                },
            });

        } catch (err) {
            console.error('Error starting capture:', err);
            setError('Could not access microphone. Please grant permission and try again.');
            setIsCapturing(false);
        }
    }, []);

    const stopCapture = useCallback(async () => {
        setIsCapturing(false);

        if (sessionPromiseRef.current) {
            try {
                const session = await sessionPromiseRef.current;
                session.close();
            } catch (e) {
                console.error("Error closing session:", e);
            }
            sessionPromiseRef.current = null;
        }

        if (streamRef.current) {
            streamRef.current.getTracks().forEach(track => track.stop());
            streamRef.current = null;
        }
        
        if (scriptProcessorRef.current) {
            scriptProcessorRef.current.disconnect();
            scriptProcessorRef.current = null;
        }

        if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
            await audioContextRef.current.close();
            audioContextRef.current = null;
        }
    }, []);

    const handleScroll = () => {
        if (scrollContainerRef.current) {
            const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
            const isAtBottom = scrollHeight - scrollTop - clientHeight < 1;
            setIsScrolledUp(!isAtBottom);
        }
    };
    
    const scrollToBottom = () => {
      if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
      }
    };

    const toggleFullscreen = () => {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(err => {
                setError(`Error attempting to enable full-screen mode: ${err.message} (${err.name})`);
            });
        } else {
            document.exitFullscreen();
        }
    };

    return (
        <main className="bg-black text-white h-screen w-screen flex flex-col font-sans relative overflow-hidden">
            <div
                ref={scrollContainerRef}
                onScroll={handleScroll}
                className="flex-grow w-full max-w-5xl mx-auto p-8 md:p-12 overflow-y-auto"
            >
                <div className="flex flex-col justify-end min-h-full">
                    {transcripts.map((text, index) => (
                        <p key={index} className="text-3xl md:text-5xl lg:text-6xl leading-normal md:leading-snug lg:leading-tight mb-4 animate-fade-in">
                            {text}
                        </p>
                    ))}
                    {currentTranscript && (
                        <p className="text-3xl md:text-5xl lg:text-6xl leading-normal md:leading-snug lg:leading-tight text-gray-400">
                            {currentTranscript}
                        </p>
                    )}
                </div>
            </div>
            
            {error && <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-red-800 text-white px-4 py-2 rounded-md shadow-lg">{error}</div>}

            {isScrolledUp && (
                <button
                    onClick={scrollToBottom}
                    className="absolute bottom-28 lg:bottom-24 left-1/2 -translate-x-1/2 bg-blue-600 hover:bg-blue-500 text-white rounded-full p-3 shadow-lg transition-transform duration-200 hover:scale-110 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-opacity-75 animate-bounce z-20"
                    aria-label="Scroll to bottom"
                >
                    <ArrowDownIcon />
                </button>
            )}

            {showControls && (
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-4 bg-gray-900 bg-opacity-70 backdrop-blur-sm p-3 rounded-full shadow-2xl transition-opacity duration-300">
                    {!isCapturing ? (
                        <button onClick={startCapture} className="bg-green-600 hover:bg-green-500 rounded-full p-4 text-white transition-transform duration-200 hover:scale-110 focus:outline-none focus:ring-2 focus:ring-green-400 focus:ring-opacity-75" aria-label="Start Capturing">
                            <PlayIcon />
                        </button>
                    ) : (
                        <button onClick={stopCapture} className="bg-red-600 hover:bg-red-500 rounded-full p-4 text-white transition-transform duration-200 hover:scale-110 focus:outline-none focus:ring-2 focus:ring-red-400 focus:ring-opacity-75" aria-label="Stop Capturing">
                            <StopIcon />
                        </button>
                    )}
                    <button onClick={toggleFullscreen} className="bg-gray-700 hover:bg-gray-600 rounded-full p-4 text-white transition-transform duration-200 hover:scale-110 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-opacity-75" aria-label="Toggle Fullscreen">
                        {isFullscreen ? <MinimizeIcon /> : <MaximizeIcon />}
                    </button>
                </div>
            )}

            <button onClick={() => setShowControls(!showControls)} className="absolute bottom-6 right-6 bg-gray-700 hover:bg-gray-600 rounded-full p-4 text-white transition-transform duration-200 hover:scale-110 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-opacity-75 z-10" aria-label={showControls ? 'Hide Controls' : 'Show Controls'}>
                {showControls ? <EyeOffIcon /> : <EyeIcon />}
            </button>
        </main>
    );
};

export default App;