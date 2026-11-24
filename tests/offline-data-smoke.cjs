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

    // Birthday deletion removes only the birthday date and its own reminder;
    // the customer profile and appointments must remain untouched.
    page.once('dialog', dialog => dialog.accept());
    const birthdayDeleteQA = await page.evaluate(() => {
      const key = clientKeyFromFields('09120001122', 'مشتری تست تولد');
      appData.clientProfiles = appData.clientProfiles || {};
      appData.clientProfiles[key] = { name:'مشتری تست تولد', phone:'09120001122', birthDate:'1370-05-21', birthdayAlertYear:'1405', records:[] };
      appData.appointments = appData.appointments || [];
      appData.appointments.push({ id:'qa-birthday-preserve-appt', dateKey:getTodayKey(), time:'17:15', clientName:'مشتری تست تولد', phone:'09120001122', service:'کاشت ناخن', status:'pending' });
      appData.reminders = appData.reminders || [];
      appData.reminders.push({ id:'qa-birthday-reminder', date:getTodayKey(), time:'09:00', message:'یادآوری تولد آزمایشی', birthdayClientKey:key, birthdayYear:1405 });
      renderClientBirthdays();
      deleteClientBirthday(key);
      return {
        birthDate:appData.clientProfiles[key].birthDate,
        profileExists:!!appData.clientProfiles[key],
        appointmentExists:appData.appointments.some(a=>a.id==='qa-birthday-preserve-appt'),
        birthdayReminderExists:appData.reminders.some(a=>a.id==='qa-birthday-reminder')
      };
    });
    assert.strictEqual(birthdayDeleteQA.birthDate, '', 'Birthday deletion must clear only the birth date');
    assert(birthdayDeleteQA.profileExists, 'Birthday deletion must preserve the customer profile');
    assert(birthdayDeleteQA.appointmentExists, 'Birthday deletion must preserve customer appointments');
    assert(!birthdayDeleteQA.birthdayReminderExists, 'Birthday deletion must cancel the birthday reminder');
    console.log('Birthday deletion safety:', JSON.stringify(birthdayDeleteQA));

    // Custom services support edit and delete without rewriting historical appointments.
    const serviceEditQA = await page.evaluate(() => {
      appData.services = [{ id:'qa-service-edit', name:'خدمت آزمایشی' }];
      appData.appointments = appData.appointments || [];
      appData.appointments.push({ id:'qa-service-history', dateKey:getTodayKey(), time:'12:00', clientName:'مشتری تاریخی', service:'خدمت آزمایشی', status:'done' });
      renderServicesTab();
      return { row:document.getElementById('customServicesList')?.textContent || '', history:appData.appointments.find(a=>a.id==='qa-service-history')?.service };
    });
    assert(serviceEditQA.row.includes('ویرایش') && serviceEditQA.row.includes('حذف'), 'Custom service row must expose edit and delete actions');
    assert.strictEqual(serviceEditQA.history, 'خدمت آزمایشی', 'Service management must preserve historical appointment text');
    page.once('dialog', dialog => { assert.strictEqual(dialog.type(), 'prompt'); dialog.accept('خدمت آزمایشی جدید'); });
    await page.evaluate(() => editCustomService('qa-service-edit'));
    const renamedService = await page.evaluate(() => appData.services.find(s=>s.id==='qa-service-edit')?.name);
    assert.strictEqual(renamedService, 'خدمت آزمایشی جدید', 'Custom service edit must save the new title');

    // Responsive integration audit across phone, tablet and desktop viewports.
    const responsiveFailures = [];
    for (const width of [320, 360, 390, 430, 768, 1024, 1366]) {
      await page.setViewportSize({ width, height: width < 500 ? 800 : 900 });
      for (const tab of ['calendar', 'notebook', 'clients', 'messages', 'mina', 'settings']) {
        await page.evaluate(tabName => {
          document.querySelectorAll('.tab-section').forEach(section => section.classList.remove('active'));
          document.getElementById('tab-' + tabName)?.classList.add('active');
          document.querySelectorAll('.nav-item').forEach(button => button.classList.toggle('active', button.getAttribute('onclick')?.includes("'" + tabName + "'")));
        }, tab);
        const layout = await page.evaluate(() => {
          const width = document.documentElement.clientWidth;
          const docWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
          const outside = [...document.querySelectorAll('button, input, select, textarea, .card')]
            .filter(el => {
              const style = getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden') return false;
              const rect = el.getBoundingClientRect();
              if (!rect.width || !rect.height) return false;
              // Horizontal filter rows are allowed to scroll when not in compact wrap mode.
              if (el.closest('.filter-pills') && getComputedStyle(el.closest('.filter-pills')).overflowX === 'auto') return false;
              return rect.left < -2 || rect.right > width + 2;
            }).slice(0, 4).map(el => ({ tag:el.tagName, id:el.id, cls:String(el.className).slice(0,40) }));
          return { width, docWidth, outside };
        });
        if (layout.docWidth > width + 1 || layout.outside.length) responsiveFailures.push({ width, tab, ...layout });
      }
    }

    // Measure the customer file sheet at compact phone, standard phone,
    // tablet and desktop widths without mutating customer data.
    for (const width of [320, 360, 390, 430, 768, 1366]) {
      await page.setViewportSize({ width, height: width < 500 ? 800 : 900 });
      const profileLayout = await page.evaluate(() => {
        const backdrop = document.getElementById('clientProfileModal');
        backdrop.classList.add('open');
        const modal = backdrop.querySelector('.modal-box');
        const rect = modal.getBoundingClientRect();
        const viewportWidth = document.documentElement.clientWidth;
        const footerButtons = [...document.querySelectorAll('#clientShareActions button')].map(b => {
          const r = b.getBoundingClientRect();
          return { text:b.textContent.trim(), left:r.left, right:r.right, height:r.height };
        });
        const result = { width:viewportWidth, modalLeft:rect.left, modalRight:rect.right,
          modalWidth:rect.width, modalScrollWidth:modal.scrollWidth, modalClientWidth:modal.clientWidth,
          footerButtons };
        backdrop.classList.remove('open');
        return result;
      });
      if (profileLayout.modalLeft < -1 || profileLayout.modalRight > width + 1 ||
          profileLayout.modalWidth <= 0 || profileLayout.modalScrollWidth > profileLayout.modalClientWidth + 2 ||
          profileLayout.footerButtons.some(b => b.left < -1 || b.right > width + 1 || b.height < 38)) {
        responsiveFailures.push({ width, tab:'client-profile', ...profileLayout });
      }
    }
    assert.deepStrictEqual(responsiveFailures, [], 'Responsive layout overflow or clipped controls detected: ' + JSON.stringify(responsiveFailures));
    console.log('Responsive layout audit:', JSON.stringify({ widths:[320,360,390,430,768,1024,1366], tabs:6, profile:true, failures:responsiveFailures.length }));

    // Customer directory must show each client's nearest upcoming appointment
    // date and exact time directly on the customer row, without opening the profile.
    const customerAppointmentSummary = await page.evaluate(() => {
      const today = getTodayKey();
      const clientName = 'مینا تست فهرست';
      const phone = '09129998877';
      const key = clientKeyFromFields(phone, clientName);
      appData.clientProfiles = appData.clientProfiles || {};
      appData.clientProfiles[key] = { name:clientName, phone, records:[] };
      appData.appointments = [
        { id:'qa-client-next-later', dateKey:today, time:'18:20', clientName, phone, service:'رنگ مو', status:'pending' },
        { id:'qa-client-next-first', dateKey:today, time:'16:43', clientName, phone, service:'کوتاهی مو', status:'pending' },
        { id:'qa-client-canceled', dateKey:today, time:'15:00', clientName, phone, service:'لغوشده', status:'canceled' },
        { id:'qa-client-done', dateKey:today, time:'14:00', clientName, phone, service:'انجام‌شده', status:'done' }
      ];
      renderClientsTab();
      const card = [...document.querySelectorAll('#clientsListContainer > div')].find(el => el.textContent.includes(clientName));
      return {
        found:!!card,
        visibleText:card?.textContent || '',
        expectedDate:formatJalaliFull(today),
        expectedTime:toPersianDigits('16:43'),
        laterTime:toPersianDigits('18:20')
      };
    });
    assert(customerAppointmentSummary.found, 'Customer must appear in the customer directory');
    assert(customerAppointmentSummary.visibleText.includes(customerAppointmentSummary.expectedDate), 'Customer row must show the appointment date');
    assert(customerAppointmentSummary.visibleText.includes(customerAppointmentSummary.expectedTime), 'Customer row must show the exact nearest appointment time');
    assert(customerAppointmentSummary.visibleText.includes('کوتاهی مو'), 'Customer row must show the nearest appointment service');
    assert(!customerAppointmentSummary.visibleText.includes('لغوشده') && !customerAppointmentSummary.visibleText.includes('انجام‌شده'), 'Canceled and completed appointments must not appear as upcoming');
    console.log('Customer appointment summary:', JSON.stringify(customerAppointmentSummary));

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

    // Mina Persian natural-language booking: clear commands save immediately,
    // with or without a client name; ask only when a required detail is missing.
    const minaBookingResult = await page.evaluate(() => {
      appData.appointments = [];
      minaPendingBooking = null;
      const noNameReply = minaBuildReply('برای پس فردا ۲ بعد از ظهر نوبت کاشت مژه رو ثبت کن');
      const noName = appData.appointments[0];
      const noNameOk = !!noName && noName.clientNameMissing === true &&
        noName.time === '14:00' && noName.service.includes('کاشت مژه') &&
        !String(noName.clientName).includes('پس');
      appData.appointments = [];
      minaPendingBooking = null;
      const namedReply = minaBuildReply('برای مینا پس فردا ۲ ظهر نوبت کاشت مژه ثبت کن');
      const named = appData.appointments[0];
      const namedOk = !!named && named.clientName === 'مینا' &&
        named.time === '14:00' && named.service.includes('کاشت مژه') && !minaPendingBooking;
      appData.appointments = [];
      const naturalTomorrowReply = minaBuildReply('برای فردا ساعت ۴ بعد از ظهر نوبت لیفت مژه انجام بده');
      const naturalTomorrow = appData.appointments[0];
      const naturalTomorrowOk = !!naturalTomorrow &&
        naturalTomorrow.dateKey > getTodayKey() &&
        naturalTomorrow.time === '16:00' &&
        naturalTomorrow.service.includes('لیفت مژه') &&
        naturalTomorrow.clientNameMissing === true &&
        /نوبتت ثبت شد/.test(naturalTomorrowReply);
      appData.appointments = [];
      minaPendingBooking = null;
      appData.appointments = [];
      minaConversationBooking = null;
      const spokenTimeReply = minaBuildReply('برای فردا پنج و نیم بعد از ظهر نوبت لیفت ابرو را ثبت کن');
      const spokenTimeAppt = appData.appointments[0];
      const spokenTimeOk = !!spokenTimeAppt && spokenTimeAppt.time === '17:30' &&
        spokenTimeAppt.service.includes('لیفت ابرو') && minaIsAssistantAppointment(spokenTimeAppt);
      appData.appointments = [];
      minaConversationBooking = null;
      const exactUserCommandReply = minaBuildReply('برای فردا ساعت ۵:۳۰ بعد از ظهر برای مینا لیفت ابرو را ثبت کن');
      const exactUserCommandAppt = appData.appointments[0];
      const exactUserCommandOk = !!exactUserCommandAppt && exactUserCommandAppt.clientName === 'مینا' &&
        exactUserCommandAppt.time === '17:30' && exactUserCommandAppt.service.includes('لیفت ابرو') &&
        minaIsAssistantAppointment(exactUserCommandAppt) && /نوبتت ثبت شد/.test(exactUserCommandReply);
      appData.appointments = [];
      const broadBeautyReply = minaBuildReply('برای فردا ۲ بعد از ظهر برای مینا برای کوتاهی مو نوبت بده');
      const broadBeautyAppt = appData.appointments[0];
      const broadBeautyServiceOk = !!broadBeautyAppt && broadBeautyAppt.clientName === 'مینا' &&
        broadBeautyAppt.time === '14:00' && broadBeautyAppt.service.includes('کوتاهی مو') &&
        minaIsAssistantAppointment(broadBeautyAppt) && /نوبتت ثبت شد/.test(broadBeautyReply);
      appData.appointments = [];
      minaConversationBooking = null;
      const firstTurnReply = minaBuildReply('برای فردا نوبت لیفت ابرو ثبت کن');
      const followupReply = minaBuildReply('برای ساعت پنج و نیم بعد از ظهر');
      const followupAppt = appData.appointments[0];
      const conversationalFollowupOk = /ساعت/.test(firstTurnReply) && !!followupAppt &&
        followupAppt.time === '17:30' && followupAppt.service.includes('لیفت ابرو') &&
        followupAppt.createdBy === 'mina';
      selectedDateKey = followupAppt ? followupAppt.dateKey : getTodayKey();
      renderDaySchedule();
      const calendarSourceLabelOk = document.getElementById('dayAppointmentsBody').innerHTML.includes('ثبت با مینا');
      appData.appointments = [];
      minaConversationBooking = null;
      const missingTimeReply = minaBuildReply('برای پس فردا نوبت کاشت مژه ثبت کن');
      const missingTimeOk = appData.appointments.length === 0 &&
        /ساعت/.test(missingTimeReply) && !!minaConversationBooking;
      return { noNameOk, namedOk, naturalTomorrowOk, spokenTimeOk, exactUserCommandOk, broadBeautyServiceOk, broadBeautyReply, broadBeautyAppt, exactUserCommandReply, exactUserCommandAppt, spokenTimeReply, conversationalFollowupOk, firstTurnReply, followupReply, calendarSourceLabelOk, missingTimeOk, noNameReply, namedReply, missingTimeReply };
    });
    console.log('Mina regression details:', JSON.stringify(minaBookingResult));
    assert(minaBookingResult.noNameOk, 'Mina must save a no-name booking immediately and parse date/time/service');
    assert(minaBookingResult.namedOk, 'Mina must save a named booking immediately without confirmation');
    assert(minaBookingResult.naturalTomorrowOk, 'Mina must understand “انجام بده” and save tomorrow 4 PM lash-lift booking without a client name');
    assert(minaBookingResult.spokenTimeOk, 'Mina must parse Persian spoken half-hour times and tag the appointment as assistant-created');
    assert(minaBookingResult.exactUserCommandOk, 'Mina must parse the exact natural-language command with 5:30 PM and client name after the date');
    assert(minaBookingResult.broadBeautyServiceOk, 'Mina must book general beauty salon services such as haircut and extract the client name');
    assert(minaBookingResult.conversationalFollowupOk, 'Mina must carry booking context into a time-only follow-up turn');
    assert(minaBookingResult.calendarSourceLabelOk, 'Calendar day schedule must visibly label Mina-created appointments');
    assert(minaBookingResult.missingTimeOk, 'Mina must ask only for a missing required time');

    // Simulate app exit: pagehide flushes in-memory data and reopening restores it.
    await page.evaluate(() => {
      appData.appointments = [{ id:'qa-exit-persist', dateKey:getTodayKey(), time:'16:30',
        clientName:'ماندگاری بعد خروج', service:'کوتاهی مو', status:'pending' }];
      window.dispatchEvent(new Event('pagehide'));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!document.querySelector('#calendarGrid'));
    const exitPersistence = await page.evaluate(() => appData.appointments.some(a =>
      a.id === 'qa-exit-persist' && a.clientName === 'ماندگاری بعد خروج'));
    assert(exitPersistence, 'Appointments must survive app exit/pagehide and reopening');

    // Corrupt browser storage must recover the complete Android-private snapshot,
    // not silently start with blank data or overwrite the only good copy.
    const nativeBackupRecovery = await page.evaluate(() => {
      const snapshot = {
        appointments: [{ id:'qa-native-recovery', dateKey:getTodayKey(), time:'13:00', clientName:'بازیابی اندروید', service:'کوتاهی مو', status:'pending' }],
        notes: [{ id:'qa-native-note', title:'یادداشت پشتیبان', body:'نباید پاک شود' }],
        todos: [{ id:'qa-native-todo', text:'کار پشتیبان', done:false }],
        transactions: [], services: [], clientNotes: {}, clientProfiles: {}, settings: {}
      };
      localStorage.setItem(STORAGE_KEY, '{invalid-json');
      window.AndroidApp = { getLatestBackup: () => JSON.stringify(snapshot) };
      appData.appointments = [];
      appData.notes = [];
      appData.todos = [];
      loadData();
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      const result = {
        appointment: appData.appointments.some(a => a.id === 'qa-native-recovery'),
        note: appData.notes.some(n => n.id === 'qa-native-note'),
        todo: appData.todos.some(t => t.id === 'qa-native-todo'),
        browserRepaired: stored.appointments?.some(a => a.id === 'qa-native-recovery')
      };
      delete window.AndroidApp;
      return result;
    });
    assert(nativeBackupRecovery.appointment && nativeBackupRecovery.note &&
      nativeBackupRecovery.todo && nativeBackupRecovery.browserRepaired,
      'Corrupt browser storage must recover all user data from Android private backup');

    // Destructive checklist actions require an explicit confirmation.
    const todoDeleteGuard = await page.evaluate(() => {
      appData.todos = [{ id:'qa-delete-guard', text:'نباید خودکار حذف شود', done:false }];
      const originalConfirm = window.confirm;
      window.confirm = () => false;
      deleteTodo('qa-delete-guard');
      const keptAfterCancel = appData.todos.some(t => t.id === 'qa-delete-guard');
      window.confirm = originalConfirm;
      return keptAfterCancel;
    });
    assert(todoDeleteGuard, 'Checklist data must remain when the user cancels deletion');

    // Voice-to-Mina integration: verify the APK bridge handoff and the complete
    // transcript -> Mina command -> local appointment path in the browser harness.
    const speechBridgeResult = await page.evaluate(async () => {
      appData.appointments = [];
      minaPendingBooking = null;
      const input = document.getElementById('minaInput');
      input.value = '';
      let nativeCall = null;
      window.AndroidApp = {
        startOfflineSpeechRecognition: (targetInputId, buttonId) => {
          nativeCall = { targetInputId, buttonId };
        }
      };
      startVoiceInput('minaInput', 'minaVoiceBtn');
      const buttonActive = document.getElementById('minaVoiceBtn').classList.contains('recording');
      window.receiveNativeSpeechResult('minaInput', 'برای پس فردا ۲ بعد از ظهر نوبت کاشت مژه رو ثبت کن');
      await new Promise(resolve => setTimeout(resolve, 350));
      const appointment = appData.appointments[0];
      const result = {
        bridgeCalled: nativeCall?.targetInputId === 'minaInput' && nativeCall?.buttonId === 'minaVoiceBtn',
        buttonActive,
        bookingCreated: !!appointment && appointment.time === '14:00' &&
          appointment.service.includes('کاشت مژه') && appointment.clientNameMissing === true,
        inputCleared: input.value === ''
      };
      delete window.AndroidApp;
      return result;
    });
    assert(speechBridgeResult.bridgeCalled && speechBridgeResult.buttonActive &&
      speechBridgeResult.bookingCreated && speechBridgeResult.inputCleared,
      'Native speech transcript did not flow into Mina and create the requested booking');

    const minaActionsResult = await page.evaluate(() => {
      minaConversationBooking = null;
      const dateKey = getTodayKey();
      appData.appointments = [
        { id:'mina-cancel-qa', dateKey, time:'09:00', clientName:'سارا', service:'کلاسیک', status:'pending' },
        { id:'mina-done-qa', dateKey, time:'10:00', clientName:'مریم', service:'لیفت مژه', status:'pending' },
        { id:'mina-move-qa', dateKey, time:'11:00', clientName:'علی', service:'والیوم', status:'pending' }
      ];
      const cancelReply = minaBuildReply('نوبت سارا رو کنسل کن');
      const cancelOk = appData.appointments.find(a => a.id === 'mina-cancel-qa')?.status === 'canceled';
      const doneReply = minaBuildReply('نوبت مریم انجام شد');
      const doneOk = appData.appointments.find(a => a.id === 'mina-done-qa')?.status === 'done';
      const moveReply = minaBuildReply('نوبت علی رو به ساعت ۵ عصر منتقل کن');
      const moved = appData.appointments.find(a => a.id === 'mina-move-qa');
      const moveOk = moved?.time === '17:00' && moveReply.includes('همان نوبت');
      const tomorrowKey = addDaysToJalaliKey(dateKey, 1);
      appData.appointments.push({ id:'appt_mina_qa_latest', createdBy:'mina', source:'mina', dateKey:tomorrowKey,
        time:'15:07', clientName:'⚠️ نام درج نشده (قابل تکمیل)', clientNameMissing:true,
        service:'کاشت ناخن', status:'pending' });
      const unnamedMoveReply = minaBuildReply('نوبت مینا رو بکن برای ساعت ۳:۱۰ بعدازظهر');
      const unnamedMoveOk = appData.appointments.find(a => a.id === 'appt_mina_qa_latest')?.time === '15:10';
      const exactMinuteReply = minaBuildReply('نوبت مینا رو بکن برای ساعت ۳ و ۷ دقیقه بعدازظهر');
      const exactMinuteOk = appData.appointments.find(a => a.id === 'appt_mina_qa_latest')?.time === '15:07';
      const minuteMoveReply = minaBuildReply('نوبت مینا رو بذار ساعت ۱۵:۴۳');
      const minuteMoveOk = appData.appointments.find(a => a.id === 'appt_mina_qa_latest')?.time === '15:43';
      const relativeMoveReply = minaBuildReply('نوبت مینا رو ببر یک ربع به ۳ بعدازظهر');
      const relativeMoveOk = appData.appointments.find(a => a.id === 'appt_mina_qa_latest')?.time === '14:45';
      const dateMoveReply = minaBuildReply('نوبت مینا رو بنداز پس فردا');
      const dateMoveOk = appData.appointments.find(a => a.id === 'appt_mina_qa_latest')?.dateKey === addDaysToJalaliKey(dateKey,2);
      appData.appointments.push({ id:'mina-cancel-verb-qa', dateKey, time:'12:00', clientName:'الهام', service:'کاشت ناخن', status:'pending' });
      const cancelVerbReply = minaBuildReply('کنسل کردن نوبت الهام');
      const cancelVerbOk = appData.appointments.find(a => a.id === 'mina-cancel-verb-qa')?.status === 'canceled';
      const deleteReply = minaBuildReply('نوبت سارا رو پاک کن');
      const deleteOk = !appData.appointments.some(a => a.id === 'mina-cancel-qa');
      const weekReply = minaBuildReply('برنامه هفت روز آینده');
      const weekOk = typeof weekReply === 'string' && (weekReply.includes('برنامه هفت روز آینده') || weekReply.includes('نوبتی ثبت نشده'));
      return { cancelOk, doneOk, deleteOk, cancelVerbOk, moveOk, unnamedMoveOk, exactMinuteOk, minuteMoveOk, relativeMoveOk, dateMoveOk, moveReply, unnamedMoveReply, minuteMoveReply, relativeMoveReply, dateMoveReply, weekOk, weekReply, weekNormalized:minaCleanText('برنامه هفت روز آینده'), weekAppointmentCount:appData.appointments.length, cancelReply, doneReply, deleteReply };
    });
    console.log('Mina action regression details:', JSON.stringify(minaActionsResult));
    assert(minaActionsResult.cancelOk && minaActionsResult.doneOk && minaActionsResult.deleteOk && minaActionsResult.cancelVerbOk && minaActionsResult.moveOk && minaActionsResult.unnamedMoveOk && minaActionsResult.exactMinuteOk && minaActionsResult.minuteMoveOk && minaActionsResult.relativeMoveOk && minaActionsResult.dateMoveOk && minaActionsResult.weekOk,
      'Mina must edit exact minutes and dates, cancel/delete/complete only the selected appointment, and preserve weekly reading');

    const exactTimeRegression = await page.evaluate(() => {
      minaConversationBooking = null;
      minaPendingBooking = null;
      appData.appointments = [];
      const exactReply = minaBuildReply('برای مشتری دقیقه‌ای فردا ساعت ۱۳:۴۳ نوبت رنگ مو ثبت کن');
      const exactAppt = appData.appointments[0];
      appData.appointments = [];
      const quarterReply = minaBuildReply('برای نازنین فردا یک ربع به ۳ ظهر نوبت کراتین مو ثبت کن');
      const quarterAppt = appData.appointments[0];
      appData.appointments = [{ id:'slot-taken', dateKey:getTodayKey(), time:'14:45', clientName:'مشتری اول', service:'کاشت ناخن', status:'pending' }];
      const conflictReply = minaBuildReply('برای سارا امروز یک ربع به ۳ ظهر نوبت کاشت مژه ثبت کن');
      return {
        exactTime: exactAppt?.time,
        exactOk: exactAppt?.time === '13:43',
        quarterTime: quarterAppt?.time,
        quarterOk: quarterAppt?.time === '14:45',
        conflictBlocked: appData.appointments.length === 1 && conflictReply.includes('قبلاً رزرو شده')
      };
    });
    console.log('Mina exact-time and salon conflict regression:', JSON.stringify(exactTimeRegression));
    assert(exactTimeRegression.exactOk && exactTimeRegression.quarterOk && exactTimeRegression.conflictBlocked,
      'Mina must understand exact minutes, quarter-to times, and reject cross-service time conflicts');

    const messageComposerResult = await page.evaluate(() => {
      document.getElementById('customerMessageType').value = 'discount';
      document.getElementById('customerMessageName').value = 'نازنین';
      document.getElementById('customerMessageDate').value = 'پنجشنبه';
      document.getElementById('customerMessageService').value = 'کراتین مو';
      document.getElementById('customerMessageDiscount').value = '۲۰٪';
      document.getElementById('customerMessageAddress').value = 'شهرک گلستان';
      renderCustomerMessagePreview();
      const message = document.getElementById('customerMessagePreview').value;
      let shared = null;
      window.AndroidApp = { shareText: (title, text) => { shared = { title, text }; } };
      sendCustomerMessage();
      const result = {
        tabExists: !!document.getElementById('tab-messages'),
        personalized: message.includes('نازنین') && message.includes('۲۰٪') && message.includes('شهرک گلستان'),
        noUnfilledTokens: !/\{(?:name|date|time|service|address|discount)\}/.test(message),
        androidShareChooser: shared?.text === message
      };
      delete window.AndroidApp;
      return result;
    });
    assert(messageComposerResult.tabExists && messageComposerResult.personalized &&
      messageComposerResult.noUnfilledTokens && messageComposerResult.androidShareChooser,
      'Customer message templates must personalize optional fields and use Android share chooser');

    const noLegacyFinance = await page.evaluate(() => ({
      noTransactions: !Object.prototype.hasOwnProperty.call(appData, 'transactions'),
      noFinanceTab: !document.querySelector('[id*="finance"]')
    }));
    assert(noLegacyFinance.noTransactions && noLegacyFinance.noFinanceTab,
      'Accounting/finance features must be removed from the app');

    // Static native Android guardrails: validated internet selects Android's normal
    // recognition service; Persian locale and microphone permission remain configured.
    const nativeJava = fs.readFileSync(path.join(__dirname, '../app/src/main/java/app/github/mmp1988/dastyareman/MainActivity.java'), 'utf8');
    assert(nativeJava.includes('SpeechRecognizer.isRecognitionAvailable(this)'), 'Android must check for the default speech recognition service');
    assert(nativeJava.includes('SpeechRecognizer.createSpeechRecognizer(this)'), 'Android online speech service is missing');
    assert(nativeJava.includes('RecognizerIntent.EXTRA_LANGUAGE, "fa-IR"'), 'Android speech locale must remain Persian');
    assert(nativeJava.includes('RecognizerIntent.EXTRA_PARTIAL_RESULTS, true'), 'Android speech should enable partial results');
    assert(nativeJava.includes('startSpeechRecognition(targetInputId, buttonId, false)'), 'Android must start the default recognizer without a strict network validation gate');
    assert(nativeJava.includes('Manifest.permission.RECORD_AUDIO'), 'Android microphone permission handling is missing');
    assert(nativeJava.includes('Intent.ACTION_SENDTO, smsUri'), 'Android must open the installed SMS app for prepared customer messages');
    assert(nativeJava.includes('Intent.ACTION_DIAL, uri'), 'Android must route phone links to the dialer');
    assert(nativeJava.includes('Intent.createChooser(sendIntent, "ارسال با...")'), 'Android must offer installed apps through the share chooser');

    // CRUD: create, edit and delete an appointment through the app's own form handlers.
    const appointmentResult = await page.evaluate(() => {
      const set = (id, value) => { document.getElementById(id).value = value; };
      selectedDateKey = getTodayKey();
      set('editApptId', '');
      set('apptClientName', 'مشتری تست');
      set('apptPhone', '09121112233');
      set('apptTime', '11:30');
      set('apptService', 'کلاسیک');
      set('apptNotes', 'یادداشت تست نوبت');
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
      return { created:true, editOk, notesSaved:edited?.notes === 'یادداشت تست نوبت', deleted:!appData.appointments.some(a => a.id === created.id) };
    });
    assert(appointmentResult.created && appointmentResult.editOk && appointmentResult.notesSaved && appointmentResult.deleted, 'Appointment create/edit/delete/notes failed');

    // Salon-wide exclusivity: two different customers/services cannot share one date and time.
    const duplicateResult = await page.evaluate(() => {
      const set = (id, value) => { document.getElementById(id).value = value; };
      appData.appointments = [];
      selectedDateKey = getTodayKey();
      const fill = (name, phone, service) => {
        set('editApptId', '');
        set('apptClientName', name);
        set('apptPhone', phone);
        set('apptTime', '14:00');
        set('apptService', service);
        set('apptNotes', '');
        set('apptAlarm', '15');
        set('apptStatus', 'pending');
        set('apptNextFollowup', '0');
      };
      fill('مشتری اول', '09123334455', 'والیوم'); saveAppointment();
      fill('مشتری دوم', '09125556677', 'کراتین مو'); saveAppointment();
      return appData.appointments.filter(a => a.dateKey === selectedDateKey && a.time === '14:00' && a.status !== 'canceled').length;
    });
    assert.strictEqual(duplicateResult, 1, 'Salon-wide same-time appointment conflict was not blocked');

    // Client CRUD: create profile, rename/update phone, then delete it.
    const clientResult = await page.evaluate(async () => {
      document.getElementById('newClientName').value = 'مشتری پرونده تست';
      document.getElementById('newClientPhone').value = '09129998877';
      createClientProfile();
      const oldKey = '09129998877';
      const exists = !!appData.clientProfiles[oldKey];
      document.getElementById('newClientName').value = 'نام تکراری';
      document.getElementById('newClientPhone').value = '09129998877';
      createClientProfile();
      const duplicateBlocked = Object.keys(appData.clientProfiles).filter(k => k === oldKey).length === 1 &&
        appData.clientProfiles[oldKey]?.name === 'مشتری پرونده تست';
      document.getElementById('editClientOriginalKey').value = oldKey;
      document.getElementById('editClientName').value = 'مشتری پرونده ویرایش';
      document.getElementById('editClientPhone').value = '09129998878';
      saveEditedClient();
      const newKey = '09129998878';
      const edited = !!appData.clientProfiles[newKey] && appData.clientProfiles[newKey].name === 'مشتری پرونده ویرایش';
      window.confirm = () => true;
      await deleteClient(newKey);
      return { exists, duplicateBlocked, edited, deleted:!appData.clientProfiles[newKey] };
    });
    console.log('Client CRUD diagnostic:', JSON.stringify(clientResult));
    assert(clientResult.exists && clientResult.duplicateBlocked && clientResult.edited && clientResult.deleted, 'Client create/edit/delete or duplicate prevention failed');

    // Backup round trip: export a valid JSON backup, clear the data, then restore it.
    await page.evaluate(async () => {
      appData.appointments = [{ id:'qa-backup-appt', dateKey:getTodayKey(), time:'15:00', clientName:'مشتری پشتیبان', phone:'09127776655', service:'تست بازیابی', price:123, status:'pending' }];
      appData.notes = [{ id:'qa-backup-note', title:'یادداشت بازیابی', body:'داده آزمایشی' }];
      appData.clientProfiles = { 'qa-photo-client': { name:'مشتری عکس‌دار', phone:'09120001122', photoRef:'qa-photo-ref', records:[] } };
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII='), ch => ch.charCodeAt(0));
      const db = await openClientPhotoDB();
      await new Promise((resolve,reject) => {
        const tx = db.transaction('photos','readwrite');
        tx.objectStore('photos').put(new Blob([bytes],{type:'image/png'}),'qa-photo-ref');
        tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error);
      });
      db.close();
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
    assert(exported._photoArchive?.some(photo => photo.id === 'qa-photo-ref' && photo.data.startsWith('data:image/png')), 'Export omitted customer photo archive');

    await page.evaluate(async () => {
      appData.appointments=[]; appData.notes=[]; appData.clientProfiles={}; saveData();
      const db=await openClientPhotoDB();
      await new Promise((resolve,reject)=>{const tx=db.transaction('photos','readwrite');tx.objectStore('photos').delete('qa-photo-ref');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});
      db.close();
    });
    const backupInput = page.locator('input[type="file"][accept=".json"]');
    await backupInput.setInputFiles({ name:'qa-restore.json', mimeType:'application/json', buffer:Buffer.from(JSON.stringify(exported)) });
    await page.waitForFunction(() => appData.appointments.some(a => a.id === 'qa-backup-appt') && appData.notes.some(n => n.id === 'qa-backup-note'), null, { timeout: 15000 });
    const restored = await page.evaluate(async () => {
      const stored = JSON.parse(localStorage.getItem('dastyare_man_final_v7') || '{}');
      const photo = await getClientPhotoBlob('qa-photo-ref');
      return { appointment:stored.appointments?.some(a => a.id === 'qa-backup-appt'), photo:!!photo && photo.type==='image/png' && photo.size>0, profile:stored.clientProfiles?.['qa-photo-client']?.photoRef==='qa-photo-ref' };
    });
    assert(restored.appointment && restored.photo && restored.profile, 'Restored appointment, client photo, or photo reference was not persisted');

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
        'backup export and restore round-trip including customer photos',
        'malformed backup validation',
        'Android Persian online speech configuration and native bridge handoff into Mina',
        'Mina booking from speech transcript',
        'Mina cancel/complete/reschedule/weekly schedule commands'
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
