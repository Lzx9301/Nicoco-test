/* ══════════════════════════════════════════════════════════════════
   Nicoco 後台流程導覽 v1（admin-workflow.js）

   只負責「依現有資料判斷流程進度與下一步建議」，純函式、不讀寫 Firestore、
   不改任何狀態值。所有判斷都來自案件上已存在的真實欄位：
     requirementSnapshot / requirementReviewDraft / confirmedRequirements
     quotationItems / quotationStatus / quotationRequirementRevision / validUntil
     agreements（子集合）/ project / paymentMilestones（子集合）/ project.acceptance
   子集合尚未載入時一律回報「待確認」，不假裝已完成。
   下一步建議只是操作指引，不是權限限制：不會阻擋任何既有操作。
   ══════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var STAGES = [
    { key: 'request',   label: '客戶需求', target: 'sec-requirement' },
    { key: 'review',    label: '需求審核', target: 'reviewSection' },
    { key: 'quotation', label: '正式報價', target: 'quotationSection' },
    { key: 'agreement', label: '合約',     target: 'agreementSection' },
    { key: 'project',   label: '建立專案', target: 'projectSection' },
    { key: 'execution', label: '執行與收款', target: 'sec-execution' },
    { key: 'closing',   label: '結案',     target: 'sec-closing' },
  ];

  // 狀態文字：不只靠顏色辨識
  var STATE_TEXT = {
    done: '已完成', current: '進行中', todo: '尚未開始',
    unknown: '待確認', na: '不適用', attention: '需處理',
  };

  var QSTATUS_TEXT = { draft: '草稿', sent: '已送出', accepted: '已接受', rejected: '已拒絕' };

  function tsMs(ts) {
    if (!ts) return null;
    if (typeof ts.toMillis === 'function') return ts.toMillis();
    if (typeof ts.toDate === 'function') return ts.toDate().getTime();
    if (typeof ts.seconds === 'number') return ts.seconds * 1000;
    var d = new Date(ts);
    return isNaN(d.getTime()) ? null : d.getTime();
  }

  function money(n) { return 'NT$' + (Number(n) || 0).toLocaleString(); }

  // ── 報價相關的共用判斷（quote-detail 與 quote-edit 都用同一份）──
  function quotationFacts(q, now) {
    q = q || {};
    var items = Array.isArray(q.quotationItems) ? q.quotationItems : [];
    var confirmed = q.confirmedRequirements || null;
    var hasQuote = items.length > 0 || Number(q.quotationTotal) > 0;
    // 舊資料沒有 quotationStatus 時，正式報價頁一律視為草稿（沿用 quote-edit 既有行為）
    var status = q.quotationStatus || (hasQuote ? 'draft' : null);
    var pending = items.filter(function (i) { return i && i.pricingPending; }).length;
    var validMs = tsMs(q.validUntil);
    var nowMs = typeof now === 'number' ? now : Date.now();
    var expired = status === 'sent' && validMs !== null && validMs < nowMs;
    var basedOn = q.quotationRequirementRevision || null;
    return {
      items: items,
      hasQuote: hasQuote,
      status: status,
      statusText: status ? (QSTATUS_TEXT[status] || status) : '尚未建立',
      pending: pending,
      expired: expired,
      validMs: validMs,
      confirmed: confirmed,
      basedOnRevision: basedOn,
      // 需求已重新確認，但報價明細引用的是舊版本
      revisionStale: !!(confirmed && hasQuote && basedOn && Number(basedOn) !== Number(confirmed.revision)),
      // 已有確認需求，但報價明細不是由確認需求產生（例如需求審核前就做好的報價）
      notFromConfirmed: !!(confirmed && hasQuote && !basedOn),
    };
  }

  function validAgreements(list) {
    return (list || []).filter(function (a) { return a && a.status !== 'cancelled'; });
  }

  /**
   * @param q   currentData（quotes/{id}）
   * @param ctx { agreementsLoaded, agreements, projectLoaded, paymentMilestones, paymentSummary, now }
   */
  function compute(q, ctx) {
    q = q || {};
    ctx = ctx || {};
    var f = quotationFacts(q, ctx.now);
    var hasSnapshot = !!q.requirementSnapshot;
    var draft = q.requirementReviewDraft || null;
    var confirmed = q.confirmedRequirements || null;
    var proj = q.project || null;
    var agrs = validAgreements(ctx.agreements);
    var signedAgr = agrs.filter(function (a) { return a.status === 'signed' || a.status === 'active' || a.status === 'completed'; });
    var draftAgr = agrs.filter(function (a) { return a.status === 'draft' || a.status === 'ready'; });
    var pms = ctx.paymentMilestones || [];
    var pay = ctx.paymentSummary || null;
    var acceptance = (proj && proj.acceptance) || { status: 'not_started' };
    var warranty = (proj && proj.warranty) || { status: 'not_started' };

    var st = {};

    // 1 客戶需求
    var hasLegacyRequest = (q.includedItems || []).length || (q.selectedItems || []).length ||
      (q.evaluationItems || []).length || q.message || q.projectType;
    if (hasSnapshot) st.request = { state: 'done', detail: '已收到需求書' };
    else if (hasLegacyRequest) st.request = { state: 'done', detail: '舊版估價表單（無需求書）' };
    else st.request = { state: 'unknown', detail: '找不到需求資料' };

    // 2 需求審核
    if (!hasSnapshot && !draft && !confirmed) st.review = { state: 'na', detail: '舊案件不適用' };
    else if (draft && confirmed) st.review = { state: 'current', detail: '重新審核中（第 ' + (draft.revision || '?') + ' 版）' };
    else if (draft) st.review = { state: 'current', detail: '審核中' };
    else if (confirmed) st.review = { state: 'done', detail: '已確認第 ' + confirmed.revision + ' 版' };
    else st.review = { state: 'todo', detail: '尚未審核' };

    // 3 正式報價
    if (f.status === 'accepted') st.quotation = { state: 'done', detail: '客戶已接受' };
    else if (f.status === 'rejected') st.quotation = { state: 'attention', detail: '客戶已拒絕' };
    else if (f.status === 'sent') st.quotation = f.expired
      ? { state: 'attention', detail: '已過有效期限' }
      : { state: 'current', detail: '已送出・等待回覆' };
    else if (f.hasQuote) st.quotation = { state: 'current', detail: f.pending ? ('草稿・' + f.pending + ' 項待填價格') : '草稿・尚未發送' };
    else st.quotation = { state: 'todo', detail: '尚未建立' };

    // 4 合約（子集合非同步載入：載入前一律「待確認」）
    if (!ctx.agreementsLoaded) st.agreement = { state: 'unknown', detail: '資料載入中' };
    else if (signedAgr.length) st.agreement = { state: 'done', detail: '已簽署' + (signedAgr[0].agreementNumber ? '（' + signedAgr[0].agreementNumber + '）' : '') };
    else if (draftAgr.length) st.agreement = { state: 'current', detail: draftAgr.some(function (a) { return a.status === 'ready'; }) ? '已備妥・待簽署' : '草稿' };
    else if ((ctx.agreements || []).length) st.agreement = { state: 'todo', detail: '合約皆已取消' };
    else st.agreement = { state: 'todo', detail: '尚未建立' };

    // 5 建立專案
    st.project = proj ? { state: 'done', detail: '已建立' } : { state: 'todo', detail: '尚未建立' };

    // 6 執行與收款
    if (!proj) st.execution = { state: 'todo', detail: '需先建立專案' };
    else if (!ctx.projectLoaded) st.execution = { state: 'unknown', detail: '資料載入中' };
    else if (!pms.length) st.execution = { state: 'current', detail: '尚未建立分期付款' };
    else if (pay && pay.allPaid && pay.remaining === 0) st.execution = { state: 'done', detail: '款項已全數收齊' };
    else if (pay && pay.overdue > 0) st.execution = { state: 'attention', detail: '有逾期款項 ' + money(pay.overdue) };
    else st.execution = { state: 'current', detail: pay ? ('已收 ' + money(pay.paid) + '・未收 ' + money(pay.remaining)) : '進行中' };

    // 7 結案（依現有驗收／保固欄位，沒有另外的「結案」資料）
    if (!proj) st.closing = { state: 'todo', detail: '需先建立專案' };
    else if (acceptance.status === 'accepted') st.closing = { state: 'done', detail: warranty.status === 'expired' ? '已驗收・保固已到期' : '已驗收・保固中' };
    else if (acceptance.status === 'in_review') st.closing = { state: 'current', detail: '驗收中' };
    else st.closing = { state: 'todo', detail: '尚未送驗' };

    var next = nextStep(q, ctx, f, { hasSnapshot: hasSnapshot, draft: draft, confirmed: confirmed, proj: proj,
      signedAgr: signedAgr, draftAgr: draftAgr, pms: pms, pay: pay, acceptance: acceptance, warranty: warranty });

    var stages = STAGES.map(function (s) {
      var x = st[s.key];
      return { key: s.key, label: s.label, target: s.target, state: x.state, stateText: STATE_TEXT[x.state], detail: x.detail, focus: next && next.stage === s.key };
    });
    return { stages: stages, next: next, facts: f };
  }

  // ── 下一步建議：永遠只回傳一個主要建議 ──
  function nextStep(q, ctx, f, d) {
    var notes = [];
    var editUrl = 'quote-edit.html?id=' + encodeURIComponent(ctx.quoteId || q.quoteId || '');

    if (d.proj) {
      if (f.status && f.status !== 'accepted') notes.push('此案件已建立專案，但正式報價目前為「' + f.statusText + '」。');
      if (ctx.agreementsLoaded && !d.signedAgr.length) notes.push('目前沒有已簽署的合約。');
      if (!ctx.projectLoaded) return { stage: 'execution', title: '查看專案進度', desc: '專案資料載入中…', action: { type: 'scroll', target: 'projectSection', label: '前往專案管理' }, notes: notes };
      if (d.acceptance.status === 'accepted') {
        if (d.pms.length && d.pay && d.pay.remaining > 0) return { stage: 'execution', title: '確認尾款收款', desc: '驗收已完成，尚有 ' + money(d.pay.remaining) + ' 未收。', action: { type: 'scroll', target: 'sec-payment', label: '前往分期付款' }, notes: notes };
        if (d.warranty.status === 'active') return { stage: 'closing', title: '保固期間：追蹤問題', desc: '原功能 Bug 記錄在驗收備註或操作紀錄；新需求請建立需求變更。', action: { type: 'scroll', target: 'sec-closing', label: '前往驗收與結案' }, notes: notes };
        if (q.status !== 'done') return { stage: 'closing', title: '將案件狀態設為「完成」', desc: '驗收已完成，保固已到期，可在「案件管理」把案件狀態改為完成。', action: { type: 'scroll', target: 'sec-admin', label: '前往案件管理' }, notes: notes };
        return { stage: 'closing', title: '案件已結案', desc: '驗收與保固皆已完成。', action: null, notes: notes };
      }
      if (d.acceptance.status === 'in_review') return { stage: 'closing', title: '完成驗收', desc: '客戶確認後按「完成驗收」，系統會開始保固期。', action: { type: 'scroll', target: 'sec-closing', label: '前往驗收與結案' }, notes: notes };
      if (!d.pms.length) return { stage: 'execution', title: '建立分期付款計畫', desc: '專案已建立，尚未設定分期付款。', action: { type: 'scroll', target: 'sec-payment', label: '前往分期付款' }, notes: notes };
      if (d.pay && d.pay.overdue > 0) return { stage: 'execution', title: '處理逾期款項', desc: '目前逾期 ' + money(d.pay.overdue) + '。', action: { type: 'scroll', target: 'sec-payment', label: '前往分期付款' }, notes: notes };
      return { stage: 'execution', title: '追蹤專案執行與收款', desc: '更新工作項目進度；開發完成後送出驗收。', action: { type: 'scroll', target: 'sec-execution', label: '前往專案執行' }, notes: notes };
    }

    if (f.status === 'accepted') {
      if (!ctx.agreementsLoaded) return { stage: 'agreement', title: '準備合約', desc: '合約資料載入中…', action: { type: 'scroll', target: 'agreementSection', label: '前往合約' }, notes: notes };
      if (d.signedAgr.length) return { stage: 'project', title: '建立專案', desc: '合約已簽署，可以從報價建立專案。', action: { type: 'scroll', target: 'projectSection', label: '前往建立專案' }, notes: notes };
      if (d.draftAgr.length) return { stage: 'agreement', title: '完成合約簽署', desc: '合約草稿已建立，確認內容後標記「已備妥」→「已簽署」。', action: { type: 'scroll', target: 'agreementSection', label: '前往合約' }, notes: notes };
      return { stage: 'agreement', title: '準備合約', desc: '客戶已接受正式報價（報價維持鎖定），下一步建立合約。', action: { type: 'scroll', target: 'agreementSection', label: '前往合約' }, notes: notes };
    }

    if (f.revisionStale) notes.push('需求已重新確認為第 ' + f.confirmed.revision + ' 版，但正式報價引用第 ' + f.basedOnRevision + ' 版。');
    if (f.status === 'sent') {
      if (f.expired) return { stage: 'quotation', title: '報價已過期：更新有效期限', desc: '客戶已無法回覆這份報價。與客戶確認後，到正式報價更新有效期限並重新發送。', action: { type: 'link', href: editUrl, label: '前往正式報價' }, notes: notes };
      return { stage: 'quotation', title: '等待客戶回覆', desc: '報價已送出。可再次複製客戶連結提醒客戶。', action: { type: 'scroll', target: 'quotationSection', label: '查看報價與客戶連結' }, notes: notes };
    }
    if (f.status === 'rejected') return { stage: 'quotation', title: '客戶已拒絕：調整報價', desc: '與客戶討論後修改正式報價，再重新發送。', action: { type: 'link', href: editUrl, label: '前往正式報價' }, notes: notes };

    // 草稿或尚未建立
    if (d.hasSnapshot && d.draft) {
      if (f.hasQuote) notes.push('已有報價草稿；需求確認後不會自動覆寫既有報價。');
      return { stage: 'review', title: '完成需求審核', desc: '審核工作稿尚未確認，確認後正式報價可依正式需求產生。', action: { type: 'scroll', target: 'reviewSection', label: '前往需求審核' }, notes: notes };
    }
    if (d.hasSnapshot && !d.confirmed) {
      if (f.hasQuote) notes.push('已有報價草稿，但需求尚未審核；也可以沿用既有報價方式直接檢查並發送。');
      return { stage: 'review', title: '開始需求審核', desc: '把客戶原始需求整理成正式需求：決定納入、排除與待估價項目。', action: { type: 'scroll', target: 'reviewSection', label: '前往需求審核' }, notes: notes };
    }
    if (!f.hasQuote) {
      return { stage: 'quotation', title: '建立正式報價', desc: d.confirmed ? '需求已確認，正式報價會依正式需求產生明細。' : '舊案件沒有需求書，沿用既有報價方式建立。', action: { type: 'link', href: editUrl, label: '建立正式報價' }, notes: notes };
    }
    if (f.revisionStale || f.notFromConfirmed) {
      return { stage: 'quotation', title: '更新報價依據', desc: f.revisionStale ? '報價明細引用舊版需求。請到正式報價確認是否依新版需求重新產生（需再次確認，不會自動覆寫）。' : '目前報價明細不是依確認需求產生。請到正式報價確認是否重新產生（需再次確認，不會自動覆寫）。', action: { type: 'link', href: editUrl + '&regen=1', label: '前往正式報價' }, notes: notes };
    }
    if (f.pending) return { stage: 'quotation', title: '完成報價金額', desc: '尚有 ' + f.pending + ' 項標示「待填價格」，填寫後才能發送。', action: { type: 'link', href: editUrl, label: '前往正式報價' }, notes: notes };
    return { stage: 'quotation', title: '檢查並發送正式報價', desc: '報價草稿已完成，發送前系統會再檢查一次內容。', action: { type: 'link', href: editUrl, label: '前往正式報價' }, notes: notes };
  }

  root.NicocoWorkflow = {
    STAGES: STAGES,
    STATE_TEXT: STATE_TEXT,
    QSTATUS_TEXT: QSTATUS_TEXT,
    quotationFacts: quotationFacts,
    compute: compute,
    tsMs: tsMs,
  };
})(typeof window !== 'undefined' ? window : globalThis);
