'use client';

import { passwordToEmojis } from '@/lib/utils';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { Spinner } from './ui';

interface GameLobbyModalProps {
    isOpen: boolean;
    onClose: () => void;
    gameId: string;
    gameCode: string;
    topic: { id: string; name: string };
    classroomId: string;
}

export function GameLobbyModal({ isOpen, onClose, gameId, gameCode, topic, classroomId }: GameLobbyModalProps) {
    const router = useRouter();
    const [players, setPlayers] = useState<string[]>([]);
    const [isConnecting, setIsConnecting] = useState(true);
    const [isStarting, setIsStarting] = useState(false);
    const [connectionError, setConnectionError] = useState<string | null>(null);
    const socketRef = useRef<Socket | null>(null);

    useEffect(() => {
        if (!isOpen || !gameId) return;

        const token = localStorage.getItem('auth_token');
        if (!token) {
            setConnectionError('Niste prijavljeni');
            setIsConnecting(false);
            return;
        }

        // Connect to WebSocket
        const socket = io(`${process.env.NEXT_PUBLIC_API_URL}`, {
            transports: ['polling', 'websocket'],
            withCredentials: true,
            extraHeaders: {
                Authorization: `Bearer ${token}`,
            },
            auth: {
                token: token,
            },
        });

        socketRef.current = socket;

        socket.on('connect', () => {
            console.log('Socket connected');
            setIsConnecting(false);
            setConnectionError(null);

            // Teacher joins the game room
            socket.emit('teacherJoin', { game_id: gameId, mode: 'lobby' });
        });

        socket.on('connect_error', (error) => {
            console.error('Socket connection error:', error);
            setConnectionError('Greška pri povezivanju');
            setIsConnecting(false);
        });

        socket.on('updatePlayers', (data: { players: string[] }) => {
            console.log('Players updated:', data.players);
            setPlayers(data.players);
        });

        socket.on('gameStarted', () => {
            setIsStarting(false);
            const params = new URLSearchParams({
                topicId: topic.id,
                topicName: topic.name,
                classroomId,
            });
            router.push(`/teacher/game/${gameId}?${params.toString()}`);
            onClose();
        });

        socket.on('error', (data: { message: string }) => {
            console.error('Socket error:', data.message);
            setConnectionError(data.message);
            setIsStarting(false);
        });

        return () => {
            socket.disconnect();
            socketRef.current = null;
        };
    }, [isOpen, gameId]);

    const handleClose = () => {
        if (socketRef.current) {
            // Closing lobby
            socketRef.current.emit('closeLobby', { game_id: gameId });
            socketRef.current.disconnect();
            socketRef.current = null;
        }
        setPlayers([]);
        setIsConnecting(true);
        setIsStarting(false);
        setConnectionError(null);
        onClose();
    };

    if (!isOpen) return null;

    // Convert game code to emojis (like class code)
    const gameCodeEmojis = passwordToEmojis(gameCode.split(''));

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="card p-6 sm:p-8 max-w-lg w-full relative animate-in fade-in zoom-in duration-200">
                {/* Close button */}
                <button
                    onClick={handleClose}
                    className="absolute top-3 right-3 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                >
                    ✕
                </button>

                {/* Header */}
                <div className="text-center mb-6">
                    <h2 className="text-2xl font-bold mb-2">Čekaonica igre</h2>
                    <p className="text-gray-500 dark:text-gray-400 text-sm">
                        Učenici se mogu pridružiti s kodom:
                    </p>
                </div>

                {/* Game Code Display */}
                <div className="bg-gradient-to-r from-indigo-500 to-purple-500 rounded-2xl p-6 mb-6 text-center">
                    <p className="text-white/80 text-sm mb-2">Kod igre</p>
                    <p className="text-5xl tracking-wider">{gameCodeEmojis}</p>
                </div>

                {/* Connection status */}
                {isConnecting && (
                    <div className="flex items-center justify-center gap-2 mb-4 text-gray-500">
                        <Spinner />
                        <span>Povezivanje...</span>
                    </div>
                )}

                {connectionError && (
                    <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                        <p className="text-red-600 dark:text-red-400 text-sm text-center">
                            {connectionError}
                        </p>
                    </div>
                )}

                {/* Players list */}
                <div className="mb-6">
                    <div className="flex items-center justify-between mb-3">
                        <h3 className="font-semibold text-gray-700 dark:text-gray-300">
                            Prijavljeni učenici
                        </h3>
                        <span className="text-sm bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 px-2 py-1 rounded-full">
                            {players.length}
                        </span>
                    </div>

                    {players.length === 0 ? (
                        <div className="text-center py-8 text-gray-400 border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-xl">
                            <i className="fa-solid fa-users text-3xl mb-2 opacity-50" />
                            <p>Čekanje učenika...</p>
                        </div>
                    ) : (
                        <div className="max-h-48 overflow-y-auto space-y-2">
                            {players.map((player, index) => (
                                <div
                                    key={index}
                                    className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-xl animate-in fade-in slide-in-from-left duration-300"
                                    style={{ animationDelay: `${index * 50}ms` }}
                                >
                                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-green-400 to-emerald-500 flex items-center justify-center text-white font-bold text-sm">
                                        {player.charAt(0).toUpperCase()}
                                    </div>
                                    <span className="font-medium">{player}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Start game button */}
                <button
                    disabled={players.length === 0}
                    onClick={() => {
                        if (!socketRef.current || !socketRef.current.connected) {
                            setConnectionError('Niste povezani na server');
                            return;
                        }
                        setIsStarting(true);
                        socketRef.current.emit('startGame', { game_id: gameId, topic_id: topic.id });
                    }}
                    className="btn btn-primary w-full py-3 text-lg disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    <i className="fa-solid fa-play mr-2" />
                    {isStarting ? (
                        <span className="inline-flex items-center gap-2">
                            <Spinner />
                            Pokretanje…
                        </span>
                    ) : (
                        `Započni igru (${players.length} učenika)`
                    )}
                </button>
            </div>
        </div>
    );
}

