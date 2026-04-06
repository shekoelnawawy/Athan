import cron from 'node-cron';
import { config } from './config.js';
import { sendPushToAll } from './push.js';
import { fetchPrayerSchedule } from './scraper.js';
import { readJson, writeJson } from './storage.js';
import { formatDateKey, getNowInTimeZoneParts } from './time-utils.js';

let currentRun = Promise.resolve();

export async function ensureScheduleFresh(now = new Date()) {
  const state = await readJson(config.stateFile, { schedule: null, sentNotificationIds: [] });
  const todayKey = formatDateKey(now, config.timeZone);
  const parts = getNowInTimeZoneParts(now, config.timeZone);
  const isAfterCutoff = parts.hour > config.cutoffHour || (parts.hour === config.cutoffHour && parts.minute >= config.cutoffMinute);

  if (state.schedule?.dateKey === todayKey || !isAfterCutoff) {
    return state;
  }

  const schedule = await fetchPrayerSchedule(now);
  const nextState = {
    schedule,
    sentNotificationIds: []
  };
  await writeJson(config.stateFile, nextState);
  return nextState;
}

export async function tick(now = new Date()) {
  const state = await ensureScheduleFresh(now);
  if (!state.schedule) {
    return;
  }

  const sent = new Set(state.sentNotificationIds || []);
  const due = state.schedule.notifications.filter((notification) => {
    const scheduled = new Date(notification.scheduledFor);
    return scheduled <= now && !sent.has(notification.id);
  });

  if (due.length === 0) {
    return;
  }

  for (const notification of due) {
    await sendPushToAll({
      title: notification.title,
      body: notification.body,
      prayer: notification.prayer,
      kind: notification.kind,
      scheduledFor: notification.scheduledFor
    });
    sent.add(notification.id);
  }

  await writeJson(config.stateFile, {
    schedule: state.schedule,
    sentNotificationIds: [...sent]
  });
}

export function startScheduler() {
  cron.schedule('* * * * *', () => {
    currentRun = currentRun.then(() => tick()).catch(() => undefined);
  }, {
    timezone: config.timeZone
  });
}
