// Wires up button clicks — kept separate so both files can be hash-pinned in CSP if needed.
// dashboard.js (loaded first via defer) exports all functions into the module scope.
// This file runs after dashboard.js because both have defer and appear in document order.

document.getElementById('btn-login').addEventListener('click', login);
document.getElementById('btn-create-folder').addEventListener('click', createFolderAction);
document.getElementById('btn-create-key').addEventListener('click', createKey);
document.getElementById('btn-copy-key').addEventListener('click', copyKey);
document.getElementById('btn-close-modal').addEventListener('click', closeModal);
document.getElementById('btn-refresh-files').addEventListener('click', loadFiles);
