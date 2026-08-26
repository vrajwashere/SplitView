/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vraj
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { SplitPaneContextValue } from "../context/SplitPaneContext";
import type { SplitChannelMessageProps, SplitViewCompatibilityAdapter } from "./types";

const adapters = new Map<string, SplitViewCompatibilityAdapter>();

export function registerCompatibilityAdapter(adapter: SplitViewCompatibilityAdapter): () => void {
    adapters.set(adapter.id, adapter);
    return () => adapters.delete(adapter.id);
}

export function applyMessageCompatibilityAdapters(
    props: SplitChannelMessageProps,
    pane: SplitPaneContextValue
): SplitChannelMessageProps {
    let adaptedProps = props;
    for (const adapter of adapters.values()) {
        adaptedProps = adapter.adaptMessageProps?.(adaptedProps, pane) ?? adaptedProps;
    }
    return adaptedProps;
}
