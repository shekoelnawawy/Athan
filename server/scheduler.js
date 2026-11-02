import cron from 'node-cron';
import { config } from './config.js';
import { sendPushToAll } from './push.js';
import { fetchPrayerSchedule, missingScheduleSources, mergeSchedules } from './scraper.js';
import { readJson, writeJson } from './storage.js';
import { formatDateKey, getNowInTimeZoneParts } from './time-utils.js';

let currentRun = Promise.resolve();

function runExclusive(operation) {
  const result = currentRun.then(operation);
  currentRun = result.catch(() => undefined);
  return result;
}

export function ensureScheduleFresh(now = new Date()) {
  return runExclusive(() => updateSchedule(now));
}

export function refreshSchedule(now = new Date()) {
  return runExclusive(() => updateSchedule(now, true));
}

async function updateSchedule(now, force = false) {
  const state = await readJson(config.stateFile, { schedule: null, sentNotificationIds: [] });
  const todayKey = formatDateKey(now, config.timeZone);
  const parts = getNowInTimeZoneParts(now, config.timeZone);
  const isAfterCutoff = parts.hour > config.cutoffHour || (parts.hour === config.cutoffHour && parts.minute >= config.cutoffMinute);

  const sameDay = state.schedule?.dateKey === todayKey;
  const missing = state.schedule ? state.schedule.missingSources ?? missingScheduleSources(state.schedule) : [];
  const attemptedAt = Date.parse(state.lastScheduleAttemptAt || state.schedule?.lastRefreshedAt || '');
  const retryDue = missing.length > 0 && (!Number.isFinite(attemptedAt) || now - attemptedAt >= 5 * 60 * 1000);
  if (!force && ((sameDay && !retryDue) || (!sameDay && !isAfterCutoff))) {
    return state;
  }

  let schedule;
  try {
    schedule = mergeSchedules(state.schedule, await fetchPrayerSchedule(now));
  } catch (error) {
    if (!sameDay) throw error;
    // Keep usable same-day data while a failed source is retried later.
    console.warn(`[scheduler] Schedule refresh failed: ${error.message}`);
    const failedState = { ...state, lastScheduleAttemptAt: now.toISOString() };
    await writeJson(config.stateFile, failedState);
    if (force) throw error;
    return failedState;
  }
  const nextState = {
    ...state,
    schedule,
    lastScheduleAttemptAt: now.toISOString(),
    sentNotificationIds: sameDay ? state.sentNotificationIds || [] : [],
    pendingNotificationEndpoints: sameDay ? state.pendingNotificationEndpoints || {} : {}
  };
  await writeJson(config.stateFile, nextState);
  return nextState;
}

export function tick(now = new Date()) {
  return runExclusive(() => tickUnlocked(now));
}

async function tickUnlocked(now) {
  const state = await updateSchedule(now);
  if (!state.schedule) {
    return;
  }

  const sent = new Set(state.sentNotificationIds || []);
  const pending = { ...state.pendingNotificationEndpoints };
  const GRACE_MS = 2 * 60 * 1000; // drop notifications more than 2 minutes late
  const due = state.schedule.notifications.filter((notification) => {
    const scheduled = new Date(notification.scheduledFor);
    return scheduled <= now && (now - scheduled) <= GRACE_MS && !sent.has(notification.id);
  });

  if (due.length === 0) {
    return;
  }

  for (const notification of due) {
    const result = await sendPushToAll({
      title: notification.title,
      body: notification.body,
      prayer: notification.prayer,
      eventType: notification.eventType,
      kind: notification.kind,
      scheduledFor: notification.scheduledFor
    }, { endpoints: pending[notification.id] });
    if (result.failedEndpoints.length) {
      pending[notification.id] = result.failedEndpoints;
    } else {
      delete pending[notification.id];
      sent.add(notification.id);
    }
    // Save each result so retrying one device never resends to successful ones.
    await writeJson(config.stateFile, {
      ...state,
      sentNotificationIds: [...sent],
      pendingNotificationEndpoints: pending
    });
  }
}

export function startScheduler() {
  cron.schedule('* * * * *', () => {
    tick().catch((error) => console.error(`[scheduler] ${error.message}`));
  }, {
    timezone: config.timeZone
  });
}
