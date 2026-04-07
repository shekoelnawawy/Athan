import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');

export const config = {
  port: Number(process.env.PORT || 3000),
  timeZone: 'America/Vancouver',
  bcmaUrl: 'https://org.thebcma.com/vancouver/',
  macUrl: 'https://centres.macnet.ca/macvancouvercentre/prayer-times/',
  iqamaCalendarUrl: 'https://p190-caldav.icloud.com/published/2/MTkzNDk1ODgwMjE5MzQ5NcavEtxQGqGi6CF0CqH4Z9dieTrVgItyPzeeQLP2XdnEMwYCeWLHgYWUSnM082G9WApTclzQcpzMLlC2jEMyi-I',
  publicDir: path.join(rootDir, 'public'),
  dataDir,
  subscriptionsFile: path.join(dataDir, 'subscriptions.json'),
  stateFile: path.join(dataDir, 'state.json'),
  vapidFile: path.join(dataDir, 'vapid-keys.json'),
  cutoffHour: 0,
  cutoffMinute: 5
};
