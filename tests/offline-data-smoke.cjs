const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

(async () => {
  const server = spawn('python3', ['-m', 'http.server', '4173', '--bind', '127.0.0.1'], { stdio: 'ignore' });
  let browser;
  try {
    await new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(async () => {
        try {
          const response = await fetch('http://127.0.0.1:4173/');
          if (response.ok) { clearInterval(timer); resolve(); }
        } catch (_) {}
        if (Date.now() - started > 15000) { clearInterval(timer); reject(new Error('Local test server did not start')); }
      }, 250);
    });

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto('http://127.0.0.1:4173/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!document.querySelector('#calendarGrid') && typeof renderCalendar === 'function', null, { timeout: 20000 });

    // Seed local data, then prove the installed Service Worker can reopen the app offline.
    await page.evaluate(() => {
      appData.appointments = [{ id:'qa-offline-seed', dateKey:getTodayKey(), time:'09:00', clientName:'آزمایش آفلاین', phone:'09120000000', service:'تست', price:0, deposit:0, status:'pending' }];
      saveData();
    });
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 });
    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!document.querySelector('#calendarGrid'), null, { timeout: 15000 });
    const offline = await page.evaluate(() => ({
      online: navigator.onLine,
      seed: appData.appointments.some(a => a.id === 'qa-offline-seed'),
      stored: JSON.parse(localStorage.getItem('dastyare_man_final_v7') || '{}').appointments?.some(a => a.id === 'qa-offline-seed')
    }));
    assert.strictEqual(offline.online, false, 'Browser must be offline during offline smoke test');
    assert(offline.seed && offline.stored, 'App and local data must remain available offline');
    await context.setOffline(false);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!document.querySelector('#calendarGrid'));

    // CRUD: create, edit and delete an appointment through the app's own form handlers.
    const appointmentResult = await page.evaluate(() => {
      const set = (id, value) => { document.getElementById(id).value = value; };
      selectedDateKey = getTodayKey();
      set('editApptId', '');
      set('apptClientName', 'مشتری تست');
      set('apptPhone', '09121112233');
      set('apptTime', '11:30');
      set('apptService', 'کلاسیک');
      set('apptPrice', '750000');
      set('apptDeposit', '0');
      set('apptCommPercent', '0');
      set('apptPayMethod', 'کارت‌به‌کارت');
      set('apptAlarm', '15');
      set('apptStatus', 'pending');
      set('apptNextFollowup', '0');
      saveAppointment();
      const created = appData.appointments.find(a => a.clientName === 'مشتری تست');
      if (!created) return { created:false };
      set('editApptId', created.id);
      set('apptClientName', 'مشتری تست ویرایش‌شده');
      set('apptTime', '12:00');
      saveAppointment();
      const edited = appData.appointments.find(a => a.id === created.id);
      const editOk = edited?.clientName === 'مشتری تست ویرایش‌شده' && edited?.time === '12:00';
      window.confirm = () => true;
      deleteAppointment(created.id);
      return { created:true, editOk, deleted:!appData.appointments.some(a => a.id === created.id) };
    });
    assert(appointmentResult.created && appointmentResult.editOk && appointmentResult.deleted, 'Appointment create/edit/delete failed');

    // Duplicate prevention: the same client cannot be booked twice at the same date and time.
    const duplicateResult = await page.evaluate(() => {
      const set = (id, value) => { document.getElementById(id).value = value; };
      appData.appointments = [];
      selectedDateKey = getTodayKey();
      const fill = () => {
        set('editApptId', '');
        set('apptClientName', 'مشتری تکراری');
        set('apptPhone', '09123334455');
        set('apptTime', '14:00');
        set('apptService', 'والیوم');
        set('apptPrice', '800000');
        set('apptDeposit', '0');
        set('apptCommPercent', '0');
        set('apptPayMethod', 'کارت‌به‌کارت');
        set('apptAlarm', '15');
        set('apptStatus', 'pending');
        set('apptNextFollowup', '0');
      };
      fill(); saveAppointment();
      fill(); saveAppointment();
      return appData.appointments.filter(a => a.phone === '09123334455' && a.time === '14:00').length;
    });
    assert.strictEqual(duplicateResult, 1, 'Duplicate appointment was not blocked');

    // Client CRUD: create profile, rename/update phone, then delete it.
    const clientResult = await page.evaluate(async () => {
      document.getElementById('newClientName').value = 'مشتری پرونده تست';
      document.getElementById('newClientPhone').value = '09129998877';
      createClientProfile();
      const oldKey = '09129998877';
      const exists = !!appData.clientProfiles[oldKey];
      document.getElementById('editClientOriginalKey').value = oldKey;
      document.getElementById('editClientName').value = 'مشتری پرونده ویرایش';
      document.getElementById('editClientPhone').value = '09129998878';
      saveEditedClient();
      const newKey = '09129998878';
      const edited = !!appData.clientProfiles[newKey] && appData.clientProfiles[newKey].name === 'مشتری پرونده ویرایش';
      window.confirm = () => true;
      await deleteClient(newKey);
      return { exists, edited, deleted:!appData.clientProfiles[newKey] };
    });
    assert(clientResult.exists && clientResult.edited && clientResult.deleted, 'Client create/edit/delete failed');

    // Backup round trip: export a valid JSON backup, clear the data, then restore it.
    await page.evaluate(() => {
      appData.appointments = [{ id:'qa-backup-appt', dateKey:getTodayKey(), time:'15:00', clientName:'مشتری پشتیبان', phone:'09127776655', service:'تست بازیابی', price:123, status:'pending' }];
      appData.notes = [{ id:'qa-backup-note', title:'یادداشت بازیابی', body:'داده آزمایشی' }];
      saveData();
    });
    const downloadPromise = page.waitForEvent('download');
    await page.evaluate(() => exportBackup());
    const download = await downloadPromise;
    const downloadPath = await download.path();
    assert(downloadPath && fs.statSync(downloadPath).size > 0, 'Backup export did not create a file');
    const exported = JSON.parse(fs.readFileSync(downloadPath, 'utf8'));
    assert(exported.appointments.some(a => a.id === 'qa-backup-appt'), 'Export omitted appointment data');
    assert(exported.notes.some(n => n.id === 'qa-backup-note'), 'Export omitted notes');

    await page.evaluate(() => { appData.appointments=[]; appData.notes=[]; saveData(); });
    const backupInput = page.locator('input[type="file"][accept=".json"]');
    await backupInput.setInputFiles({ name:'qa-restore.json', mimeType:'application/json', buffer:Buffer.from(JSON.stringify(exported)) });
    await page.waitForFunction(() => appData.appointments.some(a => a.id === 'qa-backup-appt') && appData.notes.some(n => n.id === 'qa-backup-note'), null, { timeout: 15000 });
    const restored = await page.evaluate(() => JSON.parse(localStorage.getItem('dastyare_man_final_v7') || '{}').appointments?.some(a => a.id === 'qa-backup-appt'));
    assert(restored, 'Restored data was not persisted to local storage');

    // A malformed backup must be rejected without replacing the valid restored state.
    const malformed = { appointments:'not-an-array' };
    const acceptedMalformed = await page.evaluate(value => validateBackupData(value), malformed);
    assert.strictEqual(acceptedMalformed, false, 'Malformed backup passed validation');

    assert.deepStrictEqual(pageErrors, [], 'Uncaught browser errors were reported');
    console.log(JSON.stringify({
      result:'PASS',
      checks:[
        'offline app launch and local data persistence',
        'appointment create/edit/delete',
        'duplicate appointment prevention',
        'client create/edit/delete',
        'backup export and restore round-trip',
        'malformed backup validation'
      ],
      offline,
      appointmentResult,
      duplicateResult,
      clientResult,
      backupBytes:fs.statSync(downloadPath).size
    }, null, 2));
    await context.close();
  } catch (error) {
    console.error(error.stack || String(error));
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})();
