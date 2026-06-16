'use strict';

const API = {
  health: '/api/health',
  projects: '/api/projects',
  project: (projectId) => `/api/projects/${encodeURIComponent(projectId)}`,
  projectSteps: (projectId) => `/api/projects/${encodeURIComponent(projectId)}/steps`,
  step: (stepId) => `/api/steps/${encodeURIComponent(stepId)}`,
  backups: '/api/backups',
  lock: '/api/lock'
};

const PROJECT_STATUS = ['Active', 'Inactive', 'Completed'];
const STEP_STATUS = ['Not Started', 'In Work', 'C/W'];

let projects = [];
let currentProjectId = null;
let dashboardFilter = 'All';

const elements = {};

document.addEventListener('DOMContentLoaded', initApp);

async function initApp() {
  cacheElements();
  wireEvents();
  await loadHealth();
  await refreshProjects();
  showGlobalDashboard();
}

function cacheElements() {
  elements.navTitle = document.getElementById('navTitle');
  elements.homeBtn = document.getElementById('homeBtn');
  elements.newProjectBtn = document.getElementById('newProjectBtn');
  elements.projectDropdown = document.getElementById('projectDropdown');
  elements.globalDashboard = document.getElementById('globalDashboard');
  elements.mainContent = document.getElementById('mainContent');
  elements.projectCardsContainer = document.getElementById('projectCardsContainer');
  elements.deleteProjectBtn = document.getElementById('deleteProjectBtn');
  elements.backupBtn = document.getElementById('backupBtn');
  elements.refreshBtn = document.getElementById('refreshBtn');
  elements.refreshProjectBtn = document.getElementById('refreshProjectBtn');
  elements.lockStatus = document.getElementById('lockStatus');
  elements.alertContainer = document.getElementById('alertContainer');
  elements.serverStatus = document.getElementById('serverStatus');
  elements.projNameTitle = document.getElementById('projNameTitle');
  elements.projName = document.getElementById('projName');
  elements.projStatus = document.getElementById('projStatus');
  elements.projAssignee = document.getElementById('projAssignee');
  elements.projStartDate = document.getElementById('projStartDate');
  elements.projTotalTime = document.getElementById('projTotalTime');
  elements.projEtic = document.getElementById('projEtic');
  elements.searchInput = document.getElementById('searchInput');
  elements.addStepBtn = document.getElementById('addStepBtn');
  elements.tableBody = document.getElementById('tableBody');
  elements.progressBar = document.getElementById('progressBar');
  elements.progressText = document.getElementById('progressText');
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
  elements.newProjectBtn.addEventListener('click', createNewProject);
  elements.projectDropdown.addEventListener('change', loadSelectedProject);
  elements.deleteProjectBtn.addEventListener('click', deleteCurrentProject);
  elements.backupBtn.addEventListener('click', createBackup);
  elements.refreshBtn.addEventListener('click', async () => {
    await refreshProjects();
    showAlert('Refreshed from the shared database.', 'success');
  });
  elements.refreshProjectBtn.addEventListener('click', refreshCurrentProjectFromDatabase);
  elements.addStepBtn.addEventListener('click', addStep);
  elements.searchInput.addEventListener('input', filterTable);

  document.querySelectorAll('.filter-btn').forEach((button) => {
    button.addEventListener('click', () => setDashboardFilter(button.dataset.filter));
  });

  [
    elements.projName,
    elements.projStatus,
    elements.projAssignee,
    elements.projStartDate,
    elements.projTotalTime,
    elements.projEtic
  ].forEach((input) => input.addEventListener('change', saveCurrentProject));

  elements.tableBody.addEventListener('blur', async (event) => {
    const cell = event.target.closest('[contenteditable="true"]');
    if (cell) {
      await saveStepFromRow(cell.closest('tr'));
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

async function refreshProjects() {
  const previousProjectId = currentProjectId;
  const data = await apiFetch(API.projects);
  projects = Array.isArray(data.projects) ? data.projects : [];
  updateDropdown();
  renderDashboardCards();
  await refreshLockStatus();

  if (previousProjectId && !elements.mainContent.hidden) {
    const refreshedProject = getProjectById(previousProjectId);
    if (refreshedProject) {
      currentProjectId = refreshedProject.id;
      elements.projectDropdown.value = String(refreshedProject.id);
      renderProject(refreshedProject);
    } else {
      showGlobalDashboard();
      showAlert('The project you were viewing no longer exists in the shared database.', 'error');
    }
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

async function refreshCurrentProjectFromDatabase() {
  if (!currentProjectId) {
    return;
  }
  await refreshProjects();
  showAlert('Project refreshed from the shared database.', 'success');
}

async function apiFetch(url, options = {}) {
  const requestOptions = {
    headers: {
      'Accept': 'application/json',
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

function getProjectById(projectId) {
  return projects.find((project) => String(project.id) === String(projectId));
}

function getCurrentProject() {
  return currentProjectId ? getProjectById(currentProjectId) : null;
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

function showGlobalDashboard() {
  elements.mainContent.hidden = true;
  elements.globalDashboard.hidden = false;
  elements.projectDropdown.value = '';
  currentProjectId = null;
  renderDashboardCards();
}

function renderDashboardCards() {
  elements.projectCardsContainer.replaceChildren();

  const visibleProjects = projects.filter((project) => {
    const projectStatus = project.status || 'Active';
    return dashboardFilter === 'All' || projectStatus === dashboardFilter;
  });

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
    card.append(badge, title, assignee, etic, progress, progressContainer);
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

function updateDropdown() {
  elements.projectDropdown.replaceChildren();

  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.disabled = true;
  defaultOption.selected = true;
  defaultOption.textContent = '-- Jump to Project --';
  elements.projectDropdown.appendChild(defaultOption);

  projects.forEach((project) => {
    const option = document.createElement('option');
    option.value = String(project.id);
    option.textContent = project.name;
    elements.projectDropdown.appendChild(option);
  });
}

function loadSelectedProject() {
  const selected = elements.projectDropdown.value;
  if (selected) {
    openProject(selected);
  }
}

function openProject(projectId) {
  const project = getProjectById(projectId);
  if (!project) {
    showAlert('Project not found. Refreshing from the database.', 'error');
    refreshProjects().catch((error) => showAlert(error.message, 'error'));
    return;
  }

  currentProjectId = project.id;
  elements.projectDropdown.value = String(project.id);
  elements.globalDashboard.hidden = true;
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

  const actions = document.createElement('td');
  const deleteButton = document.createElement('button');
  deleteButton.className = 'btn btn-danger';
  deleteButton.type = 'button';
  deleteButton.dataset.deleteStep = 'true';
  deleteButton.textContent = 'Delete';
  actions.appendChild(deleteButton);

  row.append(stepNumber, issue, tool, etic, statusCell, actions);
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
    etic: elements.projEtic.value
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
    elements.projectDropdown.value = String(data.project.id);
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

function replaceProject(project) {
  const index = projects.findIndex((item) => String(item.id) === String(project.id));
  if (index >= 0) {
    projects[index] = project;
  } else {
    projects.push(project);
  }
  projects.sort((a, b) => a.name.localeCompare(b.name));
}

async function createNewProject() {
  const newName = window.prompt('Enter the name of the new project:');
  if (!newName || !newName.trim()) {
    return;
  }

  try {
    const data = await apiFetch(API.projects, {
      method: 'POST',
      body: JSON.stringify({ name: newName.trim(), status: 'Active' })
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
    status: row.querySelector('select[data-step-status]')?.value || 'Not Started'
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
    row.style.display = row.textContent.toUpperCase().includes(filter) ? '' : 'none';
  });
}

async function createBackup() {
  try {
    const data = await apiFetch(API.backups, { method: 'POST' });
    showAlert(`Backup created: ${data.backup}`, 'success');
  } catch (error) {
    showAlert(error.message, 'error');
  }
}
