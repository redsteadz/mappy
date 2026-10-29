import type { MockAppDef, MockView } from "./mock.ts";

/**
 * "Notely" — a small fake notes app used by tests and the dashboard's demo device. It covers the
 * patterns the crawler must handle: bottom navigation, a list → detail template, a form, a dialog,
 * a risky action, a permission prompt, an external app, toggles, scrolling and a crash.
 */

const NOTES = ["Groceries", "Trip to Lisbon", "Book club", "Workout plan", "Gift ideas", "Recipes", "Garden", "Meeting notes", "Reading list", "Taxes"];

const row = (text: string, onClick: MockView["onClick"], id = "pref_row"): MockView => ({ id, text, onClick, h: 150 });

export const demoApp: MockAppDef = {
  pkg: "com.mappy.notely",
  label: "Notely",
  launch: "home",
  screens: {
    home: {
      activity: "com.mappy.notely.MainActivity",
      title: "Notes",
      bottomNav: [
        { id: "nav_notes", text: "Notes", go: "home" },
        { id: "nav_search", text: "Search", go: "search" },
        { id: "nav_settings", text: "Settings", go: "settings" },
      ],
      body: () => [
        {
          row: true,
          children: [
            { id: "filter_label", text: "All notes", h: 120 },
            // Deliberately unlabeled icon button: shows up as an accessibility finding.
            { id: "btn_sort", onClick: { noop: true }, h: 120 },
          ],
        },
        {
          id: "note_list",
          scrollable: true,
          h: 1500,
          children: NOTES.map((n) => ({
            id: "note_item",
            clickable: true,
            h: 200,
            onClick: { go: "detail", param: n },
            children: [
              { id: "note_title", text: n, h: 110 },
              { id: "note_preview", text: `Preview of ${n.toLowerCase()}`, h: 90 },
            ],
          })),
        },
        { id: "fab_new", desc: "New note", onClick: { go: "editor" }, h: 160 },
      ],
    },
    detail: {
      activity: "com.mappy.notely.NoteActivity",
      title: (ctx) => ctx.param ?? "Note",
      body: (ctx) => [
        { id: "note_body", text: `Body of ${ctx.param}`, h: 600 },
        {
          row: true,
          children: [
            { id: "btn_edit", text: "Edit", onClick: { go: "editor", param: ctx.param } },
            { id: "btn_delete", text: "Delete", onClick: { dialog: "confirmDelete" } },
            { id: "btn_open_link", text: "Open link", onClick: { external: "com.android.chrome" } },
          ],
        },
      ],
    },
    editor: {
      activity: "com.mappy.notely.EditorActivity",
      title: "Edit note",
      body: () => [
        { id: "input_title", editable: true, hint: "Title" },
        { id: "input_body", editable: true, hint: "Write something", h: 400 },
        { id: "chk_pin", text: "Pin note", checkable: true },
        { id: "btn_save", text: "Save", onClick: { back: true } },
      ],
    },
    confirmDelete: {
      activity: "com.mappy.notely.NoteActivity",
      dialog: true,
      body: () => [
        { id: "dlg_message", text: "Delete this note?" },
        {
          row: true,
          children: [
            { id: "dlg_cancel", text: "Cancel", onClick: { back: true } },
            { id: "dlg_confirm", text: "Delete", onClick: { back: true } },
          ],
        },
      ],
    },
    search: {
      activity: "com.mappy.notely.MainActivity",
      title: "Search",
      bottomNav: [
        { id: "nav_notes", text: "Notes", go: "home" },
        { id: "nav_search", text: "Search", go: "search" },
        { id: "nav_settings", text: "Settings", go: "settings" },
      ],
      body: () => [
        { id: "search_input", editable: true, hint: "Search notes" },
        { id: "btn_search", text: "Go", onClick: { go: "results" } },
        { id: "recent_label", text: "Recent searches", h: 120 },
      ],
    },
    results: {
      activity: "com.mappy.notely.ResultsActivity",
      title: "Results",
      body: () => [
        { id: "result_count", text: "3 results", h: 120 },
        {
          id: "result_list",
          scrollable: true,
          h: 900,
          children: NOTES.slice(0, 3).map((n) => ({ id: "result_item", text: n, onClick: { go: "detail", param: n }, h: 180 })),
        },
      ],
    },
    settings: {
      activity: "com.mappy.notely.MainActivity",
      title: "Settings",
      bottomNav: [
        { id: "nav_notes", text: "Notes", go: "home" },
        { id: "nav_search", text: "Search", go: "search" },
        { id: "nav_settings", text: "Settings", go: "settings" },
      ],
      body: () => [
        {
          id: "settings_scroll",
          scrollable: true,
          cls: "android.widget.ScrollView",
          h: 1300,
          children: [
            { id: "sw_dark", text: "Dark mode", checkable: true, cls: "android.widget.Switch" },
            row("Account", { go: "account" }, "pref_account"),
            row("Notifications", { permission: "send notifications", then: { go: "notifications" } }, "pref_notifications"),
            row("About", { go: "about" }, "pref_about"),
            row("Backup", { go: "backup" }, "pref_backup"),
            row("Export data", { go: "export" }, "pref_export"),
            row("Help", { go: "help" }, "pref_help"),
            row("Crash test", { crash: true }, "pref_crash"),
            row("Log out", { replace: "login" }, "pref_logout"),
            row("Licenses", { go: "licenses" }, "pref_licenses"),
          ],
        },
      ],
    },
    account: {
      activity: "com.mappy.notely.SettingsActivity",
      title: "Account",
      body: () => [
        { id: "input_name", editable: true, hint: "Name" },
        { id: "input_email", editable: true, hint: "Email" },
        { id: "btn_change_pw", text: "Change password", onClick: { go: "password" } },
      ],
    },
    password: {
      activity: "com.mappy.notely.SettingsActivity",
      title: "Change password",
      body: () => [
        { id: "input_password", editable: true, password: true, hint: "New password" },
        { id: "btn_update", text: "Update", onClick: { back: true } },
      ],
    },
    notifications: {
      activity: "com.mappy.notely.SettingsActivity",
      title: "Notifications",
      body: () => [
        { id: "sw_reminders", text: "Reminders", checkable: true, cls: "android.widget.Switch" },
        { id: "sw_digest", text: "Weekly digest", checkable: true, cls: "android.widget.Switch" },
      ],
    },
    about: {
      activity: "com.mappy.notely.SettingsActivity",
      title: "About",
      body: () => [
        { id: "version", text: "Version 1.0", h: 120 },
        { id: "btn_website", text: "Website", onClick: { external: "com.android.chrome" } },
      ],
    },
    backup: { activity: "com.mappy.notely.SettingsActivity", title: "Backup", body: () => [{ id: "backup_info", text: "Backups are off", h: 200 }] },
    export: { activity: "com.mappy.notely.SettingsActivity", title: "Export data", body: () => [{ id: "btn_export_csv", text: "CSV", onClick: { noop: true } }] },
    help: { activity: "com.mappy.notely.SettingsActivity", title: "Help", body: () => [{ id: "faq", text: "Frequently asked questions", h: 300 }] },
    licenses: { activity: "com.mappy.notely.SettingsActivity", title: "Licenses", body: () => [{ id: "license_text", text: "Apache 2.0", h: 300 }] },
    login: {
      activity: "com.mappy.notely.LoginActivity",
      title: "Sign in",
      body: () => [
        { id: "login_email", editable: true, hint: "Email" },
        { id: "login_password", editable: true, password: true, hint: "Password" },
        { id: "btn_sign_in", text: "Sign in", onClick: { replace: "home" } },
      ],
    },
  },
};
