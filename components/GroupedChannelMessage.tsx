/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vraj
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { SplitChannelMessageProps } from "../compatibility/types";
import { ChannelMessage } from "../discord/webpack";

interface GroupedChannelMessageProps {
    messageProps: SplitChannelMessageProps;
}

export function GroupedChannelMessage({ messageProps }: GroupedChannelMessageProps) {
    return (
        <div className="vc-splitview-native-message">
            <ChannelMessage {...messageProps} />
        </div>
    );
}
