import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import webpush from 'web-push';
import { config } from '../server/config.js';
import { writeJson, readJson } from '../server/storage.js';
import { tick, ensureScheduleFresh, refreshSchedule } from '../server/scheduler.js';
import { fetchPrayerSchedule } from '../server/scraper.js';

const now = new Date('2026-11-01T23:15:00Z');
const prayers = ['Fajr', 'Sunrise', 'Duhr', 'Asr', 'Maghrib', 'Isha'];
const bcma = `<table><tbody>${prayers.map((p) => `<tr><td>${p}</td><td>4:15 PM</td></tr>`).join('')}</tbody></table>`;
const mac = prayers.map((p) => `<div class="prayer-time"><h3>${p}</h3><div class="prayer-start">4:15 PM</div></div>`).join('');
const ics = `BEGIN:VCALENDAR\n${prayers.filter((p) => p !== 'Sunrise').map((p) => `BEGIN:VEVENT\nSUMMARY:${p}\nDTSTART;TZID=America/Vancouver:20261101T161500\nEND:VEVENT`).join('\n')}\nEND:VCALENDAR`;
let directory;
let originalPaths;

beforeEach(async (t) => {
  directory = await mkdtemp(path.join(tmpdir(), 'athan-test-'));
  originalPaths = { stateFile: config.stateFile, subscriptionsFile: config.subscriptionsFile };
  config.stateFile = path.join(directory, 'state.json');
  config.subscriptionsFile = path.join(directory, 'subscriptions.json');
  t.mock.method(globalThis, 'fetch', async (url) => new Response(url === config.bcmaUrl ? bcma : url === config.iqamaCalendarUrl ? ics : mac));
});

afterEach(async () => {
  Object.assign(config, originalPaths);
  await rm(directory, { recursive: true, force: true });
});

async function saveState(schedule, extra = {}) {
  await writeJson(config.stateFile, { schedule, sentNotificationIds: ['already-sent'], ...extra });
}

test('partial source failure retries after five minutes and preserves notification history', async (t) => {
  let available = false;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url === config.iqamaCalendarUrl && !available) throw Error('temporary calendar outage');
    return new Response(url === config.bcmaUrl ? bcma : url === config.iqamaCalendarUrl ? ics : mac);
  });
  const partial = await fetchPrayerSchedule(now);
  assert.deepEqual(partial.missingSources, ['iqama']);
  await saveState(partial, { lastScheduleAttemptAt: now.toISOString() });
  available = true;
  let state = await ensureScheduleFresh(new Date(now.getTime() + 60000));
  assert.equal(state.schedule.prayers.find((p) => p.prayer === 'Asr').iqama, null);
  state = await ensureScheduleFresh(new Date(now.getTime() + 300000));
  assert.equal(state.schedule.prayers.find((p) => p.prayer === 'Asr').iqama.label, '4:15 PM');
  assert.deepEqual(state.schedule.missingSources, []);
  assert.deepEqual(state.sentNotificationIds, ['already-sent']);
});

test('failed refresh retains known same-day source data and never reuses yesterday', async (t) => {
  await saveState(await fetchPrayerSchedule(now));
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url === config.iqamaCalendarUrl) throw Error('calendar unavailable');
    return new Response(url === config.bcmaUrl ? bcma : mac);
  });
  let state = await refreshSchedule(now);
  assert.equal(state.schedule.prayers.find((p) => p.prayer === 'Asr').iqama.label, '4:15 PM');
  assert.deepEqual(state.schedule.missingSources, ['iqama']);
  state.schedule.dateKey = '2026-10-31';
  await saveState(state.schedule);
  state = await ensureScheduleFresh(now);
  assert.equal(state.schedule.prayers.find((p) => p.prayer === 'Asr').iqama, null);
  assert.deepEqual(state.sentNotificationIds, []);
});

test('all-source outage keeps same-day schedule and backs off retries', async (t) => {
  const schedule = await fetchPrayerSchedule(now);
  schedule.missingSources = ['iqama'];
  await saveState(schedule, { lastScheduleAttemptAt: new Date(now.getTime() - 300000).toISOString() });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('offline'); });
  const state = await ensureScheduleFresh(now);
  assert.deepEqual(state.schedule, schedule);
  assert.equal(calls, 3);
  await ensureScheduleFresh(new Date(now.getTime() + 60000));
  assert.equal(calls, 3);
});

test('successful calendar cancellation removes cached iqama instead of restoring it', async (t) => {
  await saveState(await fetchPrayerSchedule(now));
  t.mock.method(globalThis, 'fetch', async (url) => new Response(url === config.bcmaUrl ? bcma : url === config.iqamaCalendarUrl
    ? ics.replaceAll('END:VEVENT', 'STATUS:CANCELLED\nEND:VEVENT') : mac));
  const state = await refreshSchedule(now);
  assert.equal(state.schedule.prayers.find((p) => p.prayer === 'Asr').iqama, null);
  assert.ok(!state.schedule.notifications.some((n) => n.eventType === 'iqama'));
  assert.deepEqual(state.schedule.missingSources, []);
});

test('push retries only failed devices, persists progress, and removes expired subscriptions', async (t) => {
  const schedule = await fetchPrayerSchedule(now);
  schedule.notifications = [{ id: 'asr', prayer: 'Asr', eventType: 'iqama', kind: 'at', scheduledFor: now.toISOString() }];
  await saveState(schedule);
  await writeJson(config.subscriptionsFile, ['good', 'temporary', 'expired'].map((endpoint) => ({ endpoint })));
  const calls = [];
  let retry = false;
  t.mock.method(webpush, 'sendNotification', async ({ endpoint }) => {
    calls.push(endpoint);
    if (endpoint === 'expired') throw { statusCode: 410 };
    if (endpoint === 'temporary' && !retry) throw { statusCode: 503 };
  });
  await tick(now);
  let state = await readJson(config.stateFile);
  assert.deepEqual(state.sentNotificationIds, ['already-sent']);
  assert.deepEqual(state.pendingNotificationEndpoints.asr, ['temporary']);
  assert.deepEqual((await readJson(config.subscriptionsFile)).map((s) => s.endpoint), ['good', 'temporary']);
  retry = true;
  await tick(new Date(now.getTime() + 60000));
  state = await readJson(config.stateFile);
  assert.deepEqual(calls, ['good', 'temporary', 'expired', 'temporary']);
  assert.ok(state.sentNotificationIds.includes('asr'));
  assert.deepEqual(state.pendingNotificationEndpoints, {});
});

test('concurrent scheduler ticks do not duplicate notifications', async (t) => {
  const schedule = await fetchPrayerSchedule(now);
  schedule.notifications = [{ id: 'asr', scheduledFor: now.toISOString() }];
  await saveState(schedule);
  await writeJson(config.subscriptionsFile, [{ endpoint: 'good' }]);
  let calls = 0;
  t.mock.method(webpush, 'sendNotification', async () => { calls++; });
  await Promise.all([tick(now), tick(now)]);
  assert.equal(calls, 1);
  assert.ok(JSON.parse(await readFile(config.stateFile)).sentNotificationIds.includes('asr'));
});
