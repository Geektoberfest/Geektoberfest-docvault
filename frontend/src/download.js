export function downloadErrorMessage(error) {
  switch (error.response?.status) {
    case 401: return "Please sign in again to download this document.";
    case 403:
    case 404: return "This document is unavailable or you no longer have access. Refresh the document list.";
    case 409: return "This document failed an integrity check. Please upload a valid copy or contact support.";
    case 500:
    case 503: return "The document is temporarily unavailable. Please try again later.";
    default: return "The download could not be completed. Check your connection and try again.";
  }
}

export function saveDownload(response, filename) {
  if (!(response.data instanceof Blob)) {
    throw Object.assign(new Error("Invalid download response"), { response: { status: 409 } });
  }
  const name = String(filename || "document").replace(/\\/g, "/").split("/").pop()
    .replace(/[\p{Cc}:*?"<>|]/gu, "_").trim() || "document";
  const link = document.createElement("a");
  const url = URL.createObjectURL(response.data);
  try {
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    // Let the browser consume the click before releasing its object URL.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
