'use strict';

const API = {
  health: '/api/health',
  meeting: '/api/meeting',
  projects: '/api/projects',
  project: (projectId) => `/api/projects/${encodeURIComponent(projectId)}`,
  projectSteps: (projectId) => `/api/projects/${encodeURIComponent(projectId)}/steps`,
  step: (stepId) => `/api/steps/${encodeURIComponent(stepId)}`,
  notes: '/api/notes',
  note: (noteId) => `/api/notes/${encodeURIComponent(noteId)}`,
  members: '/api/members',
  member: (memberId) => `/api/members/${encodeURIComponent(memberId)}`,
  backups: '/api/backups',
  exportExcel: '/api/export/excel',
  lock: '/api/lock'
};

const PROJECT_STATUS = ['Active', 'Inactive', 'Completed'];
const STEP_STATUS = ['Not Started', 'In Work', 'C/W'];

let projects = [];
let notes = [];
let members = [];
let meeting = { meetingAt: '', location: '' };
let currentProjectId = null;
let dashboardFilter = 'All';

const elements = {};

document.addEventListener('DOMContentLoaded', initApp);

async function initApp() {
  cacheElements();
  wireEvents();
  setDefaultDateInputs();
  await loadHealth();
  await loadMeeting();
  await refreshProjects();
  showGlobalDashboard();
}

function cacheElements() {
  const ids = [
    'navTitle', 'homeBtn', 'notesTopBtn', 'membersTopBtn', 'newProjectBtn', 'exportExcelBtn',
    'projectDropdown', 'globalDashboard', 'mainContent', 'notesPage', 'membersPage',
    'projectCardsContainer', 'deleteProjectBtn', 'pinProjectBtn', 'projPinStatus', 'backupBtn', 'refreshBtn', 'refreshProjectBtn',
    'lockStatus', 'alertContainer', 'serverStatus', 'projNameTitle', 'projName', 'projStatus',
    'projAssignee', 'projStartDate', 'projTotalTime', 'projEtic', 'projNotes', 'searchInput', 'addStepBtn',
    'tableBody', 'progressBar', 'progressText', 'meetingDisplay', 'meetingLocationDisplay',
    'editMeetingBtn', 'meetingEditor', 'meetingAtInput', 'meetingLocationInput', 'saveMeetingBtn',
    'cancelMeetingBtn', 'refreshNotesBtn', 'newNoteForm', 'noteDateInput', 'noteTitleInput',
    'noteAuthorInput', 'noteBodyInput', 'clearNoteFormBtn', 'notesList', 'refreshMembersBtn',
    'newMemberForm', 'memberNameInput', 'memberPositionInput', 'memberEmailInput',
    'memberPhoneInput', 'memberNotesInput', 'clearMemberFormBtn', 'membersTableBody'
  ];

  ids.forEach((id) => {
    elements[id] = document.getElementById(id);
  });
}

function wireEvents() {
  elements.navTitle.addEventListener('click', showGlobalDashboard);
  elements.navTitle.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      showGlobalDashboard();
    }
  });

  elements.homeBtn.addEventListener('click', showGlobalDashboard);
  elements.notesTopBtn.addEventListener('click', showNotesPage);
  elements.membersTopBtn.addEventListener('click', showMembersPage);
  elements.newProjectBtn.addEventListener('click', createNewProject);
  elements.exportExcelBtn.addEventListener('click', exportExcel);
  elements.projectDropdown.addEventListener('change', loadSelectedNavigation);
  elements.deleteProjectBtn.addEventListener('click', deleteCurrentProject);
  elements.pinProjectBtn.addEventListener('click', toggleCurrentProjectPinned);
  elements.backupBtn.addEventListener('click', createBackup);
  elements.refreshBtn.addEventListener('click', async () => {
    await refreshProjects();
    showAlert('Refreshed from the shared database.', 'success');
  });
  elements.refreshProjectBtn.addEventListener('click', refreshCurrentProjectFromDatabase);
  elements.addStepBtn.addEventListener('click', addStep);
  elements.searchInput.addEventListener('input', filterTable);

  elements.editMeetingBtn.addEventListener('click', showMeetingEditor);
  elements.cancelMeetingBtn.addEventListener('click', hideMeetingEditor);
  elements.saveMeetingBtn.addEventListener('click', saveMeeting);

  elements.refreshNotesBtn.addEventListener('click', async () => {
    await refreshNotes();
    showAlert('Notes refreshed from the shared database.', 'success');
  });
  elements.newNoteForm.addEventListener('submit', createNote);
  elements.clearNoteFormBtn.addEventListener('click', clearNoteForm);
  elements.notesList.addEventListener('click', handleNoteListClick);

  elements.refreshMembersBtn.addEventListener('click', async () => {
    await refreshMembers();
    showAlert('Members refreshed from the shared database.', 'success');
  });
  elements.newMemberForm.addEventListener('submit', createMember);
  elements.clearMemberFormBtn.addEventListener('click', clearMemberForm);
  elements.membersTableBody.addEventListener('click', handleMemberTableClick);

  document.querySelectorAll('.filter-btn').forEach((button) => {
    button.addEventListener('click', () => setDashboardFilter(button.dataset.filter));
  });

  [
    elements.projName,
    elements.projStatus,
    elements.projAssignee,
    elements.projStartDate,
    elements.projTotalTime,
    elements.projEtic,
    elements.projNotes
  ].forEach((input) => input.addEventListener('change', saveCurrentProject));

  elements.tableBody.addEventListener('blur', async (event) => {
    const cell = event.target.closest('[contenteditable="true"]');
    if (cell) {
      await saveStepFromRow(cell.closest('tr'));
      return;
    }

    const stepNotes = event.target.closest('textarea[data-step-notes]');
    if (stepNotes) {
      await saveStepFromRow(stepNotes.closest('tr'));
    }
  }, true);

  elements.tableBody.addEventListener('keydown', (event) => {
    if (event.target.matches('[contenteditable="true"]') && event.key === 'Enter') {
      event.preventDefault();
      event.target.blur();
    }
  });

  elements.tableBody.addEventListener('change', async (event) => {
    if (event.target.matches('select[data-step-status]')) {
      updateStatusClass(event.target.closest('tr'), event.target.value);
      await saveStepFromRow(event.target.closest('tr'));
    }
  });

  elements.tableBody.addEventListener('click', async (event) => {
    const deleteButton = event.target.closest('button[data-delete-step]');
    if (deleteButton) {
      await deleteRow(deleteButton);
    }
  });
}

async function apiFetch(url, options = {}) {
  const requestOptions = {
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {})
    },
    ...options
  };

  const response = await fetch(url, requestOptions);
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : null;

  if (!response.ok) {
    const message = body?.error || `Request failed with HTTP ${response.status}`;
    throw new Error(message);
  }

  return body;
}

function showAlert(message, type = 'info') {
  elements.alertContainer.replaceChildren();
  if (!message) {
    return;
  }

  const alert = document.createElement('div');
  alert.className = `alert alert-${type}`;
  alert.textContent = message;
  elements.alertContainer.appendChild(alert);

  if (type !== 'error') {
    window.setTimeout(() => {
      if (alert.isConnected) {
        alert.remove();
      }
    }, 4500);
  }
}

async function loadHealth() {
  try {
    const data = await apiFetch(API.health);
    elements.serverStatus.textContent = `Connected. Database: ${data.database}`;
    elements.lockStatus.textContent = data.lock?.locked ? `Write lock active: ${data.lock.owner}` : 'Write lock: available';
  } catch (error) {
    elements.serverStatus.textContent = 'Unable to reach the Python server.';
    showAlert(error.message, 'error');
  }
}

async function refreshLockStatus() {
  try {
    const data = await apiFetch(API.lock);
    elements.lockStatus.textContent = data.locked ? `Write lock active: ${data.owner}` : 'Write lock: available';
  } catch {
    elements.lockStatus.textContent = 'Write lock status unavailable.';
  }
}

function setDefaultDateInputs() {
  const now = localDateTimeValue(new Date());
  elements.noteDateInput.value = now;
}

function localDateTimeValue(date) {
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function displayDateTime(value) {
  if (!value) {
    return 'Not set';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

async function loadMeeting() {
  try {
    const data = await apiFetch(API.meeting);
    meeting = data.meeting || { meetingAt: '', location: '' };
    renderMeetingBanner();
  } catch (error) {
    showAlert(error.message, 'error');
  }
}

function renderMeetingBanner() {
  elements.meetingDisplay.textContent = displayDateTime(meeting.meetingAt);
  elements.meetingLocationDisplay.textContent = meeting.location || 'Not set';
  elements.meetingAtInput.value = meeting.meetingAt || '';
  elements.meetingLocationInput.value = meeting.location || '';
}

function showMeetingEditor() {
  renderMeetingBanner();
  elements.meetingEditor.hidden = false;
  elements.meetingAtInput.focus();
}

function hideMeetingEditor() {
  elements.meetingEditor.hidden = true;
}

async function saveMeeting() {
  const payload = {
    meetingAt: elements.meetingAtInput.value,
    location: elements.meetingLocationInput.value
  };

  try {
    const data = await apiFetch(API.meeting, {
      method: 'PATCH',
      body: JSON.stringify(payload)
    });
    meeting = data.meeting;
    renderMeetingBanner();
    hideMeetingEditor();
    showAlert('Next meeting saved.', 'success');
  } catch (error) {
    showAlert(error.message, 'error');
  }
}

function hideAllPages() {
  elements.globalDashboard.hidden = true;
  elements.mainContent.hidden = true;
  elements.notesPage.hidden = true;
  elements.membersPage.hidden = true;
}

function showGlobalDashboard() {
  hideAllPages();
  elements.globalDashboard.hidden = false;
  currentProjectId = null;
  elements.projectDropdown.value = '__home__';
  renderDashboardCards();
}

async function showNotesPage() {
  hideAllPages();
  elements.notesPage.hidden = false;
  currentProjectId = null;
  elements.projectDropdown.value = '__notes__';
  await refreshNotes();
}

async function showMembersPage() {
  hideAllPages();
  elements.membersPage.hidden = false;
  currentProjectId = null;
  elements.projectDropdown.value = '__members__';
  await refreshMembers();
}

function loadSelectedNavigation() {
  const selected = elements.projectDropdown.value;
  if (selected === '__home__') {
    showGlobalDashboard();
  } else if (selected === '__notes__') {
    showNotesPage();
  } else if (selected === '__members__') {
    showMembersPage();
  } else if (selected.startsWith('project:')) {
    openProject(selected.slice('project:'.length));
  }
}

async function refreshProjects() {
  const previousProjectId = currentProjectId;
  const data = await apiFetch(API.projects);
  projects = Array.isArray(data.projects) ? data.projects : [];
  projects.sort(compareProjects);
  updateDropdown();
  renderDashboardCards();
  await refreshLockStatus();

  if (previousProjectId && !elements.mainContent.hidden) {
    const refreshedProject = getProjectById(previousProjectId);
    if (refreshedProject) {
      currentProjectId = refreshedProject.id;
      elements.projectDropdown.value = `project:${refreshedProject.id}`;
      renderProject(refreshedProject);
    } else {
      showGlobalDashboard();
      showAlert('The project you were viewing no longer exists in the shared database.', 'error');
    }
  }
}

function updateDropdown() {
  elements.projectDropdown.replaceChildren();

  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.disabled = true;
  defaultOption.textContent = '-- Navigate --';
  elements.projectDropdown.appendChild(defaultOption);

  const pagesGroup = document.createElement('optgroup');
  pagesGroup.label = 'Pages';
  pagesGroup.append(createOption('__home__', 'Home Dashboard'));
  pagesGroup.append(createOption('__notes__', 'Meeting Notes / Journal'));
  pagesGroup.append(createOption('__members__', 'Members / Info'));
  elements.projectDropdown.appendChild(pagesGroup);

  const projectsGroup = document.createElement('optgroup');
  projectsGroup.label = 'Projects';
  projects.forEach((project) => {
    projectsGroup.append(createOption(`project:${project.id}`, `${project.pinned ? '📌 ' : ''}${project.name}`));
  });
  elements.projectDropdown.appendChild(projectsGroup);
}

function createOption(value, text) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = text;
  return option;
}

async function refreshCurrentProjectFromDatabase() {
  if (!currentProjectId) {
    return;
  }
  await refreshProjects();
  showAlert('Project refreshed from the shared database.', 'success');
}

function getProjectById(projectId) {
  return projects.find((project) => String(project.id) === String(projectId));
}

function getCurrentProject() {
  return currentProjectId ? getProjectById(currentProjectId) : null;
}

function compareProjects(a, b) {
  const pinnedComparison = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
  if (pinnedComparison !== 0) {
    return pinnedComparison;
  }
  return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
}

function compareNotesNewestFirst(a, b) {
  const aTime = Date.parse(a.noteDate || a.createdAt || '') || 0;
  const bTime = Date.parse(b.noteDate || b.createdAt || '') || 0;
  if (aTime !== bTime) {
    return bTime - aTime;
  }
  return Number(b.id) - Number(a.id);
}

function setDashboardFilter(filterType) {
  dashboardFilter = filterType;

  document.querySelectorAll('.filter-btn').forEach((button) => button.classList.remove('active'));
  const activeButton = document.getElementById(`filter-${filterType}`);
  if (activeButton) {
    activeButton.classList.add('active');
  }

  renderDashboardCards();
}

function renderDashboardCards() {
  elements.projectCardsContainer.replaceChildren();

  const visibleProjects = projects
    .filter((project) => {
      const projectStatus = project.status || 'Active';
      return dashboardFilter === 'All' || projectStatus === dashboardFilter;
    })
    .sort(compareProjects);

  if (visibleProjects.length === 0) {
    const emptyState = document.createElement('div');
    emptyState.className = 'empty-state';
    emptyState.textContent = 'No projects match the selected filter.';
    elements.projectCardsContainer.appendChild(emptyState);
    return;
  }

  visibleProjects.forEach((project) => {
    const projectStatus = project.status || 'Active';
    const stats = calculateStats(project.steps);
    const card = document.createElement('button');

    card.type = 'button';
    card.className = 'project-card';
    card.dataset.projectId = project.id;
    card.addEventListener('click', () => openProject(project.id));

    const badge = document.createElement('span');
    badge.className = `badge ${getBadgeClass(projectStatus)}`;
    badge.textContent = projectStatus;

    const pinMarker = document.createElement('span');
    pinMarker.className = 'pin-marker';
    pinMarker.textContent = project.pinned ? '📌 Pinned' : '';
    pinMarker.hidden = !project.pinned;

    const title = document.createElement('h3');
    title.textContent = project.name;

    const assignee = document.createElement('p');
    appendStrongText(assignee, 'Assignee:', project.assignee || 'Unassigned');

    const etic = document.createElement('p');
    appendStrongText(etic, 'ETIC:', project.etic || 'TBD');

    const progress = document.createElement('p');
    appendStrongText(progress, 'Progress:', `${stats.perc}% (${stats.completed}/${stats.total} Tasks)`);

    const progressContainer = document.createElement('div');
    progressContainer.className = 'card-progress-container';

    const progressBar = document.createElement('div');
    progressBar.className = 'card-progress-bar';
    progressBar.style.width = `${stats.perc}%`;

    progressContainer.appendChild(progressBar);
    card.append(badge, pinMarker, title, assignee, etic, progress, progressContainer);
    elements.projectCardsContainer.appendChild(card);
  });
}

function appendStrongText(parent, label, text) {
  const strong = document.createElement('strong');
  strong.textContent = label;
  parent.append(strong, document.createTextNode(` ${text}`));
}

function getBadgeClass(status) {
  if (status === 'Inactive') return 'badge-inactive';
  if (status === 'Completed') return 'badge-completed';
  return 'badge-active';
}

function calculateStats(stepsArray) {
  if (!Array.isArray(stepsArray) || stepsArray.length === 0) {
    return { total: 0, completed: 0, perc: 0 };
  }

  const total = stepsArray.length;
  const completed = stepsArray.filter((step) => step.status === 'C/W').length;
  const perc = Math.round((completed / total) * 100);
  return { total, completed, perc };
}

function openProject(projectId) {
  const project = getProjectById(projectId);
  if (!project) {
    showAlert('Project not found. Refreshing from the database.', 'error');
    refreshProjects().catch((error) => showAlert(error.message, 'error'));
    return;
  }

  hideAllPages();
  currentProjectId = project.id;
  elements.projectDropdown.value = `project:${project.id}`;
  elements.mainContent.hidden = false;
  renderProject(project);
}

function renderProject(project) {
  elements.projNameTitle.textContent = project.name;
  elements.projName.value = project.name || '';
  elements.projStatus.value = PROJECT_STATUS.includes(project.status) ? project.status : 'Active';
  elements.projAssignee.value = project.assignee || '';
  elements.projStartDate.value = project.startDate || '';
  elements.projTotalTime.value = project.totalTime || '';
  elements.projEtic.value = project.etic || '';
  elements.projNotes.value = project.notes || '';
  elements.pinProjectBtn.textContent = project.pinned ? 'Unpin Project' : 'Pin Project';
  elements.pinProjectBtn.setAttribute('aria-pressed', project.pinned ? 'true' : 'false');
  elements.projPinStatus.hidden = !project.pinned;

  elements.tableBody.replaceChildren();

  const steps = Array.isArray(project.steps) ? project.steps : [];
  steps.forEach((step, index) => {
    elements.tableBody.appendChild(createStepRow(step, index));
  });

  calculateProgress();
}

function createStepRow(step, index) {
  const row = document.createElement('tr');
  row.dataset.stepId = String(step.id);
  updateStatusClass(row, step.status);

  const stepNumber = document.createElement('td');
  stepNumber.textContent = String(index + 1);

  const issue = editableCell(step.issue || '', 'issue');
  const tool = editableCell(step.tool || '', 'tool');
  const etic = editableCell(step.etic || '', 'etic');

  const statusCell = document.createElement('td');
  const statusSelect = document.createElement('select');
  statusSelect.dataset.stepStatus = 'true';
  STEP_STATUS.forEach((status) => {
    const option = document.createElement('option');
    option.value = status;
    option.textContent = status;
    option.selected = (step.status || 'Not Started') === status;
    statusSelect.appendChild(option);
  });
  statusCell.appendChild(statusSelect);

  const notesCell = document.createElement('td');
  const notesTextarea = document.createElement('textarea');
  notesTextarea.className = 'step-notes-textarea';
  notesTextarea.dataset.stepNotes = 'true';
  notesTextarea.rows = 3;
  notesTextarea.maxLength = 10000;
  notesTextarea.value = step.notes || '';
  notesTextarea.placeholder = 'Step notes, blockers, decisions, or follow-up...';
  notesCell.appendChild(notesTextarea);

  const actions = document.createElement('td');
  const deleteButton = document.createElement('button');
  deleteButton.className = 'btn btn-danger';
  deleteButton.type = 'button';
  deleteButton.dataset.deleteStep = 'true';
  deleteButton.textContent = 'Delete';
  actions.appendChild(deleteButton);

  row.append(stepNumber, issue, tool, etic, statusCell, notesCell, actions);
  return row;
}

function editableCell(value, field) {
  const cell = document.createElement('td');
  cell.contentEditable = 'true';
  cell.dataset.field = field;
  cell.spellcheck = true;
  cell.textContent = value;
  return cell;
}

async function saveCurrentProject() {
  const project = getCurrentProject();
  if (!project) {
    return;
  }

  const payload = {
    name: elements.projName.value,
    status: elements.projStatus.value,
    assignee: elements.projAssignee.value,
    startDate: elements.projStartDate.value,
    totalTime: elements.projTotalTime.value,
    etic: elements.projEtic.value,
    notes: elements.projNotes.value
  };

  if (!payload.name.trim()) {
    showAlert('Project name cannot be blank.', 'error');
    elements.projName.value = project.name;
    return;
  }

  try {
    const data = await apiFetch(API.project(project.id), {
      method: 'PATCH',
      body: JSON.stringify(payload)
    });
    replaceProject(data.project);
    currentProjectId = data.project.id;
    elements.projNameTitle.textContent = data.project.name;
    updateDropdown();
    elements.projectDropdown.value = `project:${data.project.id}`;
    renderDashboardCards();
  } catch (error) {
    showAlert(error.message, 'error');
    await refreshProjects();
    const refreshed = getProjectById(project.id);
    if (refreshed) {
      renderProject(refreshed);
    }
  }
}

async function toggleCurrentProjectPinned() {
  const project = getCurrentProject();
  if (!project) {
    return;
  }

  try {
    const data = await apiFetch(API.project(project.id), {
      method: 'PATCH',
      body: JSON.stringify({ pinned: !project.pinned })
    });
    replaceProject(data.project);
    currentProjectId = data.project.id;
    updateDropdown();
    elements.projectDropdown.value = `project:${data.project.id}`;
    renderProject(data.project);
    renderDashboardCards();
    showAlert(data.project.pinned ? 'Project pinned to the top.' : 'Project unpinned.', 'success');
  } catch (error) {
    showAlert(error.message, 'error');
  }
}

function replaceProject(project) {
  const index = projects.findIndex((item) => String(item.id) === String(project.id));
  if (index >= 0) {
    projects[index] = project;
  } else {
    projects.push(project);
  }
  projects.sort(compareProjects);
}

async function createNewProject() {
  const newName = window.prompt('Enter the name of the new project:');
  if (!newName || !newName.trim()) {
    return;
  }

  try {
    const data = await apiFetch(API.projects, {
      method: 'POST',
      body: JSON.stringify({ name: newName.trim(), status: 'Active', pinned: false })
    });
    replaceProject(data.project);
    updateDropdown();
    openProject(data.project.id);
    showAlert('Project created.', 'success');
  } catch (error) {
    showAlert(error.message, 'error');
  }
}

async function deleteCurrentProject() {
  const project = getCurrentProject();
  if (!project) {
    return;
  }

  const confirmed = window.confirm(`Delete "${project.name}"? This cannot be undone.`);
  if (!confirmed) {
    return;
  }

  try {
    await apiFetch(API.project(project.id), { method: 'DELETE' });
    projects = projects.filter((item) => String(item.id) !== String(project.id));
    updateDropdown();
    showGlobalDashboard();
    showAlert('Project deleted.', 'success');
  } catch (error) {
    showAlert(error.message, 'error');
  }
}

async function addStep() {
  const project = getCurrentProject();
  if (!project) {
    return;
  }

  try {
    const data = await apiFetch(API.projectSteps(project.id), {
      method: 'POST',
      body: JSON.stringify({ status: 'Not Started' })
    });
    project.steps.push(data.step);
    renderProject(project);
    const newRow = elements.tableBody.querySelector(`tr[data-step-id="${CSS.escape(String(data.step.id))}"]`);
    const firstEditableCell = newRow?.querySelector('[contenteditable="true"]');
    firstEditableCell?.focus();
  } catch (error) {
    showAlert(error.message, 'error');
  }
}

async function deleteRow(deleteButton) {
  const row = deleteButton.closest('tr');
  const stepId = row?.dataset.stepId;
  const project = getCurrentProject();
  if (!stepId || !project) {
    return;
  }

  const confirmed = window.confirm('Delete this step?');
  if (!confirmed) {
    return;
  }

  try {
    await apiFetch(API.step(stepId), { method: 'DELETE' });
    project.steps = project.steps.filter((step) => String(step.id) !== String(stepId));
    row.remove();
    reindexSteps();
    calculateProgress();
    renderDashboardCards();
  } catch (error) {
    showAlert(error.message, 'error');
  }
}

async function saveStepFromRow(row) {
  const project = getCurrentProject();
  const stepId = row?.dataset.stepId;
  if (!project || !stepId) {
    return;
  }

  const payload = {
    issue: getCellText(row, 'issue'),
    tool: getCellText(row, 'tool'),
    etic: getCellText(row, 'etic'),
    status: row.querySelector('select[data-step-status]')?.value || 'Not Started',
    notes: row.querySelector('textarea[data-step-notes]')?.value.trim() || ''
  };

  try {
    const data = await apiFetch(API.step(stepId), {
      method: 'PATCH',
      body: JSON.stringify(payload)
    });
    const stepIndex = project.steps.findIndex((step) => String(step.id) === String(stepId));
    if (stepIndex >= 0) {
      project.steps[stepIndex] = data.step;
    }
    updateStatusClass(row, data.step.status);
    calculateProgress();
    renderDashboardCards();
  } catch (error) {
    showAlert(error.message, 'error');
  }
}

function getCellText(row, field) {
  const cell = row.querySelector(`[data-field="${field}"]`);
  return cell ? cell.textContent.trim() : '';
}

function updateStatusClass(row, status) {
  if (!row) {
    return;
  }

  row.classList.remove('status-cw', 'status-in-work', 'status-not-started');
  if (status === 'C/W') {
    row.classList.add('status-cw');
  } else if (status === 'In Work') {
    row.classList.add('status-in-work');
  } else {
    row.classList.add('status-not-started');
  }
}

function reindexSteps() {
  Array.from(elements.tableBody.rows).forEach((row, index) => {
    row.cells[0].textContent = String(index + 1);
  });
}

function calculateProgress() {
  const selects = elements.tableBody.querySelectorAll('select[data-step-status]');
  const total = selects.length;
  const completed = Array.from(selects).filter((select) => select.value === 'C/W').length;
  const perc = total === 0 ? 0 : Math.round((completed / total) * 100);

  elements.progressBar.style.width = `${perc}%`;
  elements.progressBar.textContent = perc > 5 ? `${perc}%` : '';
  elements.progressText.textContent = `${perc}% Complete (${completed}/${total} tasks)`;
}

function filterTable() {
  const filter = elements.searchInput.value.toUpperCase();
  Array.from(elements.tableBody.rows).forEach((row) => {
    const fieldValues = Array.from(row.querySelectorAll('input, textarea, select'))
      .map((field) => field.value || '')
      .join(' ');
    const haystack = `${row.textContent} ${fieldValues}`.toUpperCase();
    row.style.display = haystack.includes(filter) ? '' : 'none';
  });
}

async function refreshNotes() {
  try {
    const data = await apiFetch(API.notes);
    notes = Array.isArray(data.notes) ? data.notes : [];
    notes.sort(compareNotesNewestFirst);
    renderNotes();
  } catch (error) {
    showAlert(error.message, 'error');
  }
}

function renderNotes() {
  elements.notesList.replaceChildren();
  if (notes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No meeting notes have been added yet.';
    elements.notesList.appendChild(empty);
    return;
  }

  notes.forEach((note) => {
    const card = document.createElement('article');
    card.className = 'journal-card';
    card.dataset.noteId = String(note.id);

    const header = document.createElement('div');
    header.className = 'journal-card-header';

    const dateLabel = document.createElement('div');
    dateLabel.className = 'journal-date';
    dateLabel.textContent = displayDateTime(note.noteDate);

    const actions = document.createElement('div');
    actions.className = 'row-actions';

    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.className = 'btn btn-success';
    saveButton.dataset.saveNote = 'true';
    saveButton.textContent = 'Save';

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'btn btn-danger';
    deleteButton.dataset.deleteNote = 'true';
    deleteButton.textContent = 'Delete';

    actions.append(saveButton, deleteButton);
    header.append(dateLabel, actions);

    const grid = document.createElement('div');
    grid.className = 'form-grid compact-grid';

    grid.append(
      labeledInput('Date/Time', 'datetime-local', 'noteDate', note.noteDate || ''),
      labeledInput('Title', 'text', 'title', note.title || '', 200),
      labeledInput('Author', 'text', 'author', note.author || '', 200),
      labeledTextarea('Note', 'body', note.body || '', 5, 10000, true)
    );

    card.append(header, grid);
    elements.notesList.appendChild(card);
  });
}

function labeledInput(labelText, type, field, value, maxLength = null) {
  const label = document.createElement('label');
  label.textContent = labelText;
  const input = document.createElement('input');
  input.type = type;
  input.dataset.field = field;
  input.value = value;
  if (maxLength) {
    input.maxLength = maxLength;
  }
  label.appendChild(input);
  return label;
}

function labeledTextarea(labelText, field, value, rows = 4, maxLength = null, spanAll = false) {
  const label = document.createElement('label');
  label.textContent = labelText;
  if (spanAll) {
    label.className = 'span-all';
  }
  const textarea = document.createElement('textarea');
  textarea.dataset.field = field;
  textarea.rows = rows;
  textarea.value = value;
  if (maxLength) {
    textarea.maxLength = maxLength;
  }
  label.appendChild(textarea);
  return label;
}

async function createNote(event) {
  event.preventDefault();
  const payload = {
    noteDate: elements.noteDateInput.value || localDateTimeValue(new Date()),
    title: elements.noteTitleInput.value,
    author: elements.noteAuthorInput.value,
    body: elements.noteBodyInput.value
  };

  if (!payload.body.trim() && !payload.title.trim()) {
    showAlert('Add a title or note before saving.', 'error');
    return;
  }

  try {
    const data = await apiFetch(API.notes, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    notes.push(data.note);
    notes.sort(compareNotesNewestFirst);
    renderNotes();
    clearNoteForm();
    showAlert('Note added.', 'success');
  } catch (error) {
    showAlert(error.message, 'error');
  }
}

function clearNoteForm() {
  elements.noteDateInput.value = localDateTimeValue(new Date());
  elements.noteTitleInput.value = '';
  elements.noteAuthorInput.value = '';
  elements.noteBodyInput.value = '';
}

async function handleNoteListClick(event) {
  const saveButton = event.target.closest('button[data-save-note]');
  const deleteButton = event.target.closest('button[data-delete-note]');
  if (saveButton) {
    await saveNoteCard(saveButton.closest('.journal-card'));
  } else if (deleteButton) {
    await deleteNoteCard(deleteButton.closest('.journal-card'));
  }
}

async function saveNoteCard(card) {
  const noteId = card?.dataset.noteId;
  if (!noteId) {
    return;
  }

  const payload = {
    noteDate: getCardField(card, 'noteDate') || localDateTimeValue(new Date()),
    title: getCardField(card, 'title'),
    author: getCardField(card, 'author'),
    body: getCardField(card, 'body')
  };

  try {
    const data = await apiFetch(API.note(noteId), {
      method: 'PATCH',
      body: JSON.stringify(payload)
    });
    const index = notes.findIndex((note) => String(note.id) === String(noteId));
    if (index >= 0) {
      notes[index] = data.note;
    }
    notes.sort(compareNotesNewestFirst);
    renderNotes();
    showAlert('Note saved.', 'success');
  } catch (error) {
    showAlert(error.message, 'error');
  }
}

async function deleteNoteCard(card) {
  const noteId = card?.dataset.noteId;
  if (!noteId) {
    return;
  }
  if (!window.confirm('Delete this note?')) {
    return;
  }

  try {
    await apiFetch(API.note(noteId), { method: 'DELETE' });
    notes = notes.filter((note) => String(note.id) !== String(noteId));
    renderNotes();
    showAlert('Note deleted.', 'success');
  } catch (error) {
    showAlert(error.message, 'error');
  }
}

function getCardField(card, field) {
  const input = card.querySelector(`[data-field="${field}"]`);
  return input ? input.value.trim() : '';
}

async function refreshMembers() {
  try {
    const data = await apiFetch(API.members);
    members = Array.isArray(data.members) ? data.members : [];
    renderMembers();
  } catch (error) {
    showAlert(error.message, 'error');
  }
}

function renderMembers() {
  elements.membersTableBody.replaceChildren();
  if (members.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.className = 'empty-table-cell';
    cell.textContent = 'No members have been added yet.';
    row.appendChild(cell);
    elements.membersTableBody.appendChild(row);
    return;
  }

  members.forEach((member) => {
    const row = document.createElement('tr');
    row.dataset.memberId = String(member.id);

    row.append(
      tableInputCell('name', member.name || '', 'text', 200),
      tableInputCell('position', member.position || '', 'text', 200),
      tableInputCell('email', member.email || '', 'email', 320),
      tableInputCell('phone', member.phone || '', 'text', 80),
      tableTextareaCell('notes', member.notes || '', 2000),
      memberActionCell()
    );

    elements.membersTableBody.appendChild(row);
  });
}

function tableInputCell(field, value, type = 'text', maxLength = null) {
  const cell = document.createElement('td');
  const input = document.createElement('input');
  input.type = type;
  input.dataset.field = field;
  input.value = value;
  if (maxLength) {
    input.maxLength = maxLength;
  }
  cell.appendChild(input);
  return cell;
}

function tableTextareaCell(field, value, maxLength = null) {
  const cell = document.createElement('td');
  const textarea = document.createElement('textarea');
  textarea.dataset.field = field;
  textarea.rows = 2;
  textarea.value = value;
  if (maxLength) {
    textarea.maxLength = maxLength;
  }
  cell.appendChild(textarea);
  return cell;
}

function memberActionCell() {
  const cell = document.createElement('td');
  const wrapper = document.createElement('div');
  wrapper.className = 'row-actions vertical-actions';

  const saveButton = document.createElement('button');
  saveButton.type = 'button';
  saveButton.className = 'btn btn-success';
  saveButton.dataset.saveMember = 'true';
  saveButton.textContent = 'Save';

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'btn btn-danger';
  deleteButton.dataset.deleteMember = 'true';
  deleteButton.textContent = 'Delete';

  wrapper.append(saveButton, deleteButton);
  cell.appendChild(wrapper);
  return cell;
}

async function createMember(event) {
  event.preventDefault();
  const payload = {
    name: elements.memberNameInput.value,
    position: elements.memberPositionInput.value,
    email: elements.memberEmailInput.value,
    phone: elements.memberPhoneInput.value,
    notes: elements.memberNotesInput.value
  };

  if (!payload.name.trim()) {
    showAlert('Member name is required.', 'error');
    return;
  }

  try {
    const data = await apiFetch(API.members, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    members.push(data.member);
    members.sort((a, b) => a.name.localeCompare(b.name));
    renderMembers();
    clearMemberForm();
    showAlert('Member added.', 'success');
  } catch (error) {
    showAlert(error.message, 'error');
  }
}

function clearMemberForm() {
  elements.memberNameInput.value = '';
  elements.memberPositionInput.value = '';
  elements.memberEmailInput.value = '';
  elements.memberPhoneInput.value = '';
  elements.memberNotesInput.value = '';
}

async function handleMemberTableClick(event) {
  const saveButton = event.target.closest('button[data-save-member]');
  const deleteButton = event.target.closest('button[data-delete-member]');
  if (saveButton) {
    await saveMemberRow(saveButton.closest('tr'));
  } else if (deleteButton) {
    await deleteMemberRow(deleteButton.closest('tr'));
  }
}

async function saveMemberRow(row) {
  const memberId = row?.dataset.memberId;
  if (!memberId) {
    return;
  }

  const payload = {
    name: getRowField(row, 'name'),
    position: getRowField(row, 'position'),
    email: getRowField(row, 'email'),
    phone: getRowField(row, 'phone'),
    notes: getRowField(row, 'notes')
  };

  if (!payload.name.trim()) {
    showAlert('Member name cannot be blank.', 'error');
    return;
  }

  try {
    const data = await apiFetch(API.member(memberId), {
      method: 'PATCH',
      body: JSON.stringify(payload)
    });
    const index = members.findIndex((member) => String(member.id) === String(memberId));
    if (index >= 0) {
      members[index] = data.member;
    }
    members.sort((a, b) => a.name.localeCompare(b.name));
    renderMembers();
    showAlert('Member saved.', 'success');
  } catch (error) {
    showAlert(error.message, 'error');
  }
}

async function deleteMemberRow(row) {
  const memberId = row?.dataset.memberId;
  if (!memberId) {
    return;
  }
  if (!window.confirm('Delete this member?')) {
    return;
  }

  try {
    await apiFetch(API.member(memberId), { method: 'DELETE' });
    members = members.filter((member) => String(member.id) !== String(memberId));
    renderMembers();
    showAlert('Member deleted.', 'success');
  } catch (error) {
    showAlert(error.message, 'error');
  }
}

function getRowField(row, field) {
  const input = row.querySelector(`[data-field="${field}"]`);
  return input ? input.value.trim() : '';
}

async function createBackup() {
  try {
    const data = await apiFetch(API.backups, { method: 'POST' });
    showAlert(`Backup created: ${data.backup}`, 'success');
  } catch (error) {
    showAlert(error.message, 'error');
  }
}

function exportExcel() {
  const link = document.createElement('a');
  link.href = API.exportExcel;
  link.download = '';
  document.body.appendChild(link);
  link.click();
  link.remove();
}
