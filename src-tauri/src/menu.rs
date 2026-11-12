//! Native macOS application menu.
//!
//! `build_menu` compiles on every platform so clippy and the test suite
//! type-check it, but the menu is installed only on macOS (see the
//! `#[cfg(target_os = "macos")]` block in `lib.rs`); Linux and Windows keep
//! their chromeless window. On macOS AppKit consumes a menu accelerator before
//! the webview receives the key, so the frontend keydown handler skips the
//! keys the menu owns (see `src/lib/menuShortcuts.ts`) to avoid running an
//! action twice.
//!
//! Custom items fire a `menu://action` event carrying their id. Two ids are
//! handled here in Rust instead: `help_github` opens the project page and
//! `close_window` closes the main window. Predefined items (About, Quit, Cut,
//! …) run their native selector and never emit an event, so they never reach
//! [`handle_event`].

use tauri::menu::{Menu, MenuEvent, MenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_opener::OpenerExt;

/// Build the application menu: App, File, Edit, View, Window, Help.
///
/// The `#[cfg_attr]` keeps the builder warning-free on non-macOS targets, where
/// it is compiled but never installed.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    // App menu: the first submenu; macOS renders it bold under the app name.
    let app_menu = SubmenuBuilder::new(app, "Marque")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    // File
    let open_file = MenuItem::with_id(app, "open_file", "Open File…", true, Some("CmdOrCtrl+O"))?;
    let close_tab = MenuItem::with_id(app, "close_tab", "Close Tab", true, Some("CmdOrCtrl+W"))?;
    let reveal = MenuItem::with_id(app, "reveal", "Reveal in Finder", true, None::<&str>)?;
    let copy_markdown = MenuItem::with_id(app, "copy_markdown", "Copy as Markdown", true, None::<&str>)?;
    let print = MenuItem::with_id(app, "print", "Print…", true, Some("CmdOrCtrl+P"))?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&open_file)
        .separator()
        .item(&close_tab)
        .separator()
        .item(&reveal)
        .item(&copy_markdown)
        .separator()
        .item(&print)
        .build()?;

    // Edit: the standard predefined items that power webview copy/paste/undo.
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    // View
    let palette = MenuItem::with_id(app, "palette", "Command Palette", true, Some("CmdOrCtrl+K"))?;
    let find = MenuItem::with_id(app, "find", "Find", true, Some("CmdOrCtrl+F"))?;
    let split_right = MenuItem::with_id(app, "split_right", "Split Right", true, Some("CmdOrCtrl+Backslash"))?;
    let split_down = MenuItem::with_id(app, "split_down", "Split Down", true, Some("CmdOrCtrl+Shift+Backslash"))?;
    let close_split = MenuItem::with_id(app, "close_split", "Close Split", true, None::<&str>)?;
    let zoom_in = MenuItem::with_id(app, "zoom_in", "Zoom In", true, Some("CmdOrCtrl+Equal"))?;
    let zoom_out = MenuItem::with_id(app, "zoom_out", "Zoom Out", true, Some("CmdOrCtrl+Minus"))?;
    let zoom_reset = MenuItem::with_id(app, "zoom_reset", "Actual Size", true, Some("CmdOrCtrl+Digit0"))?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&palette)
        .item(&find)
        .separator()
        .item(&split_right)
        .item(&split_down)
        .item(&close_split)
        .separator()
        .item(&zoom_in)
        .item(&zoom_out)
        .item(&zoom_reset)
        .separator()
        .fullscreen()
        .build()?;

    // Window: Minimize and Zoom (the macOS name for Maximize), plus a Close
    // item with no accelerator — the predefined Close Window would claim ⌘W,
    // which the app reserves for Close Tab.
    let close_window = MenuItem::with_id(app, "close_window", "Close", true, None::<&str>)?;
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .item(&close_window)
        .build()?;

    // Help
    let help_github = MenuItem::with_id(app, "help_github", "Marque on GitHub", true, None::<&str>)?;
    let help = SubmenuBuilder::new(app, "Help")
        .item(&help_github)
        .build()?;

    let menu = Menu::new(app)?;
    menu.append(&app_menu)?;
    menu.append(&file)?;
    menu.append(&edit)?;
    menu.append(&view)?;
    menu.append(&window)?;
    menu.append(&help)?;
    Ok(menu)
}

/// Handle a menu event.
///
/// Rust owns two ids directly; every other custom id is forwarded to the
/// frontend as a `menu://action` event whose payload is the id string.
pub(crate) fn handle_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        "help_github" => {
            let _ = app.opener().open_url("https://github.com/superbiche/marque", None::<&str>);
        }
        "close_window" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.close();
            }
        }
        other => {
            let _ = Emitter::emit(app, "menu://action", other);
        }
    }
}
