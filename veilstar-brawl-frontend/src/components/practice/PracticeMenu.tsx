import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { CHARACTER_ROSTER } from "@/data/characters";
import type { Character } from "@/types/game";
import { Leaf, Swords, Trophy } from "lucide-react";

interface PracticeMenuProps {
    onStart: (characterId: string, difficulty: string) => void;
}

const DIFFICULTIES = [
    { id: "easy", label: "BEGINNER", color: "bg-green-600", icon: Leaf },
    { id: "medium", label: "FIGHTER", color: "bg-amber-500", icon: Swords },
    { id: "hard", label: "CHAMPION", color: "bg-red-600", icon: Trophy },
];

export default function PracticeMenu({ onStart }: PracticeMenuProps) {
    const [selectedChar, setSelectedChar] = useState<string>(CHARACTER_ROSTER[0].id);
    const [difficulty, setDifficulty] = useState<string>("medium");

    const selectedCharacter = CHARACTER_ROSTER.find(c => c.id === selectedChar);

    const handleCharacterSelect = (charId: string) => {
        // In Practice mode, allow all characters to be selected
        setSelectedChar(charId);
    };

    return (
        <div className="flex flex-col md:flex-row gap-8 md:gap-12 w-full max-w-6xl mx-auto items-start">
            {/* Left: Character Selection */}
            <div className="flex-1 w-full">
                <h2 className="text-xl sm:text-2xl font-bold font-orbitron text-white mb-4 sm:mb-6">SELECT FIGHTER</h2>

                {/* 5-Column Grid */}
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 sm:gap-4">
                    {CHARACTER_ROSTER.map((char: Character) => {
                        const isUnlocked = true;

                        return (
                            <div
                                key={char.id}
                                onClick={() => isUnlocked && handleCharacterSelect(char.id)}
                                className={`
                                cursor-pointer rounded-xl border-2 transition-all overflow-hidden relative group
                                ${selectedChar === char.id
                                        ? "border-cyber-orange bg-cyber-orange/10 shadow-[0_0_20px_rgba(224,54,9,0.3)]"
                                        : isUnlocked
                                            ? "border-cyber-gray/30 bg-black/40 hover:border-cyber-gold/50"
                                            : "border-gray-800 bg-black/60 opacity-60 grayscale"
                                    }
                            `}
                            >
                                {/* Character Portrait */}
                                <div className="h-32 sm:h-40 bg-black/50 flex items-center justify-center relative overflow-hidden">
                                    <img
                                        src={char.portraitUrl}
                                        alt={char.name}
                                        className="object-cover object-top w-full h-full"
                                    />
                                    {selectedChar === char.id && (
                                        <div className="absolute inset-0 bg-gradient-to-t from-cyber-orange/40 to-transparent"></div>
                                    )}

                                    {/* Lock Overlay */}
                                    {!isUnlocked && (
                                        <div className="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-[2px]">
                                            <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                                            </svg>
                                        </div>
                                    )}
                                </div>

                                <div className="p-3">
                                    <h3 className={`font-orbitron font-bold text-xs sm:text-sm mb-1 truncate ${selectedChar === char.id ? "text-cyber-orange" : isUnlocked ? "text-white" : "text-gray-500"}`}>
                                        {char.name}
                                    </h3>
                                </div>
                            </div>
                        )
                    })}
                </div>

                {/* Selected character info */}
                {selectedCharacter && (
                    <div className="mt-6 p-4 bg-black/40 border border-cyber-gray/30 rounded-xl">
                        <h3 className="font-orbitron text-cyber-gold text-lg mb-2">{selectedCharacter.name}</h3>
                        <p className="text-cyber-gray text-sm leading-relaxed">{selectedCharacter.theme}</p>
                    </div>
                )}
            </div>

            {/* Right: Difficulty & Start */}
            <div className="w-full md:w-80 flex flex-col gap-6 sm:gap-8 bg-zinc-950/90 border border-cyber-gold/20 p-6 sm:p-8 rounded-2xl h-fit shadow-xl">
                <div>
                    <h2 className="text-xl sm:text-2xl font-bold font-orbitron text-white mb-4 sm:mb-6">DIFFICULTY</h2>
                    <div className="flex flex-col gap-3">
                        {DIFFICULTIES.map((diff) => {
                            const Icon = diff.icon;
                            return (
                                <Button
                                    key={diff.id}
                                    variant="outline"
                                    onClick={() => setDifficulty(diff.id)}
                                    className={`
                                        w-full justify-between h-12 font-orbitron uppercase border-opacity-50 transition-all
                                        ${difficulty === diff.id
                                            ? "!bg-[#F0B71F] !text-black !border-[#F0B71F] font-bold shadow-[0_0_15px_rgba(240,183,31,0.4)]"
                                            : "text-cyber-gray hover:text-white border-cyber-gray hover:border-white bg-transparent hover:bg-white/5"
                                        }
                                    `}
                                >
                                    <span className="flex items-center gap-2">
                                        <Icon className="w-4 h-4" />
                                        <span>{diff.label}</span>
                                    </span>
                                </Button>
                            );
                        })}
                    </div>
                </div>

                <div className="pt-8 border-t border-white/10">
                    <Button
                        onClick={() => onStart(selectedChar, difficulty)}
                        className="w-full h-14 text-lg bg-gradient-cyber text-white font-orbitron font-bold shadow-[0_0_20px_rgba(240,183,31,0.3)] hover:shadow-[0_0_30px_rgba(240,183,31,0.5)] transition-all"
                    >
                        START TRAINING
                    </Button>
                </div>
            </div>
        </div>
    );
}
