# SplitView

A Vencord user plugin that opens multiple Discord conversations in resizable panes without changing the selected primary channel.

## Features

- Open DMs, group DMs, text channels, and threads in split panes.
- Drag channels onto pane edges to create layouts with up to four views.
- Use tabs inside secondary panes and resize each split.
- Reorder tabs, move them between split panes, and swap whole views with their tabs.
- Send messages, replies, files, images, and GIFs.
- Browse Discord's native GIF picker, including saved GIFs.
- Keep independent drafts and restore saved layouts.

## Usage

Right-click a supported channel or DM and select **Open in Split View**. You can also drag channels from Discord's sidebar when drag-to-split is enabled in the plugin settings.

In narrow panes, tab names truncate to keep the header tidy. Use the scroll arrows, mouse wheel, or trackpad to reach overflowing tabs; hover a tab to see its full name. Keyboard tab switching keeps the selected tab visible.

### Rearranging tabs and panes

- Drag a tab before or after another tab to reorder it, including across split panes. The insertion line shows where it will land.
- Drop a tab elsewhere in a split pane to move it to the end of that pane's tabs. Moving the last tab out removes the empty pane; drafts stay with their channels.
- Drag the six-dot handle at the left of a split pane's tab bar onto another view to swap their positions. All tabs move with their pane, and you can also swap with the main chat.
- Press `Escape` while dragging to cancel. Rearrangements are saved when **Remember Layout** is enabled.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl` + `Shift` + `Space` | Cycle composer focus through the primary chat and split panes. |
| `Ctrl` + `Shift` + `Arrow key` | Move composer focus to the pane in that direction. |
| `Ctrl` + `Alt` + `1`–`4` | Focus a pane by position. `1` is the primary chat; split panes follow in visual order. |
| `Ctrl` + `Alt` + `0` | Resize all views, including the primary chat, to equal shares of the workspace. |
| `Ctrl` + `Left Arrow` / `Right Arrow` | Select the previous / next tab in the focused pane, including the original chat. |

Main-chat tabs use Discord's native channel navigation. Ctrl+Arrow switches tabs while focus is inside a pane with multiple tabs; outside the panes it leaves Discord's shortcuts unchanged. Alt+Arrow retains Discord's normal history navigation.

Equalizing keeps the current arrangement and focused pane. Columns become equal widths, rows become equal heights, and mixed layouts get equal areas. You can also select **Equalize view sizes (Ctrl+Alt+0)** in the Vencord toolbox. The new sizes are saved when **Remember Layout** is enabled.

SplitView uses Discord's existing message, upload, and GIF systems. It does not create another client session or connection.
