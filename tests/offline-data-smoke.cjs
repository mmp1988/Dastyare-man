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
    // Allow the first-install Service Worker controllerchange refresh to settle before browser interactions.
    await page.waitForTimeout(1500);
    await page.waitForFunction(() => !!document.querySelector('#calendarGrid') && typeof renderCalendar === 'function', null, { timeout: 20000 });

    // The redesigned appointment form must expose and persist an editable Jalali visit date.
    const appointmentDateFormQA = await page.evaluate(() => {
      selectedDateKey = getTodayKey();
      openApptModal();
      const field = document.getElementById('apptDate');
      const initialDate = field?.value || '';
      const target = addDaysToJalaliKey(getTodayKey(), 3);
      field.value = toPersianDigits(target.replace(/-/g, '/'));
      const accepted = updateAppointmentDate(true);
      const updatedDate = selectedDateKey;
      field.value = '۱۴۰۵/۱۳/۴۰';
      const invalidRejected = !updateAppointmentDate(false);
      closeModal('apptModal');
      return {
        visible: !!field && !!document.querySelector('label[for="apptDate"]'),
        initialDateMatchesSelectedDay: initialDate === toPersianDigits(getTodayKey().replace(/-/g, '/')),
        validDateAccepted: accepted && updatedDate === target,
        invalidDateRejected: invalidRejected
      };
    });
    assert(appointmentDateFormQA.visible && appointmentDateFormQA.initialDateMatchesSelectedDay &&
      appointmentDateFormQA.validDateAccepted && appointmentDateFormQA.invalidDateRejected,
      'Appointment form must show its default Jalali date, accept a changed date, and reject invalid dates');

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

    // Top-to-bottom hierarchy audit for all six visible pages. The main action
    // on each page must appear before secondary tools, with no duplicate tab.
    const sixPageHierarchyQA = await page.evaluate(() => {
      const ids = [...document.querySelectorAll('main > .tab-section')].map(el => el.id.replace('tab-',''));
      const nav = [...document.querySelectorAll('.bottom-nav .nav-item')].map(el => el.textContent.trim());
      const position = (root, selector) => {
        const node = root.querySelector(selector);
        return node ? [...root.querySelectorAll('*')].indexOf(node) : -1;
      };
      const home = document.getElementById('tab-calendar');
      const clients = document.getElementById('tab-clients');
      const mina = document.getElementById('tab-mina');
      const notebook = document.getElementById('tab-notebook');
      const messages = document.getElementById('tab-messages');
      const settings = document.getElementById('tab-settings');
      const ordered = (root, selectors) => {
        const values = selectors.map(sel => position(root, sel));
        return values.every((v,i) => v >= 0 && (i === 0 || v > values[i-1]));
      };
      return {
        pageOrder:ids.join(',') === 'calendar,clients,mina,notebook,messages,settings',
        navCount:nav.length === 6 && ['خانه','مشتریان','مینا','یادداشت‌ها','پیام‌ها','شخصی‌سازی'].every((label,i) => nav[i].includes(label)),
        noDuplicateAppointmentsPage:!document.getElementById('tab-appointments') && !!home?.contains(document.getElementById('allAppointmentsPanel')),
        homePriority:ordered(home,['#homeWelcomeCard','.home-appointment-stats','.cal-header','#smartDashboard','#selectedDateLabel','#allAppointmentsPanel']),
        clientsPriority:ordered(clients,['#clientsListContainer','#clientBirthdaysCard','#customServicesList']),
        minaPriority:ordered(mina,['.mina-hero','.mina-chat-card','.mina-suggestions']),
        notebookPriority:ordered(notebook,['#notesListContainer','#todoListContainer','#personalReminderList']),
        messagesPriority:ordered(messages,['#customerMessageType','#customerMessagePreview','.mina-suggestions']),
        settingsPriority:ordered(settings,['#officialContactCard','.mina-personalize-card','#settingAppPin','#appDirectUrlText']),
        noFloatingDuplicateActions:!document.getElementById('fabMenu') && !document.querySelector('.fab-btn'),
        minaConfidentVoice:!mina.textContent.includes('رفیق کوچولوت') && mina.textContent.includes('دستیار هوشمند')
      };
    });
    assert(Object.values(sixPageHierarchyQA).every(Boolean),
      'Six-page top-to-bottom hierarchy or duplicate-section audit failed: ' + JSON.stringify(sixPageHierarchyQA));
    console.log('Six-page hierarchy:', JSON.stringify(sixPageHierarchyQA));

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
    const spokenClockUpgrade = await page.evaluate(() => ({
      spokenHourMinute: minaParseReminderClock('ساعت پانزده و چهل و سه دقیقه'),
      spokenRelativeBefore: minaParseReminderClock('بیست دقیقه به سه بعدازظهر'),
      spokenRelativeAfter: minaParseReminderClock('هفت دقیقه بعد از سه بعدازظهر'),
      midnight: minaParseReminderClock('دوازده شب'),
      invalidMinute: minaParseReminderClock('ساعت ۱۳:۶۰')
    }));
    assert(spokenClockUpgrade.spokenHourMinute === '15:43', 'Mina must parse Persian number words for exact hour/minute values');
    assert(spokenClockUpgrade.spokenRelativeBefore === '14:40', 'Mina must parse spoken minute offsets before an afternoon hour');
    assert(spokenClockUpgrade.spokenRelativeAfter === '15:07', 'Mina must parse spoken minute offsets after an afternoon hour');
    assert(spokenClockUpgrade.midnight === '00:00', 'Mina must interpret twelve at night as midnight');
    assert.strictEqual(spokenClockUpgrade.invalidMinute, null, 'Mina must reject invalid minute values without changing appointments');
    console.log('Mina spoken clock upgrade:', JSON.stringify(spokenClockUpgrade));

    console.log('Mina action regression details:', JSON.stringify(minaActionsResult));
    assert(minaActionsResult.cancelOk && minaActionsResult.doneOk && minaActionsResult.deleteOk && minaActionsResult.cancelVerbOk && minaActionsResult.moveOk && minaActionsResult.unnamedMoveOk && minaActionsResult.exactMinuteOk && minaActionsResult.minuteMoveOk && minaActionsResult.relativeMoveOk && minaActionsResult.dateMoveOk && minaActionsResult.weekOk,
      'Mina must edit exact minutes and dates, cancel/delete/complete only the selected appointment, and preserve weekly reading');

    const conversationalSafetyQA = await page.evaluate(() => {
      const today = getTodayKey();
      const tomorrow = addDaysToJalaliKey(today, 1);
      const dayAfter = addDaysToJalaliKey(today, 2);
      appData.appointments = [];
      minaConversationBooking = null;
      minaPendingBooking = null;
      const firstTurn = minaBuildReply('برای فردا نوبت رنگ مو برای سارا ثبت کن');
      const secondTurn = minaBuildReply('پانزده و چهل و سه دقیقه');
      const continued = appData.appointments.find(a => a.clientName === 'سارا');
      const multiTurnExactMinute = !!continued && continued.dateKey === tomorrow && continued.time === '15:43';

      appData.appointments = [
        { id:'qa-sara-today', dateKey:today, time:'09:00', clientName:'سارا', service:'کاشت ناخن', status:'pending' },
        { id:'qa-sara-tomorrow', dateKey:tomorrow, time:'10:00', clientName:'سارا', service:'رنگ مو', status:'pending' }
      ];
      const ambiguousDeleteReply = minaBuildReply('نوبت سارا رو پاک کن');
      const ambiguousDeleteSafe = appData.appointments.length === 2 &&
        appData.appointments.every(a => a.status !== 'canceled');

      const exactDateDeleteReply = minaBuildReply('نوبت سارا فردا رو پاک کن');
      const exactDateDeleteSafe = appData.appointments.some(a => a.id === 'qa-sara-today') &&
        !appData.appointments.some(a => a.id === 'qa-sara-tomorrow');

      appData.appointments = [
        { id:'qa-done-delete', dateKey:today, time:'11:00', clientName:'مریم', service:'لیفت مژه', status:'done' },
        { id:'qa-keep-other', dateKey:today, time:'12:00', clientName:'الهام', service:'کاشت ناخن', status:'pending' }
      ];
      const completedDeleteReply = minaBuildReply('نوبت مریم رو حذف کن');
      const completedDeleteSafe = !appData.appointments.some(a => a.id === 'qa-done-delete') &&
        appData.appointments.some(a => a.id === 'qa-keep-other');

      appData.appointments = [
        { id:'qa-unknown-keep', dateKey:today, time:'13:00', clientName:'الهام', service:'کاشت ناخن', status:'pending' }
      ];
      const unknownDeleteReply = minaBuildReply('نوبت ناشناس رو حذف کن');
      const unknownDeleteSafe = appData.appointments.length === 1 &&
        appData.appointments[0].id === 'qa-unknown-keep';

      appData.appointments = [
        { id:'qa-reminder-sara-1', dateKey:today, time:'09:00', clientName:'سارا', service:'کاشت ناخن', status:'pending' },
        { id:'qa-reminder-sara-2', dateKey:tomorrow, time:'10:00', clientName:'سارا', service:'رنگ مو', status:'pending' }
      ];
      const ambiguousReminder = minaFindReferencedAppointment('برای سارا یادآوری نوبت رو ساعت ۱۴ تنظیم کن');
      const reminderAmbiguitySafe = ambiguousReminder === null &&
        appData.appointments.every(a => !a.reminderEnabled);

      appData.appointments = [
        { id:'qa-move-destination', dateKey:tomorrow, time:'15:07', clientName:'سارا', service:'رنگ مو', status:'pending' }
      ];
      const moveDestinationReply = minaBuildReply('نوبت سارا رو بنداز پس فردا');
      const moveDestinationSafe = appData.appointments[0].dateKey === dayAfter;

      return {
        firstTurn, secondTurn, multiTurnExactMinute,
        ambiguousDeleteReply, ambiguousDeleteSafe,
        exactDateDeleteReply, exactDateDeleteSafe,
        completedDeleteReply, completedDeleteSafe,
        unknownDeleteReply, unknownDeleteSafe,
        reminderAmbiguitySafe,
        moveDestinationReply, moveDestinationSafe
      };
    });
    console.log('Mina conversational safety:', JSON.stringify(conversationalSafetyQA));
    assert(conversationalSafetyQA.multiTurnExactMinute,
      'Mina must preserve a booking when the exact spoken time arrives in the next message');
    assert(conversationalSafetyQA.ambiguousDeleteSafe,
      'Mina must never delete one of several same-customer appointments without a date/time');
    assert(conversationalSafetyQA.exactDateDeleteSafe,
      'Mina must select the appointment matching the explicitly named date');
    assert(conversationalSafetyQA.completedDeleteSafe,
      'Mina must be able to delete the explicitly named completed appointment without touching others');
    assert(conversationalSafetyQA.unknownDeleteSafe,
      'An unknown customer name must not fall through and delete another appointment');
    assert(conversationalSafetyQA.reminderAmbiguitySafe,
      'Mina must not attach a reminder to an arbitrary appointment when multiple matches exist');
    assert(conversationalSafetyQA.moveDestinationSafe,
      'A date after a move verb must be treated as the destination date, not the old appointment date');

    const serviceEditByMinaQA = await page.evaluate(() => {
      const dateKey = getTodayKey();
      appData.appointments = [
        { id:'qa-service-edit-by-mina', dateKey, time:'14:13', clientName:'سارا', service:'کاشت ناخن', status:'pending' }
      ];
      const reply = minaBuildReply('خدمت نوبت سارا رو به رنگ مو تغییر بده');
      const appt = appData.appointments[0];
      return {
        reply,
        serviceChanged: appt.service === 'رنگ مو',
        datePreserved: appt.dateKey === dateKey,
        timePreserved: appt.time === '14:13',
        noDuplicate: appData.appointments.length === 1
      };
    });
    assert(serviceEditByMinaQA.serviceChanged && serviceEditByMinaQA.datePreserved &&
      serviceEditByMinaQA.timePreserved && serviceEditByMinaQA.noDuplicate,
      'Mina must edit an appointment service in place without changing its date/time or creating a duplicate');
    console.log('Mina service edit:', JSON.stringify(serviceEditByMinaQA));

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
    assert(nativeJava.includes('target.getName() + ".previous"') &&
      nativeJava.includes('Cannot restore previous'), 'Android bundled page replacement must retain rollback safety');
    assert(nativeJava.includes('bytes.size() < 50_000') &&
      nativeJava.includes('lowerHtml.contains("</html>")') &&
      nativeJava.includes('lowerHtml.contains("</script>")'),
      'Android content updater must reject truncated or invalid HTML before replacing the offline page');
    assert(nativeJava.includes('final boolean contentUnchanged = unchanged') &&
      nativeJava.includes('prefs.edit().putLong("last_success_ms", System.currentTimeMillis()).apply()'),
      'Android updater must save its success timestamp only after the new content is safely installed');
    assert(nativeJava.includes('Intent.ACTION_SENDTO, smsUri'), 'Android must open the installed SMS app for prepared customer messages');
    assert(nativeJava.includes('Intent.ACTION_DIAL, uri'), 'Android must route phone links to the dialer');
    assert(nativeJava.includes('Intent.createChooser(sendIntent, "ارسال با...")'), 'Android must offer installed apps through the share chooser');

    // CRUD: create, edit and delete an appointment through the app's own form handlers.
    const appointmentResult = await page.evaluate(() => {
      const set = (id, value) => { document.getElementById(id).value = value; };
      selectedDateKey = getTodayKey();
      document.getElementById('apptDate').value = toPersianDigits(selectedDateKey.replace(/-/g, '/'));
      set('editApptId', '');
      set('apptClientName', 'مشتری تست');
      set('apptPhone', '09121112233');
      set('apptTime', '11:30');
      set('apptService', 'کلاسیک');
      set('apptDate', toPersianDigits(selectedDateKey.replace(/-/g, '/')));
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

    // All-appointments search/filter now lives inside Home; no duplicate appointments page remains.
    const completedArchiveQA = await page.evaluate(() => {
      const panel = document.getElementById('allAppointmentsPanel');
      const home = document.getElementById('tab-calendar');
      const hasHub = !!panel && !!document.getElementById('appointmentHubList') &&
        !document.getElementById('tab-appointments') && !!home && home.contains(panel);
      switchTab('appointments', null);
      const legacyRouteMapsHome = home?.classList.contains('active') === true;
      if (panel) panel.open = true;
      if (typeof renderAppointmentsHub === 'function') renderAppointmentsHub();
      const hubRendered = !!document.querySelector('#appointmentHubStats .appointment-hub-stat');
      const item = { id:'qa-completed-archive', dateKey:getTodayKey(), time:'15:27', clientName:'مشتری تاریخچه', phone:'09127778899', service:'لیفت مژه', notes:'سابقه ثابت', status:'done', completedAt:Date.now() };
      appData.appointments.push(item);
      const key = findClientProfileKeyForAppointment(item) || clientKeyFromFields(item.phone,item.clientName);
      getClientProfile(key);
      window.confirm = () => true;
      deleteAppointment(item.id);
      const archived = (appData.clientProfiles[key]?.records || []).find(r => r.id === 'done_'+item.id);
      const appointmentRemoved = !appData.appointments.some(a => a.id === item.id);
      const archivedImmutable = archived?.immutable === true && archived?.service === 'لیفت مژه' && archived?.notes === 'سابقه ثابت';
      if (archived) deleteClientHistoryItem(encodeURIComponent(key), encodeURIComponent(archived.id), 'record');
      const explicitHistoryDelete = !(appData.clientProfiles[key]?.records || []).some(r => r.id === 'done_'+item.id);
      return { hasHub, hubRendered, legacyRouteMapsHome, appointmentRemoved, archivedImmutable, explicitHistoryDelete };
    });
    assert(completedArchiveQA.hasHub && completedArchiveQA.hubRendered && completedArchiveQA.legacyRouteMapsHome, 'All-appointments hub must render inside Home and old appointments routes must redirect to Home');
    assert(completedArchiveQA.appointmentRemoved && completedArchiveQA.archivedImmutable, 'Deleting a completed appointment must archive an immutable history record');
    assert(completedArchiveQA.explicitHistoryDelete, 'History records must be deletable only through the explicit history action');
    console.log('Completed appointment archive:', JSON.stringify(completedArchiveQA));


    // Salon-wide exclusivity: two different customers/services cannot share one date and time.
    const duplicateResult = await page.evaluate(() => {
      const set = (id, value) => { document.getElementById(id).value = value; };
      appData.appointments = [];
      selectedDateKey = getTodayKey();
      document.getElementById('apptDate').value = toPersianDigits(selectedDateKey.replace(/-/g, '/'));
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
      document.getElementById('newClientPhone').value = '09128887766';
      createClientProfile();
      const oldKey = '09128887766';
      const exists = !!appData.clientProfiles[oldKey];
      document.getElementById('newClientName').value = 'نام تکراری';
      document.getElementById('newClientPhone').value = '09128887766';
      createClientProfile();
      const duplicateBlocked = Object.keys(appData.clientProfiles).filter(k => k === oldKey).length === 1 &&
        appData.clientProfiles[oldKey]?.name === 'مشتری پرونده تست';
      document.getElementById('editClientOriginalKey').value = oldKey;
      document.getElementById('editClientName').value = 'مشتری پرونده ویرایش';
      document.getElementById('editClientPhone').value = '09128887767';
      saveEditedClient();
      const newKey = '09128887767';
      const edited = !!appData.clientProfiles[newKey] && appData.clientProfiles[newKey].name === 'مشتری پرونده ویرایش';
      window.confirm = () => true;
      await deleteClient(newKey);
      return { exists, duplicateBlocked, edited, deleted:!appData.clientProfiles[newKey] };
    });
    assert(clientResult.exists && clientResult.duplicateBlocked && clientResult.edited && clientResult.deleted, 'Client create/edit/delete or duplicate prevention failed');

    // A customer without a phone number must still have a stable profile identity,
    // show the next appointment in the directory, and appear in the main calendar.
    const noPhoneAppointmentQA = await page.evaluate(() => {
      appData.clientProfiles = {};
      appData.appointments = [];
      selectedDateKey = getTodayKey();
      document.getElementById('apptDate').value = toPersianDigits(selectedDateKey.replace(/-/g, '/'));
      const set = (id, value) => { document.getElementById(id).value = value; };
      set('editApptId', '');
      set('apptClientName', 'مشتری بدون شماره');
      set('apptPhone', '');
      set('apptTime', '10:07');
      set('apptService', 'کاشت ناخن');
      set('apptNotes', '');
      set('apptAlarm', '15');
      set('apptStatus', 'pending');
      set('apptNextFollowup', '0');
      saveAppointment();
      const appt = appData.appointments.find(a => a.clientName === 'مشتری بدون شماره');
      const key = clientKeyFromFields('', 'مشتری بدون شماره');
      const profile = appData.clientProfiles[key];
      renderClientsTab();
      const card = [...document.querySelectorAll('#clientsListContainer > div')].find(el => el.textContent.includes('مشتری بدون شماره'));
      renderCalendar();
      renderDaySchedule();
      return {
        appointmentCreated: !!appt,
        phoneIsEmpty: !!appt && !appt.phone,
        linkedByClientId: !!appt && !!profile && appt.clientId === profile.clientId,
        customerListed: !!card,
        dateShown: !!card && card.textContent.includes(formatJalaliFull(appt.dateKey)),
        timeShown: !!card && card.textContent.includes(toPersianDigits('10:07')),
        calendarDayCount: appData.appointments.filter(a => a.dateKey === selectedDateKey && a.status !== 'canceled').length
      };
    });
    assert(noPhoneAppointmentQA.appointmentCreated && noPhoneAppointmentQA.phoneIsEmpty &&
      noPhoneAppointmentQA.linkedByClientId && noPhoneAppointmentQA.customerListed &&
      noPhoneAppointmentQA.dateShown && noPhoneAppointmentQA.timeShown &&
      noPhoneAppointmentQA.calendarDayCount === 1,
      'No-phone customer appointments must remain linked and visible in customer list and main calendar');

    // Primary appointment + linked follow-up must be two durable records,
    // both visible in the client profile and the main calendar.
    const primaryFollowupQA = await page.evaluate(() => {
      appData.appointments = [];
      appData.clientProfiles = {};
      const clientName = 'مشتری نوبت اصلی و ترمیم';
      selectedDateKey = getTodayKey();
      document.getElementById('apptDate').value = toPersianDigits(selectedDateKey.replace(/-/g, '/'));
      const set = (id, value) => { document.getElementById(id).value = value; };
      set('editApptId', '');
      set('apptClientName', clientName);
      set('apptPhone', '');
      set('apptTime', '10:17');
      set('apptService', 'کاشت مژه');
      set('apptNotes', 'نوبت اصلی تست');
      set('apptAlarm', '15');
      set('apptStatus', 'pending');
      set('apptBirthdayYear', '1375');
      set('apptBirthdayMonth', '08');
      set('apptBirthdayDay', '12');
      set('apptNextFollowup', 'custom');
      set('apptFollowupCustomDays', '14');
      saveAppointment();
      const primary = appData.appointments.find(a => a.clientName === clientName && !isFollowupAppointment(a));
      const followup = appData.appointments.find(a => a.parentAppointmentId === primary?.id);
      const key = primary ? findClientProfileKeyForAppointment(primary) : '';
      renderClientsTab();
      const card = [...document.querySelectorAll('#clientsListContainer > div')].find(el => el.textContent.includes(clientName));
      const cardText = card?.textContent || '';
      if (key) openClientRecord(key);
      if (primary) editClientAppointmentInline(primary.id);
      const inlineEditWorks = !!primary &&
        clientEditingNextAppointmentId === primary.id &&
        document.getElementById('clientNextTime').value === primary.time &&
        document.getElementById('clientNextService').value === primary.service &&
        document.getElementById('clientNextAppointmentType').value === 'primary' &&
        document.getElementById('clientProfileModal').classList.contains('open');
      if (key) openClientRecord(key);
      const compactAppointmentUI = !!document.querySelector('#clientScheduledAppointments .client-appointment-row') ||
        document.querySelector('#clientScheduledAppointments').style.display === 'flex';
      const nextFormStartsNew = clientEditingNextAppointmentId === null &&
        !document.getElementById('clientNextDate').value &&
        document.getElementById('clientNextTime').value === '10:00';
      const extraDate = addDaysToJalaliKey(selectedDateKey, 21);
      document.getElementById('clientNextDate').value = toPersianDigits(extraDate.replace(/-/g, '/'));
      document.getElementById('clientNextTime').value = '11:33';
      document.getElementById('clientNextService').value = 'مراجعه جداگانه سوم';
      saveClientNextAppointment();
      const extraAppointment = appData.appointments.find(a => a.clientName === clientName && a.service === 'مراجعه جداگانه سوم');
      if (key) openClientRecord(key);
      const profileText = document.getElementById('clientScheduledAppointments')?.textContent || '';
      const primaryDate = primary?.dateKey || '';
      const followupDate = followup?.dateKey || '';
      viewYear = Number(followupDate.slice(0,4));
      viewMonth = Number(followupDate.slice(5,7));
      selectedDateKey = followupDate;
      showFollowupOnly = false;
      renderCalendar();
      renderDaySchedule();
      const calendarText = document.getElementById('calendarGrid').textContent || '';
      const scheduleText = document.getElementById('dayAppointmentsBody').textContent || '';
      const calendarShowsFollowup = calendarText.includes('ترمیم');
      const scheduleShowsFollowup = scheduleText.includes('ترمیم');
      if (primary) cycleStatus(primary.id);
      const cardAfterDone = [...document.querySelectorAll('#clientsListContainer > div')].find(el => el.textContent.includes(clientName));
      const followupStillShownAfterDone = !!cardAfterDone && cardAfterDone.textContent.includes('ترمیم');
      return {
        primaryCreated:!!primary,
        followupCreated:!!followup,
        birthdaySavedFromAppointment:!!key && appData.clientProfiles[key]?.birthDate === '1375-08-12',
        birthdayAppearsInBirthdayList:!!key && (() => { renderClientBirthdays(); return [...document.querySelectorAll('#clientBirthdaysList [data-client-birthday-key]')].some(row => row.dataset.clientBirthdayKey === encodeURIComponent(key)); })(),
        linkedToPrimary:!!followup && followup.parentAppointmentId === primary.id,
        followupHasOwnDateAndTime:!!followup && followup.dateKey === addDaysToJalaliKey(primary.dateKey,14) && followup.time === '10:17',
        cardShowsBoth:cardText.includes('نوبت اصلی') && cardText.includes('ترمیم'),
        profileShowsBoth:profileText.includes('نوبت اصلی') && profileText.includes('نوبت بعدی ترمیم'),
        profileHasEditDelete:!!document.querySelector('#clientScheduledAppointments [data-client-appt-edit]') && !!document.querySelector('#clientScheduledAppointments [data-client-appt-delete]'),
        inlineEditWorks,
        compactAppointmentUI,
        profileFormAddsNewWithoutOverwriting:nextFormStartsNew && !!extraAppointment &&
          appData.appointments.some(a => a.id === primary.id) &&
          appData.appointments.some(a => a.id === followup.id) &&
          extraAppointment.dateKey === extraDate && extraAppointment.time === '11:33',
        calendarShowsFollowup,
        scheduleShowsFollowup,
        followupStillShownAfterDone,
        primaryDate,
        followupDate
      };
    });
    assert(primaryFollowupQA.primaryCreated && primaryFollowupQA.followupCreated &&
      primaryFollowupQA.linkedToPrimary && primaryFollowupQA.followupHasOwnDateAndTime,
      'Primary and follow-up must be separately stored with a stable parent link and exact date/time');
    assert(primaryFollowupQA.birthdaySavedFromAppointment && primaryFollowupQA.birthdayAppearsInBirthdayList,
      'Birthday entered in the appointment form must be saved to the customer profile and birthday list');
    assert(primaryFollowupQA.cardShowsBoth && primaryFollowupQA.profileShowsBoth && primaryFollowupQA.profileHasEditDelete,
      'Customer card and profile must show both appointment types with edit/delete actions');
    assert(primaryFollowupQA.inlineEditWorks && primaryFollowupQA.compactAppointmentUI,
      'Customer appointment controls must be compact and edit directly inside the customer profile');
    assert(primaryFollowupQA.profileFormAddsNewWithoutOverwriting,
      'Adding another appointment from the customer profile must create a new record without overwriting the primary or follow-up');
    assert(primaryFollowupQA.calendarShowsFollowup && primaryFollowupQA.scheduleShowsFollowup,
      'Main calendar and day schedule must visibly distinguish follow-up appointments');
    assert(primaryFollowupQA.followupStillShownAfterDone,
      'Marking the primary appointment done must not hide or remove its future follow-up');
    console.log('Primary/follow-up integration:', JSON.stringify(primaryFollowupQA));

    // Direct follow-up booking from the appointment modal must open the Jalali
    // calendar, accept a manually chosen date and minute-precise time, and skip
    // the automatic 14/21/28-day scheduling controls.
    const directFollowupModalQA = await page.evaluate(() => {
      const name = 'مشتری ترمیم با تاریخ دلخواه';
      const clientId = 'qa-direct-followup-client';
      const today = getTodayKey();
      const targetDate = addDaysToJalaliKey(today, 17);
      appData.clientProfiles = {
        [name]: { name, phone:'', clientId, records:[] }
      };
      appData.appointments = [{
        id:'qa-direct-followup-primary', appointmentType:'primary', parentAppointmentId:'',
        dateKey:today, time:'09:00', clientName:name, phone:'', clientId,
        service:'کاشت مژه', status:'done', alarm:'none'
      }];
      selectedDateKey = today;
      viewYear = Number(today.slice(0,4));
      viewMonth = Number(today.slice(5,7));
      openApptModal();
      document.getElementById('apptClientName').value = name;
      document.getElementById('apptPhone').value = '';
      document.getElementById('apptService').value = 'ترمیم مژه';
      document.getElementById('apptTime').value = '13:47';
      document.getElementById('apptType').value = 'followup';
      updateAppointmentTypeUI();
      const calendarOpened = document.getElementById('apptJalaliPicker').style.display === 'block';
      const autoScheduleHidden = document.getElementById('autoFollowupSection').style.display === 'none';
      selectAppointmentJalaliDate(targetDate);
      saveAppointment();
      const created = appData.appointments.find(a => a.appointmentType === 'followup' &&
        a.parentAppointmentId === 'qa-direct-followup-primary' && a.clientName === name);
      const linkedFollowups = appData.appointments.filter(a => a.parentAppointmentId === 'qa-direct-followup-primary');
      return {
        calendarOpened,
        autoScheduleHidden,
        saved:!!created,
        exactDate:!!created && created.dateKey === targetDate,
        exactTime:!!created && created.time === '13:47',
        linkedToPrimary:!!created && created.parentAppointmentId === 'qa-direct-followup-primary',
        noDuplicateFollowup:linkedFollowups.length === 1,
        pickerClosedAfterSelection:document.getElementById('apptJalaliPicker').style.display === 'none'
      };
    });
    assert(directFollowupModalQA.calendarOpened && directFollowupModalQA.autoScheduleHidden &&
      directFollowupModalQA.saved && directFollowupModalQA.exactDate && directFollowupModalQA.exactTime &&
      directFollowupModalQA.linkedToPrimary && directFollowupModalQA.noDuplicateFollowup &&
      directFollowupModalQA.pickerClosedAfterSelection,
      'Direct follow-up booking must use a manually selected Jalali date/time and must not show auto-schedule controls');
    console.log('Direct follow-up modal:', JSON.stringify(directFollowupModalQA));

    const homeDashboardQA = await page.evaluate(() => {
      const today = getTodayKey();
      const tomorrow = addDaysToJalaliKey(today, 1);
      appData.appointments = [
        { id:'qa-home-late', dateKey:today, time:'14:45', clientName:'مشتری دوم', service:'لیفت', status:'pending', alarm:'15' },
        { id:'qa-home-early', dateKey:today, time:'09:05', clientName:'مشتری اول', service:'کاشت', status:'done', alarm:'none' },
        { id:'qa-home-next', dateKey:tomorrow, time:'11:07', clientName:'مشتری فردا', service:'ترمیم', status:'pending', appointmentType:'followup', alarm:'30' },
        { id:'qa-home-canceled', dateKey:today, time:'08:00', clientName:'لغوشده', service:'—', status:'canceled' }
      ];
      updateDashboardStats();
      openHomeAppointmentList('today');
      const todayRows = [...document.querySelectorAll('#homeAppointmentDetailsList .home-appt-row')];
      const todayNames = todayRows.map(row => row.querySelector('.home-appt-main strong')?.textContent || '');
      const todaySummary = document.getElementById('homeAppointmentDetailsSummary').textContent;
      const todayExpanded = document.querySelector('[data-home-mode="today"]').getAttribute('aria-expanded') === 'true';
      openHomeAppointmentList('month');
      const monthRows = [...document.querySelectorAll('#homeAppointmentDetailsList .home-appt-row')];
      const monthNames = monthRows.map(row => row.querySelector('.home-appt-main strong')?.textContent || '');
      renderSmartDashboard();
      const upcomingText = document.getElementById('smartUpcomingList').textContent || '';
      return {
        todayCount:document.getElementById('statTodayCount').textContent,
        monthCount:document.getElementById('statMonthCount').textContent,
        todayRows:todayRows.length,
        todaySorted:todayNames[0]==='مشتری اول' && todayNames[1]==='مشتری دوم',
        todaySummaryAccurate:todaySummary.includes('۲ نوبت') && todaySummary.includes('۱ در انتظار') && todaySummary.includes('۱ انجام‌شده'),
        todayExpanded,
        monthRows:monthRows.length,
        monthIncludesFutureDate:monthNames.includes('مشتری فردا'),
        upcomingExcludesToday:!upcomingText.includes('مشتری اول') && upcomingText.includes('مشتری فردا'),
        duplicateCountersRemoved:!document.getElementById('smartUpcoming') && !!document.querySelector('#smartDashboard .smart-dashboard-intro')
      };
    });
    assert(homeDashboardQA.todayRows===2 && homeDashboardQA.todaySorted &&
      homeDashboardQA.todaySummaryAccurate && homeDashboardQA.todayExpanded,
      'Home today summary must show active appointments sorted by exact time and accurate statuses');
    assert(homeDashboardQA.monthRows===3 && homeDashboardQA.monthIncludesFutureDate &&
      homeDashboardQA.upcomingExcludesToday && homeDashboardQA.duplicateCountersRemoved,
      'Home month summary and upcoming panel must distinguish this month from the next seven days without duplicate dashboard counters');
    console.log('Home dashboard:', JSON.stringify(homeDashboardQA));


    // Birthday fields are restored from their independent local snapshot even if
    // the main app record is stale after a close/reopen or an appointment change.
    const birthdayPersistenceQA = await page.evaluate(() => {
      const key = 'مشتری تولد پایدار';
      appData.clientProfiles = { [key]: { name:key, phone:'', clientId:'qa-birthday-client', birthDate:'1375-08-12', birthdayAlertYear:'1405', records:[] } };
      appData.appointments = [{ id:'qa-birthday-appt', dateKey:getTodayKey(), time:'10:07', clientName:key, phone:'', clientId:'qa-birthday-client', service:'کاشت ناخن', status:'pending' }];
      saveData();
      appData.appointments = [];
      saveData();
      const stale = JSON.parse(localStorage.getItem(STORAGE_KEY));
      stale.clientProfiles[key].birthDate = '';
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stale));
      loadData();
      return {
        birthdayRestored: appData.clientProfiles[key]?.birthDate === '1375-08-12',
        appointmentStillDeleted: !appData.appointments.some(a => a.id === 'qa-birthday-appt'),
        separateSnapshotExists: !!localStorage.getItem('dastyare_man_client_birthdays_v1')
      };
    });
    assert(birthdayPersistenceQA.birthdayRestored && birthdayPersistenceQA.appointmentStillDeleted &&
      birthdayPersistenceQA.separateSnapshotExists,
      'Customer birthdays must survive stale app snapshots independently of appointments');

    // Deleting a birthday must synchronously clear the open form, remove the list row,
    // update the count, and remain deleted after the normal load/restore path.
    const birthdayDeleteImmediateQA = await page.evaluate(() => {
      const key = 'مشتری حذف فوری تولد';
      appData.clientProfiles = {
        [key]: { name:key, phone:'', clientId:'qa-birthday-delete-client', birthDate:'1375-08-12', birthdayAlertYear:'1405', records:[] }
      };
      appData.reminders = [{ id:'qa-birthday-delete-reminder', birthdayClientKey:key, birthdayYear:1405, enabled:true }];
      saveData();
      document.getElementById('clientRecordKey').value = key;
      document.getElementById('clientBirthdayYear').value = '۱۳۷۵';
      document.getElementById('clientBirthdayMonth').value = '۰۸';
      document.getElementById('clientBirthdayDay').value = '۱۲';
      renderClientBirthdays();
      window.confirm = () => true;
      deleteClientBirthday(key);
      const rowGone = ![...document.querySelectorAll('#clientBirthdaysList [data-client-birthday-key]')]
        .some(row => row.dataset.clientBirthdayKey === encodeURIComponent(key));
      const countUpdated = document.getElementById('clientBirthdayCount').textContent.includes('۰');
      const fieldsCleared = ['clientBirthdayYear','clientBirthdayMonth','clientBirthdayDay']
        .every(id => document.getElementById(id).value === '');
      const reminderRemoved = !appData.reminders.some(r => r && r.birthdayClientKey === key);
      const recordPreserved = !!appData.clientProfiles[key] && !appData.clientProfiles[key].birthDate;
      const tombstoneSaved = !!JSON.parse(localStorage.getItem('dastyare_man_client_birthday_deleted_v1') || '{}')[key];
      loadData();
      return {
        rowGone, countUpdated, fieldsCleared, reminderRemoved, recordPreserved, tombstoneSaved,
        remainsDeletedAfterReload: !appData.clientProfiles[key]?.birthDate
      };
    });
    assert(birthdayDeleteImmediateQA.rowGone && birthdayDeleteImmediateQA.countUpdated &&
      birthdayDeleteImmediateQA.fieldsCleared && birthdayDeleteImmediateQA.reminderRemoved &&
      birthdayDeleteImmediateQA.recordPreserved && birthdayDeleteImmediateQA.tombstoneSaved &&
      birthdayDeleteImmediateQA.remainsDeletedAfterReload,
      'Birthday deletion must update the UI immediately, cancel its reminder, preserve the customer record, and survive reload');
    console.log('Immediate birthday deletion:', JSON.stringify(birthdayDeleteImmediateQA));

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
