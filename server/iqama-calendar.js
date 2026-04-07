import { config } from './config.js';
import { formatDateKey, normalizePrayerName, zonedDateForTime } from './time-utils.js';

const iqamaPrayers = new Set(['Fajr', 'Duhr', 'Asr', 'Maghrib', 'Isha']);

export async function fetchIqamaTimes(now = new Date()) {
  const response = await fetch(config.iqamaCalendarUrl, {
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
    const candidates = events.filter((event) => event.prayer === prayer && eventOccursOnDate(event, dateKey, timeZone));
    if (candidates.length === 0) continue;

    candidates.sort(compareApplicableEvents);
    const chosen = candidates[0];
    const label = formatTimeLabel(chosen.dtstart.value);
    const date = zonedDateForTime(dateKey, label, timeZone);
    if (!date) continue;

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

  return blocks.map(parseEvent).filter(Boolean);
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
      return [paramKey.toUpperCase(), paramValue];
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

    if (key === 'UID') {
      event.uid = value;
    }
  }

  return event.prayer && event.dtstart ? event : null;
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

function eventOccursOnDate(event, dateKey, timeZone) {
  const recurrenceKey = event.recurrenceId ? dateKeyForProperty(event.recurrenceId, timeZone) : null;
  if (recurrenceKey) {
    return recurrenceKey === dateKey;
  }

  const startKey = dateKeyForProperty(event.dtstart, timeZone);
  if (!startKey) return false;

  if (!event.rrule) {
    return startKey === dateKey;
  }

  if (event.rrule.FREQ !== 'DAILY') {
    return false;
  }

  if (dateKey < startKey) {
    return false;
  }

  const interval = Number(event.rrule.INTERVAL || 1);
  const diffDays = daysBetween(startKey, dateKey);
  if (diffDays % interval !== 0) {
    return false;
  }

  if (event.rrule.COUNT) {
    const occurrenceIndex = diffDays / interval;
    if (occurrenceIndex >= Number(event.rrule.COUNT)) {
      return false;
    }
  }

  if (event.rrule.UNTIL) {
    const untilKey = dateKeyForRRuleUntil(event.rrule.UNTIL, timeZone);
    if (untilKey && dateKey > untilKey) {
      return false;
    }
  }

  return true;
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

function dateKeyForProperty(property, timeZone) {
  if (!property?.value) return null;
  if (property.isUtc) {
    return formatDateKey(dateFromUtcValue(property.value), timeZone);
  }

  const raw = property.value.slice(0, 8);
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

function dateKeyForRRuleUntil(value, timeZone) {
  if (!value) return null;
  if (value.endsWith('Z')) {
    return formatDateKey(dateFromUtcValue(value), timeZone);
  }

  const raw = value.slice(0, 8);
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
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