'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { JoinGameModal, Spinner } from '@/components';
import { useAuthStore } from '@/lib/store';

export default function StudentDashboard() {
    const router = useRouter();
    const { user, isAuthenticated, isHydrated, logout } = useAuthStore();
    const [showJoinGame, setShowJoinGame] = useState(false);
    const [joinedGameCode, setJoinedGameCode] = useState<string | null>(null);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const code = localStorage.getItem('joined_game_code');
        if (code && code.trim().length === 4) {
            setJoinedGameCode(code.trim());
            setShowJoinGame(true);
        }
    }, []);

    // Redirect to login if not authenticated
    useEffect(() => {
        if (isHydrated && (!isAuthenticated || !user)) {
            router.push('/');
        }
    }, [isHydrated, isAuthenticated, user, router]);

    // Redirect teachers to their dashboard
    useEffect(() => {
        if (isHydrated && user && user.role === 'teacher') {
            router.push('/teacher/dashboard');
        }
    }, [isHydrated, user, router]);

    const handleLogout = () => {
        logout();
        router.push('/');
    };

    // Show loading while hydrating or redirecting
    if (!isHydrated || !isAuthenticated || !user || user.role !== 'student') {
        return (
            <main className="min-h-screen flex items-center justify-center">
                <Spinner />
            </main>
        );
    }

    return (
        <main className="min-h-screen relative">
            {/* Header with user info */}
            <header className="absolute top-0 left-0 right-0 p-4 sm:p-6 flex justify-end items-center">
                <div className="flex items-center gap-3 sm:gap-4">
                    <div className="flex items-center gap-2 px-3 py-2 rounded-xl" style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)' }}>
                        <i className="fa-solid fa-user-circle text-xl text-sky-500 mr-2" />
                        <span className="font-medium">{user.username}</span>
                    </div>
                    <a href="https://docs.google.com/forms/d/e/1FAIpQLSdqu_E1XEMSSxCGB6DdaShjCs2XSxdouXagCLNTKHGP8P8Ksg/viewform" target="_blank" rel="noopener noreferrer" className="btn btn-outline flex items-center gap-2 !py-2 !px-4">
                        <i className="fa-solid fa-clipboard-list text-lg text-indigo-400" />
                        <span>Klikni me</span>
                    </a>
                    <button
                        onClick={handleLogout}
                        className="btn btn-outline flex items-center gap-2 !py-2 !px-4"
                    >
                        <span>Odjava</span>
                        <i className="fa-solid fa-door-open text-lg text-red-400 ml-2" />
                    </button>
                </div>
            </header>

            {/* Start game */}
            <div className="min-h-screen flex flex-col items-center justify-center p-8">
                <div className="text-center mb-8">
                    <div className="mb-4 flex justify-center">
                        <div className="w-16 h-16 flex items-center justify-center rounded-full bg-yellow-300">
                            <i className="fa-solid fa-face-smile-beam text-white text-3xl" />
                        </div>
                    </div>

                    <h1 className="text-2xl font-bold mb-2">Bok, {user.username}!</h1>

                </div>

                {!joinedGameCode && (
                    <button
                        onClick={() => setShowJoinGame(true)}
                        className="btn btn-primary text-xl px-10 py-4 flex items-center gap-3"
                    >
                        <i className="fa-solid fa-gamepad text-2xl" />
                        Pridruži se igri
                    </button>
                )}

            </div>

            <JoinGameModal
                isOpen={showJoinGame}
                onClose={() => setShowJoinGame(false)}
                existingGameCode={joinedGameCode}
                onJoined={(code) => {
                    setJoinedGameCode(code);
                    localStorage.setItem('joined_game_code', code);
                    setShowJoinGame(true);
                }}
                onLeft={() => {
                    setJoinedGameCode(null);
                    localStorage.removeItem('joined_game_code');
                    setShowJoinGame(false);
                }}
            />
        </main>
    );
}
