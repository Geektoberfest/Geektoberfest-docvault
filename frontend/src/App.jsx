import { useState, useEffect, useRef } from "react";
import { formatFileSize } from "./formatFileSize.js";
import api, {
  getDocuments,
  getFolders,
  uploadDocument,
  deleteDocument,
  createFolder,
  renameFolder,
  deleteFolder,
  searchDocuments,
  login,
  register,
  getMe,
  getAuditLogs,
} from "./api";
import {
  createFilterPreset,
  deleteFilterPreset,
  loadFilterPresets,
  MAX_FILTER_PRESET_NAME_LENGTH,
  normalizeFilterPreset,
  saveFilterPresets,
} from "./filterPresets";
import {
  FiDownload,
  FiTrash2,
  FiFolder,
  FiFile,
  FiUpload,
  FiSearch,
  FiX,
  FiFolderPlus,
  FiEdit2,
  FiLogOut,
  FiUser,
  FiShield,
} from "react-icons/fi";

function folderErrorMessage(err, fallback) {
  const detail = err.response?.data?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail.map((error) => error.msg).join("; ") || fallback;
  }
  return fallback;
}

function readAuthToken() {
  try {
    return localStorage.getItem("token");
  } catch {
    return null;
  }
}

function App() {
  const [token, setToken] = useState(readAuthToken);
  const [user, setUser] = useState(null);

  // Auth States
  const [isLoginView, setIsLoginView] = useState(true);
  const [authUsername, setAuthUsername] = useState("");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");

  // App States
  const [selectedFileType, setSelectedFileType] = useState("all");
  const [sortBy, setSortBy] = useState("date_desc");
  const [documents, setDocuments] = useState([]);
  const [folders, setFolders] = useState([]);
  const [foldersLoaded, setFoldersLoaded] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef(null);
  const latestDocumentRequest = useRef(0);
  const accountGeneration = useRef(0);
  const [selectedFolder, setSelectedFolder] = useState(null);
  const [savedFilterPresets, setSavedFilterPresets] = useState([]);
  const [presetsLoaded, setPresetsLoaded] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [selectedPresetName, setSelectedPresetName] = useState("");
  const [presetMessage, setPresetMessage] = useState("");
  const [presetError, setPresetError] = useState("");
  const [presetStorageAvailable, setPresetStorageAvailable] = useState(true);
  const [newFolderName, setNewFolderName] = useState("");
  const [createFolderError, setCreateFolderError] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [editingFolderId, setEditingFolderId] = useState(null);
  const [renameFolderName, setRenameFolderName] = useState("");
  const [renameFolderError, setRenameFolderError] = useState("");
  const [renamingFolder, setRenamingFolder] = useState(false);
  const [uploadFile, setUploadFile] = useState(null);
  const [error, setError] = useState("");
  const [uploadSuccess, setUploadSuccess] = useState("");
  const [auditLogs, setAuditLogs] = useState([]);
  const [showAudit, setShowAudit] = useState(false);
  const [auditLoading, setAuditLoading] = useState(false);

  useEffect(() => {
    const generation = ++accountGeneration.current;
    latestDocumentRequest.current += 1;
    setUser(null);
    setDocuments([]);
    setFolders([]);
    setFoldersLoaded(false);
    setSelectedFolder(null);
    setSelectedFileType("all");
    setSortBy("date_desc");
    setSearchQuery("");
    setNewFolderName("");
    setCreateFolderError("");
    setCreatingFolder(false);
    setEditingFolderId(null);
    setRenameFolderName("");
    setRenameFolderError("");
    setRenamingFolder(false);
    setUploadFile(null);
    setAuditLogs([]);
    setShowAudit(false);
    setAuditLoading(false);
    setSavedFilterPresets([]);
    setPresetsLoaded(false);
    setPresetName("");
    setSelectedPresetName("");
    setPresetMessage("");
    setPresetError("");
    setPresetStorageAvailable(true);
    setError("");
    setUploadSuccess("");

    try {
      if (token) localStorage.setItem("token", token);
      else localStorage.removeItem("token");
    } catch {
      // Auth and preset storage are unavailable in some browser contexts.
    }
    if (token) fetchMe(generation);

    return () => {
      accountGeneration.current += 1;
      latestDocumentRequest.current += 1;
    };
  }, [token]);

  const fetchMe = async (generation) => {
    try {
      const res = await getMe();
      if (generation !== accountGeneration.current) return;
      setUser(res.data);
      fetchFolders(generation);
    } catch (err) {
      if (generation !== accountGeneration.current) return;
      console.error(err);
      setToken(null); // Invalid token
    }
  };

  // supporting both filter and sort query params
  const fetchDocuments = async (generation = accountGeneration.current) => {
    if (!token || !user?.id) return;
    const requestId = ++latestDocumentRequest.current;
    try {
      const params = new URLSearchParams();
      if (selectedFileType && selectedFileType !== "all") {
        params.append("file_type", selectedFileType);
      }
      if (sortBy && sortBy !== "date_desc") {
        params.append("sort_by", sortBy);
      }

      const queryString = params.toString() ? `?${params.toString()}` : "";
      const res = await (searchQuery
        ? searchDocuments(searchQuery)
        : api.get(`/documents/${queryString}`));
      if (
        generation === accountGeneration.current &&
        requestId === latestDocumentRequest.current
      ) {
        setDocuments(res.data);
      }
    } catch (err) {
      if (
        generation !== accountGeneration.current ||
        requestId !== latestDocumentRequest.current
      ) return;
      console.error(err);
      setError("Failed to fetch documents");
    }
  };

  const fetchFolders = async (generation = accountGeneration.current) => {
    if (!token) return;
    try {
      const res = await getFolders();
      if (generation !== accountGeneration.current) return;
      setFolders(res.data);
      setFoldersLoaded(true);
    } catch (err) {
      if (generation !== accountGeneration.current) return;
      console.error(err);
      setFoldersLoaded(true);
      setError("Failed to fetch folders");
    }
  };

  const fetchAuditLogs = async () => {
    const generation = accountGeneration.current;
    setAuditLoading(true);
    try {
      const res = await getAuditLogs();
      if (generation !== accountGeneration.current) return;
      setAuditLogs(res.data);
    } catch (err) {
      if (generation !== accountGeneration.current) return;
      console.error(err);
      setError("Failed to fetch audit logs");
    } finally {
      if (generation === accountGeneration.current) setAuditLoading(false);
    }
  };

  useEffect(() => {
    if (token && user?.id) fetchDocuments();
  }, [token, user?.id, searchQuery, selectedFileType, sortBy]);

  useEffect(() => {
    if (!user?.id) return;
    const stored = loadFilterPresets(user.id);
    setSavedFilterPresets(stored.presets);
    setPresetsLoaded(true);
    setPresetStorageAvailable(stored.storageAvailable);
    setPresetError(
      stored.error === "storage-unavailable"
        ? "Saved presets are unavailable in this browser."
        : stored.error === "invalid-data"
          ? "Some saved presets were invalid and have been ignored."
          : "",
    );
  }, [user?.id]);

  const handleAuth = async (e) => {
    e.preventDefault();
    setAuthError("");
    try {
      if (isLoginView) {
        const res = await login(authUsername, authPassword);
        setToken(res.data.access_token);
      } else {
        await register(authUsername, authEmail, authPassword);
        setIsLoginView(true);
        setAuthError("Registration successful. Please log in.");
      }
    } catch (err) {
      console.error(err);
      setAuthError(err.response?.data?.detail || "Authentication failed");
    }
  };

  const handleLogout = () => {
    accountGeneration.current += 1;
    latestDocumentRequest.current += 1;
    setToken(null);
  };

  const presetErrorMessage = (reason) => ({
    "blank-name": "Enter a name for this preset.",
    "name-too-long": `Preset names must be ${MAX_FILTER_PRESET_NAME_LENGTH} characters or fewer.`,
    "duplicate-name": "A preset with that name already exists.",
    "preset-limit": "You can save up to 20 presets.",
    "invalid-filter": "The current filters cannot be saved as a preset.",
    "storage-unavailable": "Saved presets are unavailable in this browser.",
    "identity-unavailable": "Sign in again before saving a preset.",
  }[reason] || "The preset could not be saved.");

  const handleSavePreset = (event) => {
    event.preventDefault();
    setPresetError("");
    setPresetMessage("");
    if (!user?.id) {
      setPresetError(presetErrorMessage("identity-unavailable"));
      return;
    }
    if (selectedFolder !== null) {
      if (!foldersLoaded) {
        setPresetError("Wait for your folders to load before saving this preset.");
        return;
      }
      if (!folders.some((folder) => folder.id === selectedFolder)) {
        setPresetError("The selected folder is no longer available. Choose another folder.");
        return;
      }
    }

    const created = createFilterPreset(savedFilterPresets, presetName, {
      folderId: selectedFolder,
      fileType: selectedFileType,
      sortBy,
    });
    if (created.error) {
      setPresetError(presetErrorMessage(created.error));
      return;
    }

    const saved = saveFilterPresets(user.id, created.presets);
    if (!saved.ok) {
      setPresetStorageAvailable(false);
      setPresetError(presetErrorMessage(saved.error));
      return;
    }
    setPresetStorageAvailable(true);
    setSavedFilterPresets(saved.presets);
    setSelectedPresetName(created.preset.name);
    setPresetName("");
    setPresetMessage(`Saved preset “${created.preset.name}”.`);
  };

  const handleApplyPreset = () => {
    setPresetError("");
    setPresetMessage("");
    const preset = normalizeFilterPreset(
      savedFilterPresets.find((item) => item.name === selectedPresetName),
    );
    if (!preset) {
      setPresetError("Choose a valid saved preset first.");
      return;
    }
    if (preset.folderId !== null) {
      if (!foldersLoaded) {
        setPresetError("Wait for your folders to load before applying this preset.");
        return;
      }
      if (!folders.some((folder) => folder.id === preset.folderId)) {
        setPresetError("This preset's folder is no longer available to your account. Delete it or choose another preset.");
        return;
      }
    }

    const clearedSearch = Boolean(searchQuery);
    setSelectedFolder(preset.folderId);
    setSelectedFileType(preset.fileType);
    setSortBy(preset.sortBy);
    if (clearedSearch) setSearchQuery("");
    setPresetMessage(
      clearedSearch
        ? `Applied “${preset.name}”. Search was cleared so the saved filters are active.`
        : `Applied preset “${preset.name}”.`,
    );
  };

  const handleDeletePreset = () => {
    setPresetError("");
    setPresetMessage("");
    if (!user?.id || !selectedPresetName) return;
    const remaining = deleteFilterPreset(savedFilterPresets, selectedPresetName);
    const saved = saveFilterPresets(user.id, remaining);
    if (!saved.ok) {
      setPresetStorageAvailable(false);
      setPresetError(presetErrorMessage(saved.error));
      return;
    }
    setPresetStorageAvailable(true);
    setSavedFilterPresets(saved.presets);
    setSelectedPresetName("");
    setPresetMessage("Deleted the saved preset.");
  };

  const handleUpload = async (e) => {
    const generation = accountGeneration.current;
  e.preventDefault();
  setError("");
  setUploadSuccess("");

  if (!uploadFile) {
    setError("Please choose a file to upload first.");
    return;
  }

  const maxBytes = 10 * 1024 * 1024;
  if (uploadFile.size > maxBytes) {
    setError("File is too large. Maximum allowed size is 10MB.");
    return;
  }

  const formData = new FormData();
  formData.append("file", uploadFile);
  if (selectedFolder) {
    formData.append("folder_id", selectedFolder);
  }

  try {
    await uploadDocument(formData);
    if (generation !== accountGeneration.current) return;
    setUploadFile(null);
    e.target.reset(); // clear input
    setUploadSuccess("Document uploaded successfully!");
    setTimeout(() => setUploadSuccess(""), 4000);
    fetchDocuments();
  } catch (err) {
    if (generation !== accountGeneration.current) return;
    console.error(err);
    const message = err.response?.data?.detail || "Upload failed. Please check the file format and try again.";
    setError(message);
  }
};

  const handleDeleteDoc = async (id) => {
    if (!window.confirm("Are you sure you want to delete this document?")) {
      return;
    }
    const generation = accountGeneration.current;
    try {
      await deleteDocument(id);
      if (generation !== accountGeneration.current) return;
      fetchDocuments();
    } catch (err) {
      if (generation !== accountGeneration.current) return;
      console.error(err);
      setError("Failed to delete document");
    }
  };

  const handleCreateFolder = async (e) => {
    e.preventDefault();
    const generation = accountGeneration.current;
    setCreateFolderError("");
    if (!newFolderName.trim()) {
      setCreateFolderError("Folder name cannot be empty or whitespace-only");
      return;
    }
    setCreatingFolder(true);
    try {
      await createFolder(newFolderName.trim());
      if (generation !== accountGeneration.current) return;
      setNewFolderName("");
      fetchFolders();
    } catch (err) {
      if (generation !== accountGeneration.current) return;
      console.error(err);
      setCreateFolderError(folderErrorMessage(err, "Failed to create folder"));
    } finally {
      if (generation === accountGeneration.current) setCreatingFolder(false);
    }
  };

  const handleRenameFolder = async (e) => {
    e.preventDefault();
    const generation = accountGeneration.current;
    setRenameFolderError("");
    if (!renameFolderName.trim()) {
      setRenameFolderError("Folder name cannot be empty or whitespace-only");
      return;
    }
    setRenamingFolder(true);
    try {
      const res = await renameFolder(editingFolderId, renameFolderName.trim());
      if (generation !== accountGeneration.current) return;
      setFolders((current) =>
        current.map((folder) => folder.id === res.data.id ? res.data : folder)
      );
      setEditingFolderId(null);
    } catch (err) {
      if (generation !== accountGeneration.current) return;
      setRenameFolderError(folderErrorMessage(err, "Failed to rename folder"));
    } finally {
      if (generation === accountGeneration.current) setRenamingFolder(false);
    }
  };

  const handleDeleteFolder = async (id) => {
    const generation = accountGeneration.current;
    try {
      await deleteFolder(id);
      if (generation !== accountGeneration.current) return;
      if (selectedFolder === id) setSelectedFolder(null);
      fetchFolders();
      fetchDocuments();
    } catch (err) {
      if (generation !== accountGeneration.current) return;
      console.error(err);
      setError("Failed to delete folder");
    }
  };

  const filteredDocuments = selectedFolder
    ? documents.filter((doc) => doc.folder_id === selectedFolder)
    : documents;

  if (!token) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-md w-full bg-white p-8 rounded-xl shadow-md border">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-indigo-600 flex items-center justify-center gap-2">
              <FiFolder /> DocVault
            </h1>
            <h2 className="mt-4 text-xl font-semibold text-gray-900">
              {isLoginView ? "Sign in to your account" : "Create a new account"}
            </h2>
          </div>
          <form className="space-y-4" onSubmit={handleAuth}>
            {authError && (
              <div
                className={`p-3 rounded text-sm ${authError.includes("successful") ? "bg-green-50 text-green-700 border-green-500" : "bg-red-50 text-red-700 border-red-500"} border-l-4`}
              >
                {authError}
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Username
              </label>
              <input
                type="text"
                required
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                value={authUsername}
                onChange={(e) => setAuthUsername(e.target.value)}
              />
            </div>
            {!isLoginView && (
              <div>
                <label className="block text-sm font-medium text-gray-700">
                  Email
                </label>
                <input
                  type="email"
                  required
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                />
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Password
              </label>
              <input
                type="password"
                required
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
              />
            </div>
            <button
              type="submit"
              className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
            >
              {isLoginView ? "Sign in" : "Register"}
            </button>
          </form>
          <div className="mt-6 text-center text-sm">
            <button
              onClick={() => {
                setIsLoginView(!isLoginView);
                setAuthError("");
              }}
              className="text-indigo-600 hover:text-indigo-500"
            >
              {isLoginView
                ? "Need an account? Register"
                : "Already have an account? Sign in"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans">
      <header className="bg-white shadow-sm border-b px-8 py-4 flex justify-between items-center">
        <h1 className="text-2xl font-bold text-indigo-600 flex items-center gap-2">
          <FiFolder className="text-indigo-500" /> DocVault
        </h1>
        <div className="relative w-1/3">
          <FiSearch aria-hidden="true" className="absolute left-3 top-3 text-gray-400" />
          <input
            ref={searchInputRef}
            type="text"
            aria-label="Search documents"
            placeholder="Search documents..."
            className="w-full pl-10 pr-10 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button
              type="button"
              aria-label="Clear document search"
              onClick={() => {
                latestDocumentRequest.current++;
                setSearchQuery("");
                searchInputRef.current?.focus();
              }}
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <FiX aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-4">
          {user && (
            <span className="text-sm font-medium text-gray-600 flex items-center gap-1">
              <FiUser /> {user.username}
            </span>
          )}
          <button
            onClick={() => {
              setShowAudit(true);
              fetchAuditLogs();
            }}
            className="text-gray-500 hover:text-indigo-600 flex items-center gap-1 text-sm font-medium"
          >
            <FiShield /> Audit Log
          </button>
          <button
            onClick={handleLogout}
            className="text-gray-500 hover:text-gray-700 flex items-center gap-1 text-sm font-medium"
          >
            <FiLogOut /> Logout
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-8 py-8 flex gap-8">
        {/* Sidebar */}
        <aside className="w-64 flex-shrink-0">
          <div className="bg-white p-4 rounded-xl shadow-sm border mb-6">
            <h2 className="font-semibold text-gray-700 mb-4 flex items-center gap-2">
              <FiFolder /> Folders
            </h2>
            <ul className="space-y-2">
              <li>
                <button
                  onClick={() => setSelectedFolder(null)}
                  className={`w-full text-left px-3 py-2 rounded-lg transition-colors ${selectedFolder === null ? "bg-indigo-50 text-indigo-700 font-medium" : "hover:bg-gray-100"}`}
                >
                  All Documents
                </button>
              </li>
              {folders.map((folder) => (
                <li key={folder.id}>
                  {editingFolderId === folder.id ? (
                    <form onSubmit={handleRenameFolder} className="space-y-2">
                      <input
                        aria-label="Rename folder"
                        aria-invalid={Boolean(renameFolderError)}
                        aria-describedby={
                          renameFolderError ? "rename-folder-error" : undefined
                        }
                        autoFocus
                        className="w-full border rounded px-2 py-1 text-sm"
                        value={renameFolderName}
                        disabled={renamingFolder}
                        onChange={(e) => {
                          setRenameFolderName(e.target.value);
                          setRenameFolderError("");
                        }}
                      />
                      {renameFolderError && (
                        <p id="rename-folder-error" role="alert" className="text-sm text-red-700">
                          {renameFolderError}
                        </p>
                      )}
                      <div className="flex gap-2 text-sm">
                        <button
                          type="submit"
                          disabled={renamingFolder}
                          className="bg-indigo-600 text-white rounded px-2 py-1 disabled:opacity-50"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          disabled={renamingFolder}
                          onClick={() => setEditingFolderId(null)}
                          className="rounded px-2 py-1"
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div className="flex items-center group">
                      <button
                        onClick={() => setSelectedFolder(folder.id)}
                        className={`flex-1 min-w-0 text-left px-3 py-2 rounded-lg transition-colors truncate ${selectedFolder === folder.id ? "bg-indigo-50 text-indigo-700 font-medium" : "hover:bg-gray-100"}`}
                      >
                        {folder.name}
                      </button>
                      <button
                        type="button"
                        disabled={renamingFolder}
                        onClick={() => {
                          setEditingFolderId(folder.id);
                          setRenameFolderName(folder.name);
                          setRenameFolderError("");
                        }}
                        className="text-gray-400 hover:text-indigo-600 p-2"
                        aria-label={`Rename ${folder.name}`}
                        title="Rename folder"
                      >
                        <FiEdit2 />
                      </button>
                      <button
                        onClick={() => handleDeleteFolder(folder.id)}
                        className="text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 p-2"
                        title="Delete folder"
                      >
                        <FiTrash2 />
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>

            <form onSubmit={handleCreateFolder} className="mt-4 flex gap-2">
              <input
                type="text"
                placeholder="New folder..."
                aria-label="New folder name"
                aria-invalid={Boolean(createFolderError)}
                aria-describedby={createFolderError ? "create-folder-error" : undefined}
                disabled={creatingFolder}
                className="flex-1 border w-full rounded px-2 py-1 text-sm focus:outline-none focus:border-indigo-500"
                value={newFolderName}
                onChange={(e) => {
                  setNewFolderName(e.target.value);
                  setCreateFolderError("");
                }}
              />
              <button
                type="submit"
                aria-label="Create folder"
                disabled={creatingFolder}
                className="bg-gray-100 hover:bg-gray-200 text-gray-700 p-1.5 rounded"
              >
                <FiFolderPlus />
              </button>
            </form>
            {createFolderError && (
              <p id="create-folder-error" role="alert" className="mt-2 text-sm text-red-700">
                {createFolderError}
              </p>
            )}
          </div>
        </aside>

        {/* Main Content */}
        <div className="flex-1 overflow-hidden">
          {error && (
            <div className="bg-red-50 border-l-4 border-red-500 text-red-700 p-4 mb-6 rounded shadow-sm flex justify-between">
              <p>{error}</p>
              <button onClick={() => setError("")} className="font-bold">
                &times;
              </button>
            </div>
          )}

          {uploadSuccess && (
            <div className="bg-green-50 border-l-4 border-green-500 text-green-700 p-4 mb-6 rounded shadow-sm flex justify-between">
              <p>{uploadSuccess}</p>
              <button onClick={() => setUploadSuccess("")} className="font-bold">
                &times;
              </button>
            </div>
          )}

          <div className="bg-white p-6 rounded-xl shadow-sm border mb-6 flex justify-between items-center">
            <div>
              <h2 className="text-xl font-bold">Upload Document</h2>
              <p className="text-sm text-gray-500">Max size: 10MB</p>
            </div>
            <form onSubmit={handleUpload} className="flex items-center gap-4">
              <input
                type="file"
                className="text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100"
                onChange={(e) => setUploadFile(e.target.files[0])}
              />
              <button
                type="submit"
                disabled={!uploadFile}
                className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-medium flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <FiUpload /> Upload
              </button>
            </form>
          </div>

          <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
            {/* Filter and Sort Controls */}
            <div className="p-4 border-b bg-gray-50 flex flex-wrap items-center justify-between gap-3">
              <span className="text-sm font-semibold text-gray-700">Documents</span>
              <div className="flex items-center gap-4">
                {/* File Type Filter */}
                <div className="flex items-center gap-2">
                  <label htmlFor="fileTypeFilter" className="text-xs font-medium text-gray-600">
                    Type:
                  </label>
                  <select
                    id="fileTypeFilter"
                    value={selectedFileType}
                    onChange={(e) => setSelectedFileType(e.target.value)}
                    className="px-2.5 py-1 text-xs border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="all">All Types</option>
                    <option value="pdf">PDF</option>
                    <option value="image">Images</option>
                    <option value="text">Text / Docs</option>
                  </select>
                </div>

                {/* Sort By Control */}
                <div className="flex items-center gap-2">
                  <label htmlFor="sortByFilter" className="text-xs font-medium text-gray-600">
                    Sort:
                  </label>
                  <select
                    id="sortByFilter"
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value)}
                    className="px-2.5 py-1 text-xs border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="date_desc">Newest First</option>
                    <option value="date_asc">Oldest First</option>
                    <option value="name_asc">Name (A-Z)</option>
                    <option value="name_desc">Name (Z-A)</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="px-4 py-3 border-b flex flex-wrap items-end gap-4">
              <form onSubmit={handleSavePreset} className="flex flex-wrap items-end gap-2">
                <div>
                  <label htmlFor="filterPresetName" className="block text-xs font-medium text-gray-600 mb-1">
                    Save current filters
                  </label>
                  <input
                    id="filterPresetName"
                    value={presetName}
                    maxLength={MAX_FILTER_PRESET_NAME_LENGTH}
                    disabled={!presetStorageAvailable || !user?.id}
                    aria-describedby={presetError ? "filter-preset-error" : undefined}
                    className="border border-gray-300 rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-100"
                    placeholder="Preset name"
                    onChange={(event) => {
                      setPresetName(event.target.value);
                      setPresetError("");
                    }}
                  />
                </div>
                <button
                  type="submit"
                  disabled={!presetStorageAvailable || !user?.id}
                  className="px-3 py-1.5 text-sm font-medium text-white bg-indigo-600 rounded-md hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Save preset
                </button>
              </form>

              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <label htmlFor="savedFilterPreset" className="block text-xs font-medium text-gray-600 mb-1">
                    Saved presets
                  </label>
                  <select
                    id="savedFilterPreset"
                    value={selectedPresetName}
                    disabled={!presetsLoaded || savedFilterPresets.length === 0}
                    className="border border-gray-300 rounded-md px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-100"
                    onChange={(event) => {
                      setSelectedPresetName(event.target.value);
                      setPresetError("");
                      setPresetMessage("");
                    }}
                  >
                    <option value="">Choose a preset</option>
                    {savedFilterPresets.map((preset) => (
                      <option key={preset.name} value={preset.name}>{preset.name}</option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  onClick={handleApplyPreset}
                  disabled={!selectedPresetName}
                  className="px-3 py-1.5 text-sm font-medium text-indigo-700 border border-indigo-200 rounded-md hover:bg-indigo-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Apply preset
                </button>
                <button
                  type="button"
                  onClick={handleDeletePreset}
                  disabled={!selectedPresetName || !presetStorageAvailable}
                  className="px-3 py-1.5 text-sm font-medium text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Delete preset
                </button>
              </div>

              {presetsLoaded && savedFilterPresets.length === 0 && presetStorageAvailable && (
                <p className="w-full text-sm text-gray-500">No saved presets yet. Save your current folder, type, and sort filters to reuse them.</p>
              )}
              {presetStorageAvailable === false && (
                <p id="filter-preset-error" role="alert" className="w-full text-sm text-red-700">
                  {presetError || "Saved presets are unavailable in this browser."}
                </p>
              )}
              {presetStorageAvailable && presetError && (
                <p id="filter-preset-error" role="alert" className="w-full text-sm text-red-700">
                  {presetError}
                </p>
              )}
              {presetMessage && (
                <p role="status" aria-live="polite" className="w-full text-sm text-green-700">
                  {presetMessage}
                </p>
              )}
            </div>

            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-gray-50 border-b text-gray-600 text-sm">
                  <th className="p-4 font-semibold">Filename</th>
                  <th className="p-4 font-semibold">Size</th>
                  <th className="p-4 font-semibold">Date</th>
                  <th className="p-4 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredDocuments.length === 0 ? (
                  <tr>
                    <td colSpan="4" className="py-12 px-4 text-center">
                      <div className="flex flex-col items-center justify-center text-gray-500">
                        <FiFile className="w-12 h-12 text-gray-300 mb-3" />
                        <h3 className="text-base font-semibold text-gray-700">No documents yet</h3>
                        <p className="text-sm text-gray-500 mt-1 max-w-sm">
                          {searchQuery
                            ? `No documents match "${searchQuery}". Try a different keyword.`
                            : selectedFolder
                            ? "This folder is currently empty. Upload a file above to add it here."
                            : "Your vault is empty. Select a file using the form above to get started!"}
                        </p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  filteredDocuments.map((doc) => (
                    <tr
                      key={doc.id}
                      className="border-b last:border-0 hover:bg-gray-50 transition-colors"
                    >
                      <td className="p-4 flex items-center gap-3 overflow-hidden">
                        <FiFile className="text-gray-400 text-xl flex-shrink-0" />
                        <span
                          className="font-medium text-gray-800 truncate"
                          title={doc.original_filename}
                        >
                          {doc.original_filename}
                        </span>
                      </td>
                      <td className="p-4 text-sm text-gray-500 whitespace-nowrap">
                        {formatFileSize(doc.file_size)}
                      </td>
                      <td className="p-4 text-sm text-gray-500 whitespace-nowrap">
                        {new Date(doc.created_at).toLocaleDateString()}
                      </td>
                      <td className="p-4 text-right whitespace-nowrap">
                        <div className="flex justify-end gap-2">
                          <a
                            href={`${api.defaults.baseURL}/documents/${doc.id}/download?token=${token}`}
                            target="_blank"
                            rel="noreferrer"
                            className="p-2 text-indigo-600 hover:bg-indigo-50 rounded transition-colors"
                            title="Download"
                          >
                            <FiDownload />
                          </a>
                          <button
                            onClick={() => handleDeleteDoc(doc.id)}
                            className="p-2 text-red-600 hover:bg-red-50 rounded transition-colors"
                            title="Delete"
                          >
                            <FiTrash2 />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>

      {/* ── Audit Log slide-over panel ── */}
      {showAudit && (
        <div
          className="fixed inset-0 z-50 flex justify-end"
          aria-modal="true"
          role="dialog"
          aria-label="Audit Log"
        >
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/30"
            onClick={() => setShowAudit(false)}
          />

          {/* Panel */}
          <div className="relative z-10 w-full max-w-lg bg-white shadow-xl flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b">
              <h2 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
                <FiShield className="text-indigo-500" /> Audit Log
              </h2>
              <button
                onClick={() => setShowAudit(false)}
                className="text-gray-400 hover:text-gray-600 text-xl font-bold leading-none"
                aria-label="Close audit log"
              >
                &times;
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-6">
              {auditLoading ? (
                <p className="text-center text-gray-400 py-8">Loading…</p>
              ) : auditLogs.length === 0 ? (
                <p className="text-center text-gray-400 py-8">No audit events yet.</p>
              ) : (
                <ul className="space-y-3">
                  {auditLogs.map((entry) => (
                    <li
                      key={entry.id}
                      className="flex items-start gap-3 p-3 rounded-lg border bg-gray-50"
                    >
                      {/* Action badge */}
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold uppercase tracking-wide shrink-0 ${
                          entry.action === "upload"
                            ? "bg-green-100 text-green-700"
                            : entry.action === "download"
                            ? "bg-blue-100 text-blue-700"
                            : entry.action === "delete"
                            ? "bg-red-100 text-red-700"
                            : "bg-gray-100 text-gray-600"
                        }`}
                      >
                        {entry.action}
                      </span>

                      {/* Details */}
                      <div className="flex-1 min-w-0">
                        <p
                          className="text-sm font-medium text-gray-800 truncate"
                          title={entry.target_name}
                        >
                          {entry.target_name ?? `${entry.target_type} #${entry.target_id}`}
                        </p>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {new Date(entry.created_at).toLocaleString()}
                          {entry.ip_address && (
                            <span className="ml-2 text-gray-300">· {entry.ip_address}</span>
                          )}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Refresh footer */}
            <div className="px-6 py-3 border-t flex justify-end">
              <button
                onClick={fetchAuditLogs}
                disabled={auditLoading}
                className="text-sm text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
              >
                Refresh
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
