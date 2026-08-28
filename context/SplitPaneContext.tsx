/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vraj
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React } from "@webpack/common";
import type { Context, Dispatch, PropsWithChildren, SetStateAction } from "react";

export type SplitComposerTarget =
    | { kind: "reply"; messageId: string; }
    | { kind: "edit"; messageId: string; initialContent: string; }
    | null;

export interface SplitPaneContextValue {
    active: boolean;
    paneId: string;
    channelId: string;
    guildId?: string;
    beginReply(messageId: string): void;
    beginEdit(messageId: string, initialContent: string): void;
    clearComposerTargetForMessage(messageId: string): void;
}

export interface SplitComposerContextValue {
    composerTarget: SplitComposerTarget;
    setComposerTarget: Dispatch<SetStateAction<SplitComposerTarget>>;
}

// @webpack/common discovers React asynchronously while Discord's webpack runtime
// starts. Plugin modules are evaluated before that discovery finishes, so creating
// a context at module scope can crash the whole Vencord renderer during startup.
let splitPaneContext: Context<SplitPaneContextValue | null> | undefined;
let splitComposerContext: Context<SplitComposerContextValue | null> | undefined;

function getSplitPaneContext(): Context<SplitPaneContextValue | null> {
    return splitPaneContext ??= React.createContext<SplitPaneContextValue | null>(null);
}

function getSplitComposerContext(): Context<SplitComposerContextValue | null> {
    return splitComposerContext ??= React.createContext<SplitComposerContextValue | null>(null);
}

export function SplitPaneProvider({ composerValue, value, children }: PropsWithChildren<{
    composerValue: SplitComposerContextValue;
    value: SplitPaneContextValue;
}>) {
    const SplitPaneContext = getSplitPaneContext();
    const SplitComposerContext = getSplitComposerContext();
    return (
        <SplitPaneContext.Provider value={value}>
            <SplitComposerContext.Provider value={composerValue}>
                {children}
            </SplitComposerContext.Provider>
        </SplitPaneContext.Provider>
    );
}

export function useSplitPane(): SplitPaneContextValue {
    const context = React.useContext(getSplitPaneContext());
    if (!context) throw new Error("useSplitPane must be used inside SplitPaneProvider");
    return context;
}

export function useSplitComposerState(): SplitComposerContextValue {
    const context = React.useContext(getSplitComposerContext());
    if (!context) throw new Error("useSplitComposer must be used inside SplitPaneProvider");
    return context;
}
