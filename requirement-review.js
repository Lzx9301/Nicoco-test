// ══════════════════════════════════════════════════════════════════════
//  Nicoco — Requirement Review v1（純邏輯，不含 UI、不讀寫 Firestore）
//
//  三層資料（都在 quotes/{quoteId} 上）：
//    requirementSnapshot       客戶原始提交，永久唯讀（本檔只讀取，絕不修改）
//    requirementReviewDraft    Admin 工作稿
//    confirmedRequirements     Admin 確認後的正式需求（目前有效版本）
//    previousConfirmedRequirements  上一個確認版本（只保留一份）
//
//  這裡不是第二套 Requirement Engine，也不是第二套 Pricing Engine：
//    - 需求內容只來自 Snapshot 已保存的資料（各版本欄位不同，缺的欄位一律容錯）
//    - 估價區間只讀取 pricing-data.js 的 FEATURES（NicocoPricing），並在建立審核項目時存下當時的數字
//
//  載入頁面：quote-detail.html（審核 UI）、quote-edit.html（正式報價初始化）
// ══════════════════════════════════════════════════════════════════════
(function (root) {
  'use strict';

  var SCHEMA_VERSION = 1;
  var DECISIONS = ['included', 'excluded', 'pending'];
  var REOPEN_REASONS = ['客戶補充需求', '客戶要求修改', '報價前內部調整', '發現需求理解錯誤', '其他'];
  // 代表「客戶自己也不確定」的選項值：不能當成明確需求，初始一律待確認
  var UNSURE_VALUES = ['unsure', 'undecided'];

  function clean(label) { return String(label || '').replace(/（可複選）/g, ''); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // 讀取既有價格資料（FEATURES）取得估價區間；找不到就回傳 null，不猜價格
  function featureEstimate(pricing, group, id) {
    if (!pricing) return null;
    var item = pricing.find(group, id);
    if (!item) return null;
    if (item.evaluate) return { name: item.name, evaluate: true };
    if (item.free || !item.price) return { name: item.name, free: true };
    return { name: item.name, min: item.price, max: pricing.itemHigh(item) };
  }

  // ══════════════════════════════════════════════════════════════════
  //  Snapshot → Review Items
  //
  //  審核項目的單位是「一個可以獨立決定要不要做的需求」：
  //    1. 每個帶入既有計價項目的需求 → 一項（同一個 pricing key 不論幾個來源都合併成一項）
  //    2. 每個需人工評估的需求 → 一項
  //    3. 每段客戶自由文字 → 一項（一個來源對一項；需要拆開時由 Admin 另外新增自訂需求）
  //    4. 其餘已回答的一般需求 → 一項（子問題的回答併入客戶原始內容）
  //    5. 每個區塊的「方案基本包含」→ 一項
  //  quote：整份 Quote 文件（只讀 requirementSnapshot、selectedItems、evaluationItems、pricingBreakdown、warrantyFee）
  // ══════════════════════════════════════════════════════════════════
  function buildReviewItems(quote, pricing) {
    var snap = (quote && quote.requirementSnapshot) || {};
    var items = [];
    var byKey = {};
    var derivedList = Array.isArray(snap.derivedPricingKeys) ? snap.derivedPricingKeys : [];

    function push(item) {
      if (byKey[item.key]) return byKey[item.key];
      byKey[item.key] = item;
      items.push(item);
      return item;
    }
    function base(key, label, groupLabel) {
      return {
        key: key, sourceType: 'snapshot', sourceRefs: [], groupLabel: groupLabel || '',
        label: label, sourceText: '',
        category: 'basic', decision: 'included',
        pricingMode: 'base', pricingKey: null, featureName: '',
        estimatedMin: null, estimatedMax: null, includedInPlan: false,
        requiresManualPricing: false, requiresManualReview: false, unresolvedReason: '',
        thirdParty: [], dependencies: [],
        finalDescription: label, scopeNote: '', adminNote: '',
      };
    }
    function addRef(item, key, label) {
      if (!item.sourceRefs.some(function (r) { return r.key === key; })) item.sourceRefs.push({ key: key, label: label });
    }
    function addText(item, text) {
      if (!text) return;
      if (item.sourceText.split('\n').indexOf(text) !== -1) return;
      item.sourceText = item.sourceText ? item.sourceText + '\n' + text : text;
    }
    function addThirdParty(item, responsibility) {
      (responsibility || []).forEach(function (r) {
        if (!r || !r.service) return;
        if (item.thirdParty.some(function (t) { return t.service === r.service; })) return;
        item.thirdParty.push({ service: r.service, label: r.serviceLabel || r.service, responsibilityType: r.type || '' });
      });
    }
    function addDependency(item, dependency) {
      ((dependency && dependency.requires) || []).forEach(function (r) {
        var ref = r.type === 'feature' && r.group && r.id ? 'feature:' + r.group + '/' + r.id : (r.key || '');
        if (!ref) return;
        if (item.dependencies.some(function (d) { return d.ref === ref; })) return;
        item.dependencies.push({ ref: ref, label: r.label || ref });
      });
    }

    // 帶入既有計價項目的需求：同一個 pricing key 合併成一項
    function featureItem(group, id, sourceKey, sourceLabel, groupLabel, sourceText, responsibility, dependency) {
      var key = 'feature:' + group + '/' + id;
      var d = derivedList.filter(function (x) { return x.group === group && x.id === id; })[0] || {};
      var est = featureEstimate(pricing, group, id);
      var name = (est && est.name) || d.featureName || id;
      var item = byKey[key];
      if (!item) {
        item = base(key, d.publicName || name || sourceLabel, groupLabel);
        item.pricingKey = group + '/' + id;
        item.featureName = name;
        if (d.includedInPlan || (est && est.free)) {
          // 方案內含或固定包含：屬於基本包含
          item.pricingMode = 'base'; item.includedInPlan = true; item.category = 'basic';
        } else if ((est && est.evaluate) || d.evaluate) {
          // 既有的「需評估」項目：客戶明確選了 → 預設納入，但價格待人工評估
          item.pricingMode = 'evaluate'; item.category = 'attention';
          item.requiresManualPricing = true; item.requiresManualReview = true;
          item.unresolvedReason = '此項目沒有固定價格，需人工評估後定價';
        } else if (est && est.min != null) {
          item.pricingMode = 'feature'; item.category = 'priced';
          item.estimatedMin = est.min; item.estimatedMax = est.max;
        } else {
          // 現行價格資料找不到這個項目：不猜價格
          item.pricingMode = 'manual'; item.category = 'attention'; item.decision = 'pending';
          item.requiresManualPricing = true; item.requiresManualReview = true;
          item.unresolvedReason = '目前的價格資料找不到這個項目，需人工確認';
        }
        item.finalDescription = item.label;
        push(item);
      }
      addRef(item, sourceKey, sourceLabel);
      addText(item, sourceText);
      addThirdParty(item, responsibility);
      addDependency(item, dependency);
      return item;
    }

    var evalList = Array.isArray(snap.evaluateRequirements) ? snap.evaluateRequirements : [];
    function evaluateItem(key, label, groupLabel, reason, sourceText, explicit, responsibility, dependency) {
      var rec = evalList.filter(function (e) { return e.key === key; })[0];
      if (rec) { label = rec.label || label; reason = rec.reason || reason; }
      var item = base(key, label, groupLabel);
      item.category = 'attention';
      item.pricingMode = 'evaluate';
      item.requiresManualPricing = true;
      item.requiresManualReview = true;
      item.unresolvedReason = reason || '需人工評估';
      // 客戶明確選了 → 預設納入（價格待評估）；自由文字／不確定 → 待確認
      item.decision = explicit ? 'included' : 'pending';
      item.finalDescription = explicit ? label : '';
      addRef(item, key, label);
      addText(item, sourceText);
      addThirdParty(item, responsibility);
      addDependency(item, dependency);
      return push(item);
    }

    function pricingList(p) {
      if (!p) return [];
      if (p.mode === 'features') return (p.features || []).map(function (f) { return { mode: 'feature', group: f.group, id: f.id }; });
      return [p];
    }

    // 把一個節點底下「不帶計價」的回答整理成一行文字（併入父項目的客戶原始內容）
    function describeChildren(children, groupLabel, parentItem) {
      var lines = [];
      (children || []).forEach(function (c) {
        var r = handleNode(c, groupLabel, parentItem);
        if (r) lines.push(r);
      });
      return lines;
    }

    // 處理一個節點。回傳這個節點要併入父項目的文字（已經自己成為獨立項目時回傳 ''）。
    // parentItem：最近的一般需求項目，用來承接子問題的回答、第三方責任與自由文字提示。
    function handleNode(node, groupLabel, parentItem) {
      if (!node || !node.type) return '';
      var label = clean(node.label);

      if (node.type === 'check') {
        if (!node.selected) return '';
        var modes = pricingList(node.pricing);
        var primary = modes[0] || null;
        if (primary && primary.mode === 'feature') {
          var texts = [];
          var fi = null;
          modes.forEach(function (m) {
            fi = featureItem(m.group, m.id, node.key, label, groupLabel, '', node.responsibility, node.dependency);
          });
          describeChildren(node.children, groupLabel, fi).forEach(function (t) { texts.push(t); });
          modes.forEach(function (m) { addText(byKey['feature:' + m.group + '/' + m.id], [label].concat(texts).join('；')); });
          return '';
        }
        if (primary && primary.mode === 'evaluate') {
          var ev = evaluateItem(node.key, label, groupLabel, primary.reason, '', true, node.responsibility, node.dependency);
          addText(ev, [label].concat(describeChildren(node.children, groupLabel, ev)).join('；'));
          return '';
        }
        // base / none：一般需求
        if (parentItem) {
          var sub = describeChildren(node.children, groupLabel, parentItem);
          addThirdParty(parentItem, node.responsibility);
          return [label].concat(sub).join('；');
        }
        var it = base(node.key, label, groupLabel);
        it.pricingMode = primary ? primary.mode : 'none';
        addRef(it, node.key, label);
        addThirdParty(it, node.responsibility);
        addDependency(it, node.dependency);
        push(it);
        addText(it, [label].concat(describeChildren(node.children, groupLabel, it)).join('；'));
        return '';
      }

      if (node.type === 'single' || node.type === 'multi') {
        var chosen = (node.options || []).filter(function (o) { return o.selected; });
        if (!chosen.length) return '';
        var plain = [];       // 不帶計價的選項 → 併入一般需求
        var holder = parentItem;
        var own = null;
        var optionItem = null;   // 由選項產生的獨立項目（計價或需評估）；子問題的回答掛在它底下
        function ensureOwn() {
          if (holder) return holder;
          if (!own) {
            own = base(node.key, label, groupLabel);
            own.pricingMode = 'none';
            addRef(own, node.key, label);
            addDependency(own, node.dependency);
            push(own);
          }
          return own;
        }
        chosen.forEach(function (o) {
          var okey = node.key + ':' + o.value;
          var olabel = label + '：' + o.label;
          var otext = o.label + (o.otherText ? '（' + o.otherText + '）' : '');
          var oModes = pricingList(o.pricing);
          var p0 = oModes[0] || null;
          var unsure = UNSURE_VALUES.indexOf(o.value) !== -1;

          if (p0 && p0.mode === 'feature') {
            oModes.forEach(function (m) {
              var f = featureItem(m.group, m.id, okey, olabel, groupLabel, label + '：' + otext, o.responsibility, o.dependency);
              if (!optionItem) optionItem = f;
            });
            return;
          }
          if (p0 && p0.mode === 'evaluate') {
            var e0 = evaluateItem(okey, olabel, groupLabel, p0.reason, label + '：' + otext, !unsure && !o.otherText, o.responsibility, o.dependency);
            if (!optionItem) optionItem = e0;
            return;
          }
          var target = ensureOwn();
          plain.push(otext);
          addThirdParty(target, o.responsibility);
          if (p0 && p0.mode === 'base' && target === own) target.pricingMode = 'base';
          // 「其他」的自由文字：系統無法判斷內容 → 這個項目需要人工確認
          if (o.otherText && target === own) {
            target.category = 'attention'; target.decision = 'pending';
            target.requiresManualReview = true;
            target.unresolvedReason = '客戶在「其他」填寫了自由文字，需人工確認內容';
            target.finalDescription = '';
          } else if (o.otherText && parentItem) {
            parentItem.requiresManualReview = true;
            if (!parentItem.unresolvedReason) parentItem.unresolvedReason = '客戶在「其他」填寫了自由文字，請確認是否影響範圍';
            if (parentItem.category === 'basic') { parentItem.category = 'attention'; parentItem.decision = 'pending'; parentItem.finalDescription = ''; }
          }
        });
        // 選項底下的子問題（Snapshot 把所有已選選項的 children 攤平成同一個陣列）
        var childParent = holder || own || optionItem;
        var childTexts = describeChildren(node.children, groupLabel, childParent);
        var line = plain.length ? label + '：' + plain.join('、') : '';
        var all = (line ? [line] : []).concat(childTexts);
        if (!all.length) return '';
        if (parentItem) return all.join('；');
        if (own) addText(own, all.join('；'));
        else if (optionItem && childTexts.length) addText(optionItem, childTexts.join('；'));
        return '';
      }

      if (node.type === 'text') {
        var txt = String(node.text || '').trim();
        if (!txt) return '';
        // 外部系統串接等：文字欄位是父項目的補充說明
        if (parentItem) return label + '：' + txt;
        var t = base(node.key, label, groupLabel);
        t.category = 'attention'; t.decision = 'pending';
        t.pricingMode = 'evaluate';
        t.requiresManualPricing = true; t.requiresManualReview = true;
        t.unresolvedReason = '客戶自由描述的需求，需人工確認與評估';
        t.finalDescription = '';
        t.sourceText = txt;
        addRef(t, node.key, label);
        push(t);
        return '';
      }
      return '';
    }

    // ① 六大區塊：基本包含 + 各題回答
    (Array.isArray(snap.categories) ? snap.categories : []).forEach(function (cat) {
      var b = base('base:' + cat.key, cat.label + '（方案基本包含）', cat.label);
      b.sourceText = (cat.baseIncludes || []).join('、');
      b.finalDescription = cat.label + '：' + b.sourceText;
      addRef(b, 'base:' + cat.key, cat.label);
      push(b);
      (cat.items || []).forEach(function (n) { handleNode(n, cat.label, null); });
    });

    // ② Step 3 的需求題（v1.1 起）
    var extra = snap.additionalRequirements;
    if (extra && Array.isArray(extra.items)) {
      extra.items.forEach(function (n) { handleNode(n, extra.label || '其他需求與附加服務', null); });
    }

    // ③ Step 3 客戶自行加選的既有項目（v1.1 起）
    (Array.isArray(snap.additionalServices) ? snap.additionalServices : []).forEach(function (a) {
      var it = featureItem(a.group, a.id, 'service:' + a.group + '/' + a.id, a.publicName || a.name, '其他需求與附加服務', a.publicName || a.name, null, null);
      if (a.publicName) it.label = a.publicName;
      if (!it.featureName) it.featureName = a.name;
      if (!it.finalDescription || it.finalDescription === a.name) it.finalDescription = it.label;
    });

    // ④ 安全網：Quote 上的 selectedItems／evaluationItems（中文原名）若有任何一項還沒被表示，補成審核項目。
    //    舊版 Snapshot（v1.0）沒有 additionalServices，Step 2/3 手動勾選的項目只會出現在這兩個欄位。
    var represented = {};
    items.forEach(function (i) { if (i.featureName) represented[i.featureName] = true; });
    (Array.isArray(quote && quote.selectedItems) ? quote.selectedItems : []).forEach(function (name) {
      if (represented[name]) return;
      var hit = pricing && pricing.findByName(name);
      if (hit) {
        var it = featureItem(hit.group, hit.item.id, 'quote:selectedItems:' + name, name, '加選項目', name, null, null);
        it.sourceType = 'quote_field';
      } else {
        var u = base('quote:selectedItems:' + name, name, '加選項目');
        u.sourceType = 'quote_field'; u.category = 'attention'; u.decision = 'pending';
        u.pricingMode = 'manual'; u.requiresManualPricing = true; u.requiresManualReview = true;
        u.unresolvedReason = '舊資料只有名稱，目前的價格資料找不到對應項目，需人工確認';
        u.sourceText = name; u.featureName = name; u.finalDescription = '';
        addRef(u, u.key, name); push(u);
      }
      represented[name] = true;
    });
    (Array.isArray(quote && quote.evaluationItems) ? quote.evaluationItems : []).forEach(function (name) {
      if (represented[name]) return;
      var hit = pricing && pricing.findByName(name);
      var e = evaluateItem(hit ? 'feature:' + hit.group + '/' + hit.item.id : 'quote:evaluationItems:' + name,
                           name, '需評估項目', '此項目沒有固定價格，需人工評估後定價', name, true, null, null);
      e.sourceType = 'quote_field'; e.featureName = name;
      if (hit) e.pricingKey = hit.group + '/' + hit.item.id;
      represented[name] = true;
    });

    return items;
  }

  // ── 摘要：數量與估價（估價只加總審核項目上已存下的區間，不重新計價）──
  // baseRange：{ min, max }（基礎方案），warrantyFee：保固延長金額
  function summarize(items, baseRange, warrantyFee) {
    var s = {
      basicCount: 0, pricedCount: 0, manualPricingCount: 0, pendingCount: 0, excludedCount: 0,
      includedCount: 0, thirdPartyCount: 0,
      baseMin: Number(baseRange && baseRange.min) || 0, baseMax: Number(baseRange && baseRange.max) || 0,
      addonMin: 0, addonMax: 0, warrantyFee: Number(warrantyFee) || 0,
      totalMin: 0, totalMax: 0,
    };
    var services = {};
    (items || []).forEach(function (i) {
      if (i.decision === 'pending') { s.pendingCount++; return; }
      if (i.decision === 'excluded') { s.excludedCount++; return; }
      s.includedCount++;
      if (i.requiresManualPricing) s.manualPricingCount++;
      else if (i.pricingMode === 'feature') {
        s.pricedCount++;
        s.addonMin += Number(i.estimatedMin) || 0;
        s.addonMax += Number(i.estimatedMax) || 0;
      } else s.basicCount++;
      (i.thirdParty || []).forEach(function (t) { services[t.service] = true; });
    });
    s.thirdPartyCount = Object.keys(services).length;
    s.totalMin = s.baseMin + s.addonMin + s.warrantyFee;
    s.totalMax = s.baseMax + s.addonMax + s.warrantyFee;
    return s;
  }

  // 基礎方案估價：優先用送出當時存下的 pricingBreakdown；沒有才讀現行 TYPE_CONFIG
  function baseRangeOf(quote, pricing) {
    var pb = (quote && quote.pricingBreakdown) || {};
    if (pb.baseMin != null && pb.baseMax != null) return { min: Number(pb.baseMin), max: Number(pb.baseMax) };
    var cfg = pricing && pricing.TYPE_CONFIG && pricing.TYPE_CONFIG[pb.type || 'ecom'];
    return cfg && cfg.priceMin ? { min: cfg.priceMin, max: cfg.priceMax } : { min: 0, max: 0 };
  }

  // ── 建立工作稿（從 Snapshot，或從已確認版本重新開啟）──
  function createDraftFromSnapshot(quote, pricing) {
    var snap = quote.requirementSnapshot || {};
    var items = buildReviewItems(quote, pricing);
    return {
      schemaVersion: SCHEMA_VERSION,
      sourceSnapshotDefinitionVersion: snap.definitionVersion || '',
      status: 'draft',
      revision: 1,
      baseRange: baseRangeOf(quote, pricing),
      warrantyFee: Number(quote.warrantyFee) || 0,
      items: items,
      summary: summarize(items, baseRangeOf(quote, pricing), quote.warrantyFee),
    };
  }
  function createDraftFromConfirmed(confirmed, reason, reasonNote) {
    return {
      schemaVersion: SCHEMA_VERSION,
      sourceSnapshotDefinitionVersion: confirmed.sourceSnapshotDefinitionVersion || '',
      status: 'draft',
      revision: (Number(confirmed.revision) || 0) + 1,
      reopenedFromRevision: Number(confirmed.revision) || 0,
      reopenReason: reason || '',
      reopenNote: reasonNote || '',
      baseRange: clone(confirmed.baseRange || { min: 0, max: 0 }),
      warrantyFee: Number(confirmed.warrantyFee) || 0,
      items: clone(confirmed.items || []),
      summary: clone(confirmed.summary || {}),
    };
  }

  function newCustomItem() {
    return {
      key: 'custom:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      sourceType: 'admin_custom', sourceRefs: [], groupLabel: '自訂需求',
      label: '', sourceText: '',
      category: 'attention', decision: 'included',
      pricingMode: 'manual', pricingKey: null, featureName: '',
      estimatedMin: null, estimatedMax: null, includedInPlan: false,
      requiresManualPricing: true, requiresManualReview: false, unresolvedReason: '',
      thirdParty: [], dependencies: [],
      finalDescription: '', scopeNote: '', adminNote: '',
    };
  }

  // 自訂需求的計價方式：base（含於基礎建置）｜manual（人工定價）｜evaluate（待評估）｜feature（參考既有項目）
  function setCustomPricing(item, mode, pricingKey, pricing) {
    item.pricingMode = mode;
    item.pricingKey = null; item.featureName = '';
    item.estimatedMin = null; item.estimatedMax = null;
    item.requiresManualPricing = mode === 'manual' || mode === 'evaluate';
    if (mode === 'feature' && pricingKey) {
      var parts = pricingKey.split('/');
      var est = featureEstimate(pricing, parts[0], parts[1]);
      if (est && est.min != null) {
        item.pricingKey = pricingKey; item.featureName = est.name;
        item.estimatedMin = est.min; item.estimatedMax = est.max;
      } else {
        // 不存在或沒有固定價格的項目：不硬塞，退回人工定價
        item.pricingMode = 'manual'; item.requiresManualPricing = true;
      }
    }
    item.category = item.requiresManualPricing ? 'attention' : (item.pricingMode === 'feature' ? 'priced' : 'basic');
  }

  // ── 確認前驗證：回傳具體問題清單（空陣列＝可以確認）──
  function validate(items) {
    var problems = [];
    var pending = (items || []).filter(function (i) { return i.decision === 'pending'; });
    if (pending.length) {
      problems.push({ type: 'pending', count: pending.length, labels: pending.map(function (i) { return i.label || '（未命名）'; }),
        message: '尚有 ' + pending.length + ' 項待確認：' + pending.map(function (i) { return i.label || '（未命名）'; }).join('、') });
    }
    var noDesc = (items || []).filter(function (i) { return i.decision === 'included' && !String(i.finalDescription || '').trim(); });
    if (noDesc.length) {
      problems.push({ type: 'description', count: noDesc.length, labels: noDesc.map(function (i) { return i.label || '（未命名）'; }),
        message: noDesc.length + ' 項已納入的需求缺少正式需求描述：' + noDesc.map(function (i) { return i.label || '（未命名）'; }).join('、') });
    }
    var noLabel = (items || []).filter(function (i) { return i.sourceType === 'admin_custom' && !String(i.label || '').trim(); });
    if (noLabel.length) problems.push({ type: 'label', count: noLabel.length, labels: [], message: noLabel.length + ' 項自訂需求沒有名稱' });
    // dependency：已納入的項目所依賴的項目被排除
    var broken = [];
    (items || []).forEach(function (i) {
      if (i.decision !== 'included') return;
      (i.dependencies || []).forEach(function (d) {
        var target = (items || []).filter(function (x) {
          return x.key === d.ref || (x.sourceRefs || []).some(function (r) { return r.key === d.ref; });
        })[0];
        if (target && target.decision === 'excluded') broken.push((i.label || '') + ' 需要 ' + (target.label || d.label));
      });
    });
    if (broken.length) problems.push({ type: 'dependency', count: broken.length, labels: broken, message: broken.length + ' 項相依需求尚未解決：' + broken.join('；') });
    return problems;
  }

  // ── 產生 confirmedRequirements（只保留正式內容，不保存 UI 暫時狀態）──
  function buildConfirmed(draft, confirmedBy, timestamp) {
    var items = (draft.items || []).map(function (i) {
      return {
        key: i.key, sourceType: i.sourceType, sourceRefs: clone(i.sourceRefs || []), groupLabel: i.groupLabel || '',
        label: i.label, sourceText: i.sourceText || '',
        category: i.category, decision: i.decision,
        pricingMode: i.pricingMode, pricingKey: i.pricingKey || null, featureName: i.featureName || '',
        estimatedMin: i.estimatedMin == null ? null : Number(i.estimatedMin),
        estimatedMax: i.estimatedMax == null ? null : Number(i.estimatedMax),
        includedInPlan: !!i.includedInPlan, requiresManualPricing: !!i.requiresManualPricing,
        thirdParty: clone(i.thirdParty || []), dependencies: clone(i.dependencies || []),
        finalDescription: String(i.finalDescription || '').trim(), scopeNote: i.scopeNote || '', adminNote: i.adminNote || '',
      };
    });
    return {
      schemaVersion: SCHEMA_VERSION,
      sourceSnapshotDefinitionVersion: draft.sourceSnapshotDefinitionVersion || '',
      status: 'confirmed',
      revision: Number(draft.revision) || 1,
      confirmedAt: timestamp,
      confirmedBy: confirmedBy || '',
      baseRange: clone(draft.baseRange || { min: 0, max: 0 }),
      warrantyFee: Number(draft.warrantyFee) || 0,
      items: items,
      summary: summarize(items, draft.baseRange, draft.warrantyFee),
    };
  }

  // ── 正式報價初始化：confirmedRequirements → quotationItems ──
  // 只是「初始化參考」：有估價區間的項目帶入區間中位數，Admin 可以自由修改；
  // 沒有固定價格的項目 unitPrice = null、pricingPending = true，不會用 0 假裝已定價。
  function quotationItemsFromConfirmed(confirmed, opts) {
    opts = opts || {};
    var seq = 0;
    function id() { return 'qi_' + Date.now() + '_' + (seq++) + '_' + Math.random().toString(36).slice(2, 7); }
    var out = [];
    var b = confirmed.baseRange || {};
    var baseMid = Math.round(((Number(b.min) || 0) + (Number(b.max) || 0)) / 2);
    var basics = (confirmed.items || []).filter(function (i) {
      return i.decision === 'included' && !i.requiresManualPricing && i.pricingMode !== 'feature' && i.key.indexOf('base:') === 0;
    });
    out.push({
      id: id(), name: '網站基礎建置',
      description: (opts.projectName ? opts.projectName + '　' : '') + '含 RWD・基礎 SEO・SSL・部署・DNS' +
                   (basics.length ? '；' + basics.map(function (i) { return i.groupLabel; }).join('、') : ''),
      qty: 1, unitPrice: baseMid, subtotal: baseMid, reqKey: 'base',
    });
    (confirmed.items || []).forEach(function (i) {
      if (i.decision !== 'included') return;
      var desc = [i.finalDescription, i.scopeNote].filter(function (x) { return x && x !== i.label; }).join('｜');
      if (i.requiresManualPricing) {
        out.push({ id: id(), name: i.label, description: desc, qty: 1, unitPrice: null, subtotal: 0, pricingPending: true, reqKey: i.key });
      } else if (i.pricingMode === 'feature') {
        var mid = Math.round(((Number(i.estimatedMin) || 0) + (Number(i.estimatedMax) || 0)) / 2);
        out.push({ id: id(), name: i.label, description: desc, qty: 1, unitPrice: mid, subtotal: mid, reqKey: i.key });
      }
      // 基本包含／只記錄的需求：已含在「網站基礎建置」，不另列明細
    });
    if (Number(confirmed.warrantyFee) > 0) {
      var w = Number(confirmed.warrantyFee);
      out.push({ id: id(), name: '保固延長', description: opts.warrantyLabel || '', qty: 1, unitPrice: w, subtotal: w, reqKey: 'warranty' });
    }
    return out;
  }

  function countPendingPricing(quotationItems) {
    return (quotationItems || []).filter(function (i) { return i && i.pricingPending; }).length;
  }

  root.NicocoReview = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    DECISIONS: DECISIONS,
    REOPEN_REASONS: REOPEN_REASONS,
    buildReviewItems: buildReviewItems,
    summarize: summarize,
    baseRangeOf: baseRangeOf,
    createDraftFromSnapshot: createDraftFromSnapshot,
    createDraftFromConfirmed: createDraftFromConfirmed,
    newCustomItem: newCustomItem,
    setCustomPricing: setCustomPricing,
    validate: validate,
    buildConfirmed: buildConfirmed,
    quotationItemsFromConfirmed: quotationItemsFromConfirmed,
    countPendingPricing: countPendingPricing,
  };
})(typeof window !== 'undefined' ? window : globalThis);
