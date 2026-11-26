const { chromium } = require('playwright');
const { spawn } = require('child_process');
const assert = require('node:assert/strict');

(async () => {
  const server = spawn('python3', ['-m', 'http.server', '4174', '--bind', '127.0.0.1'], { stdio: 'ignore' });
  let browser;
  try {
    await new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(async () => {
        try {
          const response = await fetch('http://127.0.0.1:4174/');
          if (response.ok) { clearInterval(timer); resolve(); }
        } catch (_) {}
        if (Date.now() - started > 15000) { clearInterval(timer); reject(new Error('Local test server did not start')); }
      }, 250);
    });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:4174/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!document.querySelector('#calendarGrid') && typeof minaBuildReply === 'function', null, { timeout: 20000 });

    const result = await page.evaluate(() => {
      const original = {
        appointments: appData.appointments,
        saveData,
        ensureClientProfileForAppointment,
        syncAutomaticRepairReminder,
        renderCalendar,
        renderDaySchedule,
        renderClientsTab
      };
      saveData = () => true;
      ensureClientProfileForAppointment = () => null;
      syncAutomaticRepairReminder = () => {};
      renderCalendar = () => {};
      renderDaySchedule = () => {};
      renderClientsTab = () => {};
      const today = getTodayKey();
      const failures = [];
      let checked = 0;
      try {
        for (let day = 1; day <= 365; day++) {
          for (const direction of ['بعد', 'پیش']) {
            appData.appointments = [];
            const marker = direction === 'بعد' ? 'آینده' : 'گذشته';
            const message = 'برای آزمون' + day + marker + ' نوبت ' + toPersianDigits(String(day)) +
              ' روز ' + direction + ' در قسمت مشتریان ثبت کن';
            const reply = minaBuildReply(message);
            const appointment = appData.appointments[0];
            const expected = addDaysToJalaliKey(today, direction === 'بعد' ? day : -day);
            checked++;
            if (!appointment || appointment.dateKey !== expected || appointment.customerOnly !== true) {
              failures.push({ day, direction, expected, actual: appointment?.dateKey, reply });
              if (failures.length >= 5) break;
            }
          }
          if (failures.length >= 5) break;
        }

        appData.appointments = [];
        const now = getIranNow();
        const baseKey = addDaysToJalaliKey(today, 2);
        const [by,bm,bd] = baseKey.split('-').map(Number);
        const [gy,gm,gd] = jalaliToGregorian(by,bm,bd);
        const expectedDate = new Date(gy,gm-1,gd,now.getHours(),now.getMinutes(),now.getSeconds(),now.getMilliseconds()+180*60000);
        const expectedJ = gregorianToJalali(expectedDate.getFullYear(),expectedDate.getMonth()+1,expectedDate.getDate());
        const expectedCombinedDate = expectedJ[0] + '-' + pad2(expectedJ[1]) + '-' + pad2(expectedJ[2]);
        const expectedCombinedTime = pad2(expectedDate.getHours()) + ':' + pad2(expectedDate.getMinutes());
        const combinedReply = minaBuildReply('برای آزمون ترکیبی نوبت دو روز و سه ساعت دیگه در قسمت مشتریان ثبت کن');
        const debugText = minaCleanText(minaNormalizePersianTypos(minaStripPrefix(minaNormalizeDigits('برای آزمون ترکیبی نوبت دو روز و سه ساعت دیگه در قسمت مشتریان ثبت کن')))).toLowerCase();
        const debug = { text: debugText, expanded: minaExpandSpokenTime(debugText), reminderClock: minaParseReminderClock(debugText), relativeOffsetMatch: /(?:\\d{1,3}|یک|یه|دو|سه|چهار|پنج|شش|شیش|هفت|هشت|نه|ده|یازده|دوازده|سیزده|چهارده|پانزده|شانزده|هفده|هجده|نوزده|بیست|سی|چهل|پنجاه|شصت|هفتاد|هشتاد|نود|صد|یکصد|دویست|سیصد|چهارصد|پانصد|ششصد|هفتصد|هشتصد|نهصد)\\s*(?:ساعت|دقیقه)\\s*(?:پیش|قبل|گذشته|بعد|دیگه|دیگر)/u.test(debugText) };
        const combined = appData.appointments[0];

        appData.appointments = [];
        const writtenNumber = minaPersianNumberValue('سیصد و شصت و پنج');
        return {
          checked,
          failures,
          combined: {
            date: combined?.dateKey || null,
            time: combined?.time || null,
            expectedDate: expectedCombinedDate,
            expectedTime: expectedCombinedTime,
            reply: combinedReply
          },
          writtenNumber,
          debug
        };
      } finally {
        appData.appointments = original.appointments;
        saveData = original.saveData;
        ensureClientProfileForAppointment = original.ensureClientProfileForAppointment;
        syncAutomaticRepairReminder = original.syncAutomaticRepairReminder;
        renderCalendar = original.renderCalendar;
        renderDaySchedule = original.renderDaySchedule;
        renderClientsTab = original.renderClientsTab;
      }
    });

    console.log('Relative date diagnostic:', JSON.stringify({combined:result.combined,debug:result.debug}));
    assert.equal(result.checked, 730, 'All 365 day offsets must be checked in both directions');
    assert.deepEqual(result.failures, [], 'At least one relative day offset was parsed incorrectly');
    assert.equal(result.combined.date, result.combined.expectedDate, 'Combined day + hour phrase produced the wrong Jalali date');
    assert.equal(result.combined.time, result.combined.expectedTime, 'Combined day + hour phrase produced the wrong Iran-local time');
    assert.equal(result.writtenNumber, 365, 'Persian compound number 365 was not understood');
    console.log('Persian relative date range: PASS', JSON.stringify({
      daysChecked: result.checked,
      directionCoverage: ['past', 'future'],
      combinedDayHour: result.combined,
      writtenNumber365: result.writtenNumber
    }));
  } catch (error) {
    console.error(error.stack || String(error));
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})();
