"""Validated application settings."""

import os
import re


DEFAULT_DOCUMENT_STORAGE_QUOTA_BYTES = 100 * 1024 * 1024
MAX_DOCUMENT_STORAGE_QUOTA_BYTES = 2**63 - 1


def parse_document_storage_quota(value: str | None) -> int:
    if value is None:
        return DEFAULT_DOCUMENT_STORAGE_QUOTA_BYTES
    if not re.fullmatch(r"[0-9]+", value):
        raise ValueError("DOCUMENT_STORAGE_QUOTA_BYTES must be a positive integer number of bytes")
    if len(value) > 19:
        raise ValueError(
            "DOCUMENT_STORAGE_QUOTA_BYTES must be between 1 and 9223372036854775807 bytes"
        )
    quota = int(value)
    if not 0 < quota <= MAX_DOCUMENT_STORAGE_QUOTA_BYTES:
        raise ValueError(
            "DOCUMENT_STORAGE_QUOTA_BYTES must be between 1 and 9223372036854775807 bytes"
        )
    return quota


# Read once when the application imports its settings, so invalid configuration
# prevents the service from starting instead of silently changing the limit.
DOCUMENT_STORAGE_QUOTA_BYTES = parse_document_storage_quota(
    os.getenv("DOCUMENT_STORAGE_QUOTA_BYTES")
)
