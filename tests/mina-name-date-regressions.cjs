const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, 'Missing source section: ' + startMarker);
  return source.slice(start, end);
}

const normalizeSource = section('function minaNormalizePersianTypos(value)', 'function minaBuildReply(raw)');
const normalizeContext = {
  appData: { services: [] },
  minaTransliterateFinglish: value => String(value || '')
};
vm.runInNewContext(normalizeSource + '\nthis.normalizeName = minaNormalizePersianTypos;', normalizeContext);

assert.equal(normalizeContext.normalizeName('آسیه'), 'آسیه',
  'Persian alef-madda in a customer name must never be flattened');
assert.equal(normalizeContext.normalizeName('مینا'), 'مینا',
  'Customer names must remain unchanged by command typo correction');
assert.equal(normalizeContext.normalizeName('فرداا'), 'فردا',
  'Command typo correction must continue to work');
const bookingParserSource = section('function minaBuildReply(raw)', 'if (/فردا/.test(t)');
assert.match(bookingParserSource, /const nameMatches = Array\.from\(q\.matchAll/,
  'New customer names must be extracted from the spelling-preserving text, not comparison-normalized text');
assert.match(bookingParserSource, /const explicitClientName = q\.match/,
  'The «به اسم آسیه» path must preserve the exact customer name');
assert.match(bookingParserSource, /t\.includes\(minaCleanText\(name\)\.toLowerCase\(\)\)/,
  'Existing names must compare canonically while retaining their saved spelling');

const maskSource = section('function minaBuildCloudSafeCommand(message)', 'function minaNeedsCloudUnderstanding(message)');
const maskContext = {
  appData: { clientProfiles: {}, appointments: [] },
  minaNormalizePersianTypos: normalizeContext.normalizeName,
  minaTransliterateFinglish: value => String(value || '')
};
vm.runInNewContext(maskSource + '\nthis.buildSafe = minaBuildCloudSafeCommand;', maskContext);

for (const phrase of ['برای آسیه فردا ساعت ۱۷ نوبت ثبت کن', 'به اسم آسیه نوبت ثبت کن']) {
  const safe = maskContext.buildSafe(phrase);
  assert.match(safe.message, /\[CLIENT_1\]/,
    'New customer name must be masked before cloud routing: ' + phrase);
  assert.doesNotMatch(safe.message, /آسیه/,
    'Raw customer name must not be sent to the cloud: ' + phrase);
  assert.match(safe.restore(safe.message), /آسیه/,
    'The exact original customer name must be restored locally: ' + phrase);
}

const learningSource = section('function minaLearningStore()', 'function minaBuildRecentConversationContext(maxChars = 5200)');
const learningContext = {
  appData: { minaLearningMemory: { version: 1, corrections: [], preferences: [], updatedAt: 0 } },
  saveData: () => { learningContext.saved = (learningContext.saved || 0) + 1; }
};
vm.runInNewContext(learningSource + '\nthis.learn = minaLearnFromUserMessage; this.learningText = minaBuildLearningContext; this.resolveLearnedName = minaResolveLearnedClientName;', learningContext);
assert.equal(learningContext.learn('اسم درستش آسیه است، نه اسیه'), true,
  'An explicit customer-name correction must be learned');
assert.equal(learningContext.resolveLearnedName('اسیه'), 'آسیه',
  'The learned correct spelling must be applied in future bookings');
assert.match(learningContext.learningText(), /آسیه/,
  'The learned correction must be available to later AI turns');
assert.equal(learningContext.learn('از این به بعد تاریخ شمسی رو رعایت کن'), true,
  'A durable user preference must be learned');
assert.match(learningContext.learningText(), /تاریخ شمسی/,
  'The durable preference must remain in persistent learning context');
assert.ok(learningContext.saved >= 2,
  'Learning must persist to the app data store');
const relativeDateSource = section('function minaParseRelativeJalaliDate(text, baseKey)', 'function minaTryManageAppointment(raw)');
const relativeDateContext = {
  minaCleanText: value => String(value || '').replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[\s\u200c]+/g, ' ').trim(),
  minaPersianNumberValue: value => ({ 'یک':1, 'یه':1, 'دو':2, 'سه':3, 'چهار':4, 'پنج':5, 'شش':6, 'هفت':7, 'هشت':8, 'نه':9, 'ده':10 }[value] ?? Number(value)),
  getTodayKey: () => '1405-09-07',
  addDaysToJalaliKey: (base, days) => base + '+' + days
};
vm.runInNewContext(relativeDateSource + '\nthis.parseRelativeDate = minaParseRelativeJalaliDate;', relativeDateContext);

assert.equal(relativeDateContext.parseRelativeDate('هفته بعد', '1405-09-07'), '1405-09-07+7');
assert.equal(relativeDateContext.parseRelativeDate('یک هفته دیگه', '1405-09-07'), '1405-09-07+7');
assert.equal(relativeDateContext.parseRelativeDate('دو هفته آینده', '1405-09-07'), '1405-09-07+14');
assert.equal(relativeDateContext.parseRelativeDate('سه روز دیگه', '1405-09-07'), '1405-09-07+3');
assert.equal(relativeDateContext.parseRelativeDate('365 روز بعد', '1405-09-07'), '1405-09-07+365');
assert.equal(relativeDateContext.parseRelativeDate('365 روز پیش', '1405-09-07'), '1405-09-07+-365');
assert.equal(relativeDateContext.parseRelativeDate('یک هفته پیش', '1405-09-07'), '1405-09-07+-7');
assert.equal(relativeDateContext.parseRelativeDate('366 روز بعد', '1405-09-07'), null);
assert.equal(relativeDateContext.parseRelativeDate('53 هفته پیش', '1405-09-07'), null);

assert.equal(relativeDateContext.parseRelativeDate('فردا', '1405-09-07'), null,
  'Explicit tomorrow remains handled by the existing exact-date branch');

assert.match(source, /else newDate = minaParseRelativeJalaliDate\(text, getTodayKey\(\)\)/,
  'Appointment edits must use the relative Jalali date parser');
assert.match(source, /minaLearningMemory: parsed\.minaLearningMemory/,
  'Mina learning memory must migrate and persist with local app data');
assert.match(source, /minaBuildLearningContext\(\)/,
  'Confirmed user corrections and preferences must be supplied to the conversation router');
assert.match(source, /minaLearnFromUserMessage\(message\)/,
  'Mina must learn from explicit user corrections during chat');
assert.match(source, /minaResolveLearnedClientName\(cleanClientName/,
  'Previously corrected customer-name spellings must be applied to later bookings');
assert.match(source, /const cleanClientName = value =>/,
  'Booking name extraction must strip prepositions from customer names');
assert.match(source, /pronounAppointmentMutationFollowup[\s\S]*?pronounAppointmentFollowup \|\| pronounAppointmentMutationFollowup/,
  'Short cancel/delete/edit follow-ups must resolve through the last selected appointment');
assert.match(source, /const pronounAppointmentMutationFollowup = !hasAppointmentWord && !!minaLastReferencedAppointmentId/,
  'An explicit customer name must override any stale last-appointment pointer');
assert.match(source, /لغو\(\?:ش\|\\s\*کردن\|\\s\*کن\)/,
  'The «لغوش کن» cancellation form must be recognized');
console.log('Mina exact-name and relative-date regression tests: PASS');
