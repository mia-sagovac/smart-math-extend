'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { AddStudentsModal, CreateClassroomModal, CreateGameModal, GameLobbyModal, Spinner } from '@/components';
import { api } from '@/lib/api';
import { useAuthStore } from '@/lib/store';
import { passwordToEmojis } from '@/lib/utils';

interface Classroom {
    id: string;
    class_name: string;
    class_code: string;
    student_count: number;
}

interface Student {
    id: string;
    username: string;
    level: number;
    xp: number;
    difficulty_do_sto: number;
    difficulty_zbrajanje: number;
    difficulty_mnozenje: number;
}

interface Topic {
    id: string;
    name: string;
}

interface AlgorithmInfo {
    id: string;
    name: string;
    description: string;
}

interface AlgorithmStatus {
    active: string;
    algorithms: AlgorithmInfo[];
}

export default function TeacherDashboard() {
    const router = useRouter();
    const { user, isAuthenticated, isHydrated, logout } = useAuthStore();

    const [showCreateClassroom, setShowCreateClassroom] = useState(false);
    const [showAddStudents, setShowAddStudents] = useState(false);
    const [showCreateGame, setShowCreateGame] = useState(false);
    const [showGameLobby, setShowGameLobby] = useState(false);
    const [currentGame, setCurrentGame] = useState<{
        gameId: string;
        gameCode: string;
        topic: Topic;
        classroomId: string;
    } | null>(null);
    const [classrooms, setClassrooms] = useState<Classroom[]>([]);
    const [selectedClassroom, setSelectedClassroom] = useState<Classroom | null>(null);
    const [isLoadingClassrooms, setIsLoadingClassrooms] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [students, setStudents] = useState<Student[]>([]);
    const [isLoadingStudents, setIsLoadingStudents] = useState(false);
    const [studentsError, setStudentsError] = useState<string | null>(null);
    const [removingStudentId, setRemovingStudentId] = useState<string | null>(null);

    const [algorithmStatus, setAlgorithmStatus] = useState<AlgorithmStatus | null>(null);
    const [isLoadingAlgorithm, setIsLoadingAlgorithm] = useState(false);
    const [algorithmError, setAlgorithmError] = useState<string | null>(null);
    const [isSwitchingAlgorithm, setIsSwitchingAlgorithm] = useState(false);

    // Algorithm helpers
    const fetchAlgorithmStatus = useCallback(async () => {
        setIsLoadingAlgorithm(true);
        setAlgorithmError(null);
        try {
            const data = await api.get<AlgorithmStatus>('/algorithm/status');
            setAlgorithmStatus(data);
        } catch {
            setAlgorithmError('Nije moguće učitati status algoritma');
        } finally {
            setIsLoadingAlgorithm(false);
        }
    }, []);

    const switchAlgorithm = useCallback(async (algorithmId: string) => {
        setIsSwitchingAlgorithm(true);
        setAlgorithmError(null);
        try {
            const data = await api.post<AlgorithmStatus>('/algorithm/select', { algorithm: algorithmId });
            setAlgorithmStatus(data);
        } catch {
            setAlgorithmError('Nije moguće promijeniti algoritam');
        } finally {
            setIsSwitchingAlgorithm(false);
        }
    }, []);

    // Fetch classrooms
    const fetchClassrooms = useCallback(async () => {
        setIsLoadingClassrooms(true);
        setError(null);
        try {
            const data = await api.get<Classroom[]>('/classroom/my-classrooms');
            setClassrooms(data);
            // Auto-select first classroom if none selected
            setSelectedClassroom(prev => {
                if (!prev && data.length > 0) {
                    return data[0];
                }
                // If previously selected classroom still exists, keep it
                if (prev) {
                    const stillExists = data.find(c => c.id === prev.id);
                    return stillExists || (data.length > 0 ? data[0] : null);
                }
                return prev;
            });
        } catch (err) {
            setError('Nije moguće učitati razrede');
            console.error(err);
        } finally {
            setIsLoadingClassrooms(false);
        }
    }, []);

    const fetchStudents = useCallback(async (classroomId: string) => {
        setIsLoadingStudents(true);
        setStudentsError(null);
        try {
            const data = await api.get<Student[]>(`/classroom/${classroomId}/students`);
            setStudents(data);
            console.log(data);
        } catch (err) {
            setStudentsError('Nije moguće učitati učenike');
            console.error(err);
        } finally {
            setIsLoadingStudents(false);
        }
    }, []);

    const removeStudent = useCallback(async (studentId: string) => {
        if (!selectedClassroom?.id) return;
        const student = students.find((s) => s.id === studentId);
        const label = student?.username ? `Ukloniti učenika "${student.username}" iz razreda?` : 'Ukloniti učenika iz razreda?';
        if (typeof window !== 'undefined') {
            const ok = window.confirm(label);
            if (!ok) return;
        }

        setRemovingStudentId(studentId);
        setStudentsError(null);
        try {
            await api.delete(`/classroom/${selectedClassroom.id}/students/${studentId}`);
            await fetchStudents(selectedClassroom.id);
            await fetchClassrooms(); // refresh student_count
        } catch (err) {
            console.error(err);
            setStudentsError('Nije moguće ukloniti učenika');
        } finally {
            setRemovingStudentId(null);
        }
    }, [selectedClassroom?.id, students, fetchStudents, fetchClassrooms]);

    // Redirect to login if not authenticated
    useEffect(() => {
        if (isHydrated && (!isAuthenticated || !user)) {
            router.push('/');
        }
    }, [isHydrated, isAuthenticated, user, router]);

    // Redirect students to their dashboard
    useEffect(() => {
        if (isHydrated && user && user.role === 'student') {
            router.push('/student/dashboard');
        }
    }, [isHydrated, user, router]);

    // Load classrooms when authenticated
    useEffect(() => {
        if (isHydrated && isAuthenticated && user?.role === 'teacher') {
            fetchClassrooms();
            fetchAlgorithmStatus();
        }
    }, [isHydrated, isAuthenticated, user, fetchClassrooms, fetchAlgorithmStatus]);

    // Load students when classroom selection changes
    useEffect(() => {
        if (!selectedClassroom?.id) {
            setStudents([]);
            setStudentsError(null);
            setIsLoadingStudents(false);
            return;
        }
        fetchStudents(selectedClassroom.id);
    }, [selectedClassroom?.id, fetchStudents]);

    const handleLogout = () => {
        logout();
        router.push('/');
    };

    const handleClassroomChange = (classroomId: string) => {
        const classroom = classrooms.find(c => c.id === classroomId);
        if (classroom) {
            setSelectedClassroom(classroom);
        }
    };

    // Show loading while hydrating or redirecting
    if (!isHydrated || !isAuthenticated || !user || user.role !== 'teacher') {
        return (
            <main className="min-h-screen flex items-center justify-center">
                <Spinner />
            </main>
        );
    }

    return (
        <main className="min-h-screen">
            {/* Header */}
            <header className="sticky top-0 z-10 p-4 sm:p-6 flex justify-end items-center" style={{ background: 'var(--background)' }}>
                <div className="flex items-center gap-3 sm:gap-4">
                    <div className="flex items-center gap-2 px-3 py-2 rounded-xl" style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)' }}>
                        <div className="w-7 h-7 flex items-center justify-center rounded-full bg-green-400">
                            <i className="fa-solid fa-chalkboard-user text-white text-lg" />
                        </div>

                        <span className="font-medium">{user.username}</span>
                    </div>
                    <button
                        onClick={handleLogout}
                        className="btn btn-outline flex items-center gap-2 !py-2 !px-4"
                    >
                        <span>Odjava</span>
                        <i className="fa-solid fa-door-open text-lg text-brown-500" />

                    </button>
                </div>
            </header>

            {/* Main content */}
            <div className="wrapper p-4 sm:p-8 max-w-3xl mx-auto pb-12">
                <div className="card1 p-6 sm:p-8 w-full">
                    {/* Title */}
                    <div className="flex items-center gap-2 mb-4">
                        <h1 className="text-2xl font-bold">Moji razredi</h1>
                        <button
                            onClick={fetchClassrooms}
                            disabled={isLoadingClassrooms}
                            className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-50 transition-colors"
                            title="Osvježi"
                        >
                            <i className={`fa-solid fa-arrows-rotate text-xl text-blue-500 ${isLoadingClassrooms ? "animate-spin" : ""}`} />

                        </button>
                    </div>

                    {/* Classroom selector */}
                    <div className="flex items-center justify-between gap-3 mb-6">
                        {classrooms.length > 0 ? (
                            <select
                                value={selectedClassroom?.id || ''}
                                onChange={(e) => handleClassroomChange(e.target.value)}
                                className="px-3 py-2 rounded-xl border bg-white dark:bg-gray-800 
                                           border-gray-200 dark:border-gray-700 
                                           focus:border-indigo-500 dark:focus:border-indigo-400 
                                           outline-none transition-colors font-medium"
                            >
                                {classrooms.map((classroom) => (
                                    <option key={classroom.id} value={classroom.id}>
                                        {classroom.class_name}
                                    </option>
                                ))}
                            </select>
                        ) : (
                            <div />
                        )}
                        <button
                            onClick={() => setShowCreateClassroom(true)}
                            className="btn btn-secondary flex items-center gap-2 !py-2 !px-4"
                        >
                            <span className="text-lg">+</span>
                            <span>Novi razred</span>
                        </button>
                    </div>

                    {/* Error message */}
                    {error && (
                        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                            <p className="text-red-600 dark:text-red-400 text-sm">
                                {error}
                            </p>
                        </div>
                    )}

                    {/* Loading state */}
                    {isLoadingClassrooms ? (
                        <div className="flex items-center justify-center py-12">
                            <Spinner />
                        </div>
                    ) : classrooms.length === 0 ? (
                        /* Empty state - no classrooms */
                        <div className="text-center py-12 text-gray-500">
                            <p className="font-medium mb-2">Nemate nijedan razred</p>
                            <p className="text-sm">Kliknite "Novi razred" za kreiranje prvog razreda</p>
                        </div>
                    ) : selectedClassroom ? (
                        /* Selected classroom info */
                        <div className="space-y-2">
                            <div className="flex items-center justify-between">
                                <p className="text-gray-600 dark:text-gray-400">
                                    Šifra razreda: <span className="text-xl ml-2">{passwordToEmojis(selectedClassroom.class_code.split(''))}</span>
                                </p>
                                <button
                                    onClick={() => setShowAddStudents(true)}
                                    className="btn btn-primary flex items-center gap-2 !py-2 !px-4"
                                >
                                    <i className="fa-solid fa-user-plus text-lg text-black-500" />
                                    <span>Dodaj učenika</span>
                                </button>
                            </div>
                            <p className="text-gray-600 dark:text-gray-400">
                                Broj učenika: <span className="font-semibold ml-2">{selectedClassroom.student_count}</span>
                            </p>

                            {/* Students list */}
                            <div className="mt-6">
                                {studentsError && (
                                    <div className="mb-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                                        <p className="text-red-600 dark:text-red-400 text-sm">{studentsError}</p>
                                    </div>
                                )}

                                {isLoadingStudents ? (
                                    <div className="flex items-center justify-center py-6">
                                        <Spinner />
                                    </div>
                                ) : students.length === 0 ? (
                                    <div className="text-center py-6 text-gray-500">
                                        <p className="font-medium mb-1">Nema učenika u razredu</p>
                                    </div>
                                ) : (
                                    <div
                                        className="rounded-xl border overflow-hidden"
                                        style={{ background: 'var(--card-bg)', borderColor: 'var(--card-border)' }}
                                    >
                                        <div className="max-h-80 overflow-auto">
                                            <table className="w-full">
                                                <thead className="bg-gray-50 dark:bg-gray-800/50 border-b border-gray-200 dark:border-gray-700">
                                                    <tr>
                                                        <th className="px-4 py-3 text-left text-sm font-semibold text-gray-600 dark:text-gray-300">Učenik</th>
                                                        <th className="px-4 py-3 text-center text-sm font-semibold text-gray-600 dark:text-gray-300">XP u prošloj rundi</th>
                                                        <th className="px-4 py-3 text-center text-sm font-semibold text-gray-600 dark:text-gray-300">Brojevi do 100</th>
                                                        <th className="px-4 py-3 text-center text-sm font-semibold text-gray-600 dark:text-gray-300">Zbrajanje/Oduzimanje</th>
                                                        <th className="px-4 py-3 text-center text-sm font-semibold text-gray-600 dark:text-gray-300">Množenje/Dijeljenje</th>
                                                        <th className="px-4 py-3 text-center text-sm font-semibold text-gray-600 dark:text-gray-300">Akcije</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {students.map((s) => (
                                                        <tr key={s.id} className="border-b border-gray-100 dark:border-gray-700 last:border-b-0">
                                                            <td className="px-4 py-3">
                                                                <div className="flex items-center gap-2">
                                                                    <i className="fa-regular fa-user text-gray-400 dark:text-gray-500" />
                                                                    <span className="font-medium">{s.username}</span>
                                                                </div>
                                                            </td>
                                                            <td className="px-4 py-3 text-center">
                                                                <span className="text-sm px-2 py-1 rounded-full bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300 font-semibold">
                                                                    ⭐ {Number.isInteger(s.xp) ? s.xp : 0}
                                                                </span>
                                                            </td>
                                                            <td className="px-4 py-3 text-center">
                                                                <span className="text-sm px-2 py-1 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-medium">
                                                                    Level {s.difficulty_do_sto}
                                                                </span>
                                                            </td>
                                                            <td className="px-4 py-3 text-center">
                                                                <span className="text-sm px-2 py-1 rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 font-medium">
                                                                    Level {s.difficulty_zbrajanje}
                                                                </span>
                                                            </td>
                                                            <td className="px-4 py-3 text-center">
                                                                <span className="text-sm px-2 py-1 rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 font-medium">
                                                                    Level {s.difficulty_mnozenje}
                                                                </span>
                                                            </td>
                                                            <td className="px-4 py-3 text-center">
                                                                <button
                                                                    onClick={() => void removeStudent(s.id)}
                                                                    disabled={removingStudentId === s.id}
                                                                    className="p-2 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-60"
                                                                    title="Izbaci učenika iz razreda"
                                                                >
                                                                    {removingStudentId === s.id ? (
                                                                        <i className="fa-solid fa-spinner animate-spin text-red-500" />
                                                                    ) : (
                                                                        <i className="fa-solid fa-minus text-red-500" />
                                                                    )}
                                                                </button>
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    ) : null}


                    {/* Algorithm Selection Card */}
                    <div className="card p-6 sm:p-8 w-full mt-6">
                        <div className="flex items-center gap-2 mb-4">
                            <h2 className="text-xl font-bold">Algoritam za predviđanje težine</h2>
                        </div>
                        <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
                            Odaberite koji ML algoritam će se koristiti za preporučivanje sljedeće razine težine zadataka.
                        </p>

                        {algorithmError && (
                            <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                                <p className="text-red-600 dark:text-red-400 text-sm">{algorithmError}</p>
                            </div>
                        )}

                        {isLoadingAlgorithm ? (
                            <div className="flex items-center justify-center py-8">
                                <Spinner />
                            </div>
                        ) : algorithmStatus ? (
                            <div className="space-y-3">
                                {algorithmStatus.algorithms.map((algo) => {
                                    const isActive = algorithmStatus.active === algo.id;
                                    const isSwitching = isSwitchingAlgorithm && !isActive;
                                    return (
                                        <button
                                            key={algo.id}
                                            onClick={() => !isActive && switchAlgorithm(algo.id)}
                                            disabled={isActive || isSwitchingAlgorithm}
                                            className={`w-full text-left px-4 py-4 rounded-xl border transition-all
                                                ${isActive
                                                    ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/30'
                                                    : 'border-gray-200 dark:border-gray-700 hover:border-indigo-300 dark:hover:border-indigo-600 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-60 disabled:cursor-not-allowed'
                                                }`}
                                        >
                                            <div className="flex items-center justify-between">
                                                <div className="flex items-center gap-3">
                                                    <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0
                                                        ${isActive
                                                            ? 'border-indigo-500 bg-indigo-500'
                                                            : 'border-gray-300 dark:border-gray-600'
                                                        }`}>
                                                        {isActive && (
                                                            <div className="w-1.5 h-1.5 rounded-full bg-white" />
                                                        )}
                                                    </div>
                                                    <div>
                                                        <p className={`font-semibold text-sm ${isActive ? 'text-indigo-700 dark:text-indigo-300' : ''}`}>
                                                            {algo.name}
                                                        </p>
                                                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                                                            {algo.description}
                                                        </p>
                                                    </div>
                                                </div>
                                                {isActive && (
                                                    <span className="text-xs px-2 py-1 rounded-full bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300 font-medium flex-shrink-0 ml-2">
                                                        Aktivan
                                                    </span>
                                                )}
                                                {isSwitching && (
                                                    <i className="fa-solid fa-spinner animate-spin text-gray-400 ml-2" />
                                                )}
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="text-center py-6 text-gray-500 text-sm">
                                <p>Nije moguće učitati algoritme.</p>
                                <button onClick={fetchAlgorithmStatus} className="mt-2 text-indigo-500 hover:underline">
                                    Pokušaj ponovo
                                </button>
                            </div>
                        )}
                    </div>
                </div>

                {/* Create Game Button */}
                {selectedClassroom && (
                    <div className="mt-8 flex justify-center">
                        <button
                            onClick={() => setShowCreateGame(true)}
                            className="btn btn-primary flex items-center gap-3 !py-4 !px-8 text-lg shadow-lg hover:shadow-xl transition-shadow"
                        >
                            <i className="fa-solid fa-gamepad text-2xl" />
                            <span>Pokreni novu igru</span>
                        </button>
                    </div>
                )}
            </div>

            {/* Create Classroom Modal */}
            <CreateClassroomModal
                isOpen={showCreateClassroom}
                onClose={() => setShowCreateClassroom(false)}
                onSuccess={() => {
                    fetchClassrooms();
                }}
            />

            {/* Add Students Modal */}
            {selectedClassroom && (
                <AddStudentsModal
                    isOpen={showAddStudents}
                    onClose={() => setShowAddStudents(false)}
                    onSuccess={() => {
                        fetchClassrooms();
                        if (selectedClassroom?.id) fetchStudents(selectedClassroom.id);
                    }}
                    classroomName={selectedClassroom.class_name}
                />
            )}

            {/* Create Game Modal */}
            <CreateGameModal
                isOpen={showCreateGame}
                onClose={() => setShowCreateGame(false)}
                onGameCreated={(data) => {
                    console.log('Game created:', data);
                    if (!selectedClassroom?.id) return;
                    setCurrentGame({
                        gameId: data.gameId,
                        gameCode: data.gameCode,
                        topic: data.topic,
                        classroomId: selectedClassroom.id,
                    });
                    setShowGameLobby(true);
                }}
                classroomId={selectedClassroom?.id}
            />

            {/* Game Lobby Modal */}
            {currentGame && (
                <GameLobbyModal
                    isOpen={showGameLobby}
                    onClose={() => {
                        setShowGameLobby(false);
                        setCurrentGame(null);
                    }}
                    gameId={currentGame.gameId}
                    gameCode={currentGame.gameCode}
                    topic={currentGame.topic}
                    classroomId={currentGame.classroomId}
                />
            )}
        </main>
    );
}
