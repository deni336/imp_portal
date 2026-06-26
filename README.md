# PIG Portal Desktop Shared-Database Build

This build is for the no-always-on-server setup: each user launches the EXE, the EXE starts a small local web server on that user's machine, opens the browser, and reads/writes the same SQLite database file on the shared drive.

## New in this version

- Next Meeting banner at the top of the app
  - Date/time uses the browser's native calendar picker via `datetime-local`
  - Location is stored beside the date/time
  - Saved in the shared SQLite database
- Meeting Notes / Journal page
  - Accessible from the top **Notes** button
  - Also accessible from the navigation dropdown
  - Notes are stored in the database and displayed chronologically
- Members / Info page
  - Stores member name, position, email, phone, and notes
  - Accessible from the top **Members** button
  - Also accessible from the navigation dropdown
- Project and step notes
  - Each project has a saved **Project Notes** section
  - Each project step has a saved **Step Notes** field
  - Both are stored in the shared SQLite database
- Excel export
  - Top **Export Excel** button downloads an `.xlsx` workbook
  - Project data is split into separate worksheets by project status
  - Project notes and step notes are included in the project worksheets
  - Meeting notes have their own worksheet
  - Members and next meeting data are also exported

## Reality check

This is a compromise design. It is better than opening a raw HTML file, but it is not as safe as a single hosted server.

To reduce database collisions, this build uses:

- one local Flask/Waitress server per user
- one shared SQLite database file
- SQLite rollback journal mode, not WAL
- `BEGIN IMMEDIATE` transactions
- a shared write-lock directory beside the database: `pig_portal.db.write.lock`
- short save transactions
- manual database backup button

Do not let users edit the SQLite database directly with DB Browser or scripts while the app is in use. All edits should go through the PIG Portal app.

## Folder layout

```text
pig_portal_desktop/
├── pig_portal_desktop.py
├── PIGPortalDesktop.spec
├── requirements.txt
├── run_from_source.bat
├── build_exe.bat
├── pig_portal_config.ini
├── static/
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── data/
└── backups/
```

## Shared drive layout after build

After building the EXE, place this on the shared drive:

```text
\\SERVER\Share\PIG_Portal\
├── PIGPortalDesktop.exe
├── pig_portal_config.ini
├── data\
│   └── pig_portal.db              # created automatically on first launch
└── backups\
```

## Recommended config

Edit `pig_portal_config.ini` beside the EXE:

```ini
[database]
path = \\SERVER\Share\PIG_Portal\data\pig_portal.db

[app]
host = 127.0.0.1
port = 0
auto_open_browser = yes
lock_timeout_seconds = 60
stale_lock_minutes = 10
backup_dir = \\SERVER\Share\PIG_Portal\backups
password =
```

`port = 0` lets the app pick an available local port each time. That avoids conflicts if the user accidentally opens the app twice.

## Run from source for testing

On Windows:

```bat
run_from_source.bat
```

The browser opens automatically.

## Build the EXE

On Windows with Python installed:

```bat
build_exe.bat
```

Output:

```text
dist\PIGPortalDesktop.exe
```

Copy the EXE and `pig_portal_config.ini` to the shared drive.

## How users run it

Users double-click:

```text
\\SERVER\Share\PIG_Portal\PIGPortalDesktop.exe
```

The app opens a local browser page like:

```text
http://127.0.0.1:54321/
```

Every user gets their own local browser session, but all users write to the same database path configured in `pig_portal_config.ini`.

## Latest layout update

The meeting banner places **Edit Meeting** immediately beside the next meeting information. The database action buttons — **Refresh From DB**, **Create DB Backup**, and **Export Excel** — are on the same banner bar to the right.

## Latest data update

Projects now include a saved **Project Notes** textarea. Every step row now includes a saved **Step Notes** textarea. Existing databases are migrated automatically on startup by adding `projects.notes` and `steps.notes` if they are missing.

## Excel export

Click **Export Excel** from the meeting/banner bar. The browser will download an `.xlsx` file. Depending on the user's browser policy, it may prompt for a save location or save to Downloads automatically.

Worksheets included:

- `Active Projects`
- `Inactive Projects`
- `Completed Projects`
- `Meeting Notes`
- `Members`
- `Next Meeting`

The project worksheets include both **Project Notes** and **Step Notes** columns. The export uses `openpyxl`, which is included in `requirements.txt` and bundled by the PyInstaller spec.

## Lock behavior

When a user saves, the app creates this folder beside the database:

```text
pig_portal.db.write.lock
```

That folder contains `owner.json` with the user, host, PID, and timestamp. Other users wait for the lock to clear before writing.

If the app crashes while saving, the lock can be cleared automatically after `stale_lock_minutes`.

If users see repeated lock errors:

1. Make sure nobody is still saving.
2. Check the lock owner shown in the app.
3. If it is stale and older than the configured stale time, restart the app.
4. As a last resort, delete `pig_portal.db.write.lock` manually.

## Backups

Use **Create DB Backup** from the meeting/banner bar. Backups are SQLite `.db` snapshots saved to the configured `backup_dir`.

## Known limitations

- This is not true client/server database access.
- Two users editing the same exact field can still overwrite each other; last save wins.
- The shared drive must allow users to create/delete folders and write files in the database directory.
- Do not use SQLite WAL mode on this design.
- Browser download behavior controls whether Excel export prompts for a save location or saves directly to Downloads.
- If this becomes mission-critical or heavily used, move to a real server or SharePoint Lists/Graph.


## Latest updates

- Meeting notes / journal entries now display newest to oldest.
- Projects can be pinned from the project page. Pinned projects sort above unpinned projects on the dashboard and in the navigation dropdown.
- Existing databases migrate automatically by adding a `projects.pinned` column when the app starts.
