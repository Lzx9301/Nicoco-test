// ══════════════════════════════════════════════════════════════════════
//  Nicoco — Agreement Generator v2.1：合約資料整合與完整需求附件
//  （純邏輯，不讀寫 Firestore、不依賴 DOM；quote-detail.html 負責讀取資料與寫入）
//
//  資料來源（全部只讀，本檔絕不修改傳入的物件）：
//    quote.requirementSnapshot       客戶原始需求（永久唯讀）
//    quote.confirmedRequirements     正式確認需求（需求審核產生）
//    quote.quotationItems …          正式報價（客戶接受後以 acceptances/{token} 快照為準）
//    changeRequests                  需求變更（只有 approved 才算「已確認的後續變更」）
//
//  產出：agreements/{id}.contractData（合約草稿當次使用的來源版本＋必要快照＋可編輯的合約需求明細）
//
//  原則：
//    - 客戶曾勾選 ≠ 合約包含。「已納入開發」只能來自已確認需求（或沒有需求書的舊案件中，客戶已接受的報價明細）
//    - 原始資料沒有的細節不補寫：交付成果／驗收依據／不包含項目預設留空，由 Admin 填寫
//    - 金額只引用報價明細與已核准變更；報價只有總額時一律顯示「待人工拆分確認」，不推算
//    - 來源資料更新時只提示差異，必須由 Admin 主動「重新帶入」才會更新合約草稿
// ══════════════════════════════════════════════════════════════════════
(function (root) {
  'use strict';

  var SCHEMA_VERSION = '2.1';

  // ── 合約需求狀態 ──
  var STATUS = {
    included: '已納入開發',
    excluded: '明確排除',
    pending: '待確認',
    separate_quote: '另行報價',
    change_confirmed: '已確認的後續變更',
  };
  var STATUS_ORDER = ['included', 'change_confirmed', 'pending', 'separate_quote', 'excluded'];
  // 只有這兩種狀態構成乙方的開發義務
  var OBLIGATION_STATUSES = ['included', 'change_confirmed'];

  var REVIEW_DECISION_TEXT = { included: '納入', excluded: '排除', pending: '待確認' };

  var MAPPING_TEXT = {
    mapped: '已對應報價項目',
    base_included: '含於「網站基礎建置」',
    manual_check: '待人工確認',
    none: '—',
  };

  // ── 費用分類 ──
  var FEE_CATEGORIES = {
    development: '網站開發費（基礎建置）',
    module: '個別功能／模組費用',
    third_party: '第三方服務串接費',
    maintenance: '維護／保固服務費',
    unclassified: '待人工分類',
  };
  var FEE_CATEGORY_ORDER = ['development', 'module', 'third_party', 'maintenance', 'unclassified'];
  var MANUAL_SPLIT_TEXT = '待人工拆分確認';
  var MANUAL_CHECK_TEXT = '待人工確認';

  // 由 Admin 填寫的欄位（重新帶入來源資料時保留）
  var EDITABLE_FIELDS = ['agreedScope', 'exclusions', 'deliverables', 'acceptanceCriteria', 'notes', 'openQuestions'];

  // ══════════════════════════════════════════════════════════════════
  //  基本工具
  // ══════════════════════════════════════════════════════════════════
  function str(v) { return v == null ? '' : String(v); }
  function trim(v) { return str(v).trim(); }
  function num(v) { var n = Number(v); return Number.isFinite(n) ? n : 0; }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function arr(v) { return Array.isArray(v) ? v : []; }

  function tsMs(ts) {
    if (!ts) return null;
    if (typeof ts.toMillis === 'function') return ts.toMillis();
    if (typeof ts.toDate === 'function') return ts.toDate().getTime();
    if (typeof ts.seconds === 'number') return ts.seconds * 1000 + Math.round((ts.nanoseconds || 0) / 1e6);
    if (typeof ts === 'number') return ts;
    var d = new Date(ts);
    return isNaN(d.getTime()) ? null : d.getTime();
  }
  function isTimestampLike(v) {
    return v && typeof v === 'object' && (typeof v.toMillis === 'function'
      || (typeof v.seconds === 'number' && typeof v.nanoseconds === 'number' && Object.keys(v).length <= 2));
  }

  // 穩定序列化（key 排序、Timestamp 轉毫秒）：用來計算來源指紋
  function canonical(v) {
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (isTimestampLike(v)) return { __ts: tsMs(v) };
    if (Array.isArray(v)) return v.map(function (x) { var c = canonical(x); return c === undefined ? null : c; });
    if (typeof v === 'object') {
      if (typeof v.isEqual === 'function' && typeof v.path === 'string') return { __ref: v.path };
      var out = {};
      Object.keys(v).sort().forEach(function (k) {
        var c = canonical(v[k]);
        if (c !== undefined) out[k] = c;
      });
      return out;
    }
    if (typeof v === 'function') return undefined;
    return v;
  }
  // FNV-1a，兩個種子組成 16 位十六進位字串（只用於「有沒有變」的比對，不是安全用途）
  function fnv(s, seed) {
    var h = seed >>> 0;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }
  function fingerprint(v) {
    var s = JSON.stringify(canonical(v) === undefined ? null : canonical(v));
    return fnv(s, 2166136261) + fnv(s, 3141592653);
  }

  // Firestore 不接受 undefined，也不適合把 Timestamp 物件以外的 class instance 寫進去：
  // 這裡只把 undefined 拿掉，其他值（含 Timestamp）原樣保留
  function stripUndefined(v) {
    if (v === undefined) return undefined;
    if (v === null || typeof v !== 'object') return v;
    if (isTimestampLike(v)) return v;
    if (Array.isArray(v)) return v.map(function (x) { var c = stripUndefined(x); return c === undefined ? null : c; });
    var out = {};
    Object.keys(v).forEach(function (k) {
      var c = stripUndefined(v[k]);
      if (c !== undefined) out[k] = c;
    });
    return out;
  }

  function esc(v) {
    return str(v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) { return 'NT$' + num(n).toLocaleString('en-US'); }
  function signedMoney(n) { n = num(n); return (n < 0 ? '-' : '+') + 'NT$' + Math.abs(n).toLocaleString('en-US'); }
  function cleanLabel(s) { return str(s).replace(/（可複選）/g, ''); }

  // ══════════════════════════════════════════════════════════════════
  //  1. 客戶原始需求：完整展開（只讀 Snapshot 自身的資料）
  //  回傳 { kind:'snapshot'|'legacy'|'none', sections:[{ key, title, baseIncludes, lines:[...] }], answeredCount }
  //  line：{ key, depth, kind:'check'|'choice'|'text'|'service'|'info', label, value }
  // ══════════════════════════════════════════════════════════════════
  function flattenNodes(nodes, depth, lines) {
    arr(nodes).forEach(function (n) {
      if (!n || !n.type) return;
      if (n.type === 'check') {
        if (!n.selected) return;
        lines.push({ key: n.key || '', depth: depth, kind: 'check', label: cleanLabel(n.label), value: '已勾選' });
        flattenNodes(n.children, depth + 1, lines);
      } else if (n.type === 'single' || n.type === 'multi') {
        var sel = arr(n.options).filter(function (o) { return o && o.selected; });
        if (!sel.length) return;
        lines.push({
          key: n.key || '', depth: depth, kind: 'choice', label: cleanLabel(n.label),
          value: sel.map(function (o) { return str(o.label) + (o.otherText ? '（' + o.otherText + '）' : ''); }).join('、'),
          options: sel.map(function (o) { return { value: str(o.value), label: str(o.label), otherText: str(o.otherText) }; }),
        });
        flattenNodes(n.children, depth + 1, lines);
      } else if (n.type === 'text') {
        var t = trim(n.text);
        if (!t) return;
        lines.push({ key: n.key || '', depth: depth, kind: 'text', label: cleanLabel(n.label), value: t });
      }
    });
  }

  function flattenOriginal(quote) {
    quote = quote || {};
    var snap = quote.requirementSnapshot;
    var sections = [];
    var answered = 0;
    function addSection(s) { answered += s.lines.length; sections.push(s); }

    if (snap && Array.isArray(snap.categories)) {
      snap.categories.forEach(function (cat) {
        var lines = [];
        flattenNodes(cat.items, 0, lines);
        addSection({ key: 'cat:' + cat.key, title: str(cat.label), baseIncludes: arr(cat.baseIncludes).map(str), lines: lines });
      });
      var extraLines = [];
      arr(snap.additionalServices).forEach(function (a) {
        extraLines.push({
          key: 'service:' + a.group + '/' + a.id, depth: 0, kind: 'service',
          label: str(a.publicName || a.name), value: a.evaluate ? '客戶加選（需評估）' : '客戶加選',
        });
      });
      if (snap.additionalRequirements) flattenNodes(snap.additionalRequirements.items, 0, extraLines);
      if (extraLines.length || snap.additionalRequirements || arr(snap.additionalServices).length) {
        addSection({ key: 'extra', title: (snap.additionalRequirements && snap.additionalRequirements.label) || '其他需求與附加服務', baseIncludes: [], lines: extraLines });
      }
      var pi = snap.projectInfo;
      if (pi) {
        var pl = [];
        pl.push({ key: 'projectInfo:launch', depth: 0, kind: 'info', label: '指定上線日期',
          value: pi.hasTargetLaunchDate === true ? (pi.targetLaunchDate || '有（未填日期）') : pi.hasTargetLaunchDate === false ? '沒有' : '未回答' });
        pl.push({ key: 'projectInfo:maintenance', depth: 0, kind: 'info', label: '後續維護服務',
          value: pi.interestedInMaintenance === true ? '希望了解' : pi.interestedInMaintenance === false ? '不需要' : '未回答' });
        if (pi.warrantyLabel) pl.push({ key: 'projectInfo:warranty', depth: 0, kind: 'info', label: '保固期間', value: str(pi.warrantyLabel) });
        if (pi.budget) pl.push({ key: 'projectInfo:budget', depth: 0, kind: 'info', label: '預算區間', value: str(pi.budget) });
        if (pi.revisionPolicy) pl.push({ key: 'projectInfo:revision', depth: 0, kind: 'info', label: '修改說明', value: str(pi.revisionPolicy) });
        sections.push({ key: 'projectInfo', title: '專案資訊', baseIncludes: [], lines: pl });
      }
      var ft = arr(snap.freeTexts);
      if (ft.length) {
        sections.push({ key: 'freeTexts', title: '客戶補充說明（自由文字）', baseIncludes: [], lines: ft.map(function (t) {
          return { key: str(t.key), depth: 0, kind: 'text', label: str(t.label), value: str(t.text) };
        }) });
      }
      var ev = arr(snap.evaluateRequirements);
      if (ev.length) {
        sections.push({ key: 'evaluate', title: '送出時標示需人工確認的需求', baseIncludes: [], lines: ev.map(function (e) {
          return { key: str(e.key), depth: 0, kind: 'info', label: str(e.categoryLabel) + '｜' + str(e.label), value: str(e.reason) };
        }) });
      }
      var tp = arr(snap.thirdPartyResponsibilities);
      if (tp.length) {
        sections.push({ key: 'thirdParty', title: '第三方服務與責任歸屬（送出時）', baseIncludes: [], lines: tp.map(function (t) {
          return { key: 'tp:' + str(t.service), depth: 0, kind: 'info', label: str(t.label),
            value: str(t.responsibilityLabel || t.responsibilityType) + (arr(t.from).length ? '（相關需求：' + arr(t.from).map(str).join('、') + '）' : '') };
        }) });
      }
      // 需求單上其他客戶填寫的欄位（Quote 層級）
      var ql = legacyQuoteLines(quote, true);
      if (ql.length) sections.push({ key: 'quoteFields', title: '需求單其他欄位', baseIncludes: [], lines: ql });
      return { kind: 'snapshot', definitionVersion: str(snap.definitionVersion), schemaVersion: snap.schemaVersion == null ? null : snap.schemaVersion,
        submittedAtClient: str(snap.submittedAtClient), sections: sections, answeredCount: answered };
    }

    // 沒有需求書：舊版估價表單欄位
    var legacy = [];
    function names(list, title, key) {
      var l = arr(list).map(function (n, i) { return { key: key + ':' + i, depth: 0, kind: 'check', label: str(n), value: title }; });
      if (l.length) legacy.push({ key: key, title: title, baseIncludes: [], lines: l });
    }
    names(quote.includedItems, '方案已包含', 'includedItems');
    names(quote.selectedItems, '加選功能', 'selectedItems');
    names(quote.evaluationItems, '需評估功能', 'evaluationItems');
    var ql2 = legacyQuoteLines(quote, false);
    if (ql2.length) legacy.push({ key: 'quoteFields', title: '需求單其他欄位', baseIncludes: [], lines: ql2 });
    legacy.forEach(function (s) { answered += s.lines.length; });
    return { kind: legacy.length ? 'legacy' : 'none', definitionVersion: '', schemaVersion: null, submittedAtClient: '', sections: legacy, answeredCount: answered };
  }

  function legacyQuoteLines(quote, hasSnapshot) {
    var out = [];
    function add(key, label, v) { if (trim(v)) out.push({ key: 'quote:' + key, depth: 0, kind: 'info', label: label, value: trim(v) }); }
    if (!hasSnapshot) add('projectType', '網站類型', quote.projectType);
    add('message', '客戶補充說明', quote.message);
    add('budget', '預算', quote.budget);
    add('launchDate', '預計上線', quote.launchDate);
    if (!hasSnapshot) {
      add('warrantyLabel', '保固', quote.warrantyLabel);
      add('revisionPolicy', '修改說明', quote.revisionPolicy);
      if (quote.maintenanceKey && quote.maintenanceKey !== 'none') add('maintenanceLabel', '維護服務', quote.maintenanceLabel);
    }
    return out;
  }

  // ══════════════════════════════════════════════════════════════════
  //  2. 正式報價（客戶已接受時以 acceptance 快照為準）
  // ══════════════════════════════════════════════════════════════════
  function quotationSource(quote, acceptance) {
    quote = quote || {};
    var useAcc = quote.quotationStatus === 'accepted' && acceptance && Array.isArray(acceptance.quotationItems);
    var src = useAcc ? acceptance : quote;
    var items = arr(src.quotationItems).map(function (i) {
      return {
        id: str(i.id), name: str(i.name), description: str(i.description),
        qty: num(i.qty), unitPrice: i.unitPrice == null ? null : num(i.unitPrice), subtotal: num(i.subtotal),
        pricingPending: !!i.pricingPending, reqKey: i.reqKey ? str(i.reqKey) : null,
      };
    });
    var total = num(src.quotationTotal);
    var present = items.length > 0 || total > 0;
    return {
      present: present,
      source: useAcc ? 'acceptance' : (present ? 'quote' : 'none'),
      status: quote.quotationStatus || (present ? 'draft' : null),
      publicQuotationVersion: useAcc ? (acceptance.publicQuotationVersion || null) : (quote.publicQuotationVersion || null),
      requirementRevision: quote.quotationRequirementRevision || null,
      acceptedAt: useAcc ? (acceptance.acceptedAt || null) : null,
      acceptanceSource: useAcc ? str(acceptance.source) : '',
      items: items,
      subtotal: num(src.quotationSubtotal),
      discount: num(src.quotationDiscount),
      tax: num(src.quotationTax),
      total: total,
      paymentTerms: str(src.paymentTerms),
      note: str(src.quotationNote),
      officialPrice: num(quote.officialPrice),
    };
  }

  function changeRequestsSource(changeRequests) {
    return arr(changeRequests).filter(function (c) { return c && (c.status === 'approved' || c.status === 'proposed'); })
      .map(function (c) {
        return {
          id: str(c.id), crNumber: str(c.crNumber), title: str(c.title), description: str(c.description),
          status: c.status, approvedAt: c.approvedAt || null,
          amountDelta: num(c.amountDelta), durationDeltaDays: num(c.durationDeltaDays),
          items: arr(c.items).map(function (i) {
            return { id: str(i.id), type: str(i.type), name: str(i.name), description: str(i.description), amountDelta: num(i.amountDelta), durationDeltaDays: num(i.durationDeltaDays) };
          }),
        };
      })
      .sort(function (a, b) { return a.crNumber.localeCompare(b.crNumber); });
  }

  // ══════════════════════════════════════════════════════════════════
  //  3. 來源版本與指紋
  // ══════════════════════════════════════════════════════════════════
  var SOURCE_LABELS = {
    requirementSnapshot: '客戶原始需求',
    confirmedRequirements: '確認需求',
    quotation: '正式報價',
    changeRequests: '需求變更（已核准／提案中）',
    legacy: '舊版估價欄位',
  };

  function sourceState(quote, acceptance, changeRequests) {
    quote = quote || {};
    var snap = quote.requirementSnapshot || null;
    var conf = quote.confirmedRequirements || null;
    var q = quotationSource(quote, acceptance);
    var crs = changeRequestsSource(changeRequests);
    return {
      requirementSnapshot: {
        present: !!snap,
        definitionVersion: snap ? str(snap.definitionVersion) : '',
        schemaVersion: snap && snap.schemaVersion != null ? snap.schemaVersion : null,
        submittedAtMs: snap ? tsMs(snap.submittedAt) : null,
        fp: snap ? fingerprint(snap) : '',
      },
      confirmedRequirements: {
        present: !!conf,
        revision: conf ? num(conf.revision) : null,
        confirmedAtMs: conf ? tsMs(conf.confirmedAt) : null,
        fp: conf ? fingerprint({ revision: conf.revision, items: conf.items, baseRange: conf.baseRange, warrantyFee: conf.warrantyFee }) : '',
      },
      quotation: {
        present: q.present, source: q.source, status: q.status,
        publicQuotationVersion: q.publicQuotationVersion, requirementRevision: q.requirementRevision,
        total: q.total,
        fp: q.present ? fingerprint({ items: q.items, subtotal: q.subtotal, discount: q.discount, tax: q.tax, total: q.total,
          paymentTerms: q.paymentTerms, note: q.note, status: q.status, version: q.publicQuotationVersion, rev: q.requirementRevision }) : '',
      },
      changeRequests: {
        approvedCount: crs.filter(function (c) { return c.status === 'approved'; }).length,
        proposedCount: crs.filter(function (c) { return c.status === 'proposed'; }).length,
        fp: crs.length ? fingerprint(crs) : '',
      },
      legacy: {
        fp: fingerprint({ i: quote.includedItems || [], s: quote.selectedItems || [], e: quote.evaluationItems || [],
          m: quote.message || '', o: quote.officialPrice || null }),
      },
    };
  }

  // 回傳有變動的來源（空陣列＝沒有變動）
  function compareSources(stored, current) {
    var out = [];
    if (!stored || !current) return out;
    Object.keys(SOURCE_LABELS).forEach(function (k) {
      var a = stored[k] || {}, b = current[k] || {};
      if (str(a.fp) === str(b.fp)) return;
      var detail = '';
      if (k === 'confirmedRequirements') detail = '第 ' + (a.revision == null ? '—' : a.revision) + ' 版 → 第 ' + (b.revision == null ? '—' : b.revision) + ' 版';
      else if (k === 'quotation') detail = (a.present ? money(a.total) + '（' + str(a.status) + '）' : '無') + ' → ' + (b.present ? money(b.total) + '（' + str(b.status) + '）' : '無');
      else if (k === 'changeRequests') detail = '已核准 ' + num(a.approvedCount) + ' 筆／提案中 ' + num(a.proposedCount) + ' 筆 → 已核准 ' + num(b.approvedCount) + ' 筆／提案中 ' + num(b.proposedCount) + ' 筆';
      out.push({ source: k, label: SOURCE_LABELS[k], detail: detail });
    });
    return out;
  }

  // ══════════════════════════════════════════════════════════════════
  //  4. 合約需求明細
  // ══════════════════════════════════════════════════════════════════
  function contractItemId(kind, key) {
    return 'CI-' + fnv(kind + '|' + key, 2166136261).toUpperCase();
  }

  function allowedStatuses(row) {
    if (row.sourceKind === 'change_request') return ['change_confirmed'];
    if (row.sourceKind === 'change_proposal') return ['pending'];
    if (row.basis === 'confirmed_included' || row.basis === 'accepted_quotation') {
      return ['included', 'separate_quote', 'pending', 'excluded'];
    }
    return ['pending', 'excluded', 'separate_quote'];
  }

  function blankRow(kind, key) {
    return {
      contractItemId: contractItemId(kind, key),
      sourceKind: kind,
      requirementKey: null,
      changeRequestId: null, changeRequestNumber: '',
      groupLabel: '', label: '',
      originalContent: '', originType: 'client',
      reviewDecision: null, confirmedDescription: '', confirmedRevision: null, originalDefaultDescription: null,
      pricingMode: '', thirdParty: [],
      quotationItemIds: [], quotationMapping: 'none',
      basis: 'none',
      defaultStatus: 'pending', contractStatus: 'pending',
      agreedScope: '', exclusions: '', deliverables: '', acceptanceCriteria: '', notes: '', openQuestions: '',
      flags: [],
    };
  }

  function originalText(item) {
    var t = trim(item.sourceText);
    if (t) return t;
    var refs = arr(item.sourceRefs).map(function (r) { return str(r.label); }).filter(Boolean);
    return refs.join('、');
  }

  /**
   * ctx: { quote, acceptance, changeRequests, pricing, review }
   *   review：NicocoReview（requirement-review.js），只用 buildReviewItems 取得「原始需求 → 審核項目」的同一套切分方式
   */
  function buildItems(ctx) {
    ctx = ctx || {};
    var quote = ctx.quote || {};
    var conf = quote.confirmedRequirements || null;
    var snap = quote.requirementSnapshot || null;
    var q = quotationSource(quote, ctx.acceptance);
    var accepted = q.status === 'accepted';
    var rows = [];
    var used = {};
    function pushRow(r) {
      var id = r.contractItemId, n = 2;
      while (used[id]) { id = r.contractItemId + '-' + (n++); }
      r.contractItemId = id; used[id] = true;
      r.allowedStatuses = allowedStatuses(r);
      if (r.allowedStatuses.indexOf(r.defaultStatus) === -1) r.defaultStatus = r.allowedStatuses[0];
      r.contractStatus = r.defaultStatus;
      // 由來源資料自動帶入的預設文字：重新帶入時用來判斷 Admin 是否改過
      r.autoFields = { agreedScope: r.agreedScope, notes: r.notes };
      rows.push(r);
      return r;
    }
    var linesByReq = {};
    q.items.forEach(function (l) { if (l.reqKey) (linesByReq[l.reqKey] = linesByReq[l.reqKey] || []).push(l); });
    var baseLine = q.items.filter(function (l) { return l.reqKey === 'base'; })[0] || null;
    var representedReq = {};

    // 原始需求依需求審核同一套規則切分（預設描述用來判斷確認需求是否「改寫過」）
    var reviewItems = null;
    if (snap && ctx.review && typeof ctx.review.buildReviewItems === 'function') {
      try { reviewItems = ctx.review.buildReviewItems(quote, ctx.pricing || null) || []; } catch (e) { reviewItems = null; }
    }
    var defaultDesc = {};
    arr(reviewItems).forEach(function (it) { defaultDesc[it.key] = str(it.finalDescription); });

    // ① 已確認需求
    if (conf) {
      arr(conf.items).forEach(function (it) {
        var r = blankRow('confirmed', it.key);
        r.requirementKey = str(it.key);
        r.groupLabel = str(it.groupLabel);
        r.label = str(it.label) || '（未命名）';
        r.originType = it.sourceType === 'admin_custom' ? 'admin_added' : 'client';
        r.originalContent = r.originType === 'admin_added' ? '' : originalText(it);
        r.reviewDecision = it.decision || null;
        r.confirmedDescription = str(it.finalDescription);
        r.originalDefaultDescription = Object.prototype.hasOwnProperty.call(defaultDesc, r.requirementKey) ? defaultDesc[r.requirementKey] : null;
        r.confirmedRevision = num(conf.revision) || null;
        r.pricingMode = str(it.pricingMode);
        r.thirdParty = arr(it.thirdParty).map(function (t) { return str(t.label || t.service); });
        representedReq[r.requirementKey] = true;

        var lines = linesByReq[r.requirementKey] || [];
        r.quotationItemIds = lines.map(function (l) { return l.id; });

        if (it.decision === 'included') {
          r.basis = 'confirmed_included';
          r.defaultStatus = 'included';
          r.agreedScope = r.confirmedDescription;
          if (lines.length) {
            r.quotationMapping = 'mapped';
            if (lines.some(function (l) { return l.pricingPending; })) r.flags.push('對應的報價項目尚未定價');
          } else if (!it.requiresManualPricing && it.pricingMode !== 'feature' && baseLine) {
            r.quotationMapping = 'base_included';
            r.quotationItemIds = [baseLine.id];
          } else {
            r.quotationMapping = 'manual_check';
            r.flags.push('找不到對應的報價項目，' + MANUAL_CHECK_TEXT);
          }
        } else if (it.decision === 'excluded') {
          r.basis = 'confirmed_excluded';
          r.defaultStatus = 'excluded';
          if (lines.length) { r.quotationMapping = 'manual_check'; r.flags.push('需求已排除，但正式報價仍有對應項目，' + MANUAL_CHECK_TEXT); }
        } else {
          r.basis = 'confirmed_pending';
          r.defaultStatus = 'pending';
          r.flags.push('確認需求中仍標示待確認');
        }
        if (it.scopeNote) r.notes = str(it.scopeNote);
        pushRow(r);
      });
    }

    // ② 原始需求中沒有出現在確認需求的項目（或尚未確認需求）：一律待確認
    if (reviewItems) {
      reviewItems.forEach(function (it) {
        if (representedReq[it.key]) return;
        var r = blankRow(conf ? 'snapshot_missing' : 'snapshot_unconfirmed', it.key);
        r.requirementKey = str(it.key);
        r.groupLabel = str(it.groupLabel);
        r.label = str(it.label) || '（未命名）';
        r.originalContent = originalText(it);
        r.pricingMode = str(it.pricingMode);
        r.thirdParty = arr(it.thirdParty).map(function (t) { return str(t.label || t.service); });
        r.basis = 'unconfirmed';
        r.defaultStatus = 'pending';
        r.flags.push(conf ? '原始需求未出現在確認需求中，' + MANUAL_CHECK_TEXT : '需求尚未完成審核確認');
        representedReq[r.requirementKey] = true;
        pushRow(r);
      });
    } else if (snap && !conf) {
      // 審核模組未載入：仍然不自動納入，只提示
      var r0 = blankRow('snapshot_unconfirmed', '__snapshot__');
      r0.label = '客戶原始需求（審核模組未載入，無法切分）';
      r0.basis = 'unconfirmed';
      r0.flags.push(MANUAL_CHECK_TEXT);
      pushRow(r0);
    }

    // ③ 沒有需求書的舊案件：舊欄位逐項列出，一律待確認
    if (!snap && !conf) {
      [['includedItems', '方案已包含'], ['selectedItems', '加選功能'], ['evaluationItems', '需評估功能']].forEach(function (pair) {
        arr(quote[pair[0]]).forEach(function (name) {
          var r = blankRow('legacy', pair[0] + ':' + name);
          r.groupLabel = pair[1];
          r.label = str(name);
          r.originalContent = str(name);
          r.basis = 'unconfirmed';
          r.flags.push('舊版估價欄位，需求未經確認');
          pushRow(r);
        });
      });
    }

    // ④ 正式報價中沒有對應到確認需求的明細（Admin 自行新增的列、舊報價、需求審核前建立的報價）
    q.items.forEach(function (l) {
      if (l.reqKey === 'warranty') return;                    // 保固延長：列在費用／維護，不是開發項目
      if (l.reqKey === 'base' && conf) return;                // 已由確認需求的「基本包含」對應
      if (l.reqKey && l.reqKey !== 'base' && representedReq[l.reqKey] && conf) return;
      var r = blankRow('quotation_line', 'q:' + (l.id || l.name));
      r.groupLabel = '正式報價明細';
      r.label = l.name || '（未命名報價項目）';
      r.originType = 'quotation';
      r.originalContent = '';
      r.quotationItemIds = [l.id];
      r.quotationMapping = 'mapped';
      if (accepted) {
        r.basis = 'accepted_quotation';
        r.defaultStatus = 'included';
        r.agreedScope = l.description ? l.name + '：' + l.description : l.name;
        if (conf) r.flags.push('報價項目未對應確認需求，請人工確認範圍');
      } else {
        r.basis = 'unconfirmed';
        r.flags.push('正式報價尚未由客戶接受');
      }
      if (l.reqKey && conf && !representedReq[l.reqKey]) r.flags.push('報價引用的需求項目不在目前的確認需求中');
      if (l.pricingPending) r.flags.push('此報價項目尚未定價');
      pushRow(r);
    });

    // ⑤ 需求變更：已核准＝已確認的後續變更；提案中＝待確認
    changeRequestsSource(ctx.changeRequests).forEach(function (c) {
      c.items.forEach(function (ci) {
        var approved = c.status === 'approved';
        var r = blankRow(approved ? 'change_request' : 'change_proposal', c.id + '/' + ci.id);
        r.changeRequestId = c.id;
        r.changeRequestNumber = c.crNumber;
        r.groupLabel = c.crNumber + '　' + c.title;
        r.label = (ci.type === 'remove' ? '刪除：' : ci.type === 'modify' ? '修改：' : '新增：') + ci.name;
        r.originType = 'change_request';
        r.originalContent = ci.description;
        r.basis = approved ? 'approved_change' : 'proposed_change';
        r.defaultStatus = approved ? 'change_confirmed' : 'pending';
        r.agreedScope = approved ? (ci.description ? ci.name + '：' + ci.description : ci.name) : '';
        if (!approved) r.flags.push('變更提案尚未核准');
        pushRow(r);
      });
    });

    return rows;
  }

  // 確保每一列的狀態都在允許範圍內（寫入前一定會呼叫）。回傳被重設的列數。
  function sanitizeItems(rows) {
    var reset = 0;
    arr(rows).forEach(function (r) {
      r.allowedStatuses = allowedStatuses(r);
      if (r.allowedStatuses.indexOf(r.contractStatus) === -1) { r.contractStatus = r.defaultStatus; reset++; }
      if (r.allowedStatuses.indexOf(r.contractStatus) === -1) { r.contractStatus = r.allowedStatuses[0]; }
      EDITABLE_FIELDS.forEach(function (f) { r[f] = str(r[f]); });
    });
    return reset;
  }

  function isObligation(row) { return OBLIGATION_STATUSES.indexOf(row.contractStatus) !== -1; }

  // ══════════════════════════════════════════════════════════════════
  //  5. 原始需求 vs 確認需求 vs 合約：差異
  // ══════════════════════════════════════════════════════════════════
  function norm(s) { return trim(s).replace(/\s+/g, ' '); }
  // 與「原始需求依審核規則產生的預設描述」比較；沒有預設描述可比（審核模組未載入）時退回與名稱／原始內容比較
  function descriptionChanged(r) {
    var c = norm(r.confirmedDescription);
    if (r.originalDefaultDescription != null && norm(r.originalDefaultDescription)) return c !== norm(r.originalDefaultDescription);
    return c !== norm(r.label) && c !== norm(r.originalContent) && c !== norm(r.groupLabel + '：' + r.originalContent);
  }
  function computeDiff(rows) {
    var out = [];
    arr(rows).forEach(function (r) {
      if (r.sourceKind === 'confirmed') {
        if (r.originType === 'admin_added') {
          out.push({ type: 'admin_added', contractItemId: r.contractItemId, label: r.label, original: '', confirmed: r.confirmedDescription, text: '非客戶原始需求，由需求審核新增' });
        } else if (r.reviewDecision === 'excluded') {
          out.push({ type: 'excluded_by_review', contractItemId: r.contractItemId, label: r.label, original: r.originalContent, confirmed: '', text: '客戶原始提出，需求審核決定排除' });
        } else if (r.reviewDecision === 'included' && norm(r.confirmedDescription) && descriptionChanged(r)) {
          out.push({ type: 'description_changed', contractItemId: r.contractItemId, label: r.label, original: r.originalContent, confirmed: r.confirmedDescription, text: '確認需求的描述與原始內容不同' });
        }
      } else if (r.sourceKind === 'snapshot_missing') {
        out.push({ type: 'missing_from_confirmed', contractItemId: r.contractItemId, label: r.label, original: r.originalContent, confirmed: '', text: '原始需求未出現在確認需求中' });
      } else if (r.sourceKind === 'change_request') {
        out.push({ type: 'change_request', contractItemId: r.contractItemId, label: r.label, original: '', confirmed: r.agreedScope, text: r.changeRequestNumber + ' 已核准的後續變更' });
      }
      if (r.contractStatus !== r.defaultStatus) {
        out.push({ type: 'contract_status_changed', contractItemId: r.contractItemId, label: r.label,
          original: STATUS[r.defaultStatus] || r.defaultStatus, confirmed: STATUS[r.contractStatus] || r.contractStatus,
          text: '合約狀態與預設（依確認需求）不同' });
      }
    });
    return out;
  }

  // ══════════════════════════════════════════════════════════════════
  //  6. 費用整合（金額一律引用報價快照／已核准變更；分類可由 Admin 指定，金額不可改）
  // ══════════════════════════════════════════════════════════════════
  function autoCategory(line, confirmedByKey) {
    if (line.reqKey === 'base') return 'development';
    if (line.reqKey === 'warranty') return 'maintenance';
    var c = line.reqKey && confirmedByKey[line.reqKey];
    if (c) return arr(c.thirdParty).length ? 'third_party' : 'module';
    return null;
  }

  /**
   * data：contractData（使用其中的 quotationSnapshot、changeRequestsSnapshot、confirmedItemsIndex、feeCategoryOverrides）
   * contractAmount：合約總額（agreement.contractAmountSnapshot）
   */
  function buildFees(data, contractAmount) {
    data = data || {};
    var q = data.quotationSnapshot || { present: false, items: [] };
    var overrides = data.feeCategoryOverrides || {};
    var confirmedByKey = {};
    arr(data.confirmedItemsIndex).forEach(function (c) { confirmedByKey[c.key] = c; });

    var mode = 'none';
    if (arr(q.items).length) mode = 'itemized';
    else if (num(q.total) > 0) mode = 'total_only';
    else if (num(q.officialPrice) > 0) mode = 'total_only';

    var lines = arr(q.items).map(function (l) {
      var auto = autoCategory(l, confirmedByKey);
      var ov = overrides[l.id];
      var cat = (ov && FEE_CATEGORIES[ov] && ov !== 'unclassified') ? ov : (auto || 'unclassified');
      return {
        quotationItemId: l.id, name: l.name, description: l.description,
        amount: l.pricingPending ? null : num(l.subtotal), pricingPending: !!l.pricingPending,
        reqKey: l.reqKey, category: cat,
        categorySource: (ov && FEE_CATEGORIES[ov] && ov !== 'unclassified') ? 'manual' : (auto ? 'auto' : 'unclassified'),
        autoCategory: auto,
      };
    });

    var categories = {};
    FEE_CATEGORY_ORDER.forEach(function (k) { categories[k] = { key: k, label: FEE_CATEGORIES[k], amount: mode === 'itemized' ? 0 : null, lineCount: 0, hasPending: false }; });
    if (mode === 'itemized') {
      lines.forEach(function (l) {
        var c = categories[l.category];
        c.lineCount++;
        if (l.pricingPending) c.hasPending = true; else c.amount += l.amount;
      });
    }
    var linesSum = lines.reduce(function (s, l) { return s + (l.amount || 0); }, 0);

    var crs = arr(data.changeRequestsSnapshot);
    var approved = crs.filter(function (c) { return c.status === 'approved'; });
    var approvedDelta = approved.reduce(function (s, c) { return s + num(c.amountDelta); }, 0);

    var baseTotal = num(q.total) > 0 ? num(q.total) : num(q.officialPrice);
    var baseTotalSource = num(q.total) > 0 ? 'quotationTotal' : (num(q.officialPrice) > 0 ? 'officialPrice' : 'none');
    var ca = num(contractAmount);
    var amountTraceable = ca > 0 && (ca === baseTotal || ca === baseTotal + approvedDelta);

    return {
      mode: mode,
      quotationSource: q.source || 'none',
      quotationStatus: q.status || null,
      lines: lines,
      categories: categories,
      linesSum: linesSum,
      subtotal: mode === 'itemized' ? num(q.subtotal) : null,
      subtotalMatches: mode !== 'itemized' || linesSum === num(q.subtotal),
      discount: num(q.discount),
      tax: num(q.tax),
      quotationTotal: num(q.total),
      officialPrice: num(q.officialPrice),
      baseTotal: baseTotal,
      baseTotalSource: baseTotalSource,
      changeOrders: approved.map(function (c) { return { crId: c.id, crNumber: c.crNumber, title: c.title, amountDelta: num(c.amountDelta) }; }),
      approvedChangeDelta: approvedDelta,
      proposedChanges: crs.filter(function (c) { return c.status === 'proposed'; }).map(function (c) { return { crId: c.id, crNumber: c.crNumber, title: c.title, amountDelta: num(c.amountDelta) }; }),
      contractAmount: ca,
      expectedWithChanges: baseTotal + approvedDelta,
      amountTraceable: amountTraceable,
      unclassifiedCount: lines.filter(function (l) { return l.category === 'unclassified'; }).length,
      pendingPriceCount: lines.filter(function (l) { return l.pricingPending; }).length,
      paymentTerms: str(q.paymentTerms),
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  7. 預留結構（本輪不實作完整介面；不預填任何數字或條款內容）
  // ══════════════════════════════════════════════════════════════════
  function reservedChangePolicy() {
    function phase() { return { freeRevisionRounds: null, coveredItems: [], workloadCapHours: null, note: '' }; }
    return {
      schemaVersion: 1,
      phases: { design: phase(), development: phase(), acceptance: phase() },
      defectVsChange: { defectDefinition: '', paidChangeDefinition: '', note: '' },
    };
  }
  function reservedTermsVersion() { return { id: null, label: '', effectiveDate: null }; }

  // ══════════════════════════════════════════════════════════════════
  //  8. 建立 contractData（建立合約或 Admin 主動「重新帶入」時呼叫）
  //  ctx: { quote, acceptance, changeRequests, pricing, review, capturedAt }
  //  previous：既有 contractData（重新帶入時保留 Admin 編輯的內容）
  // ══════════════════════════════════════════════════════════════════
  function capture(ctx, previous) {
    ctx = ctx || {};
    var quote = ctx.quote || {};
    var conf = quote.confirmedRequirements || null;
    var snap = quote.requirementSnapshot || null;
    var q = quotationSource(quote, ctx.acceptance);
    var rows = buildItems(ctx);
    var report = null;
    if (previous && Array.isArray(previous.items)) report = mergeEdits(previous.items, rows);

    var data = {
      schemaVersion: SCHEMA_VERSION,
      capturedAt: ctx.capturedAt || null,
      sources: sourceState(quote, ctx.acceptance, ctx.changeRequests),
      // 客戶原始需求的完整複本（requirementSnapshot 本身不可變，但合約保存自己的附件副本）
      originalRequirementSnapshot: snap ? clone(snap) : null,
      originalLegacyFields: snap ? null : {
        projectType: str(quote.projectType), includedItems: arr(quote.includedItems).map(str), selectedItems: arr(quote.selectedItems).map(str),
        evaluationItems: arr(quote.evaluationItems).map(str), message: str(quote.message),
        budget: str(quote.budget), launchDate: str(quote.launchDate),
        warrantyLabel: str(quote.warrantyLabel), revisionPolicy: str(quote.revisionPolicy),
        maintenanceKey: str(quote.maintenanceKey), maintenanceLabel: str(quote.maintenanceLabel),
      },
      originalQuoteFields: { message: str(quote.message), budget: str(quote.budget), launchDate: str(quote.launchDate) },
      confirmedRevision: conf ? num(conf.revision) : null,
      confirmedItemsIndex: conf ? arr(conf.items).map(function (c) {
        return { key: str(c.key), label: str(c.label), decision: str(c.decision), pricingMode: str(c.pricingMode),
          thirdParty: arr(c.thirdParty).map(function (t) { return str(t.label || t.service); }) };
      }) : [],
      quotationSnapshot: q,
      changeRequestsSnapshot: changeRequestsSource(ctx.changeRequests),
      items: rows,
      feeCategoryOverrides: (previous && previous.feeCategoryOverrides) ? clone(previous.feeCategoryOverrides) : {},
      maintenance: {
        warrantyLabel: str(quote.warrantyLabel),
        warrantyFee: num(quote.warrantyFee),
        revisionPolicy: str(quote.revisionPolicy),
        maintenanceKey: str(quote.maintenanceKey),
        maintenanceLabel: str(quote.maintenanceLabel),
        interestedInMaintenance: snap && snap.projectInfo ? (snap.projectInfo.interestedInMaintenance == null ? null : !!snap.projectInfo.interestedInMaintenance) : null,
        thirdPartyResponsibilities: snap ? arr(snap.thirdPartyResponsibilities).map(function (t) {
          return { service: str(t.service), label: str(t.label), responsibilityLabel: str(t.responsibilityLabel || t.responsibilityType), note: str(t.note) };
        }) : [],
      },
      changePolicy: (previous && previous.changePolicy) ? clone(previous.changePolicy) : reservedChangePolicy(),
      termsVersion: (previous && previous.termsVersion) ? clone(previous.termsVersion) : reservedTermsVersion(),
      resyncCount: previous ? num(previous.resyncCount) + 1 : 0,
      // 帶入時讀取失敗的來源（例如需求變更清單讀不到）：列入「尚缺少的必要資訊」
      loadWarnings: arr(ctx.loadWarnings).map(str),
    };
    // 分類覆寫只保留仍存在的報價明細
    var ids = {};
    q.items.forEach(function (l) { ids[l.id] = true; });
    Object.keys(data.feeCategoryOverrides).forEach(function (k) { if (!ids[k] || !FEE_CATEGORIES[data.feeCategoryOverrides[k]]) delete data.feeCategoryOverrides[k]; });
    return { data: data, report: report };
  }

  // 重新帶入：同一個 contractItemId 的 Admin 編輯內容保留；狀態若已不被允許則重設並回報
  function mergeEdits(oldRows, newRows) {
    var byId = {};
    arr(oldRows).forEach(function (r) { byId[r.contractItemId] = r; });
    var seen = {};
    var report = { kept: 0, added: 0, removed: [], statusReset: [] };
    newRows.forEach(function (r) {
      var o = byId[r.contractItemId];
      if (!o) { report.added++; return; }
      seen[r.contractItemId] = true;
      report.kept++;
      EDITABLE_FIELDS.forEach(function (f) {
        var oldVal = str(o[f]);
        var oldAuto = o.autoFields && Object.prototype.hasOwnProperty.call(o.autoFields, f) ? str(o.autoFields[f]) : '';
        // Admin 改過（與當時自動帶入的值不同）才保留；沒改過的就換成新來源的預設值
        if (oldVal !== oldAuto) r[f] = oldVal;
      });
      var allowed = allowedStatuses(r);
      if (o.contractStatus && allowed.indexOf(o.contractStatus) !== -1) r.contractStatus = o.contractStatus;
      else if (o.contractStatus && o.contractStatus !== r.defaultStatus) {
        report.statusReset.push({ label: r.label, from: o.contractStatus, to: r.contractStatus });
      }
    });
    arr(oldRows).forEach(function (o) { if (!seen[o.contractItemId]) report.removed.push(o.label); });
    return report;
  }

  // ══════════════════════════════════════════════════════════════════
  //  9. 尚缺少的必要資訊
  //  agr：合約草稿（client/provider/projectName/contractAmountSnapshot/paymentPlanSnapshot/timeline）
  //  live：{ reviewDraftOpen, staleSources:[...] }（即時狀態，可省略）
  //  回傳 [{ level:'required'|'check', text }]
  // ══════════════════════════════════════════════════════════════════
  function missingInfo(agr, data, live) {
    agr = agr || {}; data = data || {}; live = live || {};
    var out = [];
    function req(t) { out.push({ level: 'required', text: t }); }
    function chk(t) { out.push({ level: 'check', text: t }); }
    var client = agr.client || {};
    if (!trim(client.name) && !trim(client.company)) req('客戶名稱或公司名稱');
    var miss = [];
    if (!trim(client.address)) miss.push('地址');
    if (!trim(client.representative)) miss.push('簽約代表人');
    if (trim(client.company) && !trim(client.taxId)) miss.push('統一編號');
    if (miss.length) chk('客戶資料未填：' + miss.join('、'));
    var prov = agr.provider || {};
    if (!trim(prov.studioName)) req('承攬方名稱');
    if (!trim(agr.projectName)) req('專案名稱');
    var tl = agr.timeline || {};
    if (!tl.estimatedStartDate || !tl.estimatedCompletionDate) chk('預計開始日／完成日未填');

    if (!data.schemaVersion) { req('尚未帶入合約資料（v2.1）'); return out; }
    arr(data.loadWarnings).forEach(function (w) { req('帶入時讀取失敗：' + w + '（請重新帶入來源資料）'); });

    var src = data.sources || {};
    if (!(src.confirmedRequirements && src.confirmedRequirements.present)) {
      if (src.requirementSnapshot && src.requirementSnapshot.present) req('需求尚未完成審核確認：所有原始需求都只能列為待確認');
      else chk('此案件沒有需求書，開發項目只能依正式報價判斷');
    }
    if (live.reviewDraftOpen) chk('需求審核有尚未確認的工作稿（重新審核中）');
    var q = data.quotationSnapshot || {};
    if (!q.present && !(num(q.officialPrice) > 0)) req('沒有正式報價');
    else if (q.status !== 'accepted') chk('正式報價目前不是「已接受」狀態（' + str(q.status || '未設定') + '）');
    var conf = src.confirmedRequirements || {};
    if (conf.present && q.present && q.requirementRevision && num(q.requirementRevision) !== num(conf.revision)) {
      chk('正式報價依據需求第 ' + q.requirementRevision + ' 版，目前確認需求為第 ' + conf.revision + ' 版');
    }
    if (conf.present && q.present && arr(q.items).length && !q.requirementRevision) chk('正式報價明細不是依確認需求產生，對應關係需人工確認');

    var rows = arr(data.items);
    var pending = rows.filter(function (r) { return r.contractStatus === 'pending'; });
    if (pending.length) chk(pending.length + ' 項需求仍為「待確認」，不會列入開發義務');
    var mapCheck = rows.filter(function (r) { return isObligation(r) && r.quotationMapping === 'manual_check'; });
    if (mapCheck.length) chk(mapCheck.length + ' 項已納入的需求，對應報價項目' + MANUAL_CHECK_TEXT);
    var obligations = rows.filter(isObligation);
    if (!obligations.length) req('沒有任何「已納入開發」或「已確認的後續變更」項目');
    var noDeliv = obligations.filter(function (r) { return !trim(r.deliverables); });
    if (noDeliv.length) chk(noDeliv.length + ' 項開發項目未填「交付成果」');
    var noAcc = obligations.filter(function (r) { return !trim(r.acceptanceCriteria); });
    if (noAcc.length) chk(noAcc.length + ' 項開發項目未填「驗收依據」');
    var open = rows.filter(function (r) { return trim(r.openQuestions); });
    if (open.length) chk(open.length + ' 項有待確認事項');

    var fees = buildFees(data, agr.contractAmountSnapshot);
    if (fees.mode === 'total_only') req('報價只有總額，各類費用' + MANUAL_SPLIT_TEXT);
    if (fees.unclassifiedCount) chk(fees.unclassifiedCount + ' 筆報價明細尚未分類');
    if (fees.pendingPriceCount) req(fees.pendingPriceCount + ' 筆報價明細尚未定價');
    if (!fees.subtotalMatches) chk('報價明細加總與報價小計不一致');
    if (!(num(agr.contractAmountSnapshot) > 0)) req('合約總額');
    else if (fees.baseTotal > 0 && !fees.amountTraceable) chk('合約總額 ' + money(agr.contractAmountSnapshot) + ' 無法對應正式報價（' + money(fees.baseTotal) + '）或報價＋已核准變更（' + money(fees.expectedWithChanges) + '）');
    if (fees.proposedChanges.length) chk(fees.proposedChanges.length + ' 筆需求變更仍在提案中，未列入合約');
    var plan = arr(agr.paymentPlanSnapshot);
    if (!plan.length) req('付款計畫');
    var m = data.maintenance || {};
    var hasMaintFee = fees.lines.some(function (l) { return l.category === 'maintenance' && l.reqKey !== 'warranty'; });
    if (m.interestedInMaintenance === true && !hasMaintFee) chk('客戶表示希望了解維護服務，但報價中沒有維護費項目');
    arr(live.staleSources).forEach(function (s) { req('來源資料已更新：' + s.label + (s.detail ? '（' + s.detail + '）' : '') + '，尚未重新帶入'); });
    return out;
  }

  // ══════════════════════════════════════════════════════════════════
  //  10. 合約資料預覽（HTML 字串；樣式見 agreement-v21.css）
  //  agr：合約草稿／已存合約；opts：{ staleSources, reviewDraftOpen }
  // ══════════════════════════════════════════════════════════════════
  function statusTag(s) {
    return '<span class="agv-tag agv-st-' + esc(s) + '">' + esc(STATUS[s] || s) + '</span>';
  }
  function emptyMark(text) { return '<span class="agv-empty">' + esc(text || '未填寫') + '</span>'; }
  function feeAmount(v, mode, pending) {
    if (mode === 'total_only') return '<span class="agv-warn">' + MANUAL_SPLIT_TEXT + '</span>';
    if (mode === 'none') return emptyMark('無報價資料');
    if (pending) return '<span class="agv-warn">含待定價項目</span>' + (v ? '　' + esc(money(v)) : '');
    return esc(money(v));
  }

  function renderOriginalSections(data) {
    var fake = {};
    if (data.originalRequirementSnapshot) {
      fake = { requirementSnapshot: data.originalRequirementSnapshot };
      var of = data.originalQuoteFields || {};
      fake.message = of.message; fake.budget = of.budget; fake.launchDate = of.launchDate;
    } else if (data.originalLegacyFields) {
      fake = clone(data.originalLegacyFields);
    }
    var flat = flattenOriginal(fake);
    if (!flat.sections.length) return '<div class="agv-muted">此案件沒有任何原始需求資料。</div>';
    var head = flat.kind === 'snapshot'
      ? '<div class="agv-muted">需求書版本 ' + esc(flat.definitionVersion || '—') + '・資料格式 v' + esc(flat.schemaVersion == null ? '—' : flat.schemaVersion) + '・客戶端送出時間 ' + esc(flat.submittedAtClient || '—') + '・共 ' + flat.answeredCount + ' 筆已填答內容</div>'
      : '<div class="agv-muted">此案件建立於需求書功能之前，以下為舊版估價表單欄位。</div>';
    return head + flat.sections.map(function (s) {
      return '<div class="agv-orig-sec"><div class="agv-orig-title">' + esc(s.title) + '</div>' +
        (s.baseIncludes.length ? '<div class="agv-muted">方案基本包含：' + s.baseIncludes.map(esc).join('、') + '</div>' : '') +
        (s.lines.length ? s.lines.map(function (l) {
          return '<div class="agv-orig-line" style="padding-left:' + (l.depth * 16) + 'px">' +
            (l.kind === 'check' || l.kind === 'service' ? '✓ ' + esc(l.label) + (l.kind === 'service' ? '<span class="agv-muted">（' + esc(l.value) + '）</span>' : '')
              : '<span class="agv-k">' + esc(l.label) + '：</span>' + esc(l.value)) +
            '<span class="agv-key">' + esc(l.key) + '</span></div>';
        }).join('') : '<div class="agv-muted">無額外／特殊需求</div>') + '</div>';
    }).join('');
  }

  function rowBlock(r, quotationById) {
    // 「含於網站基礎建置」的項目不顯示基礎建置的總金額，避免誤讀成單項價格
    var showAmount = r.quotationMapping !== 'base_included';
    var q = arr(r.quotationItemIds).map(function (id) { var l = quotationById[id]; return l ? esc(l.name) + (!showAmount ? '' : l.pricingPending ? '（待定價）' : '　' + esc(money(l.subtotal))) : esc(id); });
    function field(label, v, emptyText) { return '<div class="agv-f"><span class="agv-k">' + label + '</span>' + (trim(v) ? esc(v) : emptyMark(emptyText)) + '</div>'; }
    return '<div class="agv-row">' +
      '<div class="agv-row-head">' + statusTag(r.contractStatus) + '<strong>' + esc(r.label) + '</strong>' +
        '<span class="agv-key">' + esc(r.contractItemId) + (r.requirementKey ? '・' + esc(r.requirementKey) : '') + '</span></div>' +
      (r.groupLabel ? '<div class="agv-muted">' + esc(r.groupLabel) + '</div>' : '') +
      field('原始需求內容', r.originType === 'admin_added' ? '' : r.originalContent, r.originType === 'admin_added' ? '非客戶原始需求（需求審核新增）' : r.originType === 'quotation' ? '來自正式報價明細' : '無') +
      '<div class="agv-f"><span class="agv-k">審核狀態</span>' + (r.reviewDecision ? esc(REVIEW_DECISION_TEXT[r.reviewDecision] || r.reviewDecision) + (r.confirmedRevision ? '（確認需求第 ' + esc(r.confirmedRevision) + ' 版）' : '') : emptyMark(r.sourceKind === 'change_request' ? '需求變更（已核准）' : r.sourceKind === 'change_proposal' ? '需求變更（提案中）' : '未經需求審核')) + '</div>' +
      field('最終約定的開發內容', isObligation(r) ? r.agreedScope : '', isObligation(r) ? '未填寫' : '不列入本合約開發義務') +
      field('明確不包含', r.exclusions) +
      field('交付成果', r.deliverables) +
      field('驗收依據', r.acceptanceCriteria) +
      '<div class="agv-f"><span class="agv-k">對應報價項目</span>' + (q.length ? q.join('、') : '') + ' <span class="agv-muted">' + esc(MAPPING_TEXT[r.quotationMapping] || '') + '</span></div>' +
      (r.thirdParty.length ? '<div class="agv-f"><span class="agv-k">相關第三方服務</span>' + r.thirdParty.map(esc).join('、') + '</div>' : '') +
      (trim(r.notes) ? field('備註', r.notes) : '') +
      (trim(r.openQuestions) ? '<div class="agv-f agv-warn"><span class="agv-k">待確認事項</span>' + esc(r.openQuestions) + '</div>' : '') +
      (r.flags.length ? '<div class="agv-flags">' + r.flags.map(function (f) { return '<div>⚠ ' + esc(f) + '</div>'; }).join('') + '</div>' : '') +
      '</div>';
  }

  function renderPreview(agr, opts) {
    agr = agr || {}; opts = opts || {};
    var data = agr.contractData || null;
    var client = agr.client || {}, prov = agr.provider || {}, tl = agr.timeline || {};
    var html = '';
    function sec(no, title, body) { return '<section class="agv-sec"><h3 class="agv-h"><span class="agv-no">' + no + '</span>' + esc(title) + '</h3>' + body + '</section>'; }
    function kv(k, v) { return '<div class="agv-kv"><span class="agv-k">' + esc(k) + '</span>' + (trim(v) ? esc(v) : emptyMark()) + '</div>'; }

    if (opts.staleSources && opts.staleSources.length) {
      html += '<div class="agv-alert">來源資料在這份合約草稿建立後已更新，以下內容仍是當時帶入的版本（不會自動改寫）：' +
        opts.staleSources.map(function (s) { return '<div>・' + esc(s.label) + (s.detail ? '：' + esc(s.detail) : '') + '</div>'; }).join('') + '</div>';
    }

    // 1 基本資料
    html += sec(1, '客戶與案件基本資料',
      '<div class="agv-grid">' +
      kv('合約編號', agr.agreementNumber || '（儲存後產生）') + kv('案件編號', agr.quoteId || '') +
      kv('專案名稱', agr.projectName) + kv('合約狀態', agr.statusLabel || agr.status || '草稿') +
      kv('客戶姓名', client.name) + kv('公司', client.company) + kv('統一編號', client.taxId) + kv('簽約代表人', client.representative) +
      kv('Email', client.email) + kv('電話', client.phone) + kv('地址', client.address) +
      kv('承攬方', prov.studioName) + kv('承攬方統編', prov.taxId) +
      kv('預計開始日', tl.estimatedStartDate) + kv('預計完成日', tl.estimatedCompletionDate) +
      '</div>' +
      (data ? '<div class="agv-muted" style="margin-top:8px">資料來源版本：' + sourceSummary(data.sources) + '</div>' : ''));

    if (!data) {
      html += '<div class="agv-alert">此合約沒有 v2.1 合約資料（建立於 v2.1 之前）。' +
        (agr.status === 'draft' ? '可在編輯畫面按「帶入合約資料」產生。' : '已非草稿的合約不會補產生，以免改動已定案內容。') + '</div>';
      return html;
    }

    var rows = arr(data.items);
    var qById = {};
    arr((data.quotationSnapshot || {}).items).forEach(function (l) { qById[l.id] = l; });

    // 2 原始需求
    html += sec(2, '客戶原始需求清單（附件）', renderOriginalSections(data));

    // 3 最終確認開發項目
    var oblig = rows.filter(isObligation);
    html += sec(3, '最終確認開發項目（本合約開發義務）',
      '<div class="agv-muted">只有「已納入開發」與「已確認的後續變更」構成開發義務；共 ' + oblig.length + ' 項。</div>' +
      (oblig.length ? oblig.map(function (r) { return rowBlock(r, qById); }).join('') : '<div class="agv-alert">沒有任何已納入開發的項目。</div>'));

    // 4 排除／待確認／另行報價
    var others = rows.filter(function (r) { return !isObligation(r); })
      .sort(function (a, b) { return STATUS_ORDER.indexOf(a.contractStatus) - STATUS_ORDER.indexOf(b.contractStatus); });
    var diff = computeDiff(rows);
    html += sec(4, '排除、待確認與另行報價項目',
      '<div class="agv-muted">以下項目不屬於本合約的開發義務。</div>' +
      (others.length ? others.map(function (r) { return rowBlock(r, qById); }).join('') : '<div class="agv-muted">無</div>') +
      '<h4 class="agv-h4">原始需求與確認需求的差異</h4>' +
      (diff.length ? '<table class="agv-table"><thead><tr><th>項目</th><th>差異</th><th>原始</th><th>確認／合約</th></tr></thead><tbody>' +
        diff.map(function (d) {
          return '<tr><td>' + esc(d.label) + '</td><td>' + esc(d.text) + '</td><td>' + (trim(d.original) ? esc(d.original) : emptyMark('—')) + '</td><td>' + (trim(d.confirmed) ? esc(d.confirmed) : emptyMark('—')) + '</td></tr>';
        }).join('') + '</tbody></table>' : '<div class="agv-muted">沒有差異。</div>'));

    // 5 開發費用明細
    var fees = buildFees(data, agr.contractAmountSnapshot);
    var feeBody = '<div class="agv-muted">金額來源：' + (fees.quotationSource === 'acceptance' ? '客戶接受報價時的快照' : fees.quotationSource === 'quote' ? '正式報價（' + esc(fees.quotationStatus || '') + '）' : fees.baseTotalSource === 'officialPrice' ? '議定金額（舊欄位）' : '無') + '</div>';
    feeBody += '<table class="agv-table"><tbody>' +
      FEE_CATEGORY_ORDER.filter(function (k) { return k !== 'unclassified' || fees.categories.unclassified.lineCount; }).map(function (k) {
        var c = fees.categories[k];
        return '<tr><td>' + esc(c.label) + '</td><td class="agv-num">' + (fees.mode === 'itemized' && !c.lineCount && k !== 'unclassified' ? emptyMark('無') : feeAmount(c.amount, fees.mode, c.hasPending)) + '</td></tr>';
      }).join('') +
      '<tr><td>額外修改或需求變更費（已核准）</td><td class="agv-num">' + (fees.changeOrders.length ? esc(signedMoney(fees.approvedChangeDelta)) : emptyMark('無')) + '</td></tr>' +
      '<tr><td>折扣</td><td class="agv-num">' + (fees.mode === 'none' ? emptyMark('—') : esc(fees.discount ? '-' + money(fees.discount) : money(0))) + '</td></tr>' +
      '<tr><td>稅額</td><td class="agv-num">' + (fees.mode === 'none' ? emptyMark('—') : esc(money(fees.tax))) + '</td></tr>' +
      '<tr class="agv-total"><td>正式報價總額</td><td class="agv-num">' + (fees.baseTotal ? esc(money(fees.baseTotal)) : emptyMark('—')) + '</td></tr>' +
      '<tr class="agv-total"><td>合約總額</td><td class="agv-num">' + esc(money(fees.contractAmount)) + (fees.amountTraceable ? '' : ' <span class="agv-warn">' + MANUAL_CHECK_TEXT + '</span>') + '</td></tr>' +
      '</tbody></table>';
    if (fees.mode === 'itemized') {
      feeBody += '<h4 class="agv-h4">報價明細與分類</h4><table class="agv-table"><thead><tr><th>報價項目</th><th>分類</th><th class="agv-num">金額</th></tr></thead><tbody>' +
        fees.lines.map(function (l) {
          return '<tr><td>' + esc(l.name) + '<span class="agv-key">' + esc(l.quotationItemId) + '</span></td><td>' + esc(FEE_CATEGORIES[l.category]) +
            (l.categorySource === 'auto' ? '<span class="agv-muted">（依需求資料）</span>' : l.categorySource === 'manual' ? '<span class="agv-muted">（人工指定）</span>' : '') + '</td><td class="agv-num">' +
            (l.pricingPending ? '<span class="agv-warn">待定價</span>' : esc(money(l.amount))) + '</td></tr>';
        }).join('') + '</tbody></table>';
    }
    if (fees.changeOrders.length) {
      feeBody += '<h4 class="agv-h4">已核准的需求變更</h4>' + fees.changeOrders.map(function (c) { return '<div class="agv-kv"><span class="agv-k">' + esc(c.crNumber) + '</span>' + esc(c.title) + '　' + esc(signedMoney(c.amountDelta)) + '</div>'; }).join('');
    }
    var plan = arr(agr.paymentPlanSnapshot);
    feeBody += '<h4 class="agv-h4">分期付款條件</h4>' +
      (fees.paymentTerms ? kv('報價付款條件', fees.paymentTerms) : '') +
      (plan.length ? '<table class="agv-table"><thead><tr><th>期別</th><th class="agv-num">比例</th><th class="agv-num">金額</th><th>預計日期</th></tr></thead><tbody>' +
        plan.map(function (p) { return '<tr><td>' + esc(p.title) + '</td><td class="agv-num">' + esc(p.percentage) + '%</td><td class="agv-num">' + esc(money(p.amount)) + '</td><td>' + (p.dueDate ? esc(p.dueDate) : emptyMark('—')) + '</td></tr>'; }).join('') +
        '</tbody></table>' : emptyMark('尚未設定付款計畫'));
    html += sec(5, '開發費用明細', feeBody);

    // 6 維護與額外修改
    var m = data.maintenance || {};
    var maintLines = fees.lines.filter(function (l) { return l.category === 'maintenance'; });
    var mb = '<h4 class="agv-h4">報價中的維護／保固費用</h4>' +
      (fees.mode === 'total_only' ? '<span class="agv-warn">' + MANUAL_SPLIT_TEXT + '</span>'
        : maintLines.length ? maintLines.map(function (l) { return kv(l.name, l.pricingPending ? '待定價' : money(l.amount)); }).join('') : emptyMark('報價中沒有維護費項目（未約定）'));
    mb += '<h4 class="agv-h4">客戶需求單上的相關選項（意向，非合約約定）</h4>' +
      kv('保固', m.warrantyLabel) +
      kv('後續維護服務', m.interestedInMaintenance === true ? '希望了解' : m.interestedInMaintenance === false ? '不需要' : (m.maintenanceKey && m.maintenanceKey !== 'none' ? m.maintenanceLabel : '')) +
      kv('修改說明', m.revisionPolicy);
    mb += '<h4 class="agv-h4">合約條款（目前的條款文字）</h4>' +
      kv('保固／維護條件', agr.warrantyPolicy) + kv('修改與追加需求條款', agr.changeRequestPolicy) + kv('第三方服務費說明', agr.thirdPartyFeeNotice);
    if (arr(m.thirdPartyResponsibilities).length) {
      mb += '<h4 class="agv-h4">第三方服務與責任歸屬</h4>' + m.thirdPartyResponsibilities.map(function (t) { return kv(t.label, t.responsibilityLabel); }).join('');
    }
    var cp = data.changePolicy || {};
    var phases = cp.phases || {};
    var anyRule = ['design', 'development', 'acceptance'].some(function (k) { var p = phases[k] || {}; return p.freeRevisionRounds != null || p.workloadCapHours != null || arr(p.coveredItems).length || trim(p.note); });
    mb += '<h4 class="agv-h4">各階段免費修改條件</h4>' + (anyRule ? ['design', 'development', 'acceptance'].map(function (k) {
      var p = phases[k] || {}; var name = { design: '設計階段', development: '開發階段', acceptance: '驗收階段' }[k];
      return kv(name, (p.freeRevisionRounds != null ? p.freeRevisionRounds + ' 輪' : '') + (p.workloadCapHours != null ? '・上限 ' + p.workloadCapHours + ' 小時' : '') + (trim(p.note) ? '・' + p.note : ''));
    }).join('') : emptyMark('尚未約定（v2.1 僅預留資料結構）'));
    html += sec(6, '維護與額外修改費用', mb);

    // 7 尚缺少的必要資訊
    var missing = missingInfo(agr, data, { staleSources: opts.staleSources, reviewDraftOpen: opts.reviewDraftOpen });
    html += sec(7, '尚缺少的必要資訊',
      missing.length ? '<ul class="agv-missing">' + missing.map(function (x) {
        return '<li class="agv-lv-' + x.level + '"><span class="agv-tag">' + (x.level === 'required' ? '必要' : '需確認') + '</span>' + esc(x.text) + '</li>';
      }).join('') + '</ul>' : '<div class="agv-muted">沒有缺少的資訊。</div>');
    return html;
  }

  function sourceSummary(s) {
    s = s || {};
    var parts = [];
    var r = s.requirementSnapshot || {};
    parts.push(r.present ? '原始需求（需求書 ' + esc(r.definitionVersion || '—') + '）' : '無需求書');
    var c = s.confirmedRequirements || {};
    parts.push(c.present ? '確認需求第 ' + esc(c.revision) + ' 版' : '需求未確認');
    var q = s.quotation || {};
    parts.push(q.present ? '正式報價 ' + esc(money(q.total)) + (q.publicQuotationVersion ? '（v' + esc(q.publicQuotationVersion) + '）' : '') + (q.source === 'acceptance' ? '・接受快照' : '') : '無正式報價');
    var cr = s.changeRequests || {};
    parts.push('已核准變更 ' + num(cr.approvedCount) + ' 筆');
    return parts.join('／');
  }

  // ── 寫入前的整理：重新檢查狀態、移除 undefined ──
  // stripUndefined 會建立新的物件／陣列（Timestamp 物件原樣保留），不會改動傳入的資料
  function toFirestore(data) {
    var d = stripUndefined(data) || {};
    sanitizeItems(d.items);
    return d;
  }

  root.NicocoAgreement = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    STATUS: STATUS,
    STATUS_ORDER: STATUS_ORDER,
    OBLIGATION_STATUSES: OBLIGATION_STATUSES,
    REVIEW_DECISION_TEXT: REVIEW_DECISION_TEXT,
    MAPPING_TEXT: MAPPING_TEXT,
    FEE_CATEGORIES: FEE_CATEGORIES,
    FEE_CATEGORY_ORDER: FEE_CATEGORY_ORDER,
    EDITABLE_FIELDS: EDITABLE_FIELDS,
    MANUAL_SPLIT_TEXT: MANUAL_SPLIT_TEXT,
    MANUAL_CHECK_TEXT: MANUAL_CHECK_TEXT,
    SOURCE_LABELS: SOURCE_LABELS,
    fingerprint: fingerprint,
    flattenOriginal: flattenOriginal,
    quotationSource: quotationSource,
    sourceState: sourceState,
    compareSources: compareSources,
    buildItems: buildItems,
    allowedStatuses: allowedStatuses,
    sanitizeItems: sanitizeItems,
    isObligation: isObligation,
    computeDiff: computeDiff,
    buildFees: buildFees,
    reservedChangePolicy: reservedChangePolicy,
    reservedTermsVersion: reservedTermsVersion,
    capture: capture,
    mergeEdits: mergeEdits,
    missingInfo: missingInfo,
    renderPreview: renderPreview,
    sourceSummary: sourceSummary,
    toFirestore: toFirestore,
    esc: esc,
  };
})(typeof window !== 'undefined' ? window : globalThis);
