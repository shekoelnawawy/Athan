import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIqamaCalendar } from '../server/iqama-calendar.js';

const zone = 'America/Vancouver';
const event = (lines) => `BEGIN:VEVENT\n${lines}\nEND:VEVENT`;
const parse = (...events) => parseIqamaCalendar(`BEGIN:VCALENDAR\n${events.join('\n')}\nEND:VCALENDAR`, '2026-11-01', zone);
const master = event('UID:asr-series\nSUMMARY:Asr\nDTSTART;TZID=America/Vancouver:20261031T161500\nRRULE:FREQ=DAILY;COUNT=3');

test('UTC timestamps convert to Vancouver time', () => {
  const result = parse(event('SUMMARY:Asr\nDTSTART:20261101T231500Z'));
  assert.equal(result.Asr.time, '2026-11-01T23:15:00.000Z');
  assert.equal(result.Asr.label, '4:15 PM');
});

test('TZID and floating times retain their respective clock meanings', () => {
  const zoned = parse(event('SUMMARY:Asr\nDTSTART;TZID=Etc/GMT-2:20261101T231500'));
  assert.equal(zoned.Asr.label, '2:15 PM');
  const floating = parse(event('SUMMARY:Asr\nDTSTART:20261101T161500'));
  assert.equal(floating.Asr.label, '4:15 PM');
});

test('UTC daily recurrences can fall on the previous Vancouver date', () => {
  const result = parse(event('SUMMARY:Asr\nDTSTART:20261031T001500Z\nRRULE:FREQ=DAILY;COUNT=3'));
  assert.equal(result.Asr.time, '2026-11-02T00:15:00.000Z');
  assert.equal(result.Asr.label, '5:15 PM');
});

test('cancelled standalone events are omitted', () => {
  assert.deepEqual(parse(event('SUMMARY:Asr\nDTSTART:20261101T231500Z\nSTATUS:CANCELLED')), {});
});

test('EXDATE omits a recurring instance, including UTC exclusion dates', () => {
  for (const exclusion of ['EXDATE;TZID=America/Vancouver:20261101T161500', 'EXDATE:20261101T231500Z']) {
    assert.deepEqual(parse(master.replace('END:VEVENT', `${exclusion}\nEND:VEVENT`)), {});
  }
});

test('cancelled override suppresses its master, even without SUMMARY or DTSTART', () => {
  assert.deepEqual(parse(master, event('UID:asr-series\nRECURRENCE-ID;TZID=America/Vancouver:20261101T161500\nSTATUS:CANCELLED')), {});
});

test('override replaces original time; moving it off the date removes the original', () => {
  const override = 'UID:asr-series\nRECURRENCE-ID;TZID=America/Vancouver:20261101T161500';
  assert.equal(parse(master, event(`${override}\nDTSTART:20261101T234500Z`)).Asr.label, '4:45 PM');
  assert.deepEqual(parse(master, event(`${override}\nDTSTART:20261102T234500Z`)), {});
});

test('COUNT and UNTIL boundaries prevent expired recurrences', () => {
  assert.deepEqual(parse(event('SUMMARY:Asr\nDTSTART:20261031T231500Z\nRRULE:FREQ=DAILY;COUNT=1')), {});
  assert.deepEqual(parse(event('SUMMARY:Asr\nDTSTART:20261031T231500Z\nRRULE:FREQ=DAILY;UNTIL=20261101T230000Z')), {});
});
