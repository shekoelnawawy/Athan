import express from 'express';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { config } from './config.js';
import { ensurePushReady, getPublicVapidKey, saveSubscription } from './push.js';
import { fetchPrayerSchedule } from './scraper.js';
import { ensureScheduleFresh, startScheduler, tick } from './scheduler.js';
import { readJson, writeJson } from './storage.js';

const app = express();

await fs.mkdir(config.dataDir, { recursive: true });
await ensurePushReady();

app.use(express.json());
app.use(express.static(config.publicDir));

app.get('/api/times', async (_request, response) => {
  try {
    const state = await ensureScheduleFresh(new Date());
    const schedule = state.schedule ?? await fetchPrayerSchedule(new Date());
    response.json({ ok: true, schedule });
  } catch (error) {
    response.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/refresh', async (_request, response) => {
  try {
    const schedule = await fetchPrayerSchedule(new Date());
    const state = await readJson(config.stateFile, { schedule: null, sentNotificationIds: [] });
    const sentNotificationIds = state.schedule?.dateKey === schedule.dateKey ? state.sentNotificationIds || [] : [];
    await writeJson(config.stateFile, { schedule, sentNotificationIds });
    await tick(new Date());
    response.json({ ok: true, schedule });
  } catch (error) {
    response.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/push/public-key', async (_request, response) => {
  const publicKey = await getPublicVapidKey();
  response.json({ ok: true, publicKey });
});

app.post('/api/push/subscribe', async (request, response) => {
  const subscription = request.body;
  if (!subscription?.endpoint) {
    response.status(400).json({ ok: false, error: 'Invalid subscription payload' });
    return;
  }

  await saveSubscription(subscription);
  response.json({ ok: true });
});

app.get('*', (_request, response) => {
  response.sendFile(path.join(config.publicDir, 'index.html'));
});

startScheduler();
await tick(new Date());

app.listen(config.port, () => {
  console.log(`Athan PWA listening on http://localhost:${config.port}`);
});
