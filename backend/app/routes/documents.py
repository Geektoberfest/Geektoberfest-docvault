from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from sqlalchemy.exc import SQLAlchemyError
from typing import List, Optional
import os
from .. import models, schemas, auth
from ..database import get_db
from ..document_files import save_upload, remove_files, document_file_paths

router = APIRouter()

@router.post("/upload", response_model=schemas.DocumentResponse)
def upload_document(
    file: UploadFile = File(...),
    folder_id: Optional[int] = Form(None),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user)
):
    # Check folder if provided
    if folder_id:
        folder = db.query(models.Folder).filter(
            models.Folder.id == folder_id,
            models.Folder.owner_id == current_user.id
        ).with_for_update().first()
        if not folder:
            raise HTTPException(status_code=404, detail="Folder not found or you don't have access")

    metadata = save_upload(file)
    new_doc = models.Document(**metadata, folder_id=folder_id, owner_id=current_user.id, current_version=1)
    new_doc.versions.append(models.DocumentVersion(**metadata, version_number=1))
    try:
        db.add(new_doc)
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        remove_files([metadata["file_path"]])
        raise HTTPException(status_code=500, detail="Could not save document") from exc
    db.refresh(new_doc)
    return new_doc


@router.post("/{doc_id}/versions", response_model=schemas.DocumentResponse)
def upload_version(
    doc_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(auth.get_current_user)
):
    # Serialize replacements of the same document so version numbers stay unique.
    doc = db.query(models.Document).filter(
        models.Document.id == doc_id,
        models.Document.owner_id == current_user.id
    ).with_for_update().first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    metadata = save_upload(file)
    try:
        version_number = doc.current_version + 1
        db.add(models.DocumentVersion(document_id=doc.id, version_number=version_number, **metadata))
        for field, value in metadata.items():
            setattr(doc, field, value)
        doc.current_version = version_number
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        remove_files([metadata["file_path"]])
        raise HTTPException(status_code=500, detail="Could not save new version; current version is unchanged") from exc
    db.refresh(doc)
    return doc


@router.get("/{doc_id}/versions", response_model=List[schemas.DocumentVersionResponse])
def get_versions(doc_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)):
    doc = db.query(models.Document).filter(
        models.Document.id == doc_id, models.Document.owner_id == current_user.id
    ).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    return db.query(models.DocumentVersion).filter(
        models.DocumentVersion.document_id == doc_id
    ).order_by(models.DocumentVersion.version_number.desc()).all()


@router.get("/{doc_id}/versions/{version_number}/download")
def download_version(doc_id: int, version_number: int, db: Session = Depends(get_db), current_user: models.User = Depends(auth.get_current_user)):
    version = db.query(models.DocumentVersion).join(models.Document).filter(
        models.Document.id == doc_id,
        models.Document.owner_id == current_user.id,
        models.DocumentVersion.version_number == version_number
    ).first()
    if not version:
        raise HTTPException(status_code=404, detail="Document version not found")
    if not os.path.isfile(version.file_path):
        raise HTTPException(status_code=404, detail="File not found on server")
    return FileResponse(version.file_path, filename=version.original_filename, media_type=version.content_type)


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
    ).with_for_update().first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    
    paths = document_file_paths(doc)
    db.delete(doc)
    db.commit()
    remove_files(paths)
    return None
