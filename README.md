# Document Management System

A simple, open-source Document Management System built with FastAPI and React. This repository is intended as a beginner-friendly project for open-source contributions.

## 🌐 Live Demo

Try DocVault online:

- **Frontend:** https://doc-vault-lac.vercel.app
- **Backend API:** https://docvault-backend-iv5x.onrender.com
- **API Documentation:** https://docvault-backend-iv5x.onrender.com/docs

The frontend is deployed on Vercel, and the FastAPI backend is hosted on Render.

**Note:** The backend may take a little time to respond after a period of inactivity. Please allow a few seconds for it to wake up.



## Features

- **User Authentication:** Register and log in securely with JWT
- Upload and manage personal documents (up to 10MB)
- Readable document sizes in B, KB, or MB using 1024-based units (up to two decimal places, without trailing zeros); zero-byte files show `0 B` and invalid sizes show `Unknown`
- Documents and folders are completely private to the owner
- Download documents
- Delete documents
- Create and delete folders
- Rename folders with validation that preserves your input on errors
- Search documents by filename

## Tech Stack

- **Backend:** FastAPI, PostgreSQL, SQLAlchemy, Alembic
- **Frontend:** React, Vite, Tailwind CSS, Axios

## Requirements

- Python 3.11+
- Node.js 22.12+ (or Node.js 20.x starting at 20.19)
- PostgreSQL

## Setup Instructions

### 1. Clone the repository
```bash
git clone https://github.com/your-username/DocVault.git
cd DocVault
```

### 2. Backend Setup

Configure PostgreSQL:
- Ensure PostgreSQL is running.
- Create a database (e.g., `document_manager`).

Set up Python environment and run:
```bash
cd backend
python -m venv venv
# On Windows:
venv\Scripts\activate
# On macOS/Linux:
# source venv/bin/activate

pip install -r requirements.txt

# Create .env file and set your DATABASE_URL
copy .env.example .env
# Edit .env with your PostgreSQL credentials

# Run database migrations to create tables
alembic upgrade head

# Start the application
uvicorn app.main:app --reload
```
The API will be available at `http://localhost:8000`.

### 3. Frontend Setup

```bash
cd frontend
npm install
npm run dev
```
The React application will be available at `http://localhost:5173`.

## Download safety and integrity

Downloads require the existing owner authentication check. Missing and foreign
document IDs both return the same 404. The browser uses the authenticated Axios
client and a temporary blob URL, so the document list no longer places tokens in
download URLs. Backend query-token authentication remains available for existing
clients. Download failures show actionable messages without displaying raw server
responses or internal paths.

The configured storage root is `UPLOAD_DIR` in `backend/app/routes/documents.py`
(currently `uploads`, relative to the backend working directory). Existing flat
relative paths and absolute paths inside that root are supported. Traversal,
outside paths, nested storage paths, alternate streams, and multiply linked files
are rejected. Storage and its ancestors must remain controlled by the application
operator. On POSIX, the source is opened relative to a pinned directory descriptor
with no-follow flags. On Windows, native handles pin the root and deny source
writes/deletion during copying; the actual opened destination is checked before
reading, including junction/symlink redirection.

Before response headers are sent, the source is copied in bounded chunks into a
private temporary snapshot. Regular-file type, persisted upload-derived size
(when present), copied length, and source metadata stability are checked. Legacy
rows with no size use the measured snapshot length; invalid or mismatching sizes
return 409. Missing paths and rejected storage names return 404; inaccessible
filesystem objects, read, temporary-storage, or audit failures return a sanitized
503. Snapshots are closed after transmission or
disconnect, and responses use their exact length and an encoded attachment name.

There is **no trusted checksum baseline on current main**. No checksum is created,
backfilled, or claimed as historical integrity proof; same-size corruption may
remain undetected. Issue #31's proposed upload hashes are not assumed to exist.
The snapshot prevents later source replacement from changing the response, but
network failures or temporary-file read errors after headers are committed can
still interrupt delivery; HTTP status cannot then be rewritten. The frontend
reports request failures and waits for the complete Axios blob response before
offering a save; it does not compare encoded wire size to decoded blob size. Single
byte ranges are supported after full snapshot validation. Multipart/unsupported
ranges and unmatched `If-Range` conditions receive the full response; no ETag or
checksum validator is invented.
Concurrent downloads consume temporary disk space. Audit events record a prepared
download, not proof that the browser saved it.

PR #19's version-history endpoints are not yet on main. When integrating it,
reuse these protections for version downloads with each version's size metadata,
and retain the separate version-upload API. PRs #40 and #41 also overlap the
document-list component and Axios module; keep their account and upload behavior
when resolving those files.

## Folder names

Folder creation and renaming trim leading and trailing whitespace and reject empty
or whitespace-only names. Names must be unique for each user (case-sensitive).
Folders are currently a flat list, so there is no parent-folder scope. Different
users can use the same folder name.

Use the pencil button beside a folder to rename it, then choose **Save** or
**Cancel**. Validation errors appear beside the input without clearing your text.
Renaming keeps the folder's documents and current selection unchanged.

The API accepts `PATCH /folders/{folder_id}` with `{"name": "New name"}` and requires
authentication as the folder owner. Invalid names return `422`, duplicate names
return `400`, and missing folders or folders owned by another user return `404`.

## Audit log

Sensitive document actions are recorded so users can see what happened to their
files. Document **upload**, **download** and **delete** each create an audit event
containing the actor, action, target (type, id and file name), client IP and
timestamp. Passwords, tokens and document contents are never stored. Failed
requests (for example a download of a missing document) are not recorded.

`GET /audit/` returns the authenticated user's own events, newest first, and
supports `limit` (1-500, default 100) and `offset` query parameters. Users can
only read their own events; unauthenticated requests return `401`. In the web
app, open the **Audit Log** panel from the header.

Run `alembic upgrade head` to create the new `audit_logs` table. Share creation
and revocation events will be added together with the document sharing feature.

## Folder and document permissions

Each folder and document has one owner. Only the owner can list, download,
delete, rename or upload into a folder, and every route applies the same check.

| Level  | Who has it          | Allows                                                        |
|--------|---------------------|---------------------------------------------------------------|
| Owner  | The user who created the folder or uploaded the document | List, download, delete, rename, upload into the folder |
| None   | Every other user    | Nothing. The API returns `404`, the same as for an ID that does not exist |

A document can only be placed in a folder its owner controls. Changing a document
or folder ID in a request does not grant access. `GET /documents/?folder_id=`
returns only that folder's documents and returns `404` for a folder you do not
own. Sharing levels such as read or write are not available yet and will be added
with document sharing.

## Running tests

From `backend`, with your virtual environment activated:

```bash
pip install -r requirements-dev.txt
python -m unittest discover -s tests -v
```

Backend tests use an isolated in-memory SQLite database and do not require a
running PostgreSQL instance or modify your development database.

From `frontend`:

```bash
npm install
npm test
npm run lint
npm run build
```

## Frontend Checks

From the repository root:

```bash
npm ci --prefix frontend
node --test frontend/src/formatFileSize.test.js
npm run build --prefix frontend
npm run lint --prefix frontend
```

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for details on how to get started.

Check out our [GOOD_FIRST_ISSUES.md](GOOD_FIRST_ISSUES.md) for ideas on what to work on.
