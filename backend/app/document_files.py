"""File handling shared by initial uploads, replacements, and deletion."""
import logging
import os
import shutil
import uuid

from fastapi import HTTPException, UploadFile

UPLOAD_DIR = "uploads"
MAX_FILE_SIZE = 10 * 1024 * 1024
logger = logging.getLogger(__name__)


def remove_files(paths):
    for path in set(paths):
        if not path:
            continue
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
        except OSError:
            logger.exception("Could not remove document file %s", path)


def save_upload(file: UploadFile):
    if not file.filename:
        raise HTTPException(status_code=400, detail="A filename is required")
    file.file.seek(0, 2)
    file_size = file.file.tell()
    file.file.seek(0)
    if file_size > MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail="File too large. Max size is 10MB.")

    original_filename = os.path.basename(file.filename.replace("\\", "/"))
    filename = f"{uuid.uuid4()}{os.path.splitext(original_filename)[1]}"
    file_path = os.path.join(UPLOAD_DIR, filename)
    try:
        os.makedirs(UPLOAD_DIR, exist_ok=True)
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
    except OSError as exc:
        remove_files([file_path])
        raise HTTPException(status_code=500, detail="Could not save document file") from exc

    return dict(
        filename=filename, original_filename=original_filename, file_path=file_path,
        file_size=file_size, content_type=file.content_type or "application/octet-stream"
    )


def document_file_paths(document):
    return {document.file_path, *(version.file_path for version in document.versions)}
