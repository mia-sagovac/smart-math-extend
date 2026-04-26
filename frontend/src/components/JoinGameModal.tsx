'use client';

import { getAuthedSocket } from '@/lib/realtime/socket';
import { getEmoji, PASSWORD_KEYS } from '@/lib/utils';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Socket } from 'socket.io-client';
import { Spinner } from './ui';

interface JoinGameModalProps {
    isOpen: boolean;
    onClose: () => void;
    onJoined?: (gameCode: string) => void;
    onLeft?: () => void;
    existingGameCode?: string | null;
}

export function JoinGameModal({ isOpen, onClose, onJoined, onLeft, existingGameCode }: JoinGameModalProps) {
    const router = useRouter();
    const [code, setCode] = useState<string[]>(['', '', '']);
    const [isConnecting, setIsConnecting] = useState(false);
    const [isJoined, setIsJoined] = useState(false);
    const [isClosed, setIsClosed] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const socketRef = useRef<Socket | null>(null);
    const joinTimeoutRef = useRef<number | null>(null);

    const gameKeys = useMemo(() => PASSWORD_KEYS, []);
    const isComplete = code.every(c => c !== '');
    const gameCode = code.join('');

    useEffect(() => {
        if (!isOpen) return;
        // reset on open
        setCode(existingGameCode ? existingGameCode.split('') : ['', '', '']);
        setIsConnecting(false);
        setIsJoined(Boolean(existingGameCode));
        setIsClosed(false);
        setError(null);
    }, [isOpen, existingGameCode]);

    const handleEmojiClick = (key: string) => {
        const emptyIndex = code.findIndex(p => p === '');
        if (emptyIndex !== -1) {
            const next = [...code];
            next[emptyIndex] = key;
            setCode(next);
        }
    };

    const handleSlotClick = (index: number) => {
        const next = code.map((p, i) => (i >= index ? '' : p));
        setCode(next);
    };

    const cleanupSocket = () => {
        if (joinTimeoutRef.current) {
            window.clearTimeout(joinTimeoutRef.current);
            joinTimeoutRef.current = null;
        }
        if (socketRef.current) {
            socketRef.current.disconnect();
            socketRef.current = null;
        }
    };

    const handleClose = () => {
        cleanupSocket();
        if (isJoined) {
            setIsJoined(false);
            setIsConnecting(false);
            setIsClosed(false);
            setError(null);
            onLeft?.();
        }
        onClose();
    };

    const handleJoin = async () => {
        setError(null);
        const codeToUse = existingGameCode || gameCode;
        if (!codeToUse || codeToUse.length !== 3 || (existingGameCode ? false : !isComplete)) {
            setError('Molimo unesite 3 emojia za kod igre');
            return;
        }

        const token = localStorage.getItem('auth_token');
        if (!token || !token.trim()) {
            setError('Niste prijavljeni');
            return;
        }

        setIsConnecting(true);

        const socket = getAuthedSocket(token);

        socketRef.current = socket;

        // Clean up listeners
        socket.off('connect');
        socket.off('joinedGame');
        socket.off('updatePlayers');
        socket.off('receiveQuestions');
        socket.off('gameStarted');
        socket.off('gameClosed');
        socket.off('error');
        socket.off('connect_error');
        socket.off('disconnect');

        socket.on('connect', () => {
            socket.emit('joinGame', { game_code: codeToUse });
        });

        // Join game if socket is connected.
        if (socket.connected) {
            socket.emit('joinGame', { game_code: codeToUse });
        }

        if (joinTimeoutRef.current) window.clearTimeout(joinTimeoutRef.current);
        joinTimeoutRef.current = window.setTimeout(() => {
            setError('Nije moguće pridružiti se igri (timeout). Pokušaj ponovno.');
            setIsConnecting(false);
            joinTimeoutRef.current = null;
        }, 8000);

        socket.on('joinedGame', () => {
            setIsJoined(true);
            setIsConnecting(false);
            onJoined?.(codeToUse);
            if (joinTimeoutRef.current) window.clearTimeout(joinTimeoutRef.current);
            joinTimeoutRef.current = null;
        });

        socket.on('updatePlayers', (data: { players: string[] }) => {
            setIsJoined(true);
            setIsConnecting(false);
            onJoined?.(codeToUse);
            if (joinTimeoutRef.current) window.clearTimeout(joinTimeoutRef.current);
            joinTimeoutRef.current = null;
        });

        socket.on('receiveQuestions', (data: any) => {
            try {
                const gameId = String(data?.game_id ?? '');
                if (gameId) {
                    sessionStorage.setItem(`game_payload_${gameId}`, JSON.stringify(data));
                    router.push(`/student/game/${gameId}`);
                }
            } catch {
            }
        });

        socket.on('gameStarted', (data: any) => {
            const gameId = String(data?.game_id ?? '');
            if (gameId) {
                router.push(`/student/game/${gameId}`);
            }
        });

        socket.on('gameClosed', () => {
            // Teacher ended/closed the lobby
            setIsConnecting(false);
            setIsJoined(false);
            setIsClosed(true);
            onLeft?.();
            if (joinTimeoutRef.current) window.clearTimeout(joinTimeoutRef.current);
            joinTimeoutRef.current = null;
        });

        socket.on('error', (data: { message?: string }) => {
            setError(data?.message || 'Greška pri spajanju na igru');
            setIsConnecting(false);
            setIsJoined(false);
            if (joinTimeoutRef.current) window.clearTimeout(joinTimeoutRef.current);
            joinTimeoutRef.current = null;
        });

        socket.on('connect_error', (err: unknown) => {
            const msg =
                typeof err === 'object' && err && 'message' in err
                    ? String((err as { message?: unknown }).message ?? '')
                    : '';
            setError(msg || 'Greška pri povezivanju');
            setIsConnecting(false);
            setIsJoined(false);
            if (joinTimeoutRef.current) window.clearTimeout(joinTimeoutRef.current);
            joinTimeoutRef.current = null;
        });

        socket.on('disconnect', (reason) => {
            // If server rejects auth it often disconnects quickly.
            if (!isJoined) {
                setError(`Prekinuta veza: ${reason}`);
                setIsConnecting(false);
            }
        });
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="card p-6 max-w-md w-full relative animate-in fade-in zoom-in duration-200">
                <button
                    onClick={handleClose}
                    className="absolute top-3 right-3 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                    aria-label={isJoined ? 'Odustani i napusti igru' : 'Zatvori'}
                    title={isJoined ? 'Odustani' : 'Zatvori'}
                >
                    ✕
                </button>

                <h2 className="text-xl font-bold mb-2">Pridruži se igri</h2>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                    {isClosed ? 'Igra je završena' : isJoined ? 'Pridružen/a igri' : 'Unesi kod igre (3 emojia)'}
                </p>

                {error && (
                    <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                        <p className="text-red-600 dark:text-red-400 text-sm">{error}</p>
                    </div>
                )}

                {!isJoined && (
                    <>
                        <div className="flex justify-center gap-3 mb-4">
                            {code.map((letter, index) => (
                                <button
                                    key={index}
                                    onClick={() => handleSlotClick(index)}
                                    disabled={isConnecting}
                                    className={`w-14 h-14 rounded-xl border-3 text-2xl flex items-center justify-center transition-all duration-200
                                        ${letter
                                            ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-900/30 scale-105'
                                            : 'border-dashed border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800'
                                        }
                                        hover:border-indigo-400 disabled:opacity-50 disabled:cursor-not-allowed`}
                                    title={letter ? 'Klikni za brisanje' : `Polje ${index + 1}`}
                                >
                                    {letter ? getEmoji(letter) : (
                                        <span className="text-gray-300 dark:text-gray-600 text-lg">{index + 1}</span>
                                    )}
                                </button>
                            ))}
                        </div>

                        <div className={`bg-gray-50 dark:bg-gray-800/50 rounded-xl p-4 mb-4 ${isConnecting ? 'opacity-50' : ''}`}>
                            <p className="text-xs text-gray-400 text-center mb-3">Odaberi emoji za kod:</p>
                            <div className="flex justify-center gap-2 flex-wrap">
                                {gameKeys.map((key) => (
                                    <button
                                        key={key}
                                        onClick={() => handleEmojiClick(key)}
                                        disabled={!code.includes('') || isConnecting}
                                        className={`w-12 h-12 text-2xl rounded-xl transition-all duration-200 
                                            ${!code.includes('') || isConnecting
                                                ? 'opacity-40 cursor-not-allowed'
                                                : 'hover:bg-indigo-100 dark:hover:bg-indigo-900/40 hover:scale-110 active:scale-95 cursor-pointer'
                                            }
                                            bg-white dark:bg-gray-700 shadow-sm border border-gray-200 dark:border-gray-600`}
                                    >
                                        {getEmoji(key)}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </>
                )}

                <button
                    onClick={handleJoin}
                    disabled={isConnecting || (!existingGameCode && !isComplete) || isJoined}
                    className="btn btn-primary w-full py-3 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {isConnecting ? (
                        <span className="flex items-center justify-center gap-2">
                            <Spinner />
                            Povezivanje...
                        </span>
                    ) : isJoined ? (
                        'Pridruženo!'
                    ) : (
                        'Pridruži se'
                    )}
                </button>

                {isJoined && (
                    <div className="mt-4 text-center">
                        <div className="flex items-center justify-center gap-2 text-gray-600 dark:text-gray-300">
                            <Spinner />
                            <span className="font-medium">Čekam da profesor započne igru…</span>
                        </div>
                        <p className="text-xs text-gray-400 mt-2">
                            Ne zatvaraj ovu stranicu.
                        </p>
                    </div>
                )}

                {isClosed && (
                    <div className="mt-4 text-center">
                        <p className="text-sm text-gray-600 dark:text-gray-300">
                            Profesor je zatvorio igru.
                        </p>
                        <button
                            onClick={handleClose}
                            className="btn btn-secondary w-full py-3 mt-4"
                        >
                            U redu
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}


