const { webkit } = require('playwright');
const { spawn } = require('child_process');
const assert = require('assert');

(async () => {
  const server = spawn('python3', ['-m', 'http.server', '4174', '--bind', '127.0.0.1'], { stdio: 'ignore' });
  let browser;
  try {
    await new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = setInterval(async () => {
        try {
          const response = await fetch('http://127.0.0.1:4174/');
          if (response.ok) { clearInterval(poll); resolve(); }
        } catch (_) {}
        if (Date.now() - started > 15000) { clearInterval(poll); reject(new Error('Safari/WebKit test server did not start')); }
      }, 250);
    });

    browser = await webkit.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:4174/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!document.querySelector('#calendarGrid') && typeof renderCalendar === 'function', null, { timeout: 20000 });
    await page.waitForTimeout(1200);

    const result = await page.evaluate(() => {
      const today = getTodayKey();
      const future = addDaysToJalaliKey(today, 70);
      appData.appointments = [{
        id: 'webkit-persistence-check',
        dateKey: today,
        time: '13:43',
        clientName: 'آزمایش سافاری',
        service: 'کاشت مژه',
        status: 'pending'
      }];
      saveData();

      selectedDateKey = future;
      openApptModal();
      const primaryPickerButton = document.querySelector('#apptJalaliPicker button[onclick="selectAppointmentJalaliToday()"]');
      document.getElementById('apptDate').value = toPersianDigits(today.replace(/-/g, '/'));
      toggleAppointmentJalaliPicker();
      const primaryTodayButtonVisible = !!primaryPickerButton && getComputedStyle(document.getElementById('apptJalaliPicker')).display !== 'none';
      selectAppointmentJalaliToday();
      const primaryTodaySelected = parseClientJalaliDate(document.getElementById('apptDate').value) === today;

      document.getElementById('apptDate').value = toPersianDigits(today.replace(/-/g, '/'));
      selectedDateKey = future;
      toggleNextFollowupPicker();
      const nextPicker = document.getElementById('nextFollowupJalaliPicker');
      const nextTodayButtonVisible = !!document.querySelector('#nextFollowupJalaliPicker button[onclick="selectNextFollowupToday()"]');
      const primaryParts = today.split('-').map(Number);
      const expectedMonthTitle = JALALI_MONTHS[primaryParts[1] - 1] + ' ' + toPersianDigits(primaryParts[0]);
      const nextPickerStartsAtPrimaryMonth = document.getElementById('nextFollowupPickerTitle').textContent === expectedMonthTitle;
      selectNextFollowupToday();
      const nextTodaySelected = parseClientJalaliDate(document.getElementById('apptNextFollowupDate').value) === today;

      closeModal('apptModal');
      window.dispatchEvent(new Event('pagehide'));
      return {
        primaryTodayButtonVisible,
        primaryTodaySelected,
        nextTodayButtonVisible,
        nextPickerStartsAtPrimaryMonth,
        nextTodaySelected,
        stored: localStorage.getItem('dastyare_man_appointments_v1')?.includes('webkit-persistence-check') || false,
        noHorizontalOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= document.documentElement.clientWidth + 1
      };
    });

    assert(result.primaryTodayButtonVisible && result.primaryTodaySelected, 'Primary appointment calendar must expose and select Today');
    assert(result.nextTodayButtonVisible && result.nextPickerStartsAtPrimaryMonth && result.nextTodaySelected, 'Follow-up calendar must have its own Today shortcut and open relative to the primary appointment, not the main calendar month');
    assert(result.stored, 'Appointment data must be stored before a page reload');
    assert(result.noHorizontalOverflow, 'Mobile Safari viewport must not have horizontal overflow');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!document.querySelector('#calendarGrid'));
    const restored = await page.evaluate(() => appData.appointments.some(a => a.id === 'webkit-persistence-check' && a.time === '13:43'));
    assert(restored, 'Appointment data must survive reload in WebKit');
    assert.deepStrictEqual(errors, [], 'WebKit page errors: ' + errors.join('; '));

    console.log('Safari/WebKit mobile smoke: PASS', JSON.stringify({ ...result, restored, pageErrors: errors.length }));
    await browser.close();
  } catch (error) {
    if (browser) await browser.close();
    throw error;
  } finally {
    server.kill('SIGTERM');
  }
})();
