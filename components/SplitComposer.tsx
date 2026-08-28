/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vraj
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PlusIcon } from "@components/Icons";
import type { CloudUpload } from "@vencord/discord-types";
import { ChannelStore, DraftType, GuildStore, MessageStore, PermissionStore, Popout, React, UploadAttachmentStore, UploadHandler, UploadManager, useEffect, useLayoutEffect, useRef, UserStore, useState, useStateFromStores } from "@webpack/common";
import type { ChangeEvent, ClipboardEvent, ComponentType, DragEvent, KeyboardEvent } from "react";

import { useSplitComposerState, useSplitPane } from "../context/SplitPaneContext";
import { getChannel, getChannelHeaderDetails } from "../discord/channel";
import { getSendAvailability } from "../discord/permissions";
import { editPaneMessage, sendPaneMessage, sendPaneReply } from "../discord/send";
import { type NativeGif, NativeGifPicker, NativeUpload, useNativeGifIcon } from "../discord/webpack";
import { registerSplitComposer, unregisterSplitComposer } from "../keyboard/ComposerFocusManager";
import { logger } from "../logger";
import { clearDraftAtRevision, commitStagedDraft, getDraft, getDraftRevision, getLayoutState, MAXIMUM_DRAFT_LENGTH, setActivePane, stageDraft } from "../state/layoutStore";

const DRAFT_SYNC_DELAY_MS = 250;

function restoreTextareaFocus(textarea: HTMLTextAreaElement | null, paneId: string, channelId: string): void {
    // Discord may focus its native composer after SEND_MESSAGE finishes. Waiting
    // for two paint frames lets that work settle before restoring this pane's
    // independent caret.
    requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!textarea?.isConnected || textarea.disabled) return;
        const layout = getLayoutState();
        if (layout.activePaneId !== paneId || layout.panes[paneId]?.channelId !== channelId) return;
        textarea.focus({ preventScroll: true });
        const caret = textarea.value.length;
        textarea.setSelectionRange(caret, caret);
    }));
}

function uploadsAreIdentical(first: readonly CloudUpload[], second: readonly CloudUpload[]): boolean {
    return first.length === second.length && first.every((upload, index) => upload === second[index]);
}

export function SplitComposer() {
    const { active = true, paneId, channelId } = useSplitPane();
    const { composerTarget, setComposerTarget } = useSplitComposerState();
    const [draft, setLocalDraft] = useState(() => getDraft(channelId));
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const gifButtonRef = useRef<HTMLButtonElement>(null);
    const draftRef = useRef(draft);
    const sendingRef = useRef(false);
    const [editContent, setEditContent] = useState("");
    const [sending, setSending] = useState(false);
    const [sendError, setSendError] = useState<string>();
    const [fileInputVersion, setFileInputVersion] = useState(0);
    const availability = useStateFromStores(
        [ChannelStore, PermissionStore],
        () => getSendAvailability(getChannel(channelId)),
        [channelId],
        (previous, next) => previous.canAttachFiles === next.canAttachFiles
            && previous.canSend === next.canSend
            && previous.reason === next.reason
    );
    const uploads = useStateFromStores(
        [UploadAttachmentStore],
        () => [...UploadAttachmentStore.getUploads(channelId, DraftType.ChannelMessage)],
        [channelId],
        uploadsAreIdentical
    );
    const targetMessage = useStateFromStores(
        [MessageStore],
        () => composerTarget ? MessageStore.getMessage(channelId, composerTarget.messageId) : undefined,
        [channelId, composerTarget?.messageId]
    );
    const currentUserId = useStateFromStores([UserStore], () => UserStore.getCurrentUser()?.id);
    const { Component: GifIcon, events: gifIconEvents, play: playGifIcon } = useNativeGifIcon();

    const editing = composerTarget?.kind === "edit";
    const value = editing ? editContent : draft;
    const hasContent = value.trim().length > 0;
    const hasUploads = !editing && uploads.length > 0;
    const hasPayload = hasContent || hasUploads;
    const unchangedEdit = editing && targetMessage?.content === editContent;
    const canSubmit = availability.canSend && hasPayload && !unchangedEdit && !sending;
    const channel = getChannel(channelId);
    const channelTitle = useStateFromStores(
        [ChannelStore, GuildStore, UserStore],
        () => {
            const currentChannel = getChannel(channelId);
            return currentChannel ? getChannelHeaderDetails(currentChannel).title : "this channel";
        },
        [channelId]
    );
    const setTextareaRef = React.useCallback((textarea: HTMLTextAreaElement | null) => {
        const previous = textareaRef.current;
        textareaRef.current = textarea;
        if (textarea) {
            if (active) registerSplitComposer(paneId, textarea);
        } else if (previous) {
            unregisterSplitComposer(paneId, previous);
        }
    }, [active, paneId]);

    draftRef.current = draft;

    useEffect(() => {
        const timer = setTimeout(() => commitStagedDraft(channelId), DRAFT_SYNC_DELAY_MS);
        return () => clearTimeout(timer);
    }, [channelId, draft]);

    useEffect(() => () => {
        stageDraft(channelId, draftRef.current);
        commitStagedDraft(channelId);
    }, [channelId]);

    useLayoutEffect(() => {
        if (composerTarget?.kind === "edit") setEditContent(composerTarget.initialContent);
        setSendError(undefined);
    }, [composerTarget]);

    useEffect(() => {
        if (composerTarget && !targetMessage) setComposerTarget(null);
    }, [composerTarget, setComposerTarget, targetMessage]);

    useLayoutEffect(() => {
        if (!composerTarget) return;
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus({ preventScroll: true });
        const caret = textarea.value.length;
        textarea.setSelectionRange(caret, caret);
    }, [composerTarget]);

    async function submit(contentOverride?: string) {
        const content = contentOverride ?? value;
        const submittedUploads = editing
            ? []
            : [...UploadAttachmentStore.getUploads(channelId, DraftType.ChannelMessage)];
        if ((!content.trim() && submittedUploads.length === 0) || !availability.canSend || sendingRef.current) return;

        const textarea = textareaRef.current;
        const submittedDraftRevision = getDraftRevision(channelId);
        const submittedTarget = composerTarget;
        sendingRef.current = true;
        setSending(true);
        setSendError(undefined);
        try {
            if (submittedTarget?.kind === "edit") {
                await editPaneMessage(channelId, submittedTarget.messageId, content);
                setComposerTarget(current => current === submittedTarget ? null : current);
            } else if (submittedTarget?.kind === "reply" && channel && targetMessage) {
                await sendPaneReply(
                    channel,
                    targetMessage,
                    content,
                    targetMessage.author.id !== currentUserId,
                    submittedUploads
                );
                clearSubmittedPayload();
                setComposerTarget(current => current === submittedTarget ? null : current);
            } else {
                await sendPaneMessage(channelId, content, submittedUploads);
                clearSubmittedPayload();
            }
        } catch (error) {
            logger.error("Failed to submit a message", { channelId, composerTarget: submittedTarget, error });
            setSendError(editing
                ? "Message failed to update. Your edit was kept."
                : "Message failed to send. Your draft was kept.");
        } finally {
            sendingRef.current = false;
            setSending(false);
            restoreTextareaFocus(textarea, paneId, channelId);
        }

        function clearSubmittedPayload(): void {
            if (submittedUploads.length > 0) {
                const currentUploads = UploadAttachmentStore.getUploads(channelId, DraftType.ChannelMessage);
                if (uploadsAreIdentical(submittedUploads, currentUploads)) {
                    UploadManager.clearAll(channelId, DraftType.ChannelMessage);
                }
            }

            if (contentOverride == null && clearDraftAtRevision(channelId, submittedDraftRevision)) {
                setLocalDraft(current => current === content ? "" : current);
            }
        }
    }

    function attachFiles(files: File[]): void {
        if (!availability.canAttachFiles || editing || !channel || files.length === 0) return;
        setSendError(undefined);
        try {
            UploadHandler.promptToUpload(files, channel, DraftType.ChannelMessage);
        } catch (error) {
            logger.error("Failed to add attachments", { channelId, error });
            setSendError("Discord could not add those attachments.");
        }
    }

    function onFileInputChange(event: ChangeEvent<HTMLInputElement>): void {
        attachFiles(Array.from(event.currentTarget.files ?? []));
        // Let React reset the input so the same file can be selected again.
        setFileInputVersion(version => version + 1);
    }

    function onPaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
        const files = Array.from(event.clipboardData.files);
        if (files.length === 0 || !availability.canAttachFiles || editing) return;
        event.preventDefault();
        attachFiles(files);
    }

    function onDragOver(event: DragEvent<HTMLDivElement>): void {
        if (!availability.canAttachFiles || editing || event.dataTransfer.types.indexOf("Files") === -1) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
    }

    function onDrop(event: DragEvent<HTMLDivElement>): void {
        if (!availability.canAttachFiles || editing) return;
        const files = Array.from(event.dataTransfer.files);
        if (files.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        attachFiles(files);
    }

    function onSelectGif(gif: NativeGif, closePopout: () => void): void {
        closePopout();
        void submit(gif.url);
    }

    function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
        if (event.key === "Escape" && composerTarget) {
            event.preventDefault();
            event.stopPropagation();
            setComposerTarget(null);
            return;
        }
        if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        void submit();
    }

    function updateDraft(nextDraft: string): void {
        draftRef.current = nextDraft;
        stageDraft(channelId, nextDraft);
        setLocalDraft(nextDraft);
    }

    return (
        <div className="vc-splitview-composer-wrap">
            {composerTarget && targetMessage && (
                <div className="vc-splitview-composer-target">
                    <div>
                        <strong>{editing ? "Editing message" : `Replying to ${targetMessage.author.globalName ?? targetMessage.author.username}`}</strong>
                        <span>{targetMessage.content || "Message attachment"}</span>
                    </div>
                    <button
                        type="button"
                        aria-label={editing ? "Cancel edit" : "Cancel reply"}
                        title={editing ? "Cancel edit" : "Cancel reply"}
                        onClick={() => setComposerTarget(null)}
                    >
                        ×
                    </button>
                </div>
            )}
            {hasUploads && (
                <div className="vc-splitview-attachments">
                    <ul className="vc-splitview-attachment-list" aria-label="Attachments">
                        {uploads.map(upload => (
                            <NativeUpload
                                key={upload.id}
                                channelId={channelId}
                                draftType={DraftType.ChannelMessage}
                                upload={upload}
                            />
                        ))}
                    </ul>
                </div>
            )}
            <div
                className={`vc-splitview-composer${hasUploads ? " vc-splitview-composer-with-attachments" : ""}`}
                onDragOver={onDragOver}
                onDrop={onDrop}
            >
                {!editing && (
                    <>
                        <input
                            key={fileInputVersion}
                            ref={fileInputRef}
                            className="vc-splitview-file-input"
                            type="file"
                            multiple
                            tabIndex={-1}
                            aria-hidden="true"
                            onChange={onFileInputChange}
                        />
                        <button
                            type="button"
                            className="vc-splitview-composer-action"
                            disabled={!availability.canAttachFiles || sending}
                            aria-label="Upload a file"
                            title={availability.canAttachFiles ? "Upload a file" : "You cannot attach files in this channel"}
                            onClick={() => fileInputRef.current?.click()}
                        >
                            <PlusIcon width={24} height={24} aria-hidden="true" />
                        </button>
                    </>
                )}
                <textarea
                    ref={setTextareaRef}
                    value={value}
                    rows={1}
                    maxLength={MAXIMUM_DRAFT_LENGTH}
                    aria-label={`Message ${channelTitle}`}
                    aria-busy={sending}
                    aria-keyshortcuts="Control+ArrowLeft Control+ArrowRight Control+Shift+Space Control+Shift+ArrowLeft Control+Shift+ArrowRight Control+Shift+ArrowUp Control+Shift+ArrowDown"
                    placeholder={availability.canSend ? (editing ? "Edit message" : `Message ${channelTitle}`) : availability.reason}
                    data-splitview-composer="true"
                    disabled={!availability.canSend}
                    readOnly={sending}
                    onChange={event => editing
                        ? setEditContent(event.currentTarget.value)
                        : updateDraft(event.currentTarget.value)
                    }
                    onFocus={() => setActivePane(paneId)}
                    onKeyDown={onKeyDown}
                    onPaste={onPaste}
                />
                {!editing && (
                    <Popout
                        position="top"
                        align="right"
                        animation={Popout.Animation.NONE}
                        spacing={8}
                        targetElementRef={gifButtonRef}
                        renderPopout={({ closePopout }) => (
                            <div className="vc-splitview-gif-picker">
                                <NativeGifPicker
                                    persistSearch
                                    onSelectGIF={gif => onSelectGif(gif, closePopout)}
                                />
                            </div>
                        )}
                    >
                        {(popoutProps, { isShown }) => (
                            <button
                                ref={gifButtonRef}
                                type="button"
                                className={`vc-splitview-composer-action vc-splitview-gif-button${isShown ? " vc-splitview-composer-action-selected" : ""}`}
                                disabled={!availability.canSend || sending}
                                aria-label="Open GIF picker"
                                title="Open GIF picker"
                                {...popoutProps}
                                onClick={event => {
                                    playGifIcon();
                                    popoutProps.onClick(event);
                                }}
                                onMouseEnter={gifIconEvents.onMouseEnter}
                                onMouseLeave={gifIconEvents.onMouseLeave}
                            >
                                <GifIcon size="refresh_sm" color="currentColor" />
                            </button>
                        )}
                    </Popout>
                )}
                {hasPayload && (
                    <button
                        type="button"
                        className="vc-splitview-send-button"
                        disabled={!canSubmit}
                        aria-label={editing ? "Save edit" : "Send message"}
                        title={sending ? (editing ? "Saving edit" : "Sending message") : (editing ? "Save edit" : "Send message")}
                        onClick={() => void submit()}
                    >
                        {sending
                            ? <span className="vc-splitview-send-spinner" aria-hidden="true" />
                            : (
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <path fill="currentColor" d="M3.4 2.3a1 1 0 0 0-1.3 1.2l2.2 7.1 8.2 1.4-8.2 1.4-2.2 7.1a1 1 0 0 0 1.3 1.2l18-8.8a1 1 0 0 0 0-1.8l-18-8.8Z" />
                                </svg>
                            )}
                    </button>
                )}
            </div>
            {sendError && (
                <div className="vc-splitview-composer-status" role="status">
                    {sendError}
                </div>
            )}
        </div>
    );
}

let memoizedSplitComposer: ComponentType | undefined;

/** Keep pane focus/layout updates out of the controlled composer hot path. */
export function StableSplitComposer() {
    const MemoizedSplitComposer = memoizedSplitComposer ??= React.memo(SplitComposer);
    return <MemoizedSplitComposer />;
}
