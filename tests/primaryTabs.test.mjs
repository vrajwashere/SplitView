/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vraj
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Run from the Vencord checkout: node --test src/userplugins/splitView/tests/*.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { transformSync } from "esbuild";

function createHarness({ selected = "a", saved = null } = {}) {
    let selectedId = selected;
    let savedState;
    const navigations = [];
    const forgotten = [];
    const unavailable = new Set();
    const windowListeners = new Map();
    const effects = [];
    const frames = new Map();
    let nextFrame = 0;
    let headerPaneId;
    const React = {
        createElement: (type, props, ...children) => ({ type, props, children }),
        useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
        useCallback: callback => callback,
        useRef: current => ({ current }),
        useEffect: effect => effects.push(effect),
        useLayoutEffect: effect => effects.push(effect),
        useState: initial => [initial, () => {}]
    };
    const channel = id => !id || unavailable.has(id) ? undefined : {
        id, name: id, guild_id: id.startsWith("guild") ? "guild" : undefined,
        isPrivate: () => !id.startsWith("guild"),
        isCategory: () => false, isDirectory: () => false, isGuildVocal: () => false,
        isForumLikeChannel: () => false, isThread: () => id.startsWith("thread")
    };
    const common = {
        React, ReactDOM: { createPortal: node => node },
        SelectedChannelStore: { getChannelId: () => selectedId },
        ChannelStore: { getChannel: channel },
        ChannelRouter: { transitionToChannel: id => { selectedId = id; navigations.push(id); } },
        PermissionStore: { can: () => true }, PermissionsBits: { VIEW_CHANNEL: 1n }
    };
    const settings = { store: { rememberLayout: true, restorePanesAfterRestart: true, maximumPaneCount: 4, enableDragToSplit: true } };
    const mocks = {
        "@webpack/common": common,
        "../settings": { settings },
        "../logger": { logger: { warn() {} } },
        "./messageViewportStore": { clearMessageViewportStates() {}, forgetMessageViewportState: id => forgotten.push(id) },
        "./persistence": {
            loadPersistedState: async () => saved,
            schedulePersistedState: value => { savedState = value; },
            flushPersistedState: async value => { savedState = value; },
            cancelScheduledPersistedState() {}
        },
        "../keyboard/ComposerFocusManager": { focusSplitComposer() {}, focusPrimaryComposer() {} }
    };
    const globals = {
        window: {
            addEventListener: (name, callback) => windowListeners.set(name, callback),
            removeEventListener: name => windowListeners.delete(name)
        },
        document: { elementFromPoint: () => ({ closest: () => headerPaneId === undefined ? null : { dataset: { vcSplitviewTabbar: headerPaneId } } }) },
        requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame; },
        cancelAnimationFrame: id => frames.delete(id),
        performance,
        Element: class Element {},
        Node: class Node {}
    };
    function load(relativePath) {
        const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
        const { code } = transformSync(source, { loader: "tsx", format: "cjs", jsx: "transform" });
        const module = { exports: {} };
        runInNewContext(code, { ...globals, module, exports: module.exports, require: id => {
            assert.ok(id in mocks, `Unexpected import: ${id}`);
            return mocks[id];
        } });
        return module.exports;
    }
    mocks["../discord/channel"] = load("../discord/channel.ts");
    const layout = load("../state/layoutStore.ts");
    mocks["../state/layoutStore"] = layout;
    const { migratePersistedState } = load("../state/migrations.ts");
    return {
        layout, navigations, forgotten, unavailable, load, windowListeners, effects, channel,
        get primary() { return layout.getLayoutState().primary; },
        get savedState() { return savedState; },
        channels: () => Array.from(layout.getLayoutState().primary.tabs, tab => tab.channelId),
        navigate: id => { selectedId = id; layout.syncPrimaryChannel(); },
        setHeader: id => { headerPaneId = id; },
        migratePersistedState
    };
}

test("keeping a preview preserves it across native guild, DM and thread navigation", async () => {
    const h = createHarness();
    await h.layout.initializeLayout();
    const first = h.primary.activeTabId;
    assert.equal(h.primary.previewTabId, first);
    assert.equal(h.layout.keepPrimaryTab(), true);
    h.navigate("guild-b");
    assert.deepEqual(h.channels(), ["a", "guild-b"]);
    h.navigate("thread-c");
    assert.deepEqual(h.channels(), ["a", "thread-c"]);
    h.navigate("a");
    assert.equal(h.primary.activeTabId, first);
    assert.deepEqual(h.navigations, [], "Observing Discord must never trigger navigation");
    h.navigate("d");
    assert.deepEqual(h.channels(), ["a", "d"]);
});

test("explicit add keeps the old channel and switches via Discord's real router helper", async () => {
    const h = createHarness();
    await h.layout.initializeLayout();
    h.layout.openChannel("split");
    const secondary = h.layout.getLayoutState().panes;
    assert.equal(h.layout.openPrimaryTab("b"), true);
    assert.deepEqual(h.channels(), ["a", "b"]);
    assert.equal(h.primary.previewTabId, null);
    assert.equal(h.layout.getLayoutState().panes, secondary);
    assert.deepEqual(h.navigations, ["b"]);
    h.layout.activateTab(null, h.primary.tabs[0].id);
    h.layout.syncPrimaryChannel();
    assert.deepEqual(h.navigations, ["b", "a"]);
    assert.equal(h.primary.activeTabId, h.primary.tabs[0].id);
    h.layout.openPrimaryTab("b");
    assert.deepEqual(h.channels(), ["a", "b"], "Reopening a channel reuses its tab");
});

test("closing an active main tab selects its neighbor; the last main view stays open", async () => {
    const h = createHarness();
    await h.layout.initializeLayout();
    h.layout.openPrimaryTab("b");
    h.layout.openPrimaryTab("c");
    h.layout.closeTab(null, h.primary.tabs[1].id);
    assert.deepEqual(h.navigations, ["b", "c"], "Closing a background tab does not navigate");
    h.layout.closeTab(null, h.primary.activeTabId);
    assert.deepEqual(h.navigations, ["b", "c", "a"]);
    h.layout.closeTab(null, h.primary.activeTabId);
    assert.deepEqual(h.channels(), ["a"]);
    assert.equal(h.primary.activeTabId, h.primary.previewTabId);
    h.layout.closeTab(null, h.primary.activeTabId);
    assert.deepEqual(h.channels(), ["a"]);
});

test("moving a split tab into the main pane merges duplicates and removes an empty split", async () => {
    const h = createHarness();
    await h.layout.initializeLayout();
    h.layout.openChannel("a");
    const source = Object.values(h.layout.getLayoutState().panes)[0];
    const tabId = source.activeTabId;
    const previewId = h.primary.activeTabId;
    h.layout.setDraft("a", "draft survives");
    assert.equal(h.layout.moveTab(null, tabId, previewId, "after"), true);
    assert.deepEqual(h.channels(), ["a"]);
    assert.equal(h.primary.activeTabId, tabId);
    assert.equal(h.primary.previewTabId, null);
    assert.deepEqual(Object.keys(h.layout.getLayoutState().panes), []);
    assert.equal(h.layout.getLayoutState().layout.type, "primary");
    assert.equal(h.layout.getDraft("a"), "draft survives");
    assert.equal(h.forgotten.includes(tabId), false);
    assert.deepEqual(h.navigations, ["a"]);
});

test("moving the last main tab out retains a new native preview and the dragged tab identity", async () => {
    const h = createHarness();
    await h.layout.initializeLayout();
    const tabId = h.primary.activeTabId;
    h.layout.openChannel("split");
    const target = Object.values(h.layout.getLayoutState().panes)[0];
    assert.equal(h.layout.moveTab(target.id, tabId), true);
    assert.equal(h.layout.getPaneState(target.id).activeTabId, tabId);
    assert.deepEqual(h.channels(), ["a"]);
    assert.notEqual(h.primary.activeTabId, tabId);
    assert.equal(h.primary.previewTabId, h.primary.activeTabId);
    assert.deepEqual(h.navigations, []);
});

test("moving an active main tab to a split navigates main to a remaining tab", async () => {
    const h = createHarness();
    await h.layout.initializeLayout();
    h.layout.openPrimaryTab("b");
    const tabId = h.primary.activeTabId;
    h.layout.openChannel("split");
    const target = Object.values(h.layout.getLayoutState().panes)[0];
    assert.equal(h.layout.moveTab(target.id, tabId), true);
    assert.deepEqual(h.channels(), ["a"]);
    assert.deepEqual(h.navigations, ["b", "a"]);
    assert.equal(h.layout.getLayoutState().activePaneId, target.id);
});

test("main reordering keeps a dragged preview without navigating or changing selection", async () => {
    const h = createHarness();
    await h.layout.initializeLayout();
    h.layout.keepPrimaryTab();
    h.navigate("b");
    const active = h.primary.activeTabId;
    assert.equal(h.layout.moveTab(null, active, h.primary.tabs[0].id), true);
    assert.deepEqual(h.channels(), ["b", "a"]);
    assert.equal(h.primary.activeTabId, active);
    assert.equal(h.primary.previewTabId, null);
    assert.deepEqual(h.navigations, []);
});

test("secondary tab activation and movement never route Discord", async () => {
    const h = createHarness();
    await h.layout.initializeLayout();
    h.layout.openChannel("split-a");
    const source = Object.values(h.layout.getLayoutState().panes)[0];
    h.layout.openChannelInPane("split-b", source.id);
    h.layout.activateTab(source.id, source.activeTabId);
    h.layout.openChannel("split-c");
    const target = Object.values(h.layout.getLayoutState().panes)[1];
    h.layout.moveTab(target.id, source.activeTabId);
    assert.deepEqual(h.navigations, []);
    assert.deepEqual(h.channels(), ["a"]);
});

test("tab capacity never evicts kept tabs or blocks ordinary Discord navigation", async () => {
    const h = createHarness();
    await h.layout.initializeLayout();
    for (let i = 1; i < h.layout.MAXIMUM_TABS_PER_PANE; i++) assert.equal(h.layout.openPrimaryTab(`saved-${i}`), true);
    const savedIds = Array.from(h.primary.tabs, tab => tab.id);
    h.navigate("preview");
    assert.equal(h.primary.tabs.length, 101);
    assert.equal(h.layout.keepPrimaryTab(), false);
    assert.equal(h.layout.openPrimaryTab("extra"), false);
    h.navigate("new-preview");
    assert.deepEqual(Array.from(h.primary.tabs.slice(0, -1), tab => tab.id), savedIds);
    assert.equal(h.layout.openPrimaryTab("a"), true, "Existing kept tabs are still selectable at capacity");
    assert.equal(h.primary.tabs.length, 101);
    assert.ok(h.primary.previewTabId);
    h.layout.closeTab(null, h.primary.tabs[1].id);
    h.navigate("new-preview");
    assert.equal(h.layout.keepPrimaryTab(), true);
});

test("persistence restores main tabs without forcing the old Discord route", async () => {
    const first = createHarness();
    await first.layout.initializeLayout();
    first.layout.openPrimaryTab("b");
    const saved = first.migratePersistedState(first.savedState);
    assert.ok(saved);
    const restored = createHarness({ selected: "c", saved });
    await restored.layout.initializeLayout();
    assert.deepEqual(restored.channels(), ["a", "b", "c"]);
    assert.deepEqual(restored.navigations, []);
    assert.equal(restored.primary.tabs[0].id, saved.primary.tabs[0].id);
});

test("v1/v2 layouts migrate and malformed native tab records are rejected", () => {
    const { migratePersistedState: migrate } = createHarness();
    const v2 = { version: 2, layout: { type: "primary" }, panes: {}, activePaneId: null, drafts: { a: "draft" } };
    const v3 = migrate(v2);
    assert.equal(v3.version, 3);
    assert.equal(v3.primary.tabs.length, 0);
    assert.equal(migrate({ ...v2, version: 1, layout: null, primaryRatio: 0.5 }).version, 3);
    const primary = { tabs: [{ id: "tab", channelId: "a" }], activeTabId: "tab", previewTabId: null };
    assert.ok(migrate({ ...v3, primary }));
    assert.equal(migrate({ ...v3, primary: { ...primary, previewTabId: "missing" } }), null);
    assert.equal(migrate({ ...v3, primary: { ...primary, activeTabId: "missing" } }), null);
    assert.equal(migrate({ ...v3, primary: { ...primary, tabs: [...primary.tabs, { id: "other", channelId: "a" }] } }), null);
    assert.equal(migrate({ ...v3, primary: { ...primary, tabs: [...primary.tabs, { id: "tab", channelId: "b" }] } }), null);
});

test("unavailable channels cannot be added and pruning keeps valid native tabs", async () => {
    const h = createHarness();
    await h.layout.initializeLayout();
    h.layout.openPrimaryTab("b");
    h.unavailable.add("b");
    assert.equal(h.layout.openPrimaryTab("b"), false);
    h.layout.pruneUnavailableChannels(id => !h.unavailable.has(id));
    assert.deepEqual(h.channels(), ["a"]);
    assert.equal(h.primary.activeTabId, null);
    h.navigate(undefined);
    assert.deepEqual(h.channels(), ["a"]);
});

test("main pane handle swaps positions without changing tabs or the native route", async () => {
    const h = createHarness();
    await h.layout.initializeLayout();
    h.layout.openChannel("split");
    const target = Object.values(h.layout.getLayoutState().panes)[0];
    const primary = h.primary;
    assert.equal(h.layout.swapPanePositions(null, target.id), true);
    assert.equal(h.layout.getLayoutState().layout.first.paneId, target.id);
    assert.equal(h.primary, primary);
    assert.deepEqual(h.navigations, []);
});

test("sidebar drag drops into the unsplit main header as a native tab, not a top split", async () => {
    const h = createHarness();
    await h.layout.initializeLayout();
    const drag = h.load("../drag/DragManager.tsx");
    drag.registerDragWorkspace(() => ({
        geometry: { panes: [], primary: { x: 0, y: 0, width: 1, height: 1 } },
        rect: { left: 200, top: 0, width: 800, height: 600 }
    }));
    const props = drag.getChannelDragProps(h.channel("b"));
    props.onPointerDownCapture({ button: 0, pointerId: 1, clientX: 100, clientY: 200 });
    drag.DragLayer();
    h.effects.splice(0).forEach(effect => effect());
    h.setHeader("primary");
    h.windowListeners.get("pointerup")({ pointerId: 1, clientX: 300, clientY: 10, preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(h.channels(), ["a", "b"]);
    assert.deepEqual(h.navigations, ["b"]);
    assert.equal(h.layout.getLayoutState().layout.type, "primary");
    let suppressed = false;
    props.onClickCapture({ preventDefault: () => { suppressed = true; }, stopPropagation() {} });
    assert.equal(suppressed, true, "Drop must not also trigger the sidebar's normal click");
});

test("sidebar center drops add main tabs while edge drops still create split panes", async () => {
    for (const x of [600, 995]) {
        const h = createHarness();
        await h.layout.initializeLayout();
        const drag = h.load("../drag/DragManager.tsx");
        drag.registerDragWorkspace(() => ({
            geometry: { panes: [], primary: { x: 0, y: 0, width: 1, height: 1 } },
            rect: { left: 200, top: 0, width: 800, height: 600 }
        }));
        drag.getChannelDragProps(h.channel("b")).onPointerDownCapture({ button: 0, pointerId: 1, clientX: 100, clientY: 200 });
        drag.DragLayer();
        h.effects.splice(0).forEach(effect => effect());
        h.windowListeners.get("pointerup")({ pointerId: 1, clientX: x, clientY: 300, preventDefault() {}, stopPropagation() {} });
        assert.equal(h.layout.getLayoutState().layout.type, x === 600 ? "primary" : "split");
        assert.deepEqual(h.navigations, x === 600 ? ["b"] : []);
    }
});
