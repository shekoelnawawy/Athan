import * as cheerio from 'cheerio';
import { config } from './config.js';
import { formatDateKey, normalizePrayerName, prayers, zonedDateForTime } from './time-utils.js';

export async function fetchPrayerSchedule(now = new Date()) {
  const dateKey = formatDateKey(now, config.timeZone);
  let bcmaTimes = {};
  let macTimes = {};

  try {
    const bcmaHtml = await fetchHtml(config.bcmaUrl);
    bcmaTimes = parseBcma(bcmaHtml, dateKey);
    if (!hasAnyTimes(bcmaTimes)) {
      throw new Error('BCMA parser returned no rows');
    }
  } catch (error) {
    console.warn(`[scraper] BCMA source unavailable: ${error.message}`);
  }

  try {
    const macHtml = await fetchMacMonthlyTimetableHtml(now);
    macTimes = parseMac(macHtml, dateKey);
    if (!hasAnyTimes(macTimes)) {
      throw new Error('MAC parser returned no rows');
    }
  } catch (error) {
    console.warn(`[scraper] MAC source unavailable: ${error.message}`);
  }

  if (!hasAnyTimes(bcmaTimes) && !hasAnyTimes(macTimes)) {
    throw new Error('Unable to load prayer times from both BCMA and MAC sources');
  }

  return buildSchedule(dateKey, bcmaTimes, macTimes);
}

async function fetchMacMonthlyTimetableHtml(now) {
  const month = monthNumberInTimeZone(now, config.timeZone);
  const pageUrl = new URL(config.macUrl);
  const pathParts = pageUrl.pathname.split('/').filter(Boolean);
  const siteSlug = pathParts[0];
  const ajaxPath = siteSlug ? `/${siteSlug}/wp-admin/admin-ajax.php` : '/wp-admin/admin-ajax.php';
  const ajaxUrl = new URL(ajaxPath, pageUrl.origin);

  ajaxUrl.searchParams.set('action', 'get_monthly_timetable');
  ajaxUrl.searchParams.set('month', String(month));
  ajaxUrl.searchParams.set('display', 'monthly');

  return fetchHtml(ajaxUrl.toString());
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

  // New MAC page exposes a month table; pick today's row by date and map Athan columns.
  let rowMatched = false;

  $('table tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 12) return;

    const rowDateKey = dateKeyFromMacText($(cells[0]).text());
    if (rowDateKey !== dateKey) return;

    rowMatched = true;

    const mappedTimes = [
      ['Fajr', 2],
      ['Sunrise', 4],
      ['Zuhr', 5],
      ['Asr', 7],
      ['Maghrib', 9],
      ['Isha', 11]
    ];

    mappedTimes.forEach(([prayer, index]) => {
      const raw = $(cells[index]).text().replace(/\s+/g, ' ').trim();
      const label = raw.toUpperCase();
      const date = zonedDateForTime(dateKey, label, config.timeZone);
      if (!date) return;

      values[prayer] = {
        source: 'MAC',
        time: date.toISOString(),
        label
      };
    });
  });

  if (rowMatched) {
    return values;
  }

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

function dateKeyFromMacText(raw) {
  const match = /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(String(raw).trim());
  if (!match) return null;

  const monthMap = {
    january: 1,
    february: 2,
    march: 3,
    april: 4,
    may: 5,
    june: 6,
    july: 7,
    august: 8,
    september: 9,
    october: 10,
    november: 11,
    december: 12
  };

  const month = monthMap[match[1].toLowerCase()];
  if (!month) return null;

  const day = Number(match[2]);
  const year = Number(match[3]);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function monthNumberInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    month: '2-digit'
  }).formatToParts(date);

  return Number(parts.find((part) => part.type === 'month')?.value);
}

function hasAnyTimes(values) {
  return Object.keys(values).length > 0;
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
        title: `${row.prayer} in 15 minutes`,
        body: row.winningSource
      },
      {
        id: `${dateKey}:${row.prayer}:at`,
        prayer: row.prayer,
        kind: 'at',
        source: row.winningSource,
        scheduledFor: winningDate.toISOString(),
        title: `${row.prayer} now`,
        body: row.winningSource
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
