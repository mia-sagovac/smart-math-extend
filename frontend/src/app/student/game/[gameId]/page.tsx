'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Spinner } from '@/components';
import { disconnectSocket, getAuthedSocket } from '@/lib/realtime/socket';
import { logStudentEvent } from '@/lib/realtime/student-logging';
import { useAuthStore } from '@/lib/store';
import styles from './xpBurst.module.css';

type QuestionPayload = {
    question_id: string;
    question: string;
    difficulty: number;
    type: 'num' | 'mcq' | 'wri';
    answer?: any;
};

type ReceiveQuestionsPayload = {
    game_id: string;
    topic_id: string;
    round_id?: string;
    questions: QuestionPayload[];
};

export default function StudentGamePage() {
    const router = useRouter();
    const params = useParams();
    const { user, isAuthenticated, isHydrated, logout } = useAuthStore();
    const gameId = String(params?.gameId ?? '');

    const dlog = (...args: any[]) => {
        try {
            if (typeof window !== 'undefined' && localStorage.getItem('debug_logs') === '1') {
                console.log('[student-game]', ...args);
            }
        } catch {
        }
    };

    const [payload, setPayload] = useState<ReceiveQuestionsPayload | null>(null);
    const [questionIndex, setQuestionIndex] = useState<number>(0);
    const [answer, setAnswer] = useState<string>('');
    const [error, setError] = useState<string | null>(null);
    const [feedback, setFeedback] = useState<string | null>(null);
    const [lastSaveStatus, setLastSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
    const [roundFeedback, setRoundFeedback] = useState<'hard' | 'ok' | 'easy' | null>(null);
    const [isLoadingNextBatch, setIsLoadingNextBatch] = useState(false);
    const [batchNumber, setBatchNumber] = useState<number>(0); // 1..3
    const [xp, setXp] = useState<number>(0);
    const [roundFirstTryCorrect, setRoundFirstTryCorrect] = useState<number>(0);
    const [roundXpEarned, setRoundXpEarned] = useState<number>(0);
    const [xpBursts, setXpBursts] = useState<Array<{ id: string; amount: number }>>([]);
    const [xpPulse, setXpPulse] = useState<number>(0);
    const answerInputRef = useRef<HTMLInputElement | null>(null);
    const finishedRoundIdsRef = useRef<Record<string, boolean>>({});
    const lastRoundIdRef = useRef<string | null>(null);
    const roundIndexByRoundIdRef = useRef<Record<string, number>>({});
    const roundFirstTryCorrectRef = useRef<number>(0);
    const [showWrongOverlay, setShowWrongOverlay] = useState(false);
    const roundXpEarnedRef = useRef<number>(0);
    const [showRoundSummary, setShowRoundSummary] = useState(false);
    const roundAggRef = useRef<{
        answered: number;
        correct: number;
        totalTimeSecs: number;
        totalHints: number;
        totalQuestions: number;
    }>({ answered: 0, correct: 0, totalTimeSecs: 0, totalHints: 0, totalQuestions: 0 });

    const allocateRoundIndex = (roundId: string, token?: string | null) => {
        if (!roundId) return 0;
        const existing = roundIndexByRoundIdRef.current[roundId];
        if (existing) return existing;

        const getUserKeyFromJwt = (jwtToken: string) => {
            try {
                const parts = jwtToken.split('.');
                if (parts.length < 2) return '';
                const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
                const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
                const json = atob(b64 + pad);
                const payload = JSON.parse(json) as any;
                return String(payload?.id ?? payload?.sub ?? '');
            } catch {
                return '';
            }
        };

        const tokenToUse =
            token ?? (typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null);
        const userKey = tokenToUse ? getUserKeyFromJwt(tokenToUse) : '';
        if (!userKey) return 0;

        const counterKey = `global_round_index_${userKey}`;
        const mappingKey = `round_index_${roundId}`;

        try {
            const fromSession = sessionStorage.getItem(mappingKey);
            if (fromSession) {
                const n = Number(fromSession);
                if (Number.isFinite(n) && n > 0) {
                    roundIndexByRoundIdRef.current[roundId] = n;
                    return n;
                }
            }
        } catch {
            // ignore
        }

        let next = 1;
        try {
            const current = Number(localStorage.getItem(counterKey) || '0');
            next = (Number.isFinite(current) ? current : 0) + 1;
            localStorage.setItem(counterKey, String(next));
            sessionStorage.setItem(mappingKey, String(next));
        } catch {
            // ignore
        }

        roundIndexByRoundIdRef.current[roundId] = next;
        return next;
    };

    const currentQuestion = useMemo(() => payload?.questions?.[questionIndex] ?? null, [payload, questionIndex]);

    const [questionStartedAt, setQuestionStartedAt] = useState<number>(Date.now());
    const [hasSubmitted, setHasSubmitted] = useState<boolean>(false);
    const [attemptsThisQuestion, setAttemptsThisQuestion] = useState<number>(0);
    const [hintClicksThisQuestion, setHintClicksThisQuestion] = useState<number>(0);
    const [lastAttemptWasWrong, setLastAttemptWasWrong] = useState<boolean>(false);
    const [isHintOpen, setIsHintOpen] = useState<boolean>(false);

    useEffect(() => {
        if (isHydrated && (!isAuthenticated || !user)) router.push('/');
    }, [isHydrated, isAuthenticated, user, router]);

    useEffect(() => {
        if (isHydrated && user && user.role !== 'student') {
            router.push(user.role === 'teacher' ? '/teacher/dashboard' : '/');
        }
    }, [isHydrated, user, router]);

    const fetchMyXp = async () => {
        const token = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
        if (!token) return;
        try {
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/stats/my-stats`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) return;
            const data = (await res.json()) as any;
            setXp(Number(data?.xp ?? 0) || 0);
        } catch {
            // ignore
        }
    };

    // Load XP on enter
    useEffect(() => {
        if (!isHydrated || !isAuthenticated || !user) return;
        void fetchMyXp();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isHydrated, isAuthenticated, user?.role]);

    const resetRoundXpTracking = () => {
        roundFirstTryCorrectRef.current = 0;
        roundXpEarnedRef.current = 0;
        setRoundFirstTryCorrect(0);
        setRoundXpEarned(0);
        setXpBursts([]);
    };

    const pushXpBurst = (amount: number) => {
        if (amount <= 0) return;
        const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
        setXpBursts((prev) => [...prev, { id, amount }]);
        setXpPulse((n) => n + 1);
        window.setTimeout(() => {
            setXpBursts((prev) => prev.filter((b) => b.id !== id));
        }, 900);
    };

    // Load payload from sessionStorage
    useEffect(() => {
        try {
            const raw = sessionStorage.getItem(`game_payload_${gameId}`);
            if (raw) {
                const parsed = JSON.parse(raw) as ReceiveQuestionsPayload;
                setPayload({
                    ...parsed,
                    game_id: String(parsed.game_id),
                    topic_id: String(parsed.topic_id),
                });
                setQuestionIndex(0);
                setBatchNumber(1);
                lastRoundIdRef.current = String(parsed.round_id ?? '');
                resetRoundXpTracking();
                if (parsed.round_id) allocateRoundIndex(String(parsed.round_id), localStorage.getItem('auth_token'));
                roundAggRef.current = {
                    answered: 0,
                    correct: 0,
                    totalTimeSecs: 0,
                    totalHints: 0,
                    totalQuestions: Array.isArray(parsed?.questions) ? parsed.questions.length : 0,
                };
            }
        } catch {
            // ignore
        }
    }, [gameId]);

    useEffect(() => {
        const token = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
        if (!token) return;

        const socket = getAuthedSocket(token);
        const handleClosed = () => {
            dlog('gameClosed');
            setError('Igra je završena');
            try {
                localStorage.removeItem('joined_game_code');
                sessionStorage.removeItem(`game_payload_${gameId}`);
            } catch {
                // ignore
            }
            router.push('/student/dashboard');
        };
        const handler = (data: any) => {
            const incomingGameId = String(data?.game_id ?? '');
            if (incomingGameId && incomingGameId === String(gameId)) {
                dlog('receiveQuestions', { gameId: incomingGameId, roundId: data?.round_id, count: data?.questions?.length });
                const incomingRoundId = String(data?.round_id ?? '');
                if (incomingRoundId && incomingRoundId === (lastRoundIdRef.current || '')) {
                    return; // ignore duplicate payload
                }
                lastRoundIdRef.current = incomingRoundId;
                logStudentEvent(token, 'round_started', {
                    game_id: incomingGameId,
                    topic_id: String(data?.topic_id ?? ''),
                    round_id: incomingRoundId,
                    question_count: Array.isArray(data?.questions) ? data.questions.length : null,
                });
                resetRoundXpTracking();
                if (incomingRoundId) allocateRoundIndex(incomingRoundId, token);
                roundAggRef.current = {
                    answered: 0,
                    correct: 0,
                    totalTimeSecs: 0,
                    totalHints: 0,
                    totalQuestions: Array.isArray(data?.questions) ? data.questions.length : 0,
                };
                try {
                    sessionStorage.setItem(`game_payload_${incomingGameId}`, JSON.stringify(data));
                } catch {
                    // ignore
                }
                setPayload(data as ReceiveQuestionsPayload);
                setQuestionIndex(0);
                setRoundFeedback(null);
                setIsLoadingNextBatch(false);
                setBatchNumber((n) => (n ? n + 1 : 1));
            }
        };

        socket.on('receiveQuestions', handler);
        socket.on('gameClosed', handleClosed);
        socket.on('finishRoundError', (d: any) => {
            dlog('finishRoundError', d);
            setError(String(d?.message ?? 'Greška pri završetku runde'));
        });
        socket.on('answerSaved', (data: any) => {
            if (String(data?.question_id ?? '') === String(currentQuestion?.question_id ?? '')) {
                setLastSaveStatus('saved');
            }
        });
        socket.on('answerError', () => {
            setLastSaveStatus('error');
        });

        return () => {
            socket.off('receiveQuestions', handler);
            socket.off('gameClosed', handleClosed);
            socket.off('finishRoundError');
            socket.off('answerSaved');
            socket.off('answerError');
        };
    }, [gameId, currentQuestion?.question_id, router]);

    // Reset when question changes
    useEffect(() => {
        if (!currentQuestion) return;
        setHasSubmitted(false);
        setAnswer('');
        setFeedback(null);
        setAttemptsThisQuestion(0);
        setHintClicksThisQuestion(0);
        setLastAttemptWasWrong(false);
        setIsHintOpen(false);
        const start = Date.now();
        setQuestionStartedAt(start);
        try {
            const token = localStorage.getItem('auth_token');
            if (token) {
                logStudentEvent(token, 'question_started', {
                    game_id: gameId,
                    round_id: String(payload?.round_id ?? ''),
                    question_id: String(currentQuestion?.question_id ?? ''),
                    question_index: questionIndex,
                    batch_number: batchNumber,
                    question_difficulty: currentQuestion?.difficulty ?? null,
                    question_text: String(currentQuestion?.question ?? '').slice(0, 240),
                });
            }
        } catch {
            // ignore
        }
        window.setTimeout(() => {
            try {
                answerInputRef.current?.focus();
                answerInputRef.current?.select();
            } catch {
                // ignore
            }
        }, 0);
    }, [currentQuestion]);

    const isRoundComplete = Boolean(payload && questionIndex >= (payload.questions?.length ?? 0));

    // When a round finishes, notify backend to finalize the round.
    useEffect(() => {
        if (!isRoundComplete) return;
        const token = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
        const roundId = String(payload?.round_id ?? '');
        if (!token || !roundId) return;
        if (finishedRoundIdsRef.current[roundId]) return;
        finishedRoundIdsRef.current[roundId] = true;

        try {
            const socket = getAuthedSocket(token);
            const agg = roundAggRef.current;
            const answered = Math.max(0, Number(agg.answered) || 0);
            const correct = Math.max(0, Number(agg.correct) || 0);
            const totalTimeSecs = Math.max(0, Number(agg.totalTimeSecs) || 0);
            const totalHints = Math.max(0, Number(agg.totalHints) || 0);
            const accuracy = answered > 0 ? correct / answered : 0;
            const avgTimeSecs = answered > 0 ? totalTimeSecs / answered : 0;
            const endTs = new Date().toISOString();
            const roundIndex = allocateRoundIndex(roundId, token);

            const finishPayload = {
                round_id: roundId,
                round_index: roundIndex,
                end_ts: endTs,
                accuracy,
                avg_time_secs: avgTimeSecs,
                hints: totalHints,
                xp: xp,
                selectedTopic: { topic_id: payload?.topic_id }
            };

            dlog('emit finish_round', finishPayload);
            socket.emit('finish_round', finishPayload);
            // refresh XP after finishing a round.
            window.setTimeout(() => {
                void fetchMyXp();
            }, 600);
        } catch {
            // ignore
        }
    }, [isRoundComplete, payload?.round_id]);

    useEffect(() => {
        if (isRoundComplete) {
            setShowRoundSummary(true);
        }
    }, [isRoundComplete]);

    const encouragementMessage = useMemo(() => {
        if (roundFirstTryCorrect >= 7) {
            return 'Odlično ti ide! Samo tako nastavi!';
        }
        if (roundFirstTryCorrect >= 4) {
            return 'Super trud! Svakim pitanjem sve više napreduješ';
        }
        return 'Bravo za trud! Idemo po još više bodova...';
    }, [roundFirstTryCorrect]);



    const computeTimeSpentSecs = () => {
        const elapsed = (Date.now() - questionStartedAt) / 1000;
        return Math.max(0, Math.round(elapsed));
    };

    const buildSubmitPayload = (overrides?: Record<string, unknown>) => {
        const isCorrectNow = computeIsCorrect();
        /*const studentLevel =
            user && user.role === 'student'
                ? (xp ? Math.max(1, Math.floor(xp / 100)) : null)
                : null;*/
        return {
            game_id: gameId,
            round_id: String(payload?.round_id ?? ''),
            question_id: String(currentQuestion?.question_id ?? ''),
            question_index: questionIndex,
            question_difficulty: currentQuestion?.difficulty ?? null,
            question_text: String(currentQuestion?.question ?? '').slice(0, 240),
            // student_level: studentLevel,
            answer_value: String(answer ?? '').trim().slice(0, 200),
            hints_used: hintClicksThisQuestion,
            time_spent_secs: computeTimeSpentSecs(),
            is_correct: isCorrectNow,
            ...overrides,
        };
    };

    const computeIsCorrect = () => {
        if (!currentQuestion) return false;
        const expectedRaw = currentQuestion.answer?.correct_answer;
        if (expectedRaw === undefined || expectedRaw === null) return false;

        if (currentQuestion.type === 'num') {
            const expected = Number(expectedRaw);
            return Number(answer) === expected;
        }

        const expected = String(expectedRaw).trim().toLowerCase();
        return answer.trim().toLowerCase() === expected;
    };

    const getHintText = () => {
        if (!currentQuestion || currentQuestion.type !== 'num') return null;
        const expectedRaw = currentQuestion.answer?.correct_answer;
        const expected = Number(expectedRaw);
        const entered = Number(answer);
        if (!Number.isFinite(expected) || !Number.isFinite(entered)) return 'Upiši broj kako bi dobio/la hint.';
        if (entered > expected) return 'Pokušaj unijeti manji broj.';
        if (entered < expected) return 'Pokušaj unijeti veći broj.';
        return 'To je točan broj.';
    };

    const finalizeQuestion = async (attemptsOverride?: number, source?: 'button' | 'enter') => {
        setError(null);
        setLastSaveStatus('saving');
        const token = localStorage.getItem('auth_token');
        if (!token) {
            setError('Niste prijavljeni');
            return;
        }
        if (!payload || !currentQuestion) return;
        if (hasSubmitted) return;

        const socket = getAuthedSocket(token);
        const roundId = payload.round_id;
        if (!roundId) {
            setError('Nedostaje round_id (backend mora poslati round_id u receiveQuestions)');
            return;
        }

        const isCorrect = computeIsCorrect();
        const timeSpentSecs = computeTimeSpentSecs();
        const numAttemptsToSend = Math.max(1, attemptsOverride ?? attemptsThisQuestion);

        // XP logic from backend
        if (isCorrect && numAttemptsToSend === 1) {
            const totalQ = Math.max(0, Number(payload?.questions?.length ?? 0) || 0);
            if (totalQ > 0) {
                const nextFirstTry = roundFirstTryCorrectRef.current + 1;
                const nextRoundXp = Math.floor((nextFirstTry * 100) / totalQ);
                const delta = nextRoundXp - roundXpEarnedRef.current;

                roundFirstTryCorrectRef.current = nextFirstTry;
                roundXpEarnedRef.current = nextRoundXp;
                setRoundFirstTryCorrect(nextFirstTry);
                setRoundXpEarned(nextRoundXp);

                if (delta > 0) {
                    setXp((x) => x + delta);
                    pushXpBurst(delta);
                }
            }
        }

        socket.emit('submit_answer', {
            round_id: roundId,
            question_id: currentQuestion.question_id,
            is_correct: isCorrect,
            time_spent_secs: timeSpentSecs,
            hints_used: hintClicksThisQuestion,
            num_attempts: numAttemptsToSend,
        });

        roundAggRef.current.answered += 1;
        roundAggRef.current.correct += isCorrect ? 1 : 0;
        roundAggRef.current.totalTimeSecs += timeSpentSecs;
        roundAggRef.current.totalHints += hintClicksThisQuestion;

        setHasSubmitted(true);
        setFeedback(isCorrect ? 'Točno!' : 'Netočno!');

        window.setTimeout(() => {
            setQuestionIndex((idx) => idx + 1);
        }, 350);
    };

    const handleAttempt = async (source: 'button' | 'enter') => {
        if (!currentQuestion || hasSubmitted) return;
        setFeedback(null);
        setError(null);

        const nextAttempts = attemptsThisQuestion + 1;
        setAttemptsThisQuestion(nextAttempts);

        const isCorrect = computeIsCorrect();
        try {
            const token = localStorage.getItem('auth_token');
            if (token) {
                logStudentEvent(token, 'submit_clicked', {
                    ...buildSubmitPayload({
                        submit_source: source,
                        attempt_number: nextAttempts,
                        num_attempts: nextAttempts,
                        is_correct: isCorrect,
                        will_send_to_backend: isCorrect,
                    }),
                });
            }
        } catch {
            // ignore
        }
        if (isCorrect) {
            setLastAttemptWasWrong(false);
            await finalizeQuestion(nextAttempts, source);
        } else {
            setLastAttemptWasWrong(true);
            setFeedback('Netočno, pokušaj ponovno');

            setShowWrongOverlay(true);
            setTimeout(() => setShowWrongOverlay(false), 600);
        }
    };

    const canShowHintButton =
        currentQuestion?.type === 'num' &&
        !hasSubmitted &&
        attemptsThisQuestion >= 1 &&
        lastAttemptWasWrong;

    const openHint = () => {
        if (!canShowHintButton) return;
        const nextHintClicks = hintClicksThisQuestion + 1;
        setHintClicksThisQuestion(nextHintClicks);
        setIsHintOpen(true);
        try {
            const token = localStorage.getItem('auth_token');
            if (token) {
                logStudentEvent(token, 'hint_clicked', {
                    hint_click_number: nextHintClicks,
                    ...buildSubmitPayload({
                        is_correct: computeIsCorrect(),
                    }),
                });
            }
        } catch {
            // ignore
        }
    };

    const handleNumberClick = (value: string) => {
        if (hasSubmitted) return;
        setAnswer((prev) => prev + value);
    };

    const handleBackspace = () => {
        if (hasSubmitted) return;
        setAnswer((prev) => prev.slice(0, -1));
    };

    const handleClear = () => {
        if (hasSubmitted) return;
        setAnswer('');
    };


    const handleLeaveGame = () => {
        // Leave the current game without logging out.
        disconnectSocket(); // triggers backend disconnect -> deactivates player
        try {
            localStorage.removeItem('joined_game_code');
            sessionStorage.removeItem(`game_payload_${gameId}`);
        } catch {
            // ignore
        }
        router.push('/student/dashboard');
    };

    const handleRoundFeedback = (value: 'hard' | 'ok' | 'easy') => {
        if (batchNumber >= 3) return;
        setRoundFeedback(value);
        const token = localStorage.getItem('auth_token');
        if (!token || !payload) return;
        const socket = getAuthedSocket(token);

        setIsLoadingNextBatch(true);
        // Backend expects for `fetch_new_batch`:
        // - room_id: gameId (string)
        // - selectedTopic: { topic_id }
        socket.emit('fetch_new_batch', {
            room_id: gameId,
            selectedTopic: { topic_id: payload.topic_id },
            feedback: value, // optional (backend can ignore for now)
        });
    };

    // After 3 sets, we end the game

    if (!isHydrated || !isAuthenticated || !user || user.role !== 'student') {
        return (
            <main className="min-h-screen flex items-center justify-center">
                <Spinner />
            </main>
        );
    }

    return (
        <main className="min-h-screen p-4 sm:p-8 max-w-2xl mx-auto pb-12">
            <header className="flex justify-end mb-6">
                <button onClick={handleLeaveGame} className="btn btn-outline !py-2 !px-4">
                    Izađi iz igre
                </button>
            </header>

            <div className="card p-6 sm:p-8">
                {error && (
                    <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                        <p className="text-red-600 dark:text-red-400 text-sm">{error}</p>
                    </div>
                )}

                {!currentQuestion ? (
                    <div className="flex flex-col items-center justify-center py-10 gap-3">
                        {isRoundComplete ? (
                            <div className="w-full max-w-md text-center">
                                {batchNumber >= 3 ? (
                                    <>
                                        <h2 className="text-lg font-bold mb-2">Igra je završena</h2>
                                        <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
                                            Odigrao/la si 3 setova pitanja. Bravo!
                                        </p>
                                        <button onClick={handleLeaveGame} className="btn btn-primary w-full py-3">
                                            U redu
                                        </button>
                                    </>
                                ) : (
                                    <>
                                        <h2 className="text-lg font-bold mb-2">Kako si se osjećao na ovoj rundi?</h2>
                                        <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
                                            Odaberi jednu opciju pa nastavljamo na sljedeći set pitanja.
                                        </p>

                                        <div className="flex justify-center gap-4">
                                            <button
                                                onClick={() => handleRoundFeedback('hard')}
                                                disabled={isLoadingNextBatch}
                                                className="btn btn-outline !px-5 !py-4 text-2xl disabled:opacity-50"
                                                title="Preteško"
                                            >
                                                <i className="fa-solid fa-face-dizzy text-3xl" />
                                            </button>
                                            <button
                                                onClick={() => handleRoundFeedback('ok')}
                                                disabled={isLoadingNextBatch}
                                                className="btn btn-outline !px-5 !py-4 text-2xl disabled:opacity-50"
                                                title="Taman"
                                            >
                                                <i className="fa-solid fa-face-meh text-3xl" />
                                            </button>

                                            <button
                                                onClick={() => handleRoundFeedback('easy')}
                                                disabled={isLoadingNextBatch}
                                                className="btn btn-outline !px-5 !py-4 text-2xl disabled:opacity-50"
                                                title="Prelagano"
                                            >
                                                <i className="fa-solid fa-face-smile-beam text-3xl" />
                                            </button>
                                        </div>

                                        {roundFeedback && !isLoadingNextBatch && (
                                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-4">
                                                Odabrano:{' '}
                                                {roundFeedback === 'easy'
                                                    ? 'Prelagano'
                                                    : roundFeedback === 'ok'
                                                        ? 'Taman'
                                                        : 'Preteško'}
                                            </p>
                                        )}

                                        {isLoadingNextBatch && (
                                            <div className="flex items-center justify-center gap-2 mt-6 text-gray-500">
                                                <Spinner />
                                                <span>Učitavam novi set pitanja…</span>
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>
                        ) : (
                            <>
                                <Spinner />
                                <p className="text-sm text-gray-500 dark:text-gray-400">
                                    Učitavam pitanja…
                                </p>
                            </>
                        )}
                    </div>
                ) : (
                    <>
                        <div className="flex items-center justify-between mb-6 gap-4">
                            <p className="text-sm text-gray-500 dark:text-gray-400">
                                {payload?.questions?.length
                                    ? `Pitanje ${Math.min(questionIndex + 1, payload.questions.length)} / ${payload.questions.length}`
                                    : 'Pitanje'}
                            </p>
                            <div className="flex flex-col items-end gap-1">
                                <div className={`relative flex items-center gap-2 text-2xl font-extrabold text-amber-500 ${styles.xpCounter}`}>
                                    <i className="fa-solid fa-star" />
                                    <span key={xpPulse} className={styles.xpNumber}>{xp}</span>
                                    <div className={styles.burstLayer} aria-hidden="true">
                                        {xpBursts.map((b, idx) => (
                                            <span key={b.id} className={styles.burst} style={{ ['--dx' as any]: `${((idx % 3) - 1) * 14}px` }}>
                                                <span className={styles.burstText}>+{b.amount}</span>
                                                <span className={styles.spark} style={{ ['--a' as any]: '0deg', ['--d' as any]: '24px', ['--s' as any]: '8px' }} />
                                                <span className={styles.spark} style={{ ['--a' as any]: '45deg', ['--d' as any]: '18px', ['--s' as any]: '6px' }} />
                                                <span className={styles.spark} style={{ ['--a' as any]: '90deg', ['--d' as any]: '26px', ['--s' as any]: '7px' }} />
                                                <span className={styles.spark} style={{ ['--a' as any]: '135deg', ['--d' as any]: '20px', ['--s' as any]: '6px' }} />
                                                <span className={styles.spark} style={{ ['--a' as any]: '180deg', ['--d' as any]: '24px', ['--s' as any]: '8px' }} />
                                                <span className={styles.spark} style={{ ['--a' as any]: '225deg', ['--d' as any]: '18px', ['--s' as any]: '6px' }} />
                                                <span className={styles.spark} style={{ ['--a' as any]: '270deg', ['--d' as any]: '26px', ['--s' as any]: '7px' }} />
                                                <span className={styles.spark} style={{ ['--a' as any]: '315deg', ['--d' as any]: '20px', ['--s' as any]: '6px' }} />
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div className="mb-6">
                            <p className="text-lg font-medium">{currentQuestion.question}</p>

                        </div>

                        <div className="mb-4">
                            <input
                                ref={answerInputRef}
                                value={answer}
                                readOnly
                                inputMode="none"
                                className="w-full px-4 py-3 rounded-xl border bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 outline-none cursor-default"
                                placeholder="Unesi broj klikom na tipkovnicu ispod…"
                            />

                            {currentQuestion.type === 'num' && (
                                <div className="numeric-keyboard mt-4">
                                    <div className="grid grid-cols-3 gap-3">
                                        {[1,2,3,4,5,6,7,8,9].map((num) => (
                                            <button
                                                key={num}
                                                type="button"
                                                onClick={() => handleNumberClick(String(num))}
                                                className="num-key"
                                            >
                                                {num}
                                            </button>
                                        ))}

                                        <button
                                            type="button"
                                            onClick={handleClear}
                                            className="num-key num-key-secondary"
                                        >
                                            C
                                        </button>

                                        <button
                                            type="button"
                                            onClick={() => handleNumberClick('0')}
                                            className="num-key"
                                        >
                                            0
                                        </button>

                                        <button
                                            type="button"
                                            onClick={handleBackspace}
                                            className="num-key num-key-secondary"
                                        >
                                            ⌫
                                        </button>
                                    </div>
                                </div>
                            )}

                        </div>

                        <div className="flex flex-col sm:flex-row gap-3">
                            {canShowHintButton && (
                                <button
                                    onClick={openHint}
                                    className="btn btn-outline w-full sm:w-auto !py-3"
                                >
                                    <i className="fa-regular fa-lightbulb mr-2" />
                                    Hint
                                </button>
                            )}
                            <button
                                onClick={() => void handleAttempt('button')}
                                disabled={hasSubmitted}
                                className="btn btn-primary w-full py-3 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                Provjeri odgovor (pokušaji: {attemptsThisQuestion})
                            </button>
                        </div>

                        {feedback && (() => {
                            const msg = feedback.trim().toLowerCase();
                            const kind = msg.includes('netočno')
                                ? 'wrong'
                                : (msg.startsWith('točno') || msg === 'točno!')
                                    ? 'correct'
                                    : 'info';

                            const boxClass =
                                kind === 'correct'
                                    ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800'
                                    : kind === 'wrong'
                                        ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800'
                                        : 'bg-indigo-50 dark:bg-indigo-900/20 border-indigo-200 dark:border-indigo-800';

                            const textClass =
                                kind === 'correct'
                                    ? 'text-green-700 dark:text-green-200'
                                    : kind === 'wrong'
                                        ? 'text-red-700 dark:text-red-200'
                                        : 'text-indigo-700 dark:text-indigo-200';

                            const iconClass =
                                kind === 'correct'
                                    ? 'fa-solid fa-circle-check'
                                    : kind === 'wrong'
                                        ? 'fa-solid fa-triangle-exclamation'
                                        : 'fa-solid fa-circle-info';

                            return (
                                <div className={`mt-6 p-3 rounded-lg border ${boxClass}`}>
                                    <p className={`text-sm flex items-center gap-2 ${textClass}`}>
                                        <i className={iconClass} />
                                        <span>{feedback}</span>
                                        {hasSubmitted && (
                                            <span className="ml-auto text-xs opacity-80">
                                                {lastSaveStatus === 'saving'
                                                    ? 'Spremam…'
                                                    : lastSaveStatus === 'saved'
                                                        ? 'Spremljeno'
                                                        : lastSaveStatus === 'error'
                                                            ? 'Greška pri spremanju'
                                                            : ''}
                                            </span>
                                        )}
                                    </p>
                                </div>
                            );
                        })()}
                    </>
                )}
            </div>

            {isHintOpen && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
                    <div className="card p-6 max-w-md w-full">
                        <div className="flex items-start justify-between gap-4 mb-3">
                            <h3 className="text-lg font-bold flex items-center gap-2">
                                <i className="fa-regular fa-lightbulb" />
                                Hint
                            </h3>
                            <button
                                onClick={() => setIsHintOpen(false)}
                                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                            >
                                ✕
                            </button>
                        </div>
                        <p className="text-sm text-gray-600 dark:text-gray-300">
                            {getHintText()}
                        </p>
                        <button
                            onClick={() => setIsHintOpen(false)}
                            className="btn btn-primary w-full py-3 mt-5"
                        >
                            U redu
                        </button>
                    </div>
                </div>
            )}

            {showWrongOverlay && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center pointer-events-none">
                    <i
                        className="fa-solid fa-xmark text-red-600 text-[250px] font-black animate-wrongX"
                        style={{ transform: 'translateY(-150px)' }}
                    />
                </div>
            )}

            {showRoundSummary && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
                    <div className="card p-6 max-w-md w-full text-center animate-scaleIn">
                    <i className="fa-solid fa-star text-5xl text-amber-400 mb-3" />

                    <h3 className="text-xl font-bold mb-2">
                        Završena runda!
                    </h3>

                    <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
                        Trenutno imaš <strong>{xp}</strong> zvjezdica ⭐
                    </p>

                    <p className="text-base mb-6">
                        {encouragementMessage}
                    </p>

                    <button
                        onClick={() => setShowRoundSummary(false)}
                        className="btn btn-primary w-full py-3"
                    >
                        Nastavi dalje
                    </button>
                    </div>
                </div>
            )}



        </main>
    );
}


