import { promises as fs } from 'node:fs';
import webpush from 'web-push';
import { config } from './config.js';
import { readJson, writeJson } from './storage.js';

export async function ensurePushReady() {
  await fs.mkdir(config.dataDir, { recursive: true });

  let vapidKeys = await readJson(config.vapidFile, null);
  if (!vapidKeys) {
    vapidKeys = webpush.generateVAPIDKeys();
    await writeJson(config.vapidFile, vapidKeys);
  }

  webpush.setVapidDetails(
    'mailto:athan@example.com',
    vapidKeys.publicKey,
    vapidKeys.privateKey
  );

  const subscriptions = await readJson(config.subscriptionsFile, []);
  return { vapidKeys, subscriptions };
}

export async function getPublicVapidKey() {
  const vapidKeys = await readJson(config.vapidFile, null);
  return vapidKeys?.publicKey ?? null;
}

export async function saveSubscription(subscription) {
  const subscriptions = await readJson(config.subscriptionsFile, []);
  const deduped = subscriptions.filter((item) => item.endpoint !== subscription.endpoint);
  deduped.push(subscription);
  await writeJson(config.subscriptionsFile, deduped);
  return deduped;
}

export async function sendPushToAll(payload) {
  const subscriptions = await readJson(config.subscriptionsFile, []);
  const survivors = [];

  await Promise.all(subscriptions.map(async (subscription) => {
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 120 });
      survivors.push(subscription);
    } catch (error) {
      const statusCode = error?.statusCode;
      if (statusCode && [404, 410].includes(statusCode)) {
        return;
      }
      survivors.push(subscription);
    }
  }));

  await writeJson(config.subscriptionsFile, survivors);
}
