const tableCard = document.querySelector('#tableCard');
const statusEl = document.querySelector('#status');
const lastRefreshedEl = document.querySelector('#lastRefreshed');
const enablePushButton = document.querySelector('#enablePush');
const refreshButton = document.querySelector('#refreshTimes');

refreshButton.addEventListener('click', async () => {
  await refreshSchedule(true);
});

enablePushButton.addEventListener('click', async () => {
  try {
    await enableNotifications();
    statusEl.textContent = 'Notifications enabled';
  } catch (error) {
    statusEl.textContent = error.message;
  }
});

window.addEventListener('load', async () => {
  try {
    await registerServiceWorker();
  } catch {
    statusEl.textContent = 'Service worker unavailable';
  }

  await refreshSchedule(false);
});

async function refreshSchedule(force) {
  statusEl.textContent = force ? 'Refreshing…' : 'Loading…';

  const response = await fetch(force ? '/api/refresh' : '/api/times', {
    method: force ? 'POST' : 'GET',
    headers: force ? { 'content-type': 'application/json' } : undefined
  });
  const payload = await response.json();

  if (!payload.ok) {
    statusEl.textContent = payload.error || 'Unable to load times';
    return;
  }

  renderTable(payload.schedule.prayers);
  lastRefreshedEl.textContent = `Updated ${formatClock(payload.schedule.lastRefreshedAt)}`;
  statusEl.textContent = 'Ready';
}

function renderTable(rows) {
  if (window.innerWidth <= 720) {
    tableCard.innerHTML = rows.map((row) => `
      <div class="row">
        <div class="group"><div class="grid-cell prayer">${row.prayer}</div><div></div></div>
        <div class="group"><div class="grid-cell">BCMA</div><div class="grid-cell time">${formatCell(row.bcma, row.winningSource === 'BCMA')}</div></div>
        <div class="group"><div class="grid-cell">MAC</div><div class="grid-cell time">${formatCell(row.mac, row.winningSource === 'MAC')}</div></div>
        <div class="group"><div class="grid-cell">Iqama</div><div class="grid-cell time">${formatCell(row.iqama, false)}</div></div>
      </div>
    `).join('');
    return;
  }

  const head = `
    <div class="grid">
      <div class="grid-head">Prayer</div>
      <div class="grid-head">BCMA</div>
      <div class="grid-head">MAC</div>
      <div class="grid-head">Iqama</div>
      ${rows.map((row) => `
        <div class="grid-cell prayer">${row.prayer}</div>
        <div class="grid-cell time">${formatCell(row.bcma, row.winningSource === 'BCMA')}</div>
        <div class="grid-cell time">${formatCell(row.mac, row.winningSource === 'MAC')}</div>
        <div class="grid-cell time">${formatCell(row.iqama, false)}</div>
      `).join('')}
    </div>
  `;

  tableCard.innerHTML = head;
}

function formatCell(sourceRow, isWinner) {
  const label = sourceRow?.label || '--';
  return `<span class="time-value">${label}</span>${isWinner ? '<span class="winner">earlier</span>' : ''}`;
}

function formatClock(isoString) {
  const date = new Date(isoString);
  const datePart = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(date);
  const timePart = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit'
  }).format(date);

  return `${datePart} ${timePart}`;
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    throw new Error('Service workers are not supported');
  }

  await navigator.serviceWorker.register('/sw.js');
}

function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
}

function isStandalone() {
  return window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
}

async function enableNotifications() {
  if (isIOS() && !isStandalone()) {
    throw new Error('Add to Home Screen first — tap Share → Add to Home Screen in Safari, then reopen');
  }

  if (!('Notification' in window) || !('PushManager' in window)) {
    throw new Error(isIOS()
      ? 'Push notifications require iOS 16.4 or later'
      : 'Push notifications are not supported in this browser'
    );
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Notification permission was not granted');
  }

  const registration = await navigator.serviceWorker.ready;
  const keyResponse = await fetch('/api/push/public-key');
  const keyPayload = await keyResponse.json();
  const applicationServerKey = urlBase64ToUint8Array(keyPayload.publicKey);

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey
    });
  }

  await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(subscription)
  });
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let index = 0; index < rawData.length; index += 1) {
    outputArray[index] = rawData.charCodeAt(index);
  }

  return outputArray;
}
