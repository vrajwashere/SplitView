/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vraj
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DeleteIcon, PencilIcon, ReplyIcon } from "@components/Icons";
import type { Channel, Message } from "@vencord/discord-types";
import { MessageFlags } from "@vencord/discord-types/enums";
import { ConfirmModal, MessageTypeSets, openModal } from "@webpack/common";

import { useSplitPane } from "../context/SplitPaneContext";
import { deletePaneMessage } from "../discord/send";
import { logger } from "../logger";

interface SplitMessageActionsProps {
    channel: Channel;
    message: Message;
    canEdit: boolean;
    canDelete: boolean;
}

export function SplitMessageActions({ channel, message, canEdit, canDelete }: SplitMessageActionsProps) {
    const { beginEdit, beginReply, clearComposerTargetForMessage } = useSplitPane();
    const canReply = !message.deleted
        && MessageTypeSets.REPLYABLE.has(message.type)
        && !message.hasFlag(MessageFlags.EPHEMERAL);

    function confirmDelete() {
        openModal(props => (
            <ConfirmModal
                {...props}
                title="Delete message?"
                subtitle="This message will be permanently deleted."
                confirmText="Delete"
                cancelText="Cancel"
                onConfirm={async setError => {
                    try {
                        await deletePaneMessage(channel.id, message.id);
                        clearComposerTargetForMessage(message.id);
                    } catch (error) {
                        logger.error("Failed to delete a message", { channelId: channel.id, messageId: message.id, error });
                        setError("The message could not be deleted. Please try again.");
                        throw error;
                    }
                }}
            />
        ));
    }

    if (!canReply && !canEdit && !canDelete) return null;

    return (
        <div className="vc-splitview-message-actions" role="toolbar" aria-label="Message actions">
            {canReply && (
                <button
                    type="button"
                    className="vc-splitview-message-action"
                    aria-label="Reply"
                    title="Reply"
                    onClick={() => beginReply(message.id)}
                >
                    <ReplyIcon width={18} height={18} aria-hidden="true" />
                </button>
            )}
            {canEdit && (
                <button
                    type="button"
                    className="vc-splitview-message-action"
                    aria-label="Edit"
                    title="Edit"
                    onClick={() => beginEdit(message.id, message.content)}
                >
                    <PencilIcon width={18} height={18} aria-hidden="true" />
                </button>
            )}
            {canDelete && (
                <button
                    type="button"
                    className="vc-splitview-message-action vc-splitview-message-action-danger"
                    aria-label="Delete"
                    title="Delete"
                    onClick={confirmDelete}
                >
                    <DeleteIcon width={18} height={18} aria-hidden="true" />
                </button>
            )}
        </div>
    );
}
