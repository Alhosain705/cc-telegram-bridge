# CC Telegram Bridge

<p align="center">
  <strong>اختر اللغة · Choose your language</strong><br>
  <a href="#العربية">العربية</a> · <a href="#english">English</a>
</p>

---

## العربية

ربط عربي بسيط بين تيليجرام وClaude Code على جهاز ويندوز. ترسل طلبك للبوت، والبرنامج يشغّل Claude Code على جهازك ويرجع لك الجواب. ما يحتاج سيرفر أو اشتراك استضافة.

الحزمة الجاهزة فيها نافذة إعداد عربية وNode.js محمول؛ المستخدم ما يحتاج يثبت Node أو يفتح موجّه الأوامر.

## تحميل النسخة الجاهزة لويندوز

> ⬇️ **[حمّل حزمة Windows x64 الجاهزة — الإصدار 0.1.3](https://github.com/Alhosain705/cc-telegram-bridge/releases/download/v0.1.3/cc-telegram-bridge-0.1.3-win-x64.zip)**<br>
> 🔐 **[حمّل ملف التحقق SHA-256](https://github.com/Alhosain705/cc-telegram-bridge/releases/download/v0.1.3/cc-telegram-bridge-0.1.3-win-x64.zip.sha256)** · **[شاهد صفحة الإصدار](https://github.com/Alhosain705/cc-telegram-bridge/releases/tag/v0.1.3)**

لا تستخدم **Code → Download ZIP** للتثبيت؛ هذا الزر ينزّل كود المصدر فقط، وليس حزمة ويندوز الجاهزة.

بعد التنزيل، فكّ الضغط أولاً ثم افتح `MANUAL.html` من داخل المجلد — دليل عربي مصوّر يشرح التركيب خطوة خطوة والخصائص والأمان وحلّ المشاكل. هذا الملف (`README`) للتفاصيل التقنية.

## الخطوة صفر — قبل الخمس خطوات

لازم يكون عندك حساب Claude واشتراك مدفوع مفعّل. باقتا **Pro وMax** كلتاهما تدعمان Claude Code في الطرفية؛ الفرق الأساسي في حجم الحصة، وMax ليست شرطاً لتشغيل الجسر.

إذا ما عندك اشتراك: أنشئ حساب Claude، أكّد بريدك، ثم فعّل Pro أو Max. بعد ما يصير الاشتراك جاهزاً، ابدأ الخمس خطوات أدناه.

## قبل ما تبدأ

تحتاج:

- ويندوز 10 أو 11 بنسخة x64. إصدار ARM64 غير منشور حالياً.
- حساب واشتراك Claude صالح.
- بوت تيليجرام من BotFather.
- اتصال بالإنترنت.

إذا Claude Code غير مثبت أو غير مسجل الدخول، نافذة الإعداد تقودك للعملية الرسمية وتكمل بعدها تلقائياً.

## تنبيه أمني مهم

هذا البرنامج يوصل Claude Code بجهازك، يعني يقدر يقرأ ويعدّل ملفات حسب الصلاحيات اللي تختارها. الأفضل تشغله على جهاز مخصص أو جهاز قديم منظّف من بياناتك الشخصية، وليس على جهازك الأساسي.

الوضع الافتراضي آمن: ما يضيف خيار تجاوز الصلاحيات. أول مرة تربط حسابك يسألك:

- «أوافق على كل خطوة»: إذا طلب Claude Code عملاً حساساً، يرسل الجسر إلى محادثتك زري **✅ موافق** و**❌ ارفض** مرتبطين بالطلب نفسه. الكتابة العادية مثل «موافق» لا تعتمد أي شيء، والرفض أو انتهاء مهلة 10 دقائق يمنع التنفيذ.
- «أشتغل بحرية»: يضيف خيار تجاوز الصلاحيات، فيقدر ينفّذ بدون سؤال. هذا خطر، ولا تستخدمه إلا على جهاز مخصص خالٍ من بياناتك الشخصية.

كذلك البوت مقفول من البداية:

- الإصدار الأول مخصص **لمالك واحد فقط** وفي المحادثة الخاصة فقط.
- أول استخدام يلتقط رقم المالك من رمز ربط من 6 أرقام، ثم يحفظه في قائمة السماح.
- ما يدعم إضافة مستخدمين آخرين أو تشغيله داخل المجموعات في هذا الإصدار.
- نفس الفحص ينطبق على الرسائل والأزرار.

اقرأ [SECURITY.md](SECURITY.md) قبل اختيار «أشتغل بحرية».

## التركيب — خمس خطوات بعد ما يكون عندك اشتراك كلود

1. أنشئ بوتاً من BotFather وانسخ رمز البوت.
2. [نزّل حزمة Windows x64 الجاهزة](https://github.com/Alhosain705/cc-telegram-bridge/releases/download/v0.1.3/cc-telegram-bridge-0.1.3-win-x64.zip)، فك الضغط، واضغط مرتين على `START.cmd`. إذا ظهر تحذير ويندوز، راجع اسم الملف والمصدر ثم اختر التشغيل.
3. الصق رمز البوت في النافذة واضغط «تحقّق وابدأ الربط». الوضع الآمن محدد افتراضياً.
4. إذا احتاج Claude Code تثبيتاً أو تسجيل دخول، أكمل النافذة المرئية التي تظهر مرة واحدة.
5. أرسل كود الربط المكوّن من 6 أرقام إلى بوتك.

الباقي يتم تلقائياً:

- يلتقط رقم حسابك من رسالة الربط، بدون بوت طرف ثالث.
- يثبت الملفات في `%LOCALAPPDATA%\cc-telegram-bridge`.
- يحفظ `.env` بترميز UTF-8 بدون BOM.
- يسجل اختصاراً في مجلد Startup.
- يشغّل الجسر مخفياً.
- يرسل رسالة نجاح إلى بوتك.

التشغيل التلقائي يبدأ **عند تسجيل الدخول إلى ويندوز**، وليس عند إقلاع الجهاز قبل تسجيل الدخول.

## حدود ويندوز المعروفة

- جهاز عليه Smart App Control مفروض قد يمنع سكربتات الحزمة. ما نطلب منك تعطيله.
- سياسة شركة مفروضة مثل PowerShell AllSigned أو Restricted قد تمنع التشغيل، و`ExecutionPolicy Bypass` لا يتجاوز Group Policy.
- التشغيل التلقائي يتوقف عند تسجيل الخروج ويعود عند تسجيل الدخول.
- الحزمة غير موقعة في الإصدار الأول، لذلك قد يظهر SmartScreen. لا نطلب تعطيل SmartScreen أو Defender.
- **الجسر نفسه** لا يحدّث نفسه، ولا يسحب كوداً من الإنترنت، ولا يعمل `git pull`. تحديث الجسر يحتاج تنزيل حزمة جديدة ومراجعة بصمتها.
- **Claude Code تبعية خارجية منفصلة:** إذا ثبّته اللانشر بالتنصيب الأصلي من Anthropic، فهو يتحدّث تلقائياً في الخلفية. هذا مقبول حتى تصل إصلاحات الأمان والميزات. قبل تنزيل المثبّت تعرض النافذة المصدر والأثر وتطلب موافقة صريحة.

## تعديل الإعداد والتشخيص والإلغاء

شغّل `START.cmd` مرة ثانية:

- «تعديل الإعدادات» لا يعرض رمز البوت المشفّر إلا بعد موافقة صريحة.
- «تشخيص» يفحص رمز البوت، تسجيل Claude، المالك، عملية الجسر، نسخة الحالة، واختصار Startup، ويعطي حلاً عربياً.
- «استعادة الحالة» توقف الجسر وتسترجع آخر نسخة سليمة من `state.json.bak` بعد موافقتك، مع إبقاء الملف التالف معزولاً للمراجعة.
- «إلغاء التثبيت» يوقف الجسر ويحذف اختصار Startup فقط. لا يحذف إعداداتك أو ذاكرتك؛ يعرض مكان المجلد عشان تحذفه بنفسك إذا رغبت.

## كيف يلقى Claude Code

البرنامج يبحث عند الإقلاع في:

- المسار اللي تضعه في `CLAUDE_BIN`.
- التنصيب الأصلي الثابت `%USERPROFILE%\.local\bin\claude.exe` أولاً.
- تنصيبات Claude Desktop الأصلية داخل مجلدات ويندوز المعروفة.
- ملف `cli.js` من تنصيب npm العام.
- النتائج اللي يرجعها `where.exe`.

إذا اجتمع التنصيب الأصلي مع npm، يفضّل التنصيب الأصلي المحدث. بعد التثبيت الرسمي يحفظ المسار الذي تحقق منه مباشرةً في الإعداد. ما يشغّل ملفات `.cmd` أو `.bat` عبر shell، عشان ما يدخل نص المستخدم في أمر قابل للحقن. إذا ما وجد إلا تنصيب npm، يشغّل `cli.js` مباشرة بواسطة Node.js.

اللانشر يستخدم قناة **التنصيب الأصلي الرسمية من Anthropic** (`https://claude.ai/install.ps1`) لأنها القناة التي توصي بها Anthropic على ويندوز وتدعم التحديثات الأمنية التلقائية. قبل التنفيذ يعرض الرابط ويشرح التحديث الخلفي ويطلب موافقة صريحة. إذا فشل، يعطيك رابط التثبيت اليدوي بدل ما يكمل بصمت. ما يستخدم `claude setup-token`.

## الأوامر داخل البوت

- `/help` أو `/مساعدة`: شرح سريع مع أزرار تضغطها لتنفيذ أوامر الحالة والجلسة والصلاحيات والنموذج وإعادة التشغيل والتشخيص مباشرة.
- `/status` أو `/حالة`: يوضح المهمة النشطة ومدتها بالدقائق، وعدد الطلبات المنتظرة خلفها، وهل سيُستخدم سياق سابق، والنموذج بإصداره، ومستوى التفكير والصلاحيات والاتصال.
- `/new` أو `/جديد`: يبدأ جلسة جديدة وينسى سياق الجلسة السابقة.
- `/permissions` أو `/صلاحيات`: يغيّر طريقة الصلاحيات.
- `/model` أو `/نموذج`: يعرض النموذج الحالي وأزرار **هايكو 4.5 / سونيت 5 / أوبس 5 / فيبل 5**. بعد اختيار النموذج يعرض مستويات التفكير: منخفض، متوسط، عالٍ، عالٍ جداً، وأقصى. تقدر تختار النموذج مباشرة مثل `/model opus` أو تقول «غيّر النموذج إلى أوبس».
- `/restart` أو `/إعادة_تشغيل`: يعيد تشغيل الجسر من الجوال إذا علّق أو تصرّف بغرابة، ثم يرسل تأكيداً بعد رجوعه. يرفض الأمر إذا كانت فيه مهمة شغّالة حتى ما يقطعها.
- `/diagnose` أو `/تشخيص`: يفحص اتصال الجسر، المهمة النشطة والمنتظر خلفها، سياق المحادثة، وجود Claude Code وتسجيل دخوله، الصلاحيات والنموذج بإصداره ومستوى التفكير، ويذكر الحل إذا وجد خللاً.
- زر «⏹ أوقف المهمة»: يوقف المهمة الحالية أو يحذفها من الانتظار.
- زر «🔄 أعد المحاولة»: يعيد آخر طلب في المحادثة.

النموذج الافتراضي **سونيت**، والاختيار يُحفظ لكل مستخدم ويستمر بعد إعادة تشغيل الجسر. مستوى التفكير يبقى **افتراضي من Claude** إلى أن تختاره بنفسك؛ بعدها يُحفظ ويُمرر إلى Claude Code. قد لا يتاح **فيبل** إلا في باقة Max؛ البرنامج ما يفترض تفاصيل الباقات، وإذا رفض Claude Code نموذجاً أو مستوى تفكير يعرض رسالة عربية واضحة تطلب تجربة اختيار آخر.

أثناء المهمة يرسل الجسر حالة الكتابة فوراً ويجددها كل أربع ثوانٍ، ويحافظ على رسالة تقدم واحدة معها زر الإيقاف. الوقت الظاهر والوقت النهائي بالدقائق، بلا عدّاد ثوانٍ مزعج.

أمر `/restart` لا يحدّث الجسر ولا Claude Code. الجسر يحتاج حزمة جديدة للتحديث، وClaude Code يدير تحديثه كبرنامج منفصل. فائدة الأمر هي استعادة الجسر عن بُعد إذا تعلّق.

## الذاكرة

يحفظ البرنامج معرّف جلسة Claude Code لكل محادثة واختيار النموذج ومستوى التفكير لكل مستخدم في `data/state.json`. لذلك يكمل السياق والاختيارات بعد إعادة تشغيل البرنامج. أمر `/new` يمسح جلسة المحادثة فقط.

الذاكرة محلية لجهاز واحد. ما فيه مزامنة بين جهازين، ولا Git، ولا مخزن مشترك.

كل حفظ للحالة يحتفظ بنسخة سابقة في `data/state.json.bak`. إذا كان ملف الحالة الموجود تالفاً أو بنيته غير صحيحة، **ما يبدأ الجسر بحالة فارغة**: يعزل الملف التالف، يتوقف برسالة عربية واضحة في سجل التشغيل، وينتظر منك استعادة النسخة الاحتياطية صراحةً من النافذة.

## كم يكلّف؟

المشروع نفسه مجاني ومفتوح المصدر. ما يحتاج سيرفر ولا استضافة شهرية.

تشغيل Claude Code بحساب الاشتراك يعتمد على تسجيل دخولك وحصة اشتراكك. انتبه: وجود `ANTHROPIC_API_KEY` قد يغيّر الفوترة إلى رصيد API بالدولار. البرنامج يحجب هذا المفتاح عن العملية الابنة افتراضياً، وينبهك إذا وجده.

لا تفعّل `CLAUDE_ALLOW_API_BILLING=1` إلا إذا كنت تقصد استخدام فوترة API وتفهم تكلفتها.

## الخصوصية والسجلات

- ما يسجل نص طلباتك أو أجوبة Claude في السجل.
- يمرر لعملية Claude بيئة مبنية من قائمة سماح صغيرة فقط (المسارات الأساسية واعتماد الاشتراك الشخصي)، ويستخدم اللانشر القائمة نفسها عند فحص تسجيل الدخول.
- الإصدار الأول لا يدعم بوابات Anthropic الخاصة أو proxy/CA المؤسسي؛ لذلك لا يمرر `ANTHROPIC_AUTH_TOKEN` أو `ANTHROPIC_BASE_URL` أو متغيرات proxy والشهادات، حتى لا يمر اعتماد بلا وجهته.
- يرسل رسائل تيليجرام كنص خام بدون Markdown أو HTML.
- مجلد `data/` وملف `.env` وكل الملفات المحلية مستثناة من Git.
- يخزن رمز البوت مشفراً بـDPAPI للمستخدم الحالي، ويضيّق صلاحيات ملف الإعداد.
- طلبات الموافقة الحساسة تبقى في الذاكرة فقط، ولا تُكتب مدخلات الأدوات إلى ملف الحالة. الزر يحمل معرّفاً عشوائياً قصيراً وقرار السماح أو الرفض فقط، وتُحجب الأسرار. إذا لم يمكن عرض الوصف كاملاً ضمن الحد الآمن، يُرفض الطلب قبل إرساله ويُطلب من Claude تقسيمه.
- تُحجب المسارات المطلقة بصيغ Windows وUNC وPOSIX من الرسائل والأخطاء والسجلات، مع إبقاء ذيل الأمر الظاهر حتى تعرف وش الإجراء المطلوب.
- جلسات الوضع الآمن لا تبدأ بلا سياق وسيط موافقة مكتمل، وتستخدم `--strict-mcp-config` لعزلها عن أي خوادم MCP أخرى معرّفة في إعداد المستخدم أو المشروع.
- إيقاف المهمة أو الجسر، أو فقد وسيط الموافقة، يرفض كل طلب معلق؛ ولا يوجد مستهلك ثانٍ لتحديثات تيليجرام.
- يحفظ كل جزء من الجواب كوحدة مستقلة في الصندوق الصادر، ويسجل `message_id` عند وصول الجزء؛ إذا فشل جزء لاحق ما يعيد الأجزاء المؤكدة قبله.
- ضمان الإرسال **at-least-once**: قد يتكرر الجزء الذي قبله تيليجرام ثم انقطع الاتصال قبل وصول الرد، لأن Bot API ما يوفر مفتاح idempotency. ما ندّعي exactly-once.
- الصندوق الصادر يحتفظ بحد أقصى 500 ظرف pending (الظرف = جواب واحد، وقد يكون عدة أجزاء)، وبحد أعلى 1100 سجل إجمالاً، ولمدة 7 أيام. عند الامتلاء ينقل الأقدم إلى قائمة dead-letter محلية محدودة بـ50 سجلاً؛ وعند انتهاء المدة يعزله بدل نمو الملف بلا سقف.
- سجل `logs\bridge.log` يدور تلقائياً عند 5 MiB من داخل العملية وهي شغالة، ويحتفظ بنسخة سابقة واحدة.

## التطوير والاختبار

المشروع بلا اعتماديات خارجية؛ يستخدم واجهات Node.js المدمجة فقط.

```powershell
npm run check
npm test
```

لبناء حزمة x64 الرسمية محلياً:

```powershell
npm run build:win
```

سكربت البناء ينزل Node.js 24.18.0 LTS المحمول من `nodejs.org`، يطابق SHA-256 مع `SHASUMS256.txt` الرسمي، ثم يبني ملف zip حتمياً بترتيب وأوقات ثابتة في `dist\`. بناءان من نفس المحتوى ينتجان البصمة نفسها. ثنائيات Node لا تدخل تاريخ Git.

الاختبارات تشمل الموافقة والرفض والمهلة وإعادة الضغط والمالك أو المحادثة الخطأ والإيقاف وإغلاق الوسيط، ورفض الطلب الطويل، ومنع حقن اسم الأداة، وعدم تعليق إزاحة تيليجرام على تحديث فاشل، وعزل MCP الصارم، ودورة الكتابة والتقدم وحدود الدقائق، وأزرار المساعدة ومستويات التفكير وسلامة النص ثنائي الاتجاه، إضافةً إلى عمليات مشرف وNode حقيقية للإيقاف والإلغاء والتحديث، وبيئتي اكتشاف Claude، وملف حالة تالف واستعادة صريحة، وأجزاء صندوق صادر، وسقف/TTL، وتدوير سجل أثناء بقاء العملية حية.

## الترخيص والإسناد

الترخيص MIT. راجع [LICENSE](LICENSE) و[CREDITS.md](CREDITS.md).

هذا مشروع مجتمعي غير رسمي، وليس تابعاً لـAnthropic أو Telegram ولا معتمداً منهما.

[↑ اختر اللغة / Choose language](#cc-telegram-bridge)

---

## English

A simple bridge between Telegram and Claude Code on a Windows computer. Send a request to your bot, and the bridge runs Claude Code on your computer and returns the answer. No server or hosting subscription is required.

The ready-to-use package includes an Arabic setup window and a portable Node.js runtime. Users do not need to install Node.js or open a command prompt.

## Download the ready-to-use Windows package

> ⬇️ **[Download the ready-to-use Windows x64 package — version 0.1.3](https://github.com/Alhosain705/cc-telegram-bridge/releases/download/v0.1.3/cc-telegram-bridge-0.1.3-win-x64.zip)**<br>
> 🔐 **[Download the SHA-256 checksum](https://github.com/Alhosain705/cc-telegram-bridge/releases/download/v0.1.3/cc-telegram-bridge-0.1.3-win-x64.zip.sha256)** · **[View the release page](https://github.com/Alhosain705/cc-telegram-bridge/releases/tag/v0.1.3)**

Do not use **Code → Download ZIP** for installation. That button downloads the source code, not the ready-to-use Windows package.

After downloading, extract the package first and open `MANUAL.html` from inside the folder. It is an illustrated Arabic guide that explains installation, features, security, and troubleshooting step by step. This `README` contains the technical details.

### Step zero — Before the five steps

You need an active paid Claude subscription. Both **Pro and Max** support Claude Code in the terminal; the main difference is the usage allowance. Max is not required to run the bridge.

If you do not have a subscription, create a Claude account, confirm your email address, then activate Pro or Max. Once your subscription is ready, continue with the five steps below.

### Before you start

You need:

- 64-bit Windows 10 or Windows 11. An ARM64 release is not currently available.
- A valid Claude account and subscription.
- A Telegram bot created through BotFather.
- An internet connection.

If Claude Code is not installed or you are not signed in, the setup window guides you through the official process and then continues automatically.

### Important security notice

This program connects Claude Code to your computer, which means it can read and modify files according to the permission mode you choose. We recommend running it on a dedicated computer or an older computer that has been cleared of personal data, not on your primary device.

Safe mode is the default: it does not enable permission bypassing. The first time you pair your account, the bridge asks you to choose:

- **Approve every action:** When Claude Code requests a sensitive action, the bridge sends your chat request-specific **✅ Approve** and **❌ Reject** buttons. Typing a normal message such as “approve” does not authorize anything. Rejection or the 10-minute timeout blocks the action.
- **Work freely:** Enables permission bypassing, allowing actions without asking. This is risky and should only be used on a dedicated computer with no personal data.

The bot is also locked down from the beginning:

- The first release supports **one owner only**, in a private chat only.
- On first use, it captures the owner's Telegram ID from a six-digit pairing code and saves it to the allowlist.
- This release does not support additional users or group chats.
- The same authorization check applies to messages and buttons.

Read [SECURITY.md](SECURITY.md) before choosing **Work freely**.

### Installation — Five steps after you have a Claude subscription

1. Create a bot with BotFather and copy its bot token.
2. [Download the ready-to-use Windows x64 package](https://github.com/Alhosain705/cc-telegram-bridge/releases/download/v0.1.3/cc-telegram-bridge-0.1.3-win-x64.zip), extract it, and double-click `START.cmd`. If Windows displays a warning, verify the filename and source before choosing to run it.
3. Paste the bot token into the setup window and select **Verify and start pairing**. Safe mode is selected by default.
4. If Claude Code needs to be installed or signed in, complete the visible one-time window.
5. Send the six-digit pairing code to your bot.

The rest happens automatically:

- Captures your Telegram account ID from the pairing message without using a third-party bot.
- Installs the files in `%LOCALAPPDATA%\cc-telegram-bridge`.
- Saves `.env` as UTF-8 without a BOM.
- Creates a shortcut in the Startup folder.
- Starts the bridge in the background.
- Sends a success message to your bot.

Automatic startup occurs **when you sign in to Windows**, not before sign-in during system boot.

### Known Windows limitations

- A computer with enforced Smart App Control may block the package scripts. We do not ask you to disable it.
- An enforced company policy such as PowerShell AllSigned or Restricted may block execution; `ExecutionPolicy Bypass` cannot override Group Policy.
- Automatic operation stops when you sign out and resumes when you sign in again.
- The first release is unsigned, so SmartScreen may display a warning. We do not ask you to disable SmartScreen or Defender.
- **The bridge itself** does not update automatically, download code from the internet, or run `git pull`. Updating the bridge requires downloading a new package and verifying its checksum.
- **Claude Code is a separate external dependency:** If the launcher installs it through Anthropic's native installer, Claude Code updates itself automatically in the background. This is intentional so security fixes and new features can arrive. Before downloading the installer, the setup window shows the source and impact and asks for explicit approval.

### Change settings, diagnose, or uninstall

Run `START.cmd` again:

- **Change settings** does not reveal the encrypted bot token unless you explicitly approve it.
- **Diagnostics** checks the bot token, Claude sign-in, owner, bridge process, state version, and Startup shortcut, then provides an Arabic solution.
- **Restore state** stops the bridge and restores the most recent valid `state.json.bak` after your approval, while preserving the corrupted file separately for review.
- **Uninstall** stops the bridge and removes only the Startup shortcut. It does not delete your settings or memory; it shows the folder location so you can remove it yourself if desired.

### How it locates Claude Code

At startup, the bridge checks:

- The path set in `CLAUDE_BIN`.
- The stable native installation path `%USERPROFILE%\.local\bin\claude.exe` first.
- Native Claude Desktop installations in known Windows directories.
- `cli.js` from a global npm installation.
- Results returned by `where.exe`.

When both native and npm installations exist, the bridge prefers the updated native installation. After an official installation, it saves the exact path it verified. It does not launch `.cmd` or `.bat` files through a shell, preventing user text from entering an injectable command. If only an npm installation is found, it launches `cli.js` directly with Node.js.

The launcher uses Anthropic's **official native installation channel** (`https://claude.ai/install.ps1`) because Anthropic recommends it on Windows and it supports automatic security updates. Before running it, the launcher displays the URL, explains background updates, and asks for explicit approval. If installation fails, it provides the manual installation link instead of continuing silently. It does not use `claude setup-token`.

### Bot commands

- `/help` or `/مساعدة`: Shows a quick guide with buttons for status, session, permissions, model, restart, and diagnostics commands.
- `/status` or `/حالة`: Shows the active task and its duration in minutes, queued requests, whether previous context will be used, the model and version, thinking level, permissions, and connection state.
- `/new` or `/جديد`: Starts a new session and forgets the previous conversation context.
- `/permissions` or `/صلاحيات`: Changes the permission mode.
- `/model` or `/نموذج`: Shows the current model and buttons for **Haiku 4.5 / Sonnet 5 / Opus 5 / Fable 5**. After choosing a model, it shows the thinking levels: low, medium, high, very high, and maximum. You can also select a model directly, such as `/model opus`, or ask the bot to change it in natural language.
- `/restart` or `/إعادة_تشغيل`: Restarts the bridge remotely if it hangs or behaves unexpectedly, then confirms when it is back. The command is rejected while a task is running so it cannot interrupt active work.
- `/diagnose` or `/تشخيص`: Checks the bridge connection, active and queued tasks, conversation context, Claude Code installation and sign-in, permissions, model and version, and thinking level, then suggests a solution when it finds a problem.
- **⏹ Stop task:** Stops the current task or removes it from the queue.
- **🔄 Retry:** Repeats the latest request in the conversation.

The default model is **Sonnet**. Model choice is saved per user and survives bridge restarts. The thinking level remains **Claude's default** until you choose one; after that, it is saved and passed to Claude Code. **Fable** may require a Max plan. The bridge does not assume plan details; if Claude Code rejects a model or thinking level, it displays a clear Arabic message asking you to try another option.

While a task is running, the bridge sends the typing status immediately and refreshes it every four seconds. It maintains one progress message with a stop button. Both elapsed and final times are shown in minutes without a distracting seconds counter.

The `/restart` command does not update the bridge or Claude Code. Updating the bridge requires a new package, while Claude Code manages its updates as a separate application. The command exists to recover the bridge remotely if it becomes stuck.

### Memory

The bridge stores the Claude Code session ID for each conversation, plus model and thinking-level choices for each user, in `data/state.json`. This preserves context and preferences after the program restarts. The `/new` command clears only the current conversation session.

Memory is local to one computer. There is no synchronization between computers, Git integration, or shared storage.

Each state save preserves the previous copy in `data/state.json.bak`. If the current state file is corrupted or structurally invalid, **the bridge does not start with empty state**. It isolates the corrupted file, stops with a clear Arabic message in the log, and waits for you to explicitly restore the backup through the setup window.

### How much does it cost?

The project itself is free and open source. It does not require a server or monthly hosting subscription.

Running Claude Code through your subscription depends on your sign-in and subscription allowance. Be aware that an `ANTHROPIC_API_KEY` in your environment may switch billing to metered API charges. The bridge hides this key from the child process by default and warns you when it finds one.

Do not enable `CLAUDE_ALLOW_API_BILLING=1` unless you intentionally want API billing and understand its cost.

### Privacy and logging

- The log does not record the text of your requests or Claude's answers.
- The Claude process receives an environment built from a small allowlist only: essential paths and personal subscription credentials. The launcher uses the same allowlist when checking sign-in.
- The first release does not support private Anthropic gateways or enterprise proxy/CA configurations. It therefore does not pass `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, or proxy and certificate variables, preventing credentials from being passed without their intended destination.
- Telegram messages are sent as plain text without Markdown or HTML.
- The `data/` directory, `.env`, and all local files are excluded from Git.
- The bot token is encrypted with DPAPI for the current user, and permissions on the settings file are restricted.
- Sensitive approval requests remain in memory only; tool inputs are not written to the state file. A button contains only a short random identifier and the approve or reject decision, while secrets are redacted. If the full description cannot fit within the safe limit, the request is rejected before delivery and Claude is asked to split it.
- Absolute Windows, UNC, and POSIX paths are redacted from messages, errors, and logs, while the visible command suffix is preserved so you can understand the required action.
- Safe-mode sessions cannot start without a complete approval-broker context and use `--strict-mcp-config` to isolate them from any other MCP servers configured in the user's or project's settings.
- Stopping a task or the bridge, or losing the approval broker, rejects every pending request. There is no second consumer for Telegram updates.
- Every answer part is stored as an independent outbox unit, and its `message_id` is recorded when delivered. If a later part fails, confirmed earlier parts are not sent again.
- Delivery is **at least once**: a part may be duplicated if Telegram received it but the connection failed before the response arrived, because the Bot API does not provide an idempotency key. We do not claim exactly-once delivery.
- The outbox retains at most 500 pending envelopes (one envelope is one answer and may contain several parts), no more than 1,100 total records, and no longer than seven days. When full, it moves the oldest records to a local dead-letter list capped at 50 entries; expired records are isolated instead of allowing the file to grow without limit.
- `logs\bridge.log` rotates automatically at 5 MiB while the process remains running and retains one previous copy.

### Development and testing

The project has no external dependencies; it uses only built-in Node.js APIs.

```powershell
npm run check
npm test
```

To build the official x64 package locally:

```powershell
npm run build:win
```

The build script downloads the portable Node.js 24.18.0 LTS runtime from `nodejs.org`, verifies its SHA-256 against the official `SHASUMS256.txt`, then creates a deterministic ZIP with fixed ordering and timestamps in `dist\`. Two builds from the same content produce the same checksum. Node.js binaries are not committed to Git history.

Tests cover approval, rejection, timeout, repeated button presses, wrong owner or chat, cancellation, broker shutdown, rejection of oversized requests, tool-name injection prevention, prevention of Telegram offset commits after failed updates, strict MCP isolation, typing and progress behavior, minute limits, help buttons, thinking levels, and bidirectional-text safety. They also run real supervisor and Node.js processes for stop, uninstall, and update behavior; two Claude discovery environments; corrupted state and explicit recovery; outbox parts, capacity, and TTL; and live log rotation.

### License and attribution

Licensed under the MIT License. See [LICENSE](LICENSE) and [CREDITS.md](CREDITS.md).

This is an unofficial community project. It is not affiliated with or endorsed by Anthropic or Telegram.

[↑ Choose language / اختر اللغة](#cc-telegram-bridge)
