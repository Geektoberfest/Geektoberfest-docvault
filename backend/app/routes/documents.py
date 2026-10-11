from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from typing import List, Optional
import os
import uuid
import shutil
from .. import models, schemas, auth
from ..database import get_db

router = APIRouter()
UPLOAD_DIR = "uploads"

MAX_FILE_SIZE = 10 * 1024 * 1024 # 10 MB

@router.post("/upload", response_model=schemas.DocumentResponse)
def upload_document(
    file: UploadFile = File(...),
    folder_id: Optional[int] = Form(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user)
):
    # Read file size
    file.file.seek(0, 2)
    file_size = file.file.tell()
    file.file.seek(0)

    if file_size > MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail="File too large. Max size is 10MB.")

    # Check folder if provided
    if folder_id:
        folder = db.query(models.Folder).filter(
            models.Folder.id == folder_id,
            models.Folder.owner_id == current_user.id
        ).first()
        if not folder:
            raise HTTPException(status_code=404, detail="Folder not found or you don't have access")

    # Generate unique filename to avoid conflicts
    file_ext = os.path.splitext(file.filename)[1]
    unique_filename = f"{uuid.uuid4()}{file_ext}"
    file_path = os.path.join(UPLOAD_DIR, unique_filename)

    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    new_doc = models.Document(
        filename=unique_filename,
        original_filename=file.filename,
        file_path=file_path,
        file_size=file_size,
        content_type=file.content_type,
        folder_id=folder_id,
        owner_id=current_user.id
    )

    db.add(new_doc)
    db.commit()
    db.refresh(new_doc)
    return new_doc

@router.get("/", response_model=List[schemas.DocumentResponse])
def get_documents(db: Session = Depends(get_db),
                  current_user: models.User = Depends(auth.get_current_user),
                  file_type: Optional[str] = None
                ):
    query = db.query(models.Document).filter(models.Document.owner_id == current_user.id)

    if file_type and file_type.lower() != "all":
        query = query.filter(models.Document.content_type.ilike(f"%{file_type}%"))

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


@router.get("/page", response_model=schemas.DocumentPage)
def get_document_page(
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=100),
    q: str = "",
    folder_id: Optional[int] = Query(None, ge=1),
    file_type: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user)
):
    query = db.query(models.Document).filter(models.Document.owner_id == current_user.id)
    if q:
        query = query.filter(models.Document.original_filename.ilike(f"%{q}%"))
    if folder_id is not None:
        query = query.filter(models.Document.folder_id == folder_id)
    if file_type and file_type.lower() != "all":
        query = query.filter(models.Document.content_type.ilike(f"%{file_type}%"))

    total = query.count()
    total_pages = max(1, (total + page_size - 1) // page_size)
    page = min(page, total_pages)
    items = query.order_by(
        models.Document.created_at.desc(), models.Document.id.desc()
    ).offset((page - 1) * page_size).limit(page_size).all()
    return schemas.DocumentPage(
        items=items, total=total, page=page, page_size=page_size, total_pages=total_pages
    )

@router.get("/{doc_id}/download")
def download_document(doc_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)):
    doc = db.query(models.Document).filter(
        models.Document.id == doc_id,
        models.Document.owner_id == current_user.id
    ).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    
    if not os.path.exists(doc.file_path):
        raise HTTPException(status_code=404, detail="File not found on server")

    return FileResponse(
        path=doc.file_path,
        filename=doc.original_filename,
        media_type=doc.content_type
    )

@router.delete("/{doc_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_document(doc_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)):
    doc = db.query(models.Document).filter(
        models.Document.id == doc_id,
        models.Document.owner_id == current_user.id
    ).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    
    # Remove file from disk
    if os.path.exists(doc.file_path):
        os.remove(doc.file_path)

    db.delete(doc)
    db.commit()
    return None
