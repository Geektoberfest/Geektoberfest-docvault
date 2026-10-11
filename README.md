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
- Documents and folders are completely private to the owner
- Download documents
- Upload replacement versions and download earlier versions from document history
- Delete documents
- Create and delete folders
- Rename folders with validation that preserves your input on errors
- Search documents by filename

## Tech Stack

- **Backend:** FastAPI, PostgreSQL, SQLAlchemy, Alembic
- **Frontend:** React, Vite, Tailwind CSS, Axios

## Requirements

- Python 3.11+
- Node.js (v18+ recommended)
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

## Document version history

Run `alembic upgrade head` from `backend` before starting the updated API. The
migration records each existing document as version 1 using its current file and
metadata; no existing files are copied or renamed. Back up the database and upload
directory before applying migrations to a deployed installation.

Choose **History** beside a document to see its versions, upload timestamps, sizes,
and download links. The newest version is marked **current**. Choose a file and
**Upload new version** in this panel to replace the current content while retaining
all earlier versions. The document ID, folder, owner, and original document creation
time stay unchanged; each version records its own filename and upload time.

An ordinary upload creates a separate document, even when its filename matches an
existing document. Replacing a document is an explicit action tied to its ID, so a
different replacement filename still belongs to the selected document's history.
Each upload is limited to 10MB. History is retained until the document or its folder
is deleted; there is no automatic version pruning.

All version operations require authentication and document ownership:

- `POST /documents/{id}/versions`: multipart `file`; returns the document with its
  updated `current_version` after the replacement commits.
- `GET /documents/{id}/versions`: version metadata in descending version order.
- `GET /documents/{id}/versions/{number}/download`: download that version's file.
- `GET /documents/{id}/download`: continues to download the current version.

Replacements use separate files and a PostgreSQL row lock to serialize concurrent
updates. A failed file write or rolled-back database update preserves the current
version and attempts to remove the incomplete new file. If the client loses its
connection, refresh history before retrying because the server may have completed
the upload. Deletion removes version metadata and then removes the associated
files; filesystem cleanup failures are logged for manual follow-up.

Downgrading this migration removes version-history metadata while keeping the
current document and file. Older files remain on disk, but their history links are
lost; restoring a database backup is needed to recover that history.

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

## Running tests

From `backend`, with your virtual environment activated:

```bash
pip install -r requirements-dev.txt
python -m unittest discover -s tests -v
```

The default backend tests use an in-memory SQLite database and temporary files.
To include PostgreSQL migration and concurrent-upload checks, set
`VERSION_TEST_DATABASE_URL` to a local test database URL before running the same
command. Its database user needs permission to create schemas. These checks create
and remove a separate temporary schema for each test; application tables are not
modified. Without that variable, the three PostgreSQL checks are skipped.

From `frontend`:

```bash
npm install
npm test
npm run lint
npm run build
```

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for details on how to get started.

Check out our [GOOD_FIRST_ISSUES.md](GOOD_FIRST_ISSUES.md) for ideas on what to work on.
