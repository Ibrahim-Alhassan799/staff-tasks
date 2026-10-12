/**
 * سجل مهام الموظفين: استقبال المهام من تليقرام والإيميل وتسجيلها في السجل تلقائياً.
 *
 * يعمل في Google Apps Script بحساب Gmail الخاص بك:
 *   - كل دقيقة يقرأ الرسائل الجديدة التي وصلت للبوت في تليقرام.
 *   - كل 5 دقائق يقرأ الإيميلات المرسلة إلى عنوانك مع +tasks (مثال: name+tasks@gmail.com).
 *   - يسجّل المهمة في Firestore ويرد على المرسل بتأكيد أو بسبب الرفض.
 *
 * التركيب: الصق هذا الملف في Code.gs، عبّئ CONFIG، ثم شغّل الدالة setup مرة واحدة.
 */

var CONFIG = {
  // مفتاح البوت من @BotFather (يبدأ بأرقام ثم نقطتين). لا تشاركه مع أحد.
  TELEGRAM_TOKEN: 'PUT-BOT-TOKEN-HERE',

  // رمز الدخول نفسه الموجود في قواعد Firestore.
  ACCESS_CODE: 'PUT-ACCESS-CODE-HERE',

  // من إعدادات Firebase (نفس قيم config.js في الموقع).
  FIREBASE_PROJECT: 'staff-tasks-23dbd',
  FIREBASE_API_KEY: 'AIzaSyDreHcABCUZIGh9njvI59ryP8TIoPU0ggc',

  // المدراء المسموح لهم بإرسال المهام بالإيميل: الإيميل ثم الاسم كما تريده في السجل.
  // أي إيميل غير موجود هنا يُتجاهل بدون رد.
  EMAIL_MANAGERS: {
    // 'manager@example.com': 'خالد',
  },

  HOURS_PER_DAY: 8,
  TIMEZONE: 'Asia/Riyadh'
};

var SOURCE_LABEL = { telegram: 'تليقرام', email: 'إيميل' };
var HELP_TEXT = [
  'أرسل المهمة بهذا الشكل:',
  '',
  'مهمة: تجهيز عرض سعر لعميل الرياض',
  'الموظف: عبدالله',
  'المدة: 3 أيام',
  'التسليم: الخميس',
  'عاجل',
  '',
  'المدة بالساعات أو الأيام. «التسليم» و«عاجل» و«ملاحظات» اختيارية.',
  'التسليم يقبل: اليوم، بكرة، اسم اليوم، أو تاريخ مثل 15/10.'
].join('\n');

/* ===================== التركيب ===================== */

/** شغّلها مرة واحدة بعد تعبئة CONFIG. تنشئ المؤقتات وتتحقق من الاتصال. */
function setup() {
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(CONFIG.ACCESS_CODE)) throw new Error('عبّئ ACCESS_CODE برمز الدخول.');
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('checkEmail').timeBased().everyMinutes(5).create();

  var people = listPeople_();
  Logger.log('الاتصال بالسجل يعمل. عدد الأسماء الحالية: ' + people.length);

  if (hasTelegram_()) {
    ScriptApp.newTrigger('checkTelegram').timeBased().everyMinutes(1).create();
    tg_('deleteWebhook', {});
    var me = tg_('getMe', {}).result;
    Logger.log('البوت يعمل: @' + me.username);
    Logger.log('رابط تسجيل المدراء: https://t.me/' + me.username + '?start=' + CONFIG.ACCESS_CODE);
  } else {
    Logger.log('لم يُعبّأ TELEGRAM_TOKEN، فالتليقرام متوقف وسيعمل الإيميل فقط.');
  }
  Logger.log('عنوان إيميل المهام: ' + taskAddress_());
  Logger.log('جاهز.');
}

/* ===================== تليقرام ===================== */

function hasTelegram_() { return /^\d+:[A-Za-z0-9_-]{20,}$/.test(CONFIG.TELEGRAM_TOKEN); }

function tg_(method, payload) {
  var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + CONFIG.TELEGRAM_TOKEN + '/' + method, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  var j = JSON.parse(res.getContentText() || '{}');
  if (!j.ok) throw new Error('Telegram ' + method + ': ' + (j.description || res.getResponseCode()));
  return j;
}

function tgReply_(m, text) {
  try { tg_('sendMessage', { chat_id: m.chat.id, text: text, reply_to_message_id: m.message_id }); }
  catch (e) { Logger.log(e.message); }
}

/** يعمل كل دقيقة. */
function checkTelegram() {
  if (!hasTelegram_()) return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    var props = PropertiesService.getScriptProperties();
    var offset = Number(props.getProperty('tg_offset') || 0);
    var updates = tg_('getUpdates', { offset: offset, timeout: 0, allowed_updates: ['message'] }).result || [];
    updates.forEach(function (u) {
      // تقديم المؤشر قبل المعالجة حتى لا تتكرر رسالة سببت خطأ.
      props.setProperty('tg_offset', String(u.update_id + 1));
      var m = u.message;
      if (!m || !m.text || !m.from || m.chat.type !== 'private') return;
      try { handleTelegram_(m, props); }
      catch (e) { tgReply_(m, 'تعذّر تسجيل المهمة الآن. أعد إرسالها بعد دقائق.\n(' + e.message.slice(0, 150) + ')'); }
    });
  } finally {
    lock.releaseLock();
  }
}

function handleTelegram_(m, props) {
  var text = String(m.text).trim();
  var key = 'tg_user_' + m.from.id;

  var reg = text.match(/^(?:\/start|تسجيل)(?:\s+(\S+))?(?:\s+([\s\S]+))?$/);
  if (reg) {
    if (!reg[1]) {
      if (props.getProperty(key)) { tgReply_(m, HELP_TEXT); return; }
      tgReply_(m, 'للتسجيل أرسل: تسجيل ثم رمز الدخول ثم اسمك كما تريده في السجل.\nمثال: تسجيل xxxx خالد');
      return;
    }
    if (reg[1] !== CONFIG.ACCESS_CODE) { tgReply_(m, 'رمز الدخول غير صحيح.'); return; }
    var name = clean_(reg[2]) || clean_([m.from.first_name, m.from.last_name].join(' ')) || 'مدير';
    props.setProperty(key, name.slice(0, 60));
    tgReply_(m, 'تم تسجيلك باسم «' + name + '». المهام التي ترسلها هنا تُسجَّل باسمك.\n\n' + HELP_TEXT +
      '\n\nلتغيير الاسم أرسل: تسجيل ' + CONFIG.ACCESS_CODE + ' الاسم الجديد');
    return;
  }

  var manager = props.getProperty(key);
  if (!manager) { tgReply_(m, 'لم تُسجَّل بعد. أرسل: تسجيل ثم رمز الدخول ثم اسمك.'); return; }
  if (/^(\/help|مساعدة|مساعده|\?|؟)$/.test(text)) { tgReply_(m, HELP_TEXT); return; }

  tgReply_(m, recordTask_(text, '', manager, 'telegram', true));
}

/* ===================== الإيميل ===================== */

function taskAddress_() {
  var me = Session.getEffectiveUser().getEmail().toLowerCase();
  var at = me.indexOf('@');
  return me.slice(0, at) + '+tasks' + me.slice(at);
}

/** يعمل كل 5 دقائق. */
function checkEmail() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    var props = PropertiesService.getScriptProperties();
    var done = JSON.parse(props.getProperty('mail_done') || '[]');
    var seen = {};
    done.forEach(function (id) { seen[id] = true; });
    var addr = taskAddress_();
    var managers = {};
    Object.keys(CONFIG.EMAIL_MANAGERS).forEach(function (k) { managers[k.trim().toLowerCase()] = CONFIG.EMAIL_MANAGERS[k]; });
    var okLabel = label_('مهام-مسجلة'), badLabel = label_('مهام-مرفوضة');

    GmailApp.search('to:' + addr + ' newer_than:3d', 0, 30).forEach(function (thread) {
      thread.getMessages().forEach(function (msg) {
        var id = msg.getId();
        if (seen[id]) return;
        seen[id] = true; done.push(id);
        if ((msg.getTo() + ',' + msg.getCc()).toLowerCase().indexOf(addr) === -1) return;
        var from = (msg.getFrom().match(/<([^>]+)>/) || [null, msg.getFrom()])[1].trim().toLowerCase();
        var manager = managers[from];
        if (!manager) { thread.addLabel(badLabel); return; }
        var body = stripQuoted_(msg.getPlainBody());
        var subject = msg.getSubject().replace(/^\s*((re|fwd?|إعادة توجيه|رد)\s*:\s*)+/i, '').trim();
        var result;
        try { result = recordTask_(body, subject, manager, 'email', false); }
        catch (e) { result = 'تعذّر تسجيل المهمة الآن. أعد الإرسال بعد دقائق.\n(' + e.message.slice(0, 150) + ')'; }
        msg.reply(result);
        thread.addLabel(okLabel);
      });
    });
    props.setProperty('mail_done', JSON.stringify(done.slice(-400)));
  } finally {
    lock.releaseLock();
  }
}

function label_(name) { return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name); }

function stripQuoted_(body) {
  var lines = String(body || '').replace(/\r/g, '').split('\n'), out = [];
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (/^\s*(On .+wrote:|في .+كتب:|-----Original Message-----|_{8,})\s*$/.test(l)) break;
    if (/^\s*>/.test(l)) continue;
    if (/^\s*--\s*$/.test(l)) break; // signature
    out.push(l);
  }
  return out.join('\n');
}

/* ===================== التسجيل ===================== */

function recordTask_(text, fallbackTitle, managerName, source, keepExtraLines) {
  var t = parseTask_(text, fallbackTitle, todayISO_(), keepExtraLines);
  if (t.errors.length) return 'ما سُجّلت المهمة: ' + t.errors.join('، ') + '.\n\n' + HELP_TEXT;

  var people = listPeople_();
  var emp = matchEmployee_(t.employee, people);
  if (emp.error) return emp.error;
  var managerId = ensurePerson_(managerName, 'manager', people);

  var estHours = t.est.unit === 'd' ? t.est.value * CONFIG.HOURS_PER_DAY : t.est.value;
  createDoc_('tasks', {
    title: t.title.slice(0, 200), employeeId: emp.id, managerId: managerId,
    source: source, estValue: t.est.value, estUnit: t.est.unit, estHours: estHours,
    due: t.due, urgent: t.urgent, notes: t.notes.slice(0, 600),
    status: 'todo', createdAt: Date.now(), doneAt: null
  });

  var lines = ['تم تسجيل المهمة:', t.title, 'الموظف: ' + emp.name, 'المدة: ' + durText_(t.est)];
  if (t.due) lines.push('التسليم: ' + t.due);
  if (t.urgent) lines.push('عاجلة');
  lines.push('طلبها: ' + managerName + ' · عن طريق ' + SOURCE_LABEL[source]);
  return lines.join('\n');
}

/* ===================== قراءة الرسالة ===================== */

function toLatinDigits_(s) {
  return String(s || '').replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 0x660); })
    .replace(/[۰-۹]/g, function (d) { return String(d.charCodeAt(0) - 0x6F0); });
}
function clean_(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function norm_(s) {
  return clean_(toLatinDigits_(s)).replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي').replace(/ة/g, 'ه').toLowerCase();
}

var KEYS_ = {
  title: ['مهمه', 'المهمه', 'العمل', 'المطلوب', 'الطلب'],
  employee: ['الموظف', 'موظف', 'المسؤول', 'المكلف', 'الى', 'لـ', 'ل'],
  est: ['المده', 'مده', 'المده المتوقعه', 'الوقت', 'الوقت المتوقع'],
  due: ['التسليم', 'موعد التسليم', 'تاريخ التسليم', 'الموعد', 'قبل'],
  notes: ['ملاحظات', 'ملاحظه', 'تفاصيل']
};
function keyOf_(k) {
  k = norm_(k);
  for (var f in KEYS_) if (KEYS_[f].indexOf(k) !== -1) return f;
  return null;
}

/** يحوّل نص الرسالة إلى حقول المهمة. today بصيغة YYYY-MM-DD. */
function parseTask_(raw, fallbackTitle, today, keepExtraLines) {
  var out = { title: '', employee: '', est: null, due: null, urgent: false, notes: '', errors: [] };
  var estText = '', dueText = '', free = [];
  String(raw || '').replace(/\r/g, '').split('\n').forEach(function (line) {
    line = line.replace(/^[\s\-•*–·]+/, '').trim();
    if (!line) return;
    var m = line.match(/^([^:：]{1,20})\s*[:：]\s*(.*)$/), f = m ? keyOf_(m[1]) : null;
    if (f === 'title') out.title = clean_(m[2]);
    else if (f === 'employee') out.employee = clean_(m[2]);
    else if (f === 'est') estText = m[2];
    else if (f === 'due') dueText = m[2];
    else if (f === 'notes') out.notes = clean_(m[2]);
    else if (/^(عاجل|عاجله|مستعجل|مستعجله|ضروري|urgent)[.!]*$/.test(norm_(line))) out.urgent = true;
    else free.push(line);
  });
  if (!out.title) out.title = clean_(fallbackTitle) || clean_(free.shift() || '');
  if (keepExtraLines && free.length) out.notes = [out.notes].concat(free).filter(Boolean).join('\n');

  if (!out.title) out.errors.push('لم أجد وصف المهمة');
  if (!out.employee) out.errors.push('لم أجد اسم الموظف');
  if (!clean_(estText)) out.errors.push('لم أجد المدة');
  else {
    out.est = parseDuration_(estText);
    if (!out.est) out.errors.push('لم أفهم المدة «' + clean_(estText) + '»');
  }
  if (clean_(dueText)) {
    out.due = parseDue_(dueText, today);
    if (!out.due) out.errors.push('لم أفهم موعد التسليم «' + clean_(dueText) + '»');
  }
  return out;
}

function parseDuration_(s) {
  s = norm_(s);
  var words = {
    'ساعه': [1, 'h'], 'ساعتين': [2, 'h'], 'ساعتان': [2, 'h'], 'نص ساعه': [0.5, 'h'], 'نصف ساعه': [0.5, 'h'],
    'ربع ساعه': [0.25, 'h'], 'يوم': [1, 'd'], 'يومين': [2, 'd'], 'يومان': [2, 'd'], 'نص يوم': [0.5, 'd'],
    'نصف يوم': [0.5, 'd'], 'اسبوع': [5, 'd'], 'اسبوعين': [10, 'd'], 'يوم عمل': [1, 'd']
  };
  if (words[s]) return { value: words[s][0], unit: words[s][1] };
  var m = s.match(/(\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  var n = parseFloat(m[1].replace(',', '.'));
  if (!(n > 0)) return null;
  if (/اسبوع|اسابيع|week/.test(s)) return { value: n * 5, unit: 'd' };
  if (/يوم|ايام|day/.test(s)) return { value: n, unit: 'd' };
  return { value: n, unit: 'h' }; // ساعات، أو رقم بدون وحدة
}

function parseDue_(s, today) {
  s = norm_(s);
  var base = isoToDate_(today);
  var plus = function (n) { var d = new Date(base.getTime()); d.setUTCDate(d.getUTCDate() + n); return dateToIso_(d); };
  if (/بعد بكر|بعد غد/.test(s)) return plus(2);
  if (/اليوم/.test(s)) return plus(0);
  if (/بكره|بكرا|غدا|باكر|tomorrow/.test(s)) return plus(1);
  var days = [['الاحد', 0], ['الاثنين', 1], ['الثلاثاء', 2], ['الاربعاء', 3], ['الخميس', 4], ['الجمعه', 5], ['السبت', 6]];
  for (var i = 0; i < days.length; i++) {
    if (s.indexOf(days[i][0]) !== -1 || s.indexOf(days[i][0].replace(/^ال/, '')) === 0) {
      var diff = (days[i][1] - base.getUTCDay() + 7) % 7;
      return plus(diff === 0 ? 7 : diff);
    }
  }
  var m = s.match(/(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
  if (m) return validDate_(+m[1], +m[2], +m[3]);
  m = s.match(/(\d{1,2})[-\/.](\d{1,2})(?:[-\/.](\d{2,4}))?/);
  if (m) {
    var y = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : base.getUTCFullYear();
    var iso = validDate_(y, +m[2], +m[1]);
    if (iso && !m[3] && isoToDate_(iso) < new Date(base.getTime() - 30 * 864e5)) iso = validDate_(y + 1, +m[2], +m[1]);
    return iso;
  }
  return null;
}

function isoToDate_(iso) { var p = iso.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); }
function dateToIso_(d) {
  return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
}
function validDate_(y, mo, d) {
  var dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? dateToIso_(dt) : null;
}
function todayISO_() { return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd'); }

function durText_(est) {
  var n = est.value, h = est.unit === 'h';
  if (n === 1) return h ? 'ساعة' : 'يوم';
  if (n === 2) return h ? 'ساعتين' : 'يومين';
  if (n === 0.5) return h ? 'نصف ساعة' : 'نصف يوم';
  if (Number.isInteger(n) && n >= 3 && n <= 10) return n + (h ? ' ساعات' : ' أيام');
  return n + (h ? ' ساعة' : ' يوم');
}

/* ===================== الموظفون والمدراء ===================== */

function matchEmployee_(name, people) {
  var emps = people.filter(function (p) { return p.role === 'employee'; });
  var n = norm_(name);
  var exact = emps.filter(function (p) { return norm_(p.name) === n; });
  if (exact.length) return exact[0];
  var partial = emps.filter(function (p) {
    var pn = norm_(p.name);
    return pn.indexOf(n + ' ') === 0 || pn.indexOf(' ' + n) !== -1 || pn.indexOf(n) === 0;
  });
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    return { error: 'الاسم «' + name + '» يطابق أكثر من موظف: ' +
      partial.map(function (p) { return p.name; }).join('، ') + '. اكتب الاسم كاملاً.' };
  }
  var list = emps.map(function (p) { return p.name; }).join('، ');
  return { error: 'الموظف «' + name + '» غير موجود في السجل.' +
    (list ? ' الموظفون المسجّلون: ' + list + '.' : ' أضف الموظفين من صفحة السجل أولاً.') };
}

function ensurePerson_(name, role, people) {
  var n = norm_(name);
  var found = people.filter(function (p) { return p.role === role && norm_(p.name) === n; })[0];
  if (found) return found.id;
  var id = createDoc_('people', { name: clean_(name), role: role, createdAt: Date.now() });
  people.push({ id: id, name: clean_(name), role: role });
  return id;
}

/* ===================== Firestore ===================== */

function fsUrl_(path) {
  return 'https://firestore.googleapis.com/v1/projects/' + CONFIG.FIREBASE_PROJECT +
    '/databases/(default)/documents/boards/' + encodeURIComponent(CONFIG.ACCESS_CODE) + path +
    (path.indexOf('?') === -1 ? '?' : '&') + 'key=' + CONFIG.FIREBASE_API_KEY;
}
function fs_(method, path, body) {
  var opt = { method: method, muteHttpExceptions: true, contentType: 'application/json' };
  if (body) opt.payload = JSON.stringify(body);
  var res = UrlFetchApp.fetch(fsUrl_(path), opt);
  var code = res.getResponseCode(), text = res.getContentText();
  if (code === 403) throw new Error('رفض السجل الطلب. تأكد أن ACCESS_CODE يطابق القواعد في Firestore.');
  if (code >= 300) throw new Error('Firestore ' + code + ': ' + text.slice(0, 200));
  return JSON.parse(text || '{}');
}
function listPeople_() {
  var out = [], token = '';
  do {
    var r = fs_('get', '/people?pageSize=300' + (token ? '&pageToken=' + encodeURIComponent(token) : ''));
    (r.documents || []).forEach(function (d) {
      var f = d.fields || {};
      out.push({
        id: d.name.split('/').pop(),
        name: clean_(f.name && f.name.stringValue),
        role: f.role && f.role.stringValue === 'manager' ? 'manager' : 'employee'
      });
    });
    token = r.nextPageToken || '';
  } while (token);
  return out;
}
function toValue_(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  return { stringValue: String(v) };
}
function createDoc_(collection, data) {
  var fields = {};
  Object.keys(data).forEach(function (k) { fields[k] = toValue_(data[k]); });
  var doc = fs_('post', '/' + collection, { fields: fields });
  return doc.name.split('/').pop();
}
