// إعدادات ربط سجل المهام بمخزن البيانات المشترك (Firebase).
// ما دامت القيمة null تعمل الصفحة في الوضع التجريبي وتحفظ المهام على الجهاز نفسه فقط.
// بعد إنشاء مشروع Firebase الصق إعداداته هنا بهذا الشكل:
//
// window.TASKLOG_CONFIG = {
//   firebase: {
//     apiKey: "...",
//     authDomain: "your-project.firebaseapp.com",
//     projectId: "your-project",
//     appId: "..."
//   }
// };
window.TASKLOG_CONFIG = { firebase: null };
