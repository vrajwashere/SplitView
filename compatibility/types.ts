/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vraj
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Channel, Message } from "@vencord/discord-types";

import type { SplitPaneContextValue } from "../context/SplitPaneContext";

export interface SplitChannelMessageProps {
    id: string;
    channel: Channel;
    message: Message;
    compact: boolean;
    subscribeToComponentDispatch: boolean;
}

export interface SplitViewCompatibilityAdapter {
    id: string;
    adaptMessageProps?(
        props: SplitChannelMessageProps,
        pane: SplitPaneContextValue
    ): SplitChannelMessageProps;
}
