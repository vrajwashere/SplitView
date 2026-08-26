/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vraj
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";

import { logger } from "../logger";
import { migratePersistedState } from "./migrations";
import type { PersistedSplitState } from "./types";

const STORAGE_KEY = "SplitView_layout";
const SAVE_DELAY_MS = 300;

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let queuedState: PersistedSplitState | undefined;
let writeQueue = Promise.resolve();

export async function loadPersistedState(): Promise<PersistedSplitState | null> {
    try {
        return migratePersistedState(await DataStore.get<unknown>(STORAGE_KEY));
    } catch (error) {
        logger.error("Failed to load the saved layout", error);
        return null;
    }
}

async function writePersistedState(state: PersistedSplitState): Promise<void> {
    try {
        await DataStore.set(STORAGE_KEY, state);
    } catch (error) {
        logger.error("Failed to persist the layout", error);
    }
}

function enqueuePersistedState(state: PersistedSplitState): Promise<void> {
    writeQueue = writeQueue.then(() => writePersistedState(state));
    return writeQueue;
}

export function schedulePersistedState(state: PersistedSplitState): void {
    queuedState = state;
    if (saveTimer) clearTimeout(saveTimer);

    saveTimer = setTimeout(() => {
        saveTimer = undefined;
        const nextState = queuedState;
        queuedState = undefined;
        if (nextState) void enqueuePersistedState(nextState);
    }, SAVE_DELAY_MS);
}

export async function flushPersistedState(state: PersistedSplitState): Promise<void> {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = undefined;
    queuedState = undefined;
    await enqueuePersistedState(state);
}

export function cancelScheduledPersistedState(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = undefined;
    queuedState = undefined;
}

export async function forgetPersistedState(): Promise<void> {
    cancelScheduledPersistedState();
    try {
        await writeQueue;
        await DataStore.del(STORAGE_KEY);
    } catch (error) {
        logger.error("Failed to forget the saved layout", error);
    }
}
