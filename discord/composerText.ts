/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vraj
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface ComposerWord {
    end: number;
    isAtStart: boolean;
    start: number;
    word: string;
}

export interface ComposerReplacement {
    caret: number;
    value: string;
}

function clampSelectionOffset(value: string, offset: number): number {
    return Math.max(0, Math.min(value.length, offset));
}

/** Return the whitespace-delimited token immediately before the caret. */
export function getComposerWord(value: string, selectionStart: number, selectionEnd: number): ComposerWord {
    const start = clampSelectionOffset(value, selectionStart);
    const end = clampSelectionOffset(value, selectionEnd);
    if (start !== end) return { start, end, word: "", isAtStart: false };

    let wordStart = start;
    while (wordStart > 0 && !/\s/.test(value[wordStart - 1])) wordStart--;

    return {
        start: wordStart,
        end,
        word: value.slice(wordStart, end),
        isAtStart: wordStart === 0
    };
}

/** Replace a composer range and optionally separate the insertion from following text. */
export function replaceComposerRange(
    value: string,
    selectionStart: number,
    selectionEnd: number,
    insertion: string,
    addTrailingSpace: boolean
): ComposerReplacement {
    const start = clampSelectionOffset(value, Math.min(selectionStart, selectionEnd));
    const end = clampSelectionOffset(value, Math.max(selectionStart, selectionEnd));
    const followingText = value.slice(end);
    const trailingSpace = addTrailingSpace
        && insertion.length > 0
        && (followingText.length === 0 || !/^\s/.test(followingText))
        ? " "
        : "";
    const insertedText = insertion + trailingSpace;

    return {
        value: value.slice(0, start) + insertedText + followingText,
        caret: start + insertedText.length
    };
}
