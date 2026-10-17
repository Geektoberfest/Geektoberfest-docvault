"""Open flat document storage safely and validate a private download snapshot."""
from contextlib import contextmanager
import errno
import os
from pathlib import Path, PureWindowsPath
import re
import stat
import tempfile
from urllib.parse import quote

from fastapi import HTTPException
from fastapi.responses import StreamingResponse
from starlette.concurrency import iterate_in_threadpool
from starlette.datastructures import Headers

CHUNK_SIZE = 64 * 1024


def _regular_file(descriptor):
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink > 1:
            raise HTTPException(404, "Document file unavailable")
        return os.fdopen(descriptor, "rb")
    except BaseException:
        os.close(descriptor)
        raise


def _storage_name(stored_path, root):
    if not isinstance(stored_path, str) or not stored_path or "\x00" in stored_path:
        raise ValueError("Invalid stored path")
    # Uploads are flat. Never traverse database-supplied directory components.
    parts = stored_path.replace("\\", "/").split("/")
    if ".." in parts or (os.name != "nt" and PureWindowsPath(stored_path).drive):
        raise ValueError("Invalid stored path")
    relative = Path(os.path.abspath(stored_path)).relative_to(root)
    if len(relative.parts) != 1 or relative.name in ("", ".") or ":" in relative.name:
        raise ValueError("Invalid stored path")
    return relative.name


@contextmanager
def _windows_source(root, name):
    import ctypes
    from ctypes import wintypes
    import msvcrt

    generic_read = 0x80000000
    share_read, share_write = 1, 2
    open_existing = 3
    directory_handle = 0x02000000  # FILE_FLAG_BACKUP_SEMANTICS, only for the root.
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    create = kernel.CreateFileW
    create.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                       wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    create.restype = wintypes.HANDLE
    final_path = kernel.GetFinalPathNameByHandleW
    final_path.argtypes = [wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD]
    final_path.restype = wintypes.DWORD
    close = kernel.CloseHandle
    close.argtypes = [wintypes.HANDLE]
    close.restype = wintypes.BOOL
    invalid = wintypes.HANDLE(-1).value

    def open_handle(path, access, share, flags):
        handle = create(str(path), access, share, None, open_existing, flags, None)
        if handle == invalid:
            raise ctypes.WinError(ctypes.get_last_error())
        return handle

    def handle_path(handle):
        size = final_path(handle, None, 0, 0)
        if not size:
            raise ctypes.WinError(ctypes.get_last_error())
        buffer = ctypes.create_unicode_buffer(size + 1)
        length = final_path(handle, buffer, len(buffer), 0)
        if not length or length >= len(buffer):
            raise OSError("Cannot resolve opened file")
        return os.path.normcase(buffer.value)

    # Pin the root against rename/deletion. Deny writes/deletion of the source
    # while copying; validate the opened handle's destination before any reads.
    root_handle = open_handle(root, 0, share_read | share_write, directory_handle)
    file_handle = None
    try:
        expected = os.path.join(handle_path(root_handle), name)
        file_handle = open_handle(root / name, generic_read, share_read, 0)
        if handle_path(file_handle) != os.path.normcase(expected):
            raise ValueError("Stored file redirects outside its location")
        descriptor = msvcrt.open_osfhandle(file_handle, os.O_RDONLY | os.O_BINARY)
        file_handle = None  # The descriptor now owns the native handle.
        with _regular_file(descriptor) as source:
            yield source
    finally:
        if file_handle is not None:
            close(file_handle)
        close(root_handle)


@contextmanager
def _open_source(root, name):
    if os.name == "nt":
        with _windows_source(root, name) as source:
            yield source
        return
    # Use the pinned directory descriptor, not a path checked then reopened.
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root_fd)
        with _regular_file(descriptor) as source:
            yield source
    finally:
        os.close(root_fd)


def prepare_download(stored_path, storage_root, expected_size):
    """Return a validated temporary file and its length; never trust client sizes."""
    snapshot = None
    try:
        root = Path(os.path.abspath(storage_root))
        name = _storage_name(stored_path, root)
        with _open_source(root, name) as source:
            before = os.fstat(source.fileno())
            if expected_size is not None and (
                type(expected_size) is not int or expected_size < 0 or expected_size != before.st_size
            ):
                raise HTTPException(409, "Document integrity check failed")
            snapshot = tempfile.TemporaryFile(mode="w+b")
            length = 0
            while chunk := source.read(CHUNK_SIZE):
                length += len(chunk)
                if length > before.st_size:
                    raise HTTPException(409, "Document integrity check failed")
                snapshot.write(chunk)
            after = os.fstat(source.fileno())
            if (length != before.st_size or
                (before.st_size, before.st_mtime_ns, before.st_ctime_ns) !=
                    (after.st_size, after.st_mtime_ns, after.st_ctime_ns)):
                raise HTTPException(409, "Document integrity check failed")
        snapshot.seek(0)
        return snapshot, length
    except HTTPException:
        if snapshot is not None:
            snapshot.close()
        raise
    except (ValueError, RuntimeError):
        if snapshot is not None:
            snapshot.close()
        raise HTTPException(404, "Document file unavailable") from None
    except OSError as exc:
        if snapshot is not None:
            snapshot.close()
        if exc.errno in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP) or getattr(exc, "winerror", None) in (2, 3):
            raise HTTPException(404, "Document file unavailable") from None
        # Deliberately omit OS exception messages and paths from client responses.
        raise HTTPException(503, "Document file unavailable. Try again later.") from None


def download_headers(filename, length):
    name = str(filename or "document").replace("\\", "/").split("/")[-1]
    name = "".join(char for char in name if ord(char) >= 32 and ord(char) != 127)
    name = name.strip() or "document"
    return {
        "Content-Disposition": "attachment; filename*=UTF-8''" + quote(name, safe=""),
        "Content-Length": str(length),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Accept-Ranges": "bytes",
    }


def download_media_type(value):
    if isinstance(value, str) and re.fullmatch(r"[\w.+-]+/[\w.+-]+", value, re.ASCII):
        return value
    return "application/octet-stream"


def snapshot_chunks(snapshot, remaining=None):
    try:
        while remaining is None or remaining > 0:
            chunk = snapshot.read(CHUNK_SIZE if remaining is None else min(CHUNK_SIZE, remaining))
            if not chunk:
                break
            yield chunk
            if remaining is not None:
                remaining -= len(chunk)
    finally:
        snapshot.close()


def _single_range(value, length):
    # Ignore unsupported/multipart ranges. Bound parsing before integer conversion.
    if not value or len(value) > 128:
        return None
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", value.strip(), re.ASCII)
    if not match or not any(match.groups()):
        return None
    first, last = match.groups()
    if not first:
        start, stop = max(0, length - int(last)), length
    else:
        start = int(first)
        stop = min(length, int(last) + 1) if last else length
    return (start, stop) if start < stop else (0, 0)


class DownloadResponse(StreamingResponse):
    def __init__(self, snapshot, length, filename, content_type):
        self.snapshot = snapshot
        self.length = length
        super().__init__(snapshot_chunks(snapshot),
                         media_type=download_media_type(content_type),
                         headers=download_headers(filename, length))

    async def __call__(self, scope, receive, send):
        try:
            headers = Headers(raw=scope.get("headers", []))
            # There is no trusted validator to match an If-Range condition.
            selected = None if "if-range" in headers else _single_range(headers.get("range"), self.length)
            if selected is not None:
                start, stop = selected
                count = stop - start
                self.status_code = 206 if count else 416
                self.headers["content-range"] = (
                    f"bytes {start}-{stop - 1}/{self.length}" if count else f"bytes */{self.length}"
                )
                self.headers["content-length"] = str(count)
                self.snapshot.seek(start)
                self.body_iterator = iterate_in_threadpool(snapshot_chunks(self.snapshot, count))
            await super().__call__(scope, receive, send)
        finally:
            # Includes disconnects before the iterator starts or background tasks run.
            self.snapshot.close()
