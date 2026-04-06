import * as cheerio from 'cheerio';
import { config } from './config.js';
import { formatDateKey, normalizePrayerName, prayers, zonedDateForTime } from './time-utils.js';

export async function fetchPrayerSchedule(now = new Date()) {
  const [bcmaHtml, macHtml] = await Promise.all([
    fetchHtml(config.bcmaUrl),
    fetchHtml(config.macUrl)
  ]);

  const dateKey = formatDateKey(now, config.timeZone);
  const bcmaTimes = parseBcma(bcmaHtml, dateKey);
  const macTimes = parseMac(macHtml, dateKey);

  return buildSchedule(dateKey, bcmaTimes, macTimes);
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'
    }
  });

  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status}`);
  }

  return response.text();
}

function parseBcma(html, dateKey) {
  const $ = cheerio.load(html);
  const values = {};

  $('table tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 2) return;

    const prayer = normalizePrayerName($(cells[0]).text());
    if (!prayer) return;

    const timeValue = $(cells[1]).text().replace(/\s+/g, ' ').trim();
    const date = zonedDateForTime(dateKey, timeValue, config.timeZone);
    if (!date) return;

    values[prayer] = {
      source: 'BCMA',
      time: date.toISOString(),
      label: timeValue
    };
  });

  return values;
}

function parseMac(html, dateKey) {
  const $ = cheerio.load(html);
  const values = {};

  $('.prayer-time').each((_, node) => {
    const prayer = normalizePrayerName($(node).find('h3').first().text());
    if (!prayer) return;

    const timeValue = $(node).find('.prayer-start').first().text().replace(/\s+/g, ' ').trim().toUpperCase();
    const date = zonedDateForTime(dateKey, timeValue, config.timeZone);
    if (!date) return;

    values[prayer] = {
      source: 'MAC',
      time: date.toISOString(),
      label: timeValue
    };
  });

  return values;
}

function buildSchedule(dateKey, bcmaTimes, macTimes) {
  const prayerRows = prayers.map((prayer) => {
    const bcma = bcmaTimes[prayer] ?? null;
    const mac = macTimes[prayer] ?? null;
    const candidates = [bcma, mac].filter(Boolean);
    const winner = candidates.sort((left, right) => new Date(left.time) - new Date(right.time))[0] ?? null;

    return {
      prayer,
      bcma,
      mac,
      winningSource: winner?.source ?? null,
      winningTime: winner?.time ?? null
    };
  });

  const notifications = prayerRows.flatMap((row) => {
    if (!row.winningTime) return [];
    const winningDate = new Date(row.winningTime);
    const beforeDate = new Date(winningDate.getTime() - 15 * 60 * 1000);

    return [
      {
        id: `${dateKey}:${row.prayer}:before`,
        prayer: row.prayer,
        kind: 'before',
        source: row.winningSource,
        scheduledFor: beforeDate.toISOString(),
        title: `${row.prayer} Athan in 15 minutes`,
        body: `Earlier source today: ${row.winningSource}`
      },
      {
        id: `${dateKey}:${row.prayer}:at`,
        prayer: row.prayer,
        kind: 'at',
        source: row.winningSource,
        scheduledFor: winningDate.toISOString(),
        title: `${row.prayer} Athan now`,
        body: `Earlier source today: ${row.winningSource}`
      }
    ];
  });

  return {
    dateKey,
    lastRefreshedAt: new Date().toISOString(),
    prayers: prayerRows,
    notifications
  };
}
