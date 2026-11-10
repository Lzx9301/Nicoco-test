// ══════════════════════════════════════════════════════════════════════
//  Nicoco — 正式報價共用工具（Security v1）
//  載入頁面：quote-edit / quote-detail / quote-admin / dashboard（皆為 Admin 頁面）
//
//  資料架構：
//    quotes/{quoteId}                      內部案件（只有 Admin 可讀寫）
//    publicQuotations/{clientToken}        客戶公開投影（文件 ID ＝ 128-bit token）
//    quotes/{quoteId}/acceptances/{token}  客戶接受當下的不可變快照
//
//  客戶不再寫入 quotes。客戶的接受／拒絕只會落在 publicQuotations（與 acceptances），
//  內部案件的 quotationStatus／status 由 Admin 頁面載入時呼叫 reconcile() 對帳後寫回。
// ══════════════════════════════════════════════════════════════════════
(function (root) {
  'use strict';

  // 128-bit、cryptographically secure 的 token（32 個 hex 字元）
  function generateClientToken() {
    var arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  // 這份案件是否已有 Security v1 的公開報價（舊版 token 曾可被任意讀取，一律視為失效）
  function hasSecureLink(q) {
    return !!(q && q.clientToken && q.publicQuotationVersion);
  }

  function publicUrl(token) {
    var base = root.location.href.replace(/\/[^/]*(\?.*)?(#.*)?$/, '/');
    return base + 'quotation.html?t=' + encodeURIComponent(token);
  }

  // 客戶看到的專案名稱：需求書（單一入口）案件顯示中性名稱；舊類型案件沿用原本的類型名稱
  function projectDisplayName(q) {
    if (q && q.requirementSnapshot) return '網站建置專案';
    return (q && q.projectType) || '網站建置專案';
  }

  // 工作室資料的公開投影：只取報價頁實際顯示的欄位
  function studioProjection(studio) {
    studio = studio || {};
    var out = {};
    ['studioName', 'logoText', 'quotationFooter', 'contactEmail', 'phone', 'lineId', 'websiteUrl', 'bankInfo']
      .forEach(function (k) { out[k] = studio[k] || ''; });
    return out;
  }

  // 公開投影：只包含 quotation.html 實際需要的資料
  // quotation = quote-edit 儲存時算好的正式報價欄位；timestamp＝FieldValue.serverTimestamp()
  function buildPublicProjection(quoteId, q, quotation, studio, version, timestamp) {
    return {
      quoteId: quoteId,
      clientName: (q && q.name) || '',
      clientCompany: (q && q.company) || '',
      projectDisplayName: projectDisplayName(q),
      quotationItems: quotation.quotationItems,
      quotationSubtotal: quotation.quotationSubtotal,
      quotationDiscount: quotation.quotationDiscount,
      quotationTax: quotation.quotationTax,
      quotationTotal: quotation.quotationTotal,
      quotationStatus: quotation.quotationStatus,
      paymentTerms: quotation.paymentTerms,
      validUntil: quotation.validUntil || null,
      quotationNote: quotation.quotationNote || '',
      version: version,
      issuedAt: timestamp,
      studio: studioProjection(studio),
    };
  }

  // acceptance 快照：內容必須與公開投影完全一致（Rules 會逐欄比對）
  function buildAcceptance(token, pub, source, timestamp) {
    return {
      quoteId: pub.quoteId,
      clientToken: token,
      publicQuotationVersion: pub.version,
      source: source,                       // 'client' | 'admin'
      quotationItems: pub.quotationItems,
      quotationSubtotal: pub.quotationSubtotal,
      quotationDiscount: pub.quotationDiscount,
      quotationTax: pub.quotationTax,
      quotationTotal: pub.quotationTotal,
      paymentTerms: pub.paymentTerms,
      validUntil: pub.validUntil || null,
      quotationNote: pub.quotationNote || '',
      projectDisplayName: pub.projectDisplayName,
      clientName: pub.clientName,
      clientCompany: pub.clientCompany,
      acceptedAt: timestamp,
    };
  }

  // ── 對帳：把客戶在公開報價上的回覆同步回內部案件（Admin 身分執行）──
  // 只處理「內部尚未是 accepted／rejected，但公開報價已由客戶回覆」的情況。
  // 可重複執行：活動紀錄用固定 ID 與固定時間（respondedAt），arrayUnion 不會重複加入。
  // 成功時會直接更新傳入的 q 物件並回傳 true；沒有需要同步或失敗時回傳 false（不拋出，不影響頁面載入）。
  async function reconcile(db, quoteId, q) {
    try {
      if (!hasSecureLink(q)) return false;
      if (q.quotationStatus === 'accepted' || q.quotationStatus === 'rejected') return false;

      var snap = await db.collection('publicQuotations').doc(q.clientToken).get();
      if (!snap.exists) return false;
      var pub = snap.data();
      var st = pub.quotationStatus;
      if ((st !== 'accepted' && st !== 'rejected') || !pub.respondedAt) return false;

      var accepted = st === 'accepted';
      var total = Number(pub.quotationTotal || 0);
      var log = {
        id: 'act_response_' + q.clientToken.slice(0, 12),
        type: accepted ? 'payment' : 'note',
        content: accepted
          ? '客戶已接受報價，總金額 NT$' + total.toLocaleString() + '，案件狀態已自動改為開發中'
          : '客戶已拒絕報價，案件狀態已自動改為取消',
        createdAt: pub.respondedAt,
        createdBy: 'client',
      };
      var local = accepted
        ? { quotationStatus: 'accepted', quotationUpdatedAt: pub.respondedAt, status: 'developing', paymentStatus: 'unpaid', progress: 0 }
        : { quotationStatus: 'rejected', quotationUpdatedAt: pub.respondedAt, status: 'cancelled' };

      var patch = Object.assign({}, local, {
        activityLogs: root.firebase.firestore.FieldValue.arrayUnion(log),
      });
      await db.collection('quotes').doc(quoteId).update(patch);

      Object.assign(q, local);
      if (!Array.isArray(q.activityLogs)) q.activityLogs = [];
      if (!q.activityLogs.some(function (l) { return l && l.id === log.id; })) q.activityLogs.push(log);
      return true;
    } catch (err) {
      console.error('報價回覆對帳失敗（' + quoteId + '）：', err);
      return false;
    }
  }

  // 清單頁用：只對可能有新回覆的案件對帳
  async function reconcileAll(db, quotes) {
    var targets = (quotes || []).filter(function (q) {
      return hasSecureLink(q) && q.quotationStatus !== 'accepted' && q.quotationStatus !== 'rejected';
    });
    await Promise.all(targets.map(function (q) { return reconcile(db, q.id, q); }));
  }

  root.NicocoQuotation = {
    generateClientToken: generateClientToken,
    hasSecureLink: hasSecureLink,
    publicUrl: publicUrl,
    projectDisplayName: projectDisplayName,
    buildPublicProjection: buildPublicProjection,
    buildAcceptance: buildAcceptance,
    reconcile: reconcile,
    reconcileAll: reconcileAll,
  };
})(window);
