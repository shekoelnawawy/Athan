import { config } from './config.js';
import { formatDateKey, formatClock, normalizePrayerName, zonedDateForTime } from './time-utils.js';

const iqamaPrayers = new Set(['Fajr', 'Duhr', 'Asr', 'Maghrib', 'Isha']);

export async function fetchIqamaTimes(now = new Date()) {
  const response = await fetch(config.iqamaCalendarUrl, {
    signal: AbortSignal.timeout(15000),
    headers: {
      'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'
    }
  });

  if (!response.ok) {
    throw new Error(`Request failed for ${config.iqamaCalendarUrl}: ${response.status}`);
  }

  const dateKey = formatDateKey(now, config.timeZone);
  const calendarText = await response.text();
  return parseIqamaCalendar(calendarText, dateKey, config.timeZone);
}

export function parseIqamaCalendar(calendarText, dateKey, timeZone) {
  const events = parseEvents(calendarText);
  const values = {};

  for (const prayer of iqamaPrayers) {
    const candidates = events.flatMap((event) => {
      if (event.prayer !== prayer || event.status === 'CANCELLED') return [];
      const date = occurrenceOnDate(event, dateKey, timeZone);
      if (!date) return [];
      // An override replaces its original occurrence, including a cancellation
      // or an occurrence moved to another date.
      if (!event.recurrenceId && event.uid && events.some((override) =>
        override.uid === event.uid && override.recurrenceId &&
        dateForProperty(override.recurrenceId, timeZone)?.getTime() === date.getTime())) return [];
      return [{ ...event, date }];
    });
    if (candidates.length === 0) continue;

    candidates.sort(compareApplicableEvents);
    const chosen = candidates[0];
    const date = chosen.date;
    const label = formatClock(date, timeZone);

    values[prayer] = {
      source: 'Iqama',
      time: date.toISOString(),
      label
    };
  }

  return values;
}

function parseEvents(calendarText) {
  const text = unfoldIcs(calendarText);
  const blocks = text.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];

  const events = blocks.map(parseEvent).filter(Boolean);
  for (const event of events) {
    if (!event.prayer && event.recurrenceId && event.uid) {
      event.prayer = events.find((master) => master.uid === event.uid && !master.recurrenceId)?.prayer;
    }
  }
  return events;
}

function parseEvent(block) {
  const event = {};

  for (const line of block.split('\n')) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) continue;

    const rawKey = line.slice(0, separatorIndex);
    const value = line.slice(separatorIndex + 1).trim();
    const [key, ...paramParts] = rawKey.split(';');
    const params = Object.fromEntries(paramParts.map((part) => {
      const [paramKey, paramValue = ''] = part.split('=');
      return [paramKey.toUpperCase(), paramValue.replace(/^"|"$/g, '')];
    }));

    if (key === 'SUMMARY') {
      const prayer = normalizeIqamaPrayerName(value);
      if (!prayer) {
        return null;
      }
      event.summary = value;
      event.prayer = prayer;
      continue;
    }

    if (key === 'DTSTART' || key === 'RECURRENCE-ID') {
      event[toCamelKey(key)] = {
        value,
        isUtc: value.endsWith('Z'),
        tzid: params.TZID || null
      };
      continue;
    }

    if (key === 'RRULE') {
      event.rrule = Object.fromEntries(value.split(';').map((part) => {
        const [ruleKey, ruleValue = ''] = part.split('=');
        return [ruleKey.toUpperCase(), ruleValue];
      }));
      continue;
    }

    if (key === 'EXDATE') {
      event.exdates ??= [];
      event.exdates.push(...value.split(',').map((item) => ({
        value: item, isUtc: item.endsWith('Z'), tzid: params.TZID || null
      })));
    }

    if (key === 'STATUS') event.status = value.toUpperCase();

    if (key === 'UID') {
      event.uid = value;
    }
  }

  return (event.prayer || event.uid) && (event.dtstart || event.recurrenceId) ? event : null;
}

function normalizeIqamaPrayerName(raw) {
  if (/\bathan\b/i.test(String(raw))) {
    return null;
  }

  const prayer = normalizePrayerName(raw);
  return iqamaPrayers.has(prayer) ? prayer : null;
}

function unfoldIcs(text) {
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/\n[ \t]/g, '');
}

function occurrenceOnDate(event, dateKey, timeZone) {
  if (!event.dtstart) return null;
  const excluded = (date) => (event.exdates || []).some((property) =>
    property.value.length === 8
      ? formatDateKey(date, property.tzid || timeZone) === dateKeyFromRaw(property.value)
      : dateForProperty(property, timeZone)?.getTime() === date.getTime());
  if (!event.rrule || event.recurrenceId) {
    const date = dateForProperty(event.dtstart, timeZone);
    return date && formatDateKey(date, timeZone) === dateKey && !excluded(date) ? date : null;
  }
  if (event.rrule.FREQ !== 'DAILY') return null;
  const startKey = dateKeyFromRaw(event.dtstart.value);
  const interval = Number(event.rrule.INTERVAL || 1);
  if (!Number.isInteger(interval) || interval < 1) return null;
  // A source-zone date can differ from the requested Vancouver date.
  for (const shift of [-1, 0, 1]) {
    const sourceKey = new Date(new Date(`${dateKey}T00:00:00Z`).getTime() + shift * 86400000).toISOString().slice(0, 10);
    const diffDays = daysBetween(startKey, sourceKey);
    if (diffDays < 0 || diffDays % interval !== 0) continue;
    if (event.rrule.COUNT && diffDays / interval >= Number(event.rrule.COUNT)) continue;
    const property = { ...event.dtstart, value: sourceKey.replaceAll('-', '') + event.dtstart.value.slice(8) };
    const date = dateForProperty(property, timeZone);
    if (!date || formatDateKey(date, timeZone) !== dateKey) continue;
    const until = event.rrule.UNTIL;
    if (until && (until.endsWith('Z')
      ? date > dateFromUtcValue(until)
      : property.value.slice(0, until.length) > until)) continue;
    if (!excluded(date)) return date;
  }
  return null;
}

function compareApplicableEvents(left, right) {
  const leftOverride = left.recurrenceId ? 1 : 0;
  const rightOverride = right.recurrenceId ? 1 : 0;
  if (leftOverride !== rightOverride) {
    return rightOverride - leftOverride;
  }

  const leftKey = numericDateKey(left.recurrenceId?.value || left.dtstart.value);
  const rightKey = numericDateKey(right.recurrenceId?.value || right.dtstart.value);
  if (leftKey !== rightKey) {
    return rightKey.localeCompare(leftKey);
  }

  return right.dtstart.value.localeCompare(left.dtstart.value);
}

function dateKeyFromRaw(value) {
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function dateForProperty(property, timeZone) {
  if (!property?.value || property.value.length < 15) return null;
  if (property.isUtc) return dateFromUtcValue(property.value);
  return zonedDateForTime(dateKeyFromRaw(property.value), formatTimeLabel(property.value), property.tzid || timeZone);
}

function dateFromUtcValue(value) {
  const raw = value.replace('Z', '');
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6)) - 1;
  const day = Number(raw.slice(6, 8));
  const hour = Number(raw.slice(9, 11) || '0');
  const minute = Number(raw.slice(11, 13) || '0');
  const second = Number(raw.slice(13, 15) || '0');
  return new Date(Date.UTC(year, month, day, hour, minute, second));
}

function numericDateKey(value) {
  return String(value).slice(0, 8);
}

function daysBetween(leftDateKey, rightDateKey) {
  const left = new Date(`${leftDateKey}T00:00:00Z`);
  const right = new Date(`${rightDateKey}T00:00:00Z`);
  return Math.round((right.getTime() - left.getTime()) / 86400000);
}

function formatTimeLabel(value) {
  let hour = Number(value.slice(9, 11));
  const minute = value.slice(11, 13);
  const meridiem = hour >= 12 ? 'PM' : 'AM';

  if (hour === 0) hour = 12;
  if (hour > 12) hour -= 12;

  return `${hour}:${minute} ${meridiem}`;
}

function toCamelKey(key) {
  return key.toLowerCase().replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}
