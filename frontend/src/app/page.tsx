'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { RegisterModal, Spinner } from '@/components';
import { useAuthStore } from '@/lib/store';
import { EMOJI_MAP, PASSWORD_KEYS, getEmoji } from '@/lib/utils';

export default function LoginPage() {
    const router = useRouter();

    // Auth store
    const {
        loginAsStudent,
        loginAsTeacher,
        isLoading,
        error,
        clearError,
        isAuthenticated,
        user,
        isHydrated,
    } = useAuthStore();

    // Form state - password stores letters (A, B, C, D, E), not emojis
    // These letters form the class_code for student login
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState<string[]>(['', '', '']);
    const [teacherPassword, setTeacherPassword] = useState('');
    const [isTeacherMode, setIsTeacherMode] = useState(false);

    // Registration modal state
    const [showRegister, setShowRegister] = useState(false);

    // Local validation error (separate from API error)
    const [validationError, setValidationError] = useState<string | null>(null);

    // Redirect if already authenticated
    useEffect(() => {
        if (isHydrated && isAuthenticated && user) {
            const dashboardPath = user.role === 'teacher'
                ? '/teacher/dashboard'
                : '/student/dashboard';
            router.push(dashboardPath);
        }
    }, [isHydrated, isAuthenticated, user, router]);

    const handleEmojiClick = (key: string) => {
        const emptyIndex = password.findIndex(p => p === '');
        if (emptyIndex !== -1) {
            const newPassword = [...password];
            newPassword[emptyIndex] = key; // Store the letter, not the emoji
            setPassword(newPassword);
        }
    };

    const handlePasswordSlotClick = (index: number) => {
        const newPassword = password.map((p, i) => (i >= index ? '' : p));
        setPassword(newPassword);
    };

    const clearPassword = () => {
        setPassword(['', '', '']);
    };

    const handleClearError = () => {
        clearError();
        setValidationError(null);
    };

    const isPasswordComplete = password.every(p => p !== '');
    const dashboardPath = isTeacherMode ? '/teacher/dashboard' : '/student/dashboard';

    // Combined error display
    const displayError = validationError || error;

    // Validation
    const validateForm = (): boolean => {
        setValidationError(null);

        if (!username.trim()) {
            setValidationError('Molimo unesite ime');
            return false;
        }

        if (isTeacherMode) {
            if (!teacherPassword.trim()) {
                setValidationError('Molimo unesite lozinku');
                return false;
            }
        } else {
            if (!isPasswordComplete) {
                setValidationError('Molimo odaberite 3 emoji za lozinku');
                return false;
            }
        }

        return true;
    };

    // Handle login
    const handleLogin = async () => {
        handleClearError();

        if (!validateForm()) {
            return;
        }

        let success: boolean;

        if (isTeacherMode) {
            success = await loginAsTeacher(username.trim(), teacherPassword);
        } else {
            // Convert emoji password (letters A-E) to class_code string
            const classCode = password.join('');
            success = await loginAsStudent(username.trim(), classCode);
        }

        if (success) {
            router.push(dashboardPath);
        }
    };

    // Show loading while hydrating from localStorage
    if (!isHydrated) {
        return (
            <main className="min-h-screen flex items-center justify-center">
                <Spinner />
            </main>
        );
    }

    return (
        <main className="min-h-screen flex items-center justify-center p-6 py-12 relative overflow-auto">
            {/* Background decoration */}
            <div className="absolute inset-0 overflow-hidden pointer-events-none">
                <div className="absolute -top-20 -left-20 w-72 h-72 bg-indigo-500/10 rounded-full blur-3xl" />
                <div className="absolute -bottom-20 -right-20 w-96 h-96 bg-emerald-500/10 rounded-full blur-3xl" />
            </div>

            <div className="card p-8 sm:p-10 max-w-md w-full relative z-10 my-auto">
                {/* Logo/Title */}
                <div className="text-center mb-8">
                    <div className="mb-3 flex justify-center">
                    <div className="w-20 h-20 flex items-center justify-center rounded-2xl bg-gradient-to-br from-purple-500 to-pink-400 shadow-lg">
                        <i className="fa-solid fa-calculator text-white text-4xl" />
                    </div>
                    </div>

                    <h1 className="text-3xl font-bold mb-1 text-purple-600">
                    Smart Math
                    </h1>

                    <p className="text-gray-500 dark:text-gray-400 text-sm">
                        {isTeacherMode ? 'Prijava za profesora' : 'Prijava za učenika'}
                    </p>
                </div>

                {/* Error Message */}
                {displayError && (
                    <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl">
                        <div className="flex items-center justify-between">
                            <p className="text-red-600 dark:text-red-400 text-sm">
                                ⚠️ {displayError}
                            </p>
                            <button
                                onClick={handleClearError}
                                className="text-red-400 hover:text-red-600 transition-colors"
                            >
                                ✕
                            </button>
                        </div>
                    </div>
                )}

                {/* Username Field */}
                <div className="mb-6">
                    <label className="block text-sm font-medium mb-2 text-gray-600 dark:text-gray-300">
                        <i className={`mr-2 fa-solid ${isTeacherMode ? "fa-chalkboard-user" : "fa-user"} text-sky-500`}/>
                        {isTeacherMode ? "Ime profesora" : "Tvoje ime"}
                    </label>

                    <input
                        type="text"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        placeholder={isTeacherMode ? 'Unesite svoje ime...' : 'Upiši svoje ime...'}
                        disabled={isLoading}
                        className="w-full px-4 py-3 rounded-xl border-2 border-gray-200 dark:border-gray-700 
                                   bg-white dark:bg-gray-800 focus:border-indigo-500 dark:focus:border-indigo-400 
                                   outline-none transition-colors text-lg disabled:opacity-50 disabled:cursor-not-allowed"
                    />
                </div>

                {/* Password Section */}
                {isTeacherMode ? (
                    /* Teacher: Normal Password */
                    <div className="mb-6">
                        <label className="block text-sm font-medium mb-2 text-gray-600 dark:text-gray-300">
                        <i className="fa-solid fa-lock mr-2 text-yellow-500" />
                        Lozinka
                        </label>

                        <input
                            type="password"
                            value={teacherPassword}
                            onChange={(e) => setTeacherPassword(e.target.value)}
                            placeholder="Unesite lozinku..."
                            disabled={isLoading}
                            onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                            className="w-full px-4 py-3 rounded-xl border-2 border-gray-200 dark:border-gray-700 
                                       bg-white dark:bg-gray-800 focus:border-emerald-500 dark:focus:border-emerald-400 
                                       outline-none transition-colors text-lg disabled:opacity-50 disabled:cursor-not-allowed"
                        />
                    </div>
                ) : (
                    /* Student: Emoji Password (Class Code) */
                    <div className="mb-6">
                        <label className="block text-sm font-medium mb-2 text-gray-600 dark:text-gray-300">
                        <i className="fa-solid fa-key mr-2 text-green-500" />
                        Šifra razreda
                        </label>


                        {/* Password Slots */}
                        <div className="flex justify-center gap-3 mb-4">
                            {password.map((letter, index) => (
                                <button
                                    key={index}
                                    onClick={() => handlePasswordSlotClick(index)}
                                    disabled={isLoading}
                                    className={`w-14 h-14 sm:w-16 sm:h-16 rounded-xl border-3 text-2xl sm:text-3xl
                                                flex items-center justify-center transition-all duration-200
                                                ${letter
                                            ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-900/30 scale-105'
                                            : 'border-dashed border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800'
                                        }
                                                hover:border-indigo-400 cursor-pointer
                                                disabled:opacity-50 disabled:cursor-not-allowed`}
                                    title={letter ? 'Klikni za brisanje' : `Polje ${index + 1}`}
                                >
                                    {letter ? getEmoji(letter) : <span className="text-gray-300 dark:text-gray-600 text-lg">{index + 1}</span>}
                                </button>
                            ))}
                        </div>

                        {/* Clear button */}
                        {password.some(p => p !== '') && !isLoading && (
                            <button
                                onClick={clearPassword}
                                className="text-sm text-gray-400 hover:text-red-500 transition-colors mb-3 block mx-auto"
                            >
                                ✕ Obriši sve
                            </button>
                        )}

                        {/* Emoji Selection */}
                        <div className={`bg-gray-50 dark:bg-gray-800/50 rounded-xl p-4 ${isLoading ? 'opacity-50' : ''}`}>
                            <p className="text-xs text-gray-400 text-center mb-3">Odaberi emoji za šifru razreda:</p>
                            <div className="flex justify-center gap-2 flex-wrap">
                                {PASSWORD_KEYS.map((key) => (
                                    <button
                                        key={key}
                                        onClick={() => handleEmojiClick(key)}
                                        disabled={isPasswordComplete || isLoading}
                                        className={`w-12 h-12 sm:w-14 sm:h-14 text-2xl sm:text-3xl rounded-xl 
                                                    transition-all duration-200 
                                                    ${isPasswordComplete || isLoading
                                                ? 'opacity-40 cursor-not-allowed'
                                                : 'hover:bg-indigo-100 dark:hover:bg-indigo-900/40 hover:scale-110 active:scale-95 cursor-pointer'
                                            }
                                                    bg-white dark:bg-gray-700 shadow-sm border border-gray-200 dark:border-gray-600`}
                                    >
                                        {EMOJI_MAP[key]}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                )}

                {/* Login Button */}
                <button
                    onClick={handleLogin}
                    disabled={isLoading}
                    className={`btn w-full text-center text-lg py-4 relative
                                ${isTeacherMode ? 'btn-secondary' : 'btn-primary'}
                                disabled:opacity-70 disabled:cursor-not-allowed disabled:transform-none`}
                >
                    {isLoading ? (
                        <span className="flex items-center justify-center gap-3">
                            <Spinner />
                            Prijava u tijeku...
                        </span>
                    ) : (
                        <>
                        <i className={`fa-solid mr-2 ${
                            isTeacherMode
                                ? "fa-chalkboard-user text-black-500"
                                : "fa-rocket text-pink-500"
                            }`}
                        />
                        {isTeacherMode ? "Prijavi se kao profesor" : "Prijavi se"}
                        </>

                    )}
                </button>

                {/* Teacher Mode toggle */}
                <div className="mt-6 pt-6 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between">
                    <button
                        onClick={() => setShowRegister(true)}
                        className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                    >
                        + Novi korisnik
                    </button>
                    <div className="flex items-center gap-3">
                        <span className="text-xs text-gray-400">Profesor?</span>
                        <button
                            onClick={() => {
                                setIsTeacherMode(!isTeacherMode);
                                handleClearError();
                            }}
                            disabled={isLoading}
                            className={`relative w-14 h-7 rounded-full transition-all duration-300 
                                        ${isTeacherMode
                                    ? 'bg-emerald-500'
                                    : 'bg-gray-300 dark:bg-gray-600'}
                                        disabled:opacity-50 disabled:cursor-not-allowed`}
                        >
                            <span
                                className={`absolute top-1 w-5 h-5 rounded-full bg-white shadow-md 
                                            transition-all duration-300
                                            ${isTeacherMode ? 'left-8' : 'left-1'}`}
                            />
                        </button>
                    </div>
                </div>
            </div>

            {/* Registration Modal */}
            <RegisterModal
                isOpen={showRegister}
                onClose={() => setShowRegister(false)}
            />
        </main>
    );
}
