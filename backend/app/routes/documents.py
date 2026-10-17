from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, status, Request
from fastapi.responses import FileResponse
from sqlalchemy import func
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from typing import List, Optional
import os
import uuid
import shutil
import tempfile
from .. import models, schemas, auth
from ..config import DOCUMENT_STORAGE_QUOTA_BYTES
from ..database import get_db
from ..audit_logger import log_event
from ..access import get_owned_document, get_owned_folder

router = APIRouter()
UPLOAD_DIR = "uploads"

MAX_FILE_SIZE = 10 * 1024 * 1024 # 10 MB

def _lock_storage_owner(db: Session, owner_id: int) -> None:
    # Uploads and deletes take this lock before touching document accounting.
    db.query(models.User.id).filter(models.User.id == owner_id).with_for_update().one()

@router.post("/upload", response_model=schemas.DocumentResponse)
def upload_document(
    request: Request,
    file: UploadFile = File(...),
    folder_id: Optional[int] = Form(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user)
):
    # Check folder if provided
    if folder_id:
        folder = get_owned_folder(db, folder_id, current_user)
        if not folder:
            raise HTTPException(status_code=404, detail="Folder not found or you don't have access")

    os.makedirs(UPLOAD_DIR, exist_ok=True)
    staged_path = None
    file_path = None
    committed = False
    try:
        with tempfile.NamedTemporaryFile(dir=UPLOAD_DIR, prefix=".upload-", delete=False) as staged:
            staged_path = staged.name
            shutil.copyfileobj(file.file, staged)
        file_size = os.path.getsize(staged_path)
        if file_size > MAX_FILE_SIZE:
            raise HTTPException(status_code=400, detail="File too large. Max size is 10MB.")

        # Locking the user's row serializes uploads for this owner. Under
        # PostgreSQL READ COMMITTED, the following SUM sees the prior upload's
        # commit after this lock becomes available.
        _lock_storage_owner(db, current_user.id)
        used_bytes = db.query(func.coalesce(func.sum(models.Document.file_size), 0)).filter(
            models.Document.owner_id == current_user.id,
            models.Document.file_size >= 0,
        ).scalar()
        used_bytes = int(used_bytes or 0)
        remaining_bytes = max(0, DOCUMENT_STORAGE_QUOTA_BYTES - used_bytes)
        if file_size > remaining_bytes:
            raise HTTPException(
                status_code=413,
                detail={
                    "code": "STORAGE_QUOTA_EXCEEDED",
                    "quota_bytes": DOCUMENT_STORAGE_QUOTA_BYTES,
                    "used_bytes": used_bytes,
                    "incoming_bytes": file_size,
                    "remaining_bytes": remaining_bytes,
                },
            )

        file_ext = os.path.splitext(file.filename or "")[1]
        unique_filename = f"{uuid.uuid4()}{file_ext}"
        file_path = os.path.join(UPLOAD_DIR, unique_filename)
        os.replace(staged_path, file_path)
        staged_path = None

        new_doc = models.Document(
            filename=unique_filename,
            original_filename=file.filename,
            file_path=file_path,
            file_size=file_size,
            content_type=file.content_type,
            folder_id=folder_id,
            owner_id=current_user.id,
        )
        db.add(new_doc)
        db.flush()
        log_event(
            db,
            user_id=current_user.id,
            action="upload",
            target_type="document",
            target_id=new_doc.id,
            target_name=file.filename,
            ip_address=request.client.host if request.client else None,
        )
        db.commit()
        committed = True
        db.refresh(new_doc)
        return new_doc
    except HTTPException:
        db.rollback()
        raise
    except SQLAlchemyError:
        db.rollback()
        raise HTTPException(status_code=500, detail="Upload could not be saved") from None
    except OSError:
        db.rollback()
        raise HTTPException(status_code=500, detail="Upload storage is unavailable") from None
    except Exception:
        db.rollback()
        raise HTTPException(status_code=500, detail="Upload could not be saved") from None
    finally:
        for path in (staged_path, file_path if not committed else None):
            if path and os.path.exists(path):
                try:
                    os.remove(path)
                except OSError:
                    pass

# fixed : 
@router.get("/", response_model=List[schemas.DocumentResponse])
def get_documents(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
    file_type: Optional[str] = None,
    sort_by: Optional[str] = "date_desc",  # NEW
    folder_id: Optional[int] = None,
):
    query = db.query(models.Document).filter(models.Document.owner_id == current_user.id)

    # Folder filter: a folder you don't own is a 404, not an empty list
    if folder_id is not None:
        if not get_owned_folder(db, folder_id, current_user):
            raise HTTPException(status_code=404, detail="Folder not found")
        query = query.filter(models.Document.folder_id == folder_id)

    # File type filter
    if file_type and file_type.lower() != "all":
        query = query.filter(models.Document.content_type.ilike(f"%{file_type}%"))

    # Sorting options (Issue #7)
    if sort_by == "name_asc":
        query = query.order_by(models.Document.original_filename.asc())
    elif sort_by == "name_desc":
        query = query.order_by(models.Document.original_filename.desc())
    elif sort_by == "date_asc":
        query = query.order_by(models.Document.created_at.asc())
    else:
        # Default: newest first
        query = query.order_by(models.Document.created_at.desc())

    return query.all()
@router.get("/search", response_model=List[schemas.DocumentResponse])
def search_documents(q: str, db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)):
    if not q:
        return []
    # Search by original_filename, only for this user
    return db.query(models.Document).filter(
        models.Document.owner_id == current_user.id,
        models.Document.original_filename.ilike(f"%{q}%")
    ).all()

@router.get("/{doc_id}/download")
def download_document(request: Request, doc_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)):
    doc = get_owned_document(db, doc_id, current_user)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    
    if not os.path.exists(doc.file_path):
        raise HTTPException(status_code=404, detail="File not found on server")

    log_event(
        db,
        user_id=current_user.id,
        action="download",
        target_type="document",
        target_id=doc.id,
        target_name=doc.original_filename,
        ip_address=request.client.host if request.client else None,
    )
    db.commit()

    return FileResponse(
        path=doc.file_path,
        filename=doc.original_filename,
        media_type=doc.content_type
    )

@router.post("/bulk-delete", response_model=schemas.BulkDeleteResponse)
def bulk_delete_documents(
    request: Request,
    payload: schemas.BulkDeleteRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user),
):
    deleted_ids = []
    failed = []
    _lock_storage_owner(db, current_user.id)
    seen_doc_ids = set()

    for doc_id in payload.document_ids:
        if doc_id in seen_doc_ids:
            failed.append(schemas.BulkDeleteFailure(id=doc_id, reason="Duplicate document ID"))
            continue
        seen_doc_ids.add(doc_id)
        doc = db.query(models.Document).filter(models.Document.id == doc_id).first()
        if not doc:
            failed.append(schemas.BulkDeleteFailure(id=doc_id, reason="Document not found"))
            continue

        if doc.owner_id != current_user.id:
            failed.append(schemas.BulkDeleteFailure(id=doc_id, reason="Access denied"))
            continue

        doc_name = doc.original_filename
        try:
            os.remove(doc.file_path)
        except FileNotFoundError:
            pass
        except OSError:
            failed.append(schemas.BulkDeleteFailure(id=doc_id, reason="File could not be deleted"))
            continue

        db.delete(doc)
        db.flush()

        log_event(
            db,
            user_id=current_user.id,
            action="bulk_delete",
            target_type="document",
            target_id=doc_id,
            target_name=doc_name,
            ip_address=request.client.host if request.client else None,
        )
        deleted_ids.append(doc_id)

    db.commit()

    return schemas.BulkDeleteResponse(
        deleted_ids=deleted_ids,
        failed=failed,
        total_requested=len(payload.document_ids),
        total_deleted=len(deleted_ids),
    )

@router.delete("/{doc_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_document(request: Request, doc_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)):
    _lock_storage_owner(db, current_user.id)
    doc = get_owned_document(db, doc_id, current_user)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    # Capture name before deletion so the audit record is meaningful
    doc_name = doc.original_filename

    # Keep the row (and its quota usage) when the stored file cannot be removed.
    try:
        os.remove(doc.file_path)
    except FileNotFoundError:
        pass
    except OSError:
        db.rollback()
        raise HTTPException(status_code=500, detail="Document file could not be deleted") from None

    db.delete(doc)
    db.flush()

    log_event(
        db,
        user_id=current_user.id,
        action="delete",
        target_type="document",
        target_id=doc_id,
        target_name=doc_name,
        ip_address=request.client.host if request.client else None,
    )

    db.commit()
    return None
