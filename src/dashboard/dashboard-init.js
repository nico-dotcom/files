// Wires up button clicks — kept separate so both files can be hash-pinned in CSP if needed.
// dashboard.js (loaded first via defer) exports all functions into the module scope.
// This file runs after dashboard.js because both have defer and appear in document order.

document.getElementById('master-input').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });

document.getElementById('btn-login').addEventListener('click', login);
document.getElementById('btn-create-folder').addEventListener('click', createFolderAction);
document.getElementById('btn-create-key').addEventListener('click', createKey);
document.getElementById('btn-copy-key').addEventListener('click', copyKey);
document.getElementById('btn-close-modal').addEventListener('click', closeModal);
document.getElementById('btn-cancel-edit').addEventListener('click', closeEditModal);
document.getElementById('btn-save-edit').addEventListener('click', saveEdit);

// Scope radios — create form (wired here so they work before first login)
document.querySelectorAll('input[name="scope"]').forEach(radio => {
  radio.addEventListener('change', function () {
    document.getElementById('folder-select-wrapper').style.display =
      this.value === 'specific' ? 'block' : 'none';
  });
});

// Scope radios — edit modal
document.querySelectorAll('input[name="edit-scope"]').forEach(radio => {
  radio.addEventListener('change', function () {
    document.getElementById('edit-folder-wrapper').style.display =
      this.value === 'specific' ? 'block' : 'none';
  });
});
