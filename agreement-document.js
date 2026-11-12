// ══════════════════════════════════════════════════════════════════════
//  Nicoco — Agreement Generator v2.2：完整合約文件（主契約＋附件）
//  純邏輯：條款範本、資料欄位代入、警示、版本快照、版本差異。不讀寫 Firestore、不依賴 DOM。
//  依賴：agreement-data.js（NicocoAgreement）——附件內容、費用、合約需求明細。
//
//  資料：agreements/{id}.contractDocument（可反覆編輯的草稿）
//        agreements/{id}/versions/v{n}（建立版本時的不可變快照；Rules 禁止修改與刪除）
//
//  原則：
//    - 條款文字中的 {{欄位}} 於預覽時代入合約資料；沒有資料就顯示【未填寫：…】警示，不代填。
//    - 範本中標示【待確認：…】的地方是尚未確認的條件，會列入警示，直到管理員改寫。
//    - 開發義務只來自附件二（確認開發項目）與附件四（已核准變更）；附件一原始需求只是紀錄。
//    - 版本快照保存「當時代入後的條款全文」與附件所需資料；之後重新帶入需求或報價都不會改變已建立的版本。
//
//  條款預設內容：由 Claude 依 v2.2 需求文件第二節的規則與現有合約條款（AGREEMENT_DEFAULT_TEXT）擬定的草稿，
//  尚未經法律專業人士審閱。templateStatus＝'claude_draft'；管理員勾選「已確認條款內容」前會持續顯示警示。
// ══════════════════════════════════════════════════════════════════════
(function (root) {
  'use strict';

  var SCHEMA_VERSION = '2.2';
  var TEMPLATE_ID = 'nicoco-web-dev-contract-draft-1';

  function str(v) { return v == null ? '' : String(v); }
  function trim(v) { return str(v).trim(); }
  function num(v) { var n = Number(v); return Number.isFinite(n) ? n : 0; }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function esc(v) {
    return str(v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function A() { return root.NicocoAgreement || null; }
  function money(n) { return 'NT$' + num(n).toLocaleString('en-US'); }

  // ══════════════════════════════════════════════════════════════════
  //  修改與驗收規則（每份合約可個別調整；預設值依 v2.2 需求文件第二節）
  // ══════════════════════════════════════════════════════════════════
  var FREE_SCOPE_TYPES = [
    { key: 'text_replace', label: '文字內容替換（由甲方提供文字）' },
    { key: 'image_replace', label: '圖片替換（由甲方提供素材）' },
    { key: 'style_tweak', label: '色彩、字級、間距等樣式微調' },
    { key: 'layout_tweak', label: '同一頁面既有區塊的順序或位置調整' },
    { key: 'interaction_tweak', label: '既有功能的顯示與操作細節調整（不新增功能）' },
  ];
  var FREE_SCOPE_LEVELS = [
    { key: 'minor', label: '微幅調整：不改變頁面結構與功能流程' },
    { key: 'moderate', label: '中幅調整：可調整單一頁面的區塊配置，但不新增頁面或功能' },
  ];
  var CHANGE_CATEGORIES = [
    { key: 'defect', label: '可歸責於乙方的瑕疵修正', consumesQuota: false },
    { key: 'in_scope_free', label: '原契約範圍內的免費調整', consumesQuota: true },
    { key: 'over_quota', label: '超出免費額度的調整', consumesQuota: false },
    { key: 'new_requirement', label: '新增或變更需求', consumesQuota: false },
    { key: 'third_party', label: '第三方服務問題', consumesQuota: false },
    { key: 'disputed', label: '待雙方確認的爭議項目', consumesQuota: false },
  ];
  var LIMITS = { freeBatches: [0, 20], itemsPerBatch: [1, 20], periodDays: [1, 90] };

  function defaultRevisionRules() {
    return {
      development: { freeBatches: 2, itemsPerBatch: 5 },
      acceptance: { freeBatches: 2, itemsPerBatch: 5, periodDays: 14 },
      carryOver: false,
      freeScope: { types: [], pages: '', level: '', workScope: '', notes: '' },
      extraChangeFeeText: '',
    };
  }

  // 回傳錯誤訊息陣列（空＝合法）
  function validateRevisionRules(r) {
    var out = [];
    r = r || {};
    function intIn(v, lim, label) {
      if (!(Number.isInteger(v) && v >= lim[0] && v <= lim[1])) out.push(label + '須為 ' + lim[0] + '～' + lim[1] + ' 的整數');
    }
    var d = r.development || {}, a = r.acceptance || {};
    intIn(d.freeBatches, LIMITS.freeBatches, '開發期間免費修改批次');
    intIn(d.itemsPerBatch, LIMITS.itemsPerBatch, '開發期間每批次項目上限');
    intIn(a.freeBatches, LIMITS.freeBatches, '驗收期間免費修改批次');
    intIn(a.itemsPerBatch, LIMITS.itemsPerBatch, '驗收期間每批次項目上限');
    intIn(a.periodDays, LIMITS.periodDays, '驗收期限（日曆日）');
    if (typeof r.carryOver !== 'boolean') out.push('額度是否轉移設定不正確');
    var fs = r.freeScope || {};
    arr(fs.types).forEach(function (t) { if (!FREE_SCOPE_TYPES.some(function (x) { return x.key === t; })) out.push('免費修改類型「' + t + '」不在選項中'); });
    if (fs.level && !FREE_SCOPE_LEVELS.some(function (x) { return x.key === fs.level; })) out.push('調整程度設定不正確');
    return out;
  }

  // ══════════════════════════════════════════════════════════════════
  //  條款範本（Claude 擬定的草稿；{{欄位}} 於預覽時代入）
  // ══════════════════════════════════════════════════════════════════
  var SECTION_TEMPLATES = [
    { key: 'parties', title: '第一條　契約當事人與基本資料', text: [
      '甲方（委託人）：{{clientName}}',
      '統一編號：{{clientTaxId}}　代表人：{{clientRepresentative}}',
      '地址：{{clientAddress}}　聯絡方式：{{clientContact}}',
      '乙方（受託人）：{{providerName}}',
      '統一編號：{{providerTaxId}}　地址：{{providerAddress}}　聯絡方式：{{providerContact}}',
      '專案名稱：{{projectName}}　合約編號：{{agreementNumber}}',
      '一、甲方委託乙方進行前述專案之網站開發，雙方同意依本契約條款履行。',
      '二、本契約由主契約及附件一至附件六組成，附件與主契約具同等效力。開發範圍以附件二為準；附件一僅為需求溝通紀錄，與附件二不一致時，以附件二為準。',
    ] },
    { key: 'scope', title: '第二條　開發範圍、已確認需求與排除項目', text: [
      '一、乙方之開發義務，以附件二「確認開發項目」及經雙方書面核准之需求變更（附件四）為準。目前確認開發項目共 {{obligationCount}} 項。',
      '二、附件一「客戶原始需求」為甲方提出需求之完整紀錄，僅供溝通及追溯；其中未列入附件二之項目，不構成乙方之開發義務。',
      '三、附件三所列「明確排除」「另行報價」及「待確認」項目（共 {{nonObligationCount}} 項），均不屬於本契約之開發範圍。「待確認」項目須經雙方書面確認，列入附件二或依需求變更程序辦理後，始成為開發義務。',
      '四、本契約簽訂後之新增或變更需求，依第五條第五項第四款及需求變更程序辦理。',
    ] },
    { key: 'schedule', title: '第三條　開發時程、交付成果及雙方配合義務', text: [
      '一、預計開始日：{{startDate}}；預計完成日：{{completionDate}}。',
      '二、乙方應依附件二所載之交付成果及驗收依據完成開發並交付。',
      '三、甲方應提供網站所需之文字、圖片、商品資料、帳號權限及第三方服務申請資料，並指定聯絡窗口，於【待確認：甲方提供資料及回覆確認事項之期限】內回覆乙方之確認事項。',
      '四、因甲方延遲提供資料或延遲確認，致開發時程延後者，預計完成日得相應順延，不視為乙方遲延。',
    ] },
    { key: 'fees', title: '第四條　開發費用、維護費用、追加費用與付款條件', text: [
      '一、本契約原合約金額為 {{contractAmount}}（{{taxNote}}）。',
      '二、已核准之追加或變更金額：{{approvedChanges}}；調整後專案總額：{{adjustedTotal}}。',
      '三、付款計畫如下：',
      '{{paymentPlan}}',
      '四、{{paymentTermsText}}',
      '五、維護費用：{{maintenanceFees}}',
      '六、超出免費修改額度之調整及新增或變更需求之費用，依第五條辦理；第三方服務費用依第八條辦理，不包含於本契約金額。',
      '七、各項費用明細詳附件五。',
    ] },
    { key: 'devChanges', title: '第五條　開發期間修改規則', text: [
      '一、本契約之修改採「批次＋項目＋工作範圍」計算。甲方應將同一時間提出之修改事項彙整為一個批次，以書面（含電子郵件或雙方約定之通訊方式）一次提出；單一項目以一個明確、可獨立完成之調整為準。',
      '二、開發期間，甲方享有免費修改 {{devFreeBatches}} 批次，每批次以 {{devItemsPerBatch}} 項為上限。',
      '三、免費修改僅限附件六所列之免費修改範圍：調整類型為 {{freeScopeTypes}}；適用頁面為 {{freeScopePages}}；調整程度為 {{freeScopeLevel}}；工作範圍為 {{freeScopeWork}}。每批次項目數未達上限，不代表任何調整均屬免費修改。',
      '四、開發期間與驗收期間之免費修改額度分別計算，{{carryOverText}}。',
      '五、甲方提出之修改事項，由乙方先行分類並經雙方確認後，始依分類處理及計入額度：',
      '（一）可歸責於乙方之瑕疵修正：交付成果未依附件二運作或乙方實作錯誤者，乙方應修正，且不扣除免費修改額度。',
      '（二）原契約範圍內之免費調整：屬免費修改範圍且於當期額度內者，扣除當期額度。',
      '（三）超出免費額度之調整：屬原契約範圍，但當期額度已用盡或超出每批次項目上限者，依 {{extraChangeFee}} 另行計費。',
      '（四）新增或變更需求：超出附件二確認開發項目者，不屬修改額度，依需求變更程序另行評估工時及費用，經雙方書面確認後執行。',
      '（五）第三方服務問題：因第三方平台、金流、主機、網域等外部服務之規格、政策或故障所生者，依第八條辦理，不扣除額度，亦不視為乙方瑕疵。',
      '（六）待雙方確認之爭議項目：雙方對分類意見不一致者，先列為爭議項目；確認前不扣除額度，並依第十條協商。',
      '六、修改事項未經前項分類及雙方確認前，不得扣除免費修改額度。瑕疵修正之處理，仍應遵守相關法令及本契約之義務。',
      '七、{{changeRequestPolicy}}',
    ] },
    { key: 'acceptance', title: '第六條　驗收期間修改規則與驗收程序', text: [
      '一、乙方完成附件二所列開發項目並通知甲方驗收後，甲方應於收到驗收通知之日起 {{acceptanceDays}} 個日曆日內，依附件二之驗收依據進行驗收，並以書面提出驗收結果或修改事項。',
      '二、驗收期間，甲方享有免費修改 {{accFreeBatches}} 批次，每批次以 {{accItemsPerBatch}} 項為上限；其範圍、分類及計算方式依第五條第一項、第三項、第五項及第六項辦理。',
      '三、驗收期間發現之瑕疵，由乙方依第五條第五項第一款修正，不扣除驗收期間免費修改額度；修正完成後，就修正部分重新驗收。',
      '四、{{acceptancePolicy}}',
    ] },
    { key: 'warranty', title: '第七條　瑕疵修正、保固及維護責任', text: [
      '一、乙方交付之成果與附件二約定不符，或功能無法依約正常運作者，乙方應負責修正。',
      '二、{{warrantyPolicy}}',
      '三、因甲方或第三人自行修改程式、變更主機環境，或第三方服務異動等非可歸責於乙方之事由所生之問題，不屬保固範圍。',
      '四、維護服務：{{maintenanceText}}',
    ] },
    { key: 'thirdParty', title: '第八條　第三方服務、金流、主機、網域及其他外部費用', text: [
      '一、{{thirdPartyFeeNotice}}',
      '二、第三方服務之責任歸屬如下：',
      '{{thirdPartyList}}',
      '三、金流、主機、網域等服務帳號，原則上以甲方名義申請並由甲方保管；由乙方代為申請者，【待確認：帳號移交之方式及時點】。',
    ] },
    { key: 'ip', title: '第九條　智慧財產權、保密及資料處理', text: [
      '一、{{ipDeliverablesPolicy}}',
      '二、乙方於開發中使用之既有程式元件、開源套件及通用工具，其權利仍歸原權利人或乙方所有。乙方是否得將本專案列為作品展示：【待確認：作品展示之同意與範圍】。',
      '三、雙方對因本契約知悉之對方營業秘密及未公開資料，負保密義務；本契約終止或屆滿後亦同。',
      '四、乙方因開發需要接觸甲方或其客戶之個人資料者，僅得於本契約目的範圍內使用，並依個人資料保護法相關規定採取適當之安全措施；專案結束後，依甲方指示刪除或返還。',
    ] },
    { key: 'termination', title: '第十條　契約終止、爭議處理及其他約定', text: [
      '一、{{terminationPolicy}}',
      '二、本契約之修改或補充，應經雙方書面同意。',
      '三、本契約以中華民國法律為準據法。因本契約所生之爭議，雙方應先誠意協商；協商不成時，以【待確認：管轄法院】為第一審管轄法院。',
      '四、本契約未盡事宜，依相關法令及誠實信用原則處理。',
    ] },
  ];

  var ANNEXES = [
    { key: 'original', title: '附件一　客戶原始需求（紀錄，不構成開發義務）' },
    { key: 'confirmed', title: '附件二　確認開發項目、交付成果及驗收依據' },
    { key: 'excluded', title: '附件三　明確排除、另行報價及待確認項目' },
    { key: 'changes', title: '附件四　已核准之需求變更' },
    { key: 'fees', title: '附件五　費用明細及付款計畫' },
    { key: 'revision', title: '附件六　修改額度及免費修改範圍' },
  ];

  // {{欄位}} 說明（編輯畫面「可用的資料欄位」）
  var TOKEN_LABELS = {
    clientName: '甲方名稱', clientTaxId: '甲方統一編號', clientRepresentative: '甲方代表人', clientAddress: '甲方地址', clientContact: '甲方聯絡方式',
    providerName: '乙方名稱', providerTaxId: '乙方統一編號', providerAddress: '乙方地址', providerContact: '乙方聯絡方式',
    projectName: '專案名稱', agreementNumber: '合約編號', startDate: '預計開始日', completionDate: '預計完成日',
    obligationCount: '確認開發項目數', nonObligationCount: '排除／待確認項目數',
    contractAmount: '原合約金額', taxNote: '稅額說明', approvedChanges: '已核准追加金額', adjustedTotal: '調整後專案總額',
    paymentPlan: '付款計畫（清單）', paymentTermsText: '付款條件（合約欄位）', maintenanceFees: '維護費用', maintenanceText: '維護服務',
    devFreeBatches: '開發期間免費批次', devItemsPerBatch: '開發期間每批次上限', accFreeBatches: '驗收期間免費批次', accItemsPerBatch: '驗收期間每批次上限',
    acceptanceDays: '驗收期限（日曆日）', carryOverText: '額度轉移規則', freeScopeTypes: '免費修改類型', freeScopePages: '免費修改頁面',
    freeScopeLevel: '免費修改調整程度', freeScopeWork: '免費修改工作範圍', extraChangeFee: '超出額度計費方式',
    changeRequestPolicy: '修改與追加需求條款（合約欄位）', acceptancePolicy: '驗收條款（合約欄位）', warrantyPolicy: '保固條款（合約欄位）',
    thirdPartyFeeNotice: '第三方費用說明（合約欄位）', thirdPartyList: '第三方服務責任歸屬（清單）',
    ipDeliverablesPolicy: '智慧財產權條款（合約欄位）', terminationPolicy: '終止條款（合約欄位）',
  };
  var BLOCK_TOKENS = { paymentPlan: true, thirdPartyList: true };

  function sectionTemplate(key) {
    var t = SECTION_TEMPLATES.filter(function (s) { return s.key === key; })[0];
    return t ? { key: t.key, title: t.title, text: t.text.join('\n') } : null;
  }

  // ══════════════════════════════════════════════════════════════════
  //  產生合約初稿
  // ══════════════════════════════════════════════════════════════════
  function createDocument(opts) {
    opts = opts || {};
    var annexNotes = {};
    ANNEXES.forEach(function (a) { annexNotes[a.key] = ''; });
    return {
      schemaVersion: SCHEMA_VERSION,
      templateId: TEMPLATE_ID,
      templateStatus: 'claude_draft',
      title: '網站開發委託契約',
      generatedAtMs: opts.nowMs || null,
      sections: SECTION_TEMPLATES.map(function (s) { return { key: s.key, title: s.title, text: s.text.join('\n') }; }),
      supplementary: '',
      annexNotes: annexNotes,
      revisionRules: defaultRevisionRules(),
      termsConfirmed: false,
    };
  }

  // 舊資料補齊（缺少的欄位用預設值，不改動已有內容）
  function normalizeDocument(doc) {
    var d = clone(doc) || createDocument();
    if (!Array.isArray(d.sections)) d.sections = [];
    SECTION_TEMPLATES.forEach(function (t) {
      if (!d.sections.some(function (s) { return s.key === t.key; })) d.sections.push({ key: t.key, title: t.title, text: t.text.join('\n') });
    });
    d.annexNotes = d.annexNotes || {};
    ANNEXES.forEach(function (a) { if (typeof d.annexNotes[a.key] !== 'string') d.annexNotes[a.key] = ''; });
    var r = d.revisionRules || {};
    var def = defaultRevisionRules();
    d.revisionRules = {
      development: Object.assign({}, def.development, r.development || {}),
      acceptance: Object.assign({}, def.acceptance, r.acceptance || {}),
      carryOver: typeof r.carryOver === 'boolean' ? r.carryOver : def.carryOver,
      freeScope: Object.assign({}, def.freeScope, r.freeScope || {}),
      extraChangeFeeText: str(r.extraChangeFeeText),
    };
    d.revisionRules.freeScope.types = arr(d.revisionRules.freeScope.types).slice();
    d.supplementary = str(d.supplementary);
    d.termsConfirmed = !!d.termsConfirmed;
    d.schemaVersion = d.schemaVersion || SCHEMA_VERSION;
    return d;
  }

  // ══════════════════════════════════════════════════════════════════
  //  資料欄位代入
  //  agr：合約（client/provider/projectName/agreementNumber/timeline/contractAmountSnapshot/paymentPlanSnapshot/條款欄位/contractData）
  //  回傳 { key: { text, html, missing } }
  // ══════════════════════════════════════════════════════════════════
  function missingMark(label) { return '【未填寫：' + label + '】'; }

  function buildContext(agr, doc) {
    agr = agr || {}; doc = normalizeDocument(doc);
    var c = agr.client || {}, p = agr.provider || {}, tl = agr.timeline || {};
    var rr = doc.revisionRules;
    var data = agr.contractData || null;
    var Ag = A();
    var ctx = {};
    function put(key, value) {
      var v = trim(value);
      ctx[key] = v ? { text: v, missing: false } : { text: missingMark(TOKEN_LABELS[key] || key), missing: true };
    }
    put('clientName', c.company ? c.company + (c.name ? '（聯絡人：' + c.name + '）' : '') : c.name);
    put('clientTaxId', c.taxId);
    put('clientRepresentative', c.representative);
    put('clientAddress', c.address);
    put('clientContact', [c.phone, c.email].filter(Boolean).join('／'));
    put('providerName', p.studioName);
    put('providerTaxId', p.taxId);
    put('providerAddress', p.address);
    put('providerContact', [p.phone, p.contactEmail].filter(Boolean).join('／'));
    put('projectName', agr.projectName);
    put('agreementNumber', agr.agreementNumber);
    put('startDate', tl.estimatedStartDate);
    put('completionDate', tl.estimatedCompletionDate);

    var rows = data ? arr(data.items) : [];
    var hasData = !!(data && Ag);
    if (hasData) {
      ctx.obligationCount = { text: String(rows.filter(Ag.isObligation).length), missing: false };
      ctx.nonObligationCount = { text: String(rows.filter(function (r) { return !Ag.isObligation(r); }).length), missing: false };
    } else {
      put('obligationCount', ''); put('nonObligationCount', '');
    }

    var ca = num(agr.contractAmountSnapshot);
    put('contractAmount', ca > 0 ? money(ca) : '');
    var fees = hasData ? Ag.buildFees(data, ca) : null;
    if (fees && fees.mode === 'itemized' && fees.tax > 0) ctx.taxNote = { text: '含稅額 ' + money(fees.tax), missing: false };
    else ctx.taxNote = { text: '【待確認：金額是否含營業稅】', missing: true };
    if (fees) {
      ctx.approvedChanges = { text: fees.changeOrders.length ? (fees.approvedChangeDelta < 0 ? '-' : '+') + money(Math.abs(fees.approvedChangeDelta)) + '（' + fees.changeOrders.map(function (x) { return x.crNumber; }).join('、') + '）' : '無', missing: false };
      ctx.adjustedTotal = fees.adjustedTotal != null ? { text: money(fees.adjustedTotal), missing: false } : { text: '【待確認：原合約金額是否已包含已核准變更】', missing: true };
    } else {
      ctx.approvedChanges = { text: '【未填寫：合約資料（請先帶入 v2.1 合約資料）】', missing: true };
      ctx.adjustedTotal = { text: '【未填寫：合約資料（請先帶入 v2.1 合約資料）】', missing: true };
    }
    var plan = arr(agr.paymentPlanSnapshot);
    ctx.paymentPlan = plan.length
      ? { lines: plan.map(function (x, i) { return '第 ' + (i + 1) + ' 期　' + str(x.title) + '：' + num(x.percentage) + '%，' + money(x.amount) + (x.dueDate ? '，預計 ' + x.dueDate : '') + (trim(x.note) ? '（' + trim(x.note) + '）' : ''); }), missing: false }
      : { lines: [missingMark('付款計畫')], missing: true };
    put('paymentTermsText', agr.paymentTermsText);
    var maintLines = fees ? fees.lines.filter(function (l) { return l.category === 'maintenance'; }) : [];
    if (fees && fees.mode === 'total_only') ctx.maintenanceFees = { text: '【待確認：報價只有總額，維護費用待人工拆分】', missing: true };
    else if (maintLines.length) ctx.maintenanceFees = { text: maintLines.map(function (l) { return l.name + ' ' + (l.pricingPending ? '（待定價）' : money(l.amount)); }).join('、'), missing: maintLines.some(function (l) { return l.pricingPending; }) };
    else ctx.maintenanceFees = { text: hasData ? '本契約報價未包含維護費用。' : missingMark('合約資料（請先帶入 v2.1 合約資料）'), missing: !hasData };
    var maintNonWarranty = maintLines.filter(function (l) { return l.reqKey !== 'warranty'; });
    ctx.maintenanceText = { text: maintNonWarranty.length ? '依第四條第五項之維護費用及附件五辦理。' : '本契約未約定保固期後之維護服務；如有需要，雙方另行約定。', missing: false };

    ctx.devFreeBatches = { text: String(rr.development.freeBatches), missing: false };
    ctx.devItemsPerBatch = { text: String(rr.development.itemsPerBatch), missing: false };
    ctx.accFreeBatches = { text: String(rr.acceptance.freeBatches), missing: false };
    ctx.accItemsPerBatch = { text: String(rr.acceptance.itemsPerBatch), missing: false };
    ctx.acceptanceDays = { text: String(rr.acceptance.periodDays), missing: false };
    ctx.carryOverText = { text: rr.carryOver ? '開發期間未使用之額度得轉入驗收期間使用' : '未使用之額度不轉入其他期間，亦不累積', missing: false };
    var fs = rr.freeScope;
    var typeLabels = arr(fs.types).map(function (k) { var t = FREE_SCOPE_TYPES.filter(function (x) { return x.key === k; })[0]; return t ? t.label : k; });
    ctx.freeScopeTypes = typeLabels.length ? { text: typeLabels.join('、'), missing: false } : { text: missingMark('免費修改類型'), missing: true };
    put('freeScopePages', fs.pages);
    var lv = FREE_SCOPE_LEVELS.filter(function (x) { return x.key === fs.level; })[0];
    ctx.freeScopeLevel = lv ? { text: lv.label, missing: false } : { text: missingMark('免費修改調整程度'), missing: true };
    put('freeScopeWork', fs.workScope);
    ctx.extraChangeFee = trim(rr.extraChangeFeeText) ? { text: trim(rr.extraChangeFeeText), missing: false } : { text: '【待確認：超出免費額度之計費方式】', missing: true };

    ['changeRequestPolicy', 'acceptancePolicy', 'warrantyPolicy', 'thirdPartyFeeNotice', 'ipDeliverablesPolicy', 'terminationPolicy'].forEach(function (k) { put(k, agr[k]); });

    var tp = data && data.maintenance ? arr(data.maintenance.thirdPartyResponsibilities) : [];
    ctx.thirdPartyList = tp.length
      ? { lines: tp.map(function (t) { return str(t.label) + '：' + (trim(t.responsibilityLabel) || '【待確認：責任歸屬】'); }), missing: tp.some(function (t) { return !trim(t.responsibilityLabel); }) }
      : { lines: [hasData ? '本專案需求中未列出第三方服務。' : missingMark('合約資料（請先帶入 v2.1 合約資料）')], missing: !hasData };
    return ctx;
  }

  var TOKEN_RE = /\{\{\s*([A-Za-z]+)\s*\}\}/g;
  var MARK_RE = /【(待確認|未填寫)：[^】]*】/g;

  // 代入後的純文字（版本快照與差異比較用）
  function resolveText(text, ctx) {
    return str(text).split('\n').map(function (line) {
      var m = /^\s*\{\{\s*([A-Za-z]+)\s*\}\}\s*$/.exec(line);
      if (m && BLOCK_TOKENS[m[1]] && ctx[m[1]]) return ctx[m[1]].lines.map(function (l) { return '・' + l; }).join('\n');
      return line.replace(TOKEN_RE, function (all, k) {
        var v = ctx[k];
        if (!v) return '【未填寫：未知欄位 ' + k + '】';
        return v.lines ? v.lines.join('；') : v.text;
      });
    }).join('\n');
  }

  function textToHtml(plain) {
    return str(plain).split('\n').map(function (line) {
      if (!trim(line)) return '';
      var h = esc(line).replace(/【(待確認|未填寫)：[^】]*】/g, function (m) { return '<mark class="agd-flag">' + m + '</mark>'; });
      return '<p class="agd-p' + (/^・/.test(line) ? ' agd-li' : '') + '">' + h + '</p>';
    }).join('');
  }

  // 主契約各章節（含補充條款）代入後的文字
  function renderSections(agr, doc) {
    var d = normalizeDocument(doc);
    var ctx = buildContext(agr, d);
    var out = d.sections.map(function (s) { return { key: s.key, title: s.title, text: resolveText(s.text, ctx) }; });
    out.push({ key: 'supplementary', title: '補充條款', text: trim(d.supplementary) ? resolveText(d.supplementary, ctx) : '無。' });
    return out;
  }

  // ══════════════════════════════════════════════════════════════════
  //  警示（未填寫或未確認的重要資料）
  //  回傳 [{ level:'required'|'check', text, where }]
  // ══════════════════════════════════════════════════════════════════
  function collectWarnings(agr, doc, rendered) {
    var d = normalizeDocument(doc);
    var out = [];
    var seen = {};
    function add(level, text, where) { var k = level + text + (where || ''); if (seen[k]) return; seen[k] = 1; out.push({ level: level, text: text, where: where || '' }); }
    if (!d.termsConfirmed) add('required', '條款內容為 Claude 擬定的草稿，尚未由你確認（請逐條檢查後勾選「已確認條款內容」）', '');
    validateRevisionRules(d.revisionRules).forEach(function (e) { add('required', e, '修改與驗收設定'); });
    (rendered || renderSections(agr, d)).forEach(function (s) {
      var m = s.text.match(MARK_RE) || [];
      m.forEach(function (x) { add(/^【未填寫/.test(x) ? 'required' : 'check', x.replace(/^【|】$/g, ''), s.title); });
    });
    if (!agr || !agr.contractData) add('required', '沒有合約資料（v2.1），附件一至附件五無法產生；請先在合約編輯畫面帶入', '附件');
    else {
      var Ag = A();
      if (Ag) {
        var obligations = arr(agr.contractData.items).filter(Ag.isObligation);
        if (!obligations.length) add('required', '附件二沒有任何確認開發項目', '附件二');
        var noDeliv = obligations.filter(function (r) { return !trim(r.deliverables); }).length;
        var noAcc = obligations.filter(function (r) { return !trim(r.acceptanceCriteria); }).length;
        if (noDeliv) add('check', noDeliv + ' 項確認開發項目未填交付成果', '附件二');
        if (noAcc) add('check', noAcc + ' 項確認開發項目未填驗收依據', '附件二');
      }
    }
    var days = d.revisionRules.acceptance.periodDays;
    var ap = str(agr && agr.acceptancePolicy);
    var mm = /(\d+)\s*天/.exec(ap);
    if (mm && Number(mm[1]) !== days) add('required', '第六條驗收期限設為 ' + days + ' 個日曆日，但驗收條款欄位寫「' + mm[1] + ' 天」，兩者不一致', '第六條');
    return out;
  }

  // ══════════════════════════════════════════════════════════════════
  //  完整合約 HTML（主契約＋附件）
  //  source：{ agr, doc, rendered? }；版本檢視時傳入版本快照的 rendered 與 agr（含 contractData 快照）
  // ══════════════════════════════════════════════════════════════════
  function renderAnnexes(agr, doc) {
    var d = normalizeDocument(doc);
    var data = agr.contractData || null;
    var Ag = A();
    var notes = d.annexNotes;
    function note(k) { return trim(notes[k]) ? '<div class="agd-annex-note">' + textToHtml(notes[k]) + '</div>' : ''; }
    function wrap(a, body) { return '<section class="agd-annex" id="agd-annex-' + a.key + '"><h3 class="agd-h">' + esc(a.title) + '</h3>' + note(a.key) + body + '</section>'; }
    var none = '<div class="agd-missing">【未填寫：合約資料（v2.1）】此合約尚未帶入合約資料，無法產生本附件。</div>';
    var html = '';
    var rows = data ? arr(data.items) : [];
    var qById = {};
    if (data) arr((data.quotationSnapshot || {}).items).forEach(function (l) { qById[l.id] = l; });
    ANNEXES.forEach(function (a) {
      var body;
      if (a.key === 'revision') { body = renderRevisionAnnex(d.revisionRules); }
      else if (!data || !Ag) { body = none; }
      else if (a.key === 'original') { body = Ag.renderOriginalSections(data); }
      else if (a.key === 'confirmed') {
        var ob = rows.filter(function (r) { return r.contractStatus === 'included'; });
        body = ob.length ? ob.map(function (r) { return Ag.renderRowBlock(r, qById); }).join('') : '<div class="agd-missing">【未填寫：確認開發項目】</div>';
      } else if (a.key === 'excluded') {
        var ot = rows.filter(function (r) { return !Ag.isObligation(r); })
          .sort(function (x, y) { return Ag.STATUS_ORDER.indexOf(x.contractStatus) - Ag.STATUS_ORDER.indexOf(y.contractStatus); });
        body = ot.length ? ot.map(function (r) { return Ag.renderRowBlock(r, qById); }).join('') : '<div class="agv-muted">無。</div>';
      } else if (a.key === 'changes') {
        var ch = rows.filter(function (r) { return r.contractStatus === 'change_confirmed'; });
        body = ch.length ? ch.map(function (r) { return Ag.renderRowBlock(r, qById); }).join('') : '<div class="agv-muted">本契約建立時無已核准之需求變更。</div>';
      } else if (a.key === 'fees') { body = Ag.renderFeeBody(agr, data, {}); }
      html += wrap(a, body);
    });
    return html;
  }

  function renderRevisionAnnex(rr) {
    var fs = rr.freeScope || {};
    function row(k, v, missing) { return '<tr><td>' + esc(k) + '</td><td>' + (missing ? '<mark class="agd-flag">' + esc(v) + '</mark>' : esc(v)) + '</td></tr>'; }
    var types = arr(fs.types).map(function (k) { var t = FREE_SCOPE_TYPES.filter(function (x) { return x.key === k; })[0]; return t ? t.label : k; });
    var lv = FREE_SCOPE_LEVELS.filter(function (x) { return x.key === fs.level; })[0];
    return '<table class="agv-table"><tbody>' +
      row('開發期間免費修改', rr.development.freeBatches + ' 批次，每批次最多 ' + rr.development.itemsPerBatch + ' 項') +
      row('驗收期間免費修改', rr.acceptance.freeBatches + ' 批次，每批次最多 ' + rr.acceptance.itemsPerBatch + ' 項') +
      row('驗收期限', rr.acceptance.periodDays + ' 個日曆日') +
      row('額度轉移', rr.carryOver ? '開發期間未使用額度得轉入驗收期間' : '開發與驗收額度分開計算，未使用額度不自動轉移') +
      row('免費修改類型', types.length ? types.join('、') : '【未填寫：免費修改類型】', !types.length) +
      row('適用頁面', trim(fs.pages) || '【未填寫：免費修改頁面】', !trim(fs.pages)) +
      row('調整程度', lv ? lv.label : '【未填寫：免費修改調整程度】', !lv) +
      row('工作範圍', trim(fs.workScope) || '【未填寫：免費修改工作範圍】', !trim(fs.workScope)) +
      (trim(fs.notes) ? row('其他說明', trim(fs.notes)) : '') +
      row('超出額度計費方式', trim(rr.extraChangeFeeText) || '【待確認：超出免費額度之計費方式】', !trim(rr.extraChangeFeeText)) +
      '</tbody></table>' +
      '<h4 class="agv-h4">修改事項分類（確認分類後始計入額度）</h4><table class="agv-table"><tbody>' +
      CHANGE_CATEGORIES.map(function (c) { return '<tr><td>' + esc(c.label) + '</td><td>' + (c.consumesQuota ? '扣除當期免費額度' : '不扣除免費額度') + '</td></tr>'; }).join('') +
      '</tbody></table>';
  }

  var STATE_BANNERS = {
    unsaved: ['agd-banner-unsaved', '含尚未儲存的修改', '此預覽包含尚未儲存的內容，不是已儲存的草稿，也不是正式定稿。'],
    unsaved_new: ['agd-banner-unsaved', '尚未儲存的合約初稿', '此初稿尚未寫入系統。請按「儲存草稿」。'],
    draft: ['agd-banner-draft', '草稿（已儲存）・尚未定稿', '仍可修改。建立版本後，該版本內容將永久保留，不會被後續編輯覆寫。'],
    version: ['agd-banner-version', '歷史版本（唯讀）', '此為建立版本當時的完整內容；之後的修改或重新帶入需求、報價都不會改變它。'],
    locked: ['agd-banner-locked', '合約已鎖定・唯讀', '此合約已備妥或已簽署，內容不可修改。'],
  };

  function renderFullHtml(agr, doc, opts) {
    opts = opts || {};
    var d = normalizeDocument(doc);
    var sections = opts.rendered || renderSections(agr, d);
    var warnings = opts.warnings || collectWarnings(agr, d, sections);
    var b = STATE_BANNERS[opts.state];
    var html = '';
    if (b) html += '<div class="agd-banner ' + b[0] + '" role="status"><strong>' + esc(b[1]) + (opts.versionLabel ? '　' + esc(opts.versionLabel) : '') + '</strong><span>' + esc(b[2]) + '</span></div>';
    if (warnings.length && opts.showWarnings !== false) {
      html += '<div class="agd-warnings"><div class="agd-warnings-title">尚未填寫或尚未確認的內容（' + warnings.length + '）</div><ul>' +
        warnings.map(function (w) { return '<li class="agd-lv-' + w.level + '"><span class="agv-tag">' + (w.level === 'required' ? '必要' : '待確認') + '</span>' + (w.where ? '<span class="agv-muted">' + esc(w.where) + '｜</span>' : '') + esc(w.text) + '</li>'; }).join('') +
        '</ul></div>';
    }
    html += '<article class="agd-doc"><h2 class="agd-title">' + esc(d.title || '網站開發委託契約') + '</h2>';
    sections.forEach(function (s) { html += '<section class="agd-sec" id="agd-sec-' + esc(s.key) + '"><h3 class="agd-h">' + esc(s.title) + '</h3>' + textToHtml(s.text) + '</section>'; });
    html += '<div class="agd-sign"><div>甲方：' + esc(trim((agr.client || {}).company) || trim((agr.client || {}).name) || '【未填寫：甲方名稱】') + '</div><div>乙方：' + esc(trim((agr.provider || {}).studioName) || '【未填寫：乙方名稱】') + '</div><div class="agv-muted">（本系統不提供電子簽署；簽署日期與用印於紙本或另行處理）</div></div>';
    html += '<h2 class="agd-title agd-annex-title">附件</h2>' + renderAnnexes(agr, d) + '</article>';
    return html;
  }

  // ══════════════════════════════════════════════════════════════════
  //  版本
  // ══════════════════════════════════════════════════════════════════
  var AGREEMENT_SNAPSHOT_FIELDS = ['agreementNumber', 'quoteId', 'status', 'client', 'provider', 'projectName', 'contractAmountSnapshot', 'contractAmountSource',
    'paymentPlanSnapshot', 'timeline', 'paymentTermsText', 'changeRequestPolicy', 'acceptancePolicy', 'warrantyPolicy', 'thirdPartyFeeNotice',
    'ipDeliverablesPolicy', 'terminationPolicy', 'note'];

  function fingerprint(v) {
    var Ag = A();
    if (Ag && Ag.fingerprint) return Ag.fingerprint(v);
    return JSON.stringify(v).length.toString(16);
  }

  // 建立版本文件內容（createdAt／createdBy 由呼叫端放入伺服器時間與登入 Email）
  function buildVersionPayload(agr, doc, versionNumber, note) {
    var d = normalizeDocument(doc);
    var snap = {};
    AGREEMENT_SNAPSHOT_FIELDS.forEach(function (k) { if (agr[k] !== undefined) snap[k] = agr[k]; });
    // 全部深拷貝：版本建立後，記憶體中的合約或合約資料再被編輯，也不會影響已產生的版本內容
    return {
      schemaVersion: SCHEMA_VERSION,
      versionNumber: versionNumber,
      note: str(note).slice(0, 500),
      document: d,
      renderedSections: renderSections(agr, d),
      agreementSnapshot: stripForStore(clone(snap)),
      contractDataSnapshot: agr.contractData ? stripForStore(clone(agr.contractData)) : null,
    };
  }
  // JSON 深拷貝後，Firestore Timestamp 會變成 { seconds, nanoseconds[, type] }；統一成 { seconds, nanoseconds } 一般 map
  function stripForStore(v) {
    if (Array.isArray(v)) return v.map(stripForStore);
    if (v && typeof v === 'object') {
      if (typeof v.seconds === 'number' && typeof v.nanoseconds === 'number') return { seconds: v.seconds, nanoseconds: v.nanoseconds };
      var o = {}; Object.keys(v).forEach(function (k) { o[k] = stripForStore(v[k]); }); return o;
    }
    return v;
  }
  function versionIndexEntry(versionNumber, nowMs, by, note, doc) {
    return { n: versionNumber, atMs: nowMs || null, by: str(by), note: str(note).slice(0, 120), docFp: fingerprint(normalizeDocument(doc)) };
  }
  // 由版本文件還原成可預覽的 agr（不讀取目前的合約資料）
  function agrFromVersion(v) {
    var a = clone(v.agreementSnapshot || {}) || {};
    a.contractData = v.contractDataSnapshot || null;
    return a;
  }

  // ══════════════════════════════════════════════════════════════════
  //  版本差異（段落層級 LCS）
  // ══════════════════════════════════════════════════════════════════
  function lcsDiff(a, b) {
    var n = a.length, m = b.length;
    var dp = []; for (var i = 0; i <= n; i++) { dp.push(new Array(m + 1).fill(0)); }
    for (i = n - 1; i >= 0; i--) for (var j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    var out = []; i = 0; j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { out.push({ op: 'same', text: a[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ op: 'del', text: a[i++] }); }
      else { out.push({ op: 'add', text: b[j++] }); }
    }
    while (i < n) out.push({ op: 'del', text: a[i++] });
    while (j < m) out.push({ op: 'add', text: b[j++] });
    return out;
  }
  function lines(t) { return str(t).split('\n').filter(function (l) { return trim(l); }); }

  // left/right：{ label, sections:[{key,title,text}], rules }
  function diffDocuments(left, right) {
    var keys = [];
    arr(left.sections).concat(arr(right.sections)).forEach(function (s) { if (keys.indexOf(s.key) === -1) keys.push(s.key); });
    var sections = keys.map(function (k) {
      var l = arr(left.sections).filter(function (s) { return s.key === k; })[0];
      var r = arr(right.sections).filter(function (s) { return s.key === k; })[0];
      var ops = lcsDiff(lines(l && l.text), lines(r && r.text));
      var titleChanged = !!(l && r && l.title !== r.title);
      return { key: k, title: (r || l).title, oldTitle: l ? l.title : '', titleChanged: titleChanged, ops: ops,
        changed: titleChanged || !l || !r || ops.some(function (o) { return o.op !== 'same'; }) };
    });
    var rules = [];
    function cmp(label, a, b) { if (JSON.stringify(a) !== JSON.stringify(b)) rules.push({ label: label, before: a, after: b }); }
    var lr = left.rules || {}, rr = right.rules || {};
    cmp('開發期間免費批次', (lr.development || {}).freeBatches, (rr.development || {}).freeBatches);
    cmp('開發期間每批次上限', (lr.development || {}).itemsPerBatch, (rr.development || {}).itemsPerBatch);
    cmp('驗收期間免費批次', (lr.acceptance || {}).freeBatches, (rr.acceptance || {}).freeBatches);
    cmp('驗收期間每批次上限', (lr.acceptance || {}).itemsPerBatch, (rr.acceptance || {}).itemsPerBatch);
    cmp('驗收期限（日曆日）', (lr.acceptance || {}).periodDays, (rr.acceptance || {}).periodDays);
    cmp('額度轉移', lr.carryOver, rr.carryOver);
    cmp('免費修改類型', (lr.freeScope || {}).types, (rr.freeScope || {}).types);
    cmp('免費修改頁面', (lr.freeScope || {}).pages, (rr.freeScope || {}).pages);
    cmp('免費修改調整程度', (lr.freeScope || {}).level, (rr.freeScope || {}).level);
    cmp('免費修改工作範圍', (lr.freeScope || {}).workScope, (rr.freeScope || {}).workScope);
    cmp('超出額度計費方式', lr.extraChangeFeeText, rr.extraChangeFeeText);
    return { leftLabel: left.label, rightLabel: right.label, sections: sections, rules: rules,
      changedCount: sections.filter(function (s) { return s.changed; }).length + rules.length };
  }

  function renderDiffHtml(diff) {
    function v(x) { return x == null || x === '' ? '（空白）' : Array.isArray(x) ? (x.length ? x.join('、') : '（未選）') : String(x); }
    var html = '<div class="agd-diff-head">比較：<strong>' + esc(diff.leftLabel) + '</strong> → <strong>' + esc(diff.rightLabel) + '</strong>　共 ' + diff.changedCount + ' 處不同</div>';
    if (!diff.changedCount) return html + '<div class="agv-muted">兩者內容相同。</div>';
    if (diff.rules.length) {
      html += '<h4 class="agv-h4">修改與驗收設定</h4><table class="agv-table"><thead><tr><th>項目</th><th>' + esc(diff.leftLabel) + '</th><th>' + esc(diff.rightLabel) + '</th></tr></thead><tbody>' +
        diff.rules.map(function (r) { return '<tr><td>' + esc(r.label) + '</td><td><del class="agd-del">' + esc(v(r.before)) + '</del></td><td><ins class="agd-ins">' + esc(v(r.after)) + '</ins></td></tr>'; }).join('') + '</tbody></table>';
    }
    diff.sections.filter(function (s) { return s.changed; }).forEach(function (s) {
      html += '<section class="agd-diff-sec"><h4 class="agv-h4">' + esc(s.title) + (s.titleChanged ? '<span class="agv-muted">（原標題：' + esc(s.oldTitle) + '）</span>' : '') + '</h4>' +
        s.ops.map(function (o) {
          if (o.op === 'same') return '<div class="agd-dl agd-same">' + esc(o.text) + '</div>';
          if (o.op === 'del') return '<div class="agd-dl agd-del">－ ' + esc(o.text) + '</div>';
          return '<div class="agd-dl agd-ins">＋ ' + esc(o.text) + '</div>';
        }).join('') + '</section>';
    });
    return html;
  }

  root.NicocoAgreementDoc = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    TEMPLATE_ID: TEMPLATE_ID,
    FREE_SCOPE_TYPES: FREE_SCOPE_TYPES,
    FREE_SCOPE_LEVELS: FREE_SCOPE_LEVELS,
    CHANGE_CATEGORIES: CHANGE_CATEGORIES,
    LIMITS: LIMITS,
    ANNEXES: ANNEXES,
    TOKEN_LABELS: TOKEN_LABELS,
    SECTION_TEMPLATES: SECTION_TEMPLATES,
    AGREEMENT_SNAPSHOT_FIELDS: AGREEMENT_SNAPSHOT_FIELDS,
    defaultRevisionRules: defaultRevisionRules,
    validateRevisionRules: validateRevisionRules,
    sectionTemplate: sectionTemplate,
    createDocument: createDocument,
    normalizeDocument: normalizeDocument,
    buildContext: buildContext,
    resolveText: resolveText,
    renderSections: renderSections,
    collectWarnings: collectWarnings,
    renderFullHtml: renderFullHtml,
    buildVersionPayload: buildVersionPayload,
    versionIndexEntry: versionIndexEntry,
    agrFromVersion: agrFromVersion,
    fingerprint: function (doc) { return fingerprint(normalizeDocument(doc)); },
    diffDocuments: diffDocuments,
    renderDiffHtml: renderDiffHtml,
  };
})(typeof window !== 'undefined' ? window : globalThis);
