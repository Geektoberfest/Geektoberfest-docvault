import { useEffect, useState } from "react";
import { API_URL, getDocumentVersions, uploadDocumentVersion } from "./api";

export default function DocumentHistory({ document, token, onUpdated, onClose }) {
  const [history, setHistory] = useState(null);
  const [historyError, setHistoryError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [success, setSuccess] = useState("");
  const requestKey = `${document.id}:${document.current_version}:${attempt}`;
  const loading = history?.key !== requestKey;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    getDocumentVersions(document.id, controller.signal).then(({ data }) => {
      if (!active) return;
      setHistory({ key: requestKey, versions: data });
      setHistoryError("");
    }).catch(() => {
      if (!active) return;
      setHistory({ key: requestKey, versions: [] });
      setHistoryError("Could not load version history. Please try again.");
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [document.id, requestKey]);

  const handleReplace = async (event) => {
    event.preventDefault();
    if (!file || uploading) return;
    setUploadError("");
    setSuccess("");
    if (file.size > 10 * 1024 * 1024) {
      setUploadError("File too large. Max size is 10MB.");
      return;
    }
    const formData = new FormData();
    formData.append("file", file);
    setUploading(true);
    try {
      const { data } = await uploadDocumentVersion(document.id, formData);
      setFile(null);
      onUpdated(data);
      setSuccess(`Version ${data.current_version} uploaded successfully.`);
    } catch (err) {
      const detail = err.response?.data?.detail;
      setUploadError(typeof detail === "string" ? detail : "Upload failed. Refresh history to check the current version before retrying.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <section aria-labelledby="version-history-title" className="bg-white border rounded-xl shadow-sm p-6 mb-6">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="min-w-0">
          <h2 id="version-history-title" className="text-xl font-bold">Version history</h2>
          <p className="text-sm text-gray-600 break-all">{document.original_filename}</p>
        </div>
        <button onClick={onClose} disabled={uploading} className="text-gray-600 disabled:opacity-50">Close history</button>
      </div>
      <form onSubmit={handleReplace} className="space-y-3 mb-5">
        <label className="block text-sm font-medium" htmlFor="new-document-version">Upload new version (max 10MB)</label>
        <input
          key={document.current_version}
          id="new-document-version"
          type="file"
          disabled={uploading}
          onChange={(event) => {
            setFile(event.target.files[0] || null);
            setUploadError("");
            setSuccess("");
          }}
          className="block max-w-full text-sm"
        />
        <p className="text-sm text-gray-500">Previous versions stay available. This updates the selected document, even if the new filename differs.</p>
        <button type="submit" disabled={!file || uploading} className="rounded bg-indigo-600 text-white px-3 py-2 text-sm disabled:opacity-50">
          {uploading ? "Uploading version..." : "Upload new version"}
        </button>
        {uploadError && <p role="alert" className="text-sm text-red-700">{uploadError}</p>}
        {success && <p role="status" className="text-sm text-green-700">{success}</p>}
      </form>
      <button disabled={uploading} onClick={() => setAttempt((value) => value + 1)} className="text-sm text-indigo-600 underline mb-3">Refresh history</button>
      {loading ? <p role="status">Loading versions...</p> : historyError ? (
        <p role="alert" className="text-red-700">{historyError}</p>
      ) : (
        <ul className="divide-y" aria-label="Document versions">
          {history.versions.map((version, index) => (
            <li key={version.version_number} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <span className="font-medium">Version {version.version_number}{index === 0 ? " (current)" : ""}</span>
                <p className="text-sm break-all">{version.original_filename}</p>
                <p className="text-sm text-gray-500">{new Date(version.created_at.endsWith("Z") ? version.created_at : `${version.created_at}Z`).toLocaleString()} · {(version.file_size / 1024 / 1024).toFixed(2)} MB</p>
              </div>
              <a
                href={`${API_URL}/documents/${document.id}/versions/${version.version_number}/download?token=${encodeURIComponent(token)}`}
                target="_blank"
                rel="noreferrer"
                className="text-indigo-600 text-sm"
              >
                Download version {version.version_number}
              </a>
            </li>
          ))}
          {history.versions.length === 0 && <li>No versions available.</li>}
        </ul>
      )}
    </section>
  );
}
