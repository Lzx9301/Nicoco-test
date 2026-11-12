// ══════════════════════════════════════════════════════════════════════
//  Nicoco — Agreement Generator v2.2：完整合約文件編輯器（後台介面）
//  載入於 quote-detail.html；使用該頁的全域變數與函式：
//    db, auth, firebase, currentId, agreements, renderAgreementUI(), agrScrollToSection(), escapeHtml(), showToast()
//  條款範本與代入邏輯在 agreement-document.js（NicocoAgreementDoc）。
//
//  寫入（只有這兩種，且都只寫 quotes/{quoteId}/agreements/{id} 與其 versions 子集合）：
//    儲存草稿 → agreements/{id}.contractDocument
//    建立版本 → 同一個 batch：agreements/{id}（contractDocument、currentVersionNumber+1、versionIndex+1 筆）
//                              ＋ agreements/{id}/versions/v{n}（不可變快照；Rules 禁止修改、刪除）
//  不寫入需求、報價、收款、需求變更或專案資料。
// ══════════════════════════════════════════════════════════════════════

// 編輯器狀態；null＝未開啟
//   { agreementId, doc, baseline, readOnly, view:'edit'|'preview'|'versions'|'version'|'diff',
//     viewingVersion, diffPair:{left,right}, note, busy }
let agrDoc = null;
const agrDocVersionCache = {};   // key: agreementId + '/' + n → 版本文件資料

function agrDocReady() { return !!(window.NicocoAgreementDoc && window.NicocoAgreement); }
function agrDocAgreement() { return agrDoc ? agreements.find(a => a.id === agrDoc.agreementId) : null; }
function agrDocJson(doc) { return doc ? JSON.stringify(NicocoAgreementDoc.normalizeDocument(doc)) : null; }
function agrDocIsDirty() {
  return !!(agrDoc && !agrDoc.readOnly && agrDoc.doc && agrDocJson(agrDoc.doc) !== agrDoc.baseline);
}
function agrDocState() {
  if (!agrDoc) return '';
  if (agrDoc.readOnly) return 'locked';
  if (agrDoc.baseline == null) return 'unsaved_new';
  return agrDocIsDirty() ? 'unsaved' : 'draft';
}
function agrDocFmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function agrDocTsMs(t) {
  if (!t) return null;
  if (typeof t.toMillis === 'function') return t.toMillis();
  if (typeof t.seconds === 'number') return t.seconds * 1000;
  return null;
}

// ── 開啟／關閉 ──
function agrDocOpen(agreementId) {
  if (!agrDocReady()) { showToast('⚠ 合約文件模組未載入'); return; }
  const a = agreements.find(x => x.id === agreementId);
  if (!a) return;
  const readOnly = a.status !== 'draft';
  const doc = a.contractDocument ? NicocoAgreementDoc.normalizeDocument(a.contractDocument) : null;
  agrDoc = {
    agreementId, doc, readOnly,
    baseline: a.contractDocument ? agrDocJson(a.contractDocument) : null,
    view: readOnly ? 'preview' : 'edit',
    viewingVersion: null, diffPair: null, note: '', busy: false,
  };
  agreementPreviewId = null;
  renderAgreementUI();
  agrScrollToSection();
}
function agrDocClose() {
  if (agrDocIsDirty() && !confirm(agrDoc.baseline == null
      ? '合約初稿尚未儲存，關閉後會遺失。\n確定要關閉嗎？'
      : '完整合約文件有尚未儲存的修改，關閉後這些修改會遺失。\n確定要關閉嗎？')) return;
  agrDoc = null;
  renderAgreementUI();
  agrScrollToSection();
}
function agrDocSetView(view) {
  if (!agrDoc) return;
  if (agrDoc.readOnly && view === 'edit') view = 'preview';
  agrDoc.view = view;
  renderAgreementUI();
  agrScrollToSection();
}

// ── 產生初稿 ──
function agrDocGenerate() {
  if (!agrDoc || agrDoc.readOnly || agrDoc.doc) return;
  agrDoc.doc = NicocoAgreementDoc.createDocument({ nowMs: Date.now() });
  agrDoc.view = 'edit';
  showToast('✓ 已產生合約初稿（尚未儲存）');
  renderAgreementUI();
  agrScrollToSection();
}

// ── 編輯 ──
function agrDocEditable() { return agrDoc && !agrDoc.readOnly && agrDoc.doc; }
function agrDocSetSection(key, text) {
  if (!agrDocEditable()) return;
  const s = agrDoc.doc.sections.find(x => x.key === key);
  if (s) s.text = String(text || '');
  renderAgreementUI();
}
function agrDocResetSection(key) {
  if (!agrDocEditable()) return;
  const t = NicocoAgreementDoc.sectionTemplate(key);
  const s = agrDoc.doc.sections.find(x => x.key === key);
  if (!t || !s) return;
  if (!confirm(`將「${s.title}」恢復為範本內容？此章節目前的文字會被取代（尚未儲存前仍可關閉放棄）。`)) return;
  s.text = t.text; s.title = t.title;
  renderAgreementUI();
}
function agrDocSetRule(group, field, value) {
  if (!agrDocEditable()) return;
  const r = agrDoc.doc.revisionRules;
  const n = Number(value);
  r[group][field] = Number.isFinite(n) && String(value).trim() !== '' ? Math.trunc(n) : null;
  renderAgreementUI();
}
function agrDocSetCarryOver(on) {
  if (!agrDocEditable()) return;
  agrDoc.doc.revisionRules.carryOver = !!on;
  renderAgreementUI();
}
function agrDocToggleType(key, on) {
  if (!agrDocEditable()) return;
  const types = agrDoc.doc.revisionRules.freeScope.types;
  const i = types.indexOf(key);
  if (on && i === -1) types.push(key);
  if (!on && i !== -1) types.splice(i, 1);
  renderAgreementUI();
}
function agrDocSetScope(field, value) {
  if (!agrDocEditable() || !['pages', 'level', 'workScope', 'notes'].includes(field)) return;
  agrDoc.doc.revisionRules.freeScope[field] = String(value || '');
  renderAgreementUI();
}
function agrDocSetExtraFee(value) {
  if (!agrDocEditable()) return;
  agrDoc.doc.revisionRules.extraChangeFeeText = String(value || '');
  renderAgreementUI();
}
function agrDocSetSupplementary(value) {
  if (!agrDocEditable()) return;
  agrDoc.doc.supplementary = String(value || '');
  renderAgreementUI();
}
function agrDocSetAnnexNote(key, value) {
  if (!agrDocEditable()) return;
  agrDoc.doc.annexNotes[key] = String(value || '');
  renderAgreementUI();
}
function agrDocSetConfirmed(on) {
  if (!agrDocEditable()) return;
  agrDoc.doc.termsConfirmed = !!on;
  renderAgreementUI();
}
function agrDocSetNote(value) { if (agrDoc) agrDoc.note = String(value || ''); }   // 版本說明：不重繪、不算文件修改

// ── 儲存草稿 ──
async function agrDocSave() {
  const a = agrDocAgreement();
  if (!agrDocEditable() || !a || agrDoc.busy) return;
  if (a.status !== 'draft') { showToast('⚠ 此合約已非草稿，無法修改'); return; }
  const errs = NicocoAgreementDoc.validateRevisionRules(agrDoc.doc.revisionRules);
  if (errs.length) { showToast('⚠ ' + errs[0]); return; }
  agrDoc.busy = true;
  try {
    const doc = NicocoAgreementDoc.normalizeDocument(agrDoc.doc);
    await db.collection('quotes').doc(currentId).collection('agreements').doc(a.id).update({
      contractDocument: doc,
      documentSchemaVersion: NicocoAgreementDoc.SCHEMA_VERSION,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    a.contractDocument = JSON.parse(JSON.stringify(doc));
    a.documentSchemaVersion = NicocoAgreementDoc.SCHEMA_VERSION;
    agrDoc.baseline = agrDocJson(doc);
    showToast('✓ 已儲存合約文件草稿');
  } catch (err) {
    console.error(err);
    showToast(`⚠ 儲存失敗：${err.message || err}`);
  } finally {
    agrDoc && (agrDoc.busy = false);
    renderAgreementUI();
  }
}

// ── 建立版本（不可變快照）──
async function agrDocCreateVersion() {
  const a = agrDocAgreement();
  if (!agrDocEditable() || !a || agrDoc.busy) return;
  if (a.status !== 'draft') { showToast('⚠ 此合約已非草稿，無法建立版本'); return; }
  const D = NicocoAgreementDoc;
  const errs = D.validateRevisionRules(agrDoc.doc.revisionRules);
  if (errs.length) { showToast('⚠ ' + errs[0]); return; }
  const doc = D.normalizeDocument(agrDoc.doc);
  const warnings = D.collectWarnings(a, doc);
  const n = (Number(a.currentVersionNumber) || 0) + 1;
  const required = warnings.filter(w => w.level === 'required').length;
  if (!confirm(`建立「第 ${n} 版」？\n\n建立後此版本內容會永久保留，之後的修改不會覆寫它。\n`
    + (warnings.length ? `目前仍有 ${warnings.length} 項尚未填寫或尚未確認的內容（必要 ${required} 項），版本會照目前內容保存。\n` : '')
    + (agrDocIsDirty() || agrDoc.baseline == null ? '尚未儲存的修改會一併儲存。\n' : ''))) return;
  const user = auth.currentUser;
  if (!user || !user.email) { showToast('⚠ 無法取得登入帳號，請重新登入'); return; }
  agrDoc.busy = true;
  renderAgreementUI();
  try {
    const payload = D.buildVersionPayload(a, doc, n, agrDoc.note);
    const entry = D.versionIndexEntry(n, Date.now(), user.email, agrDoc.note, doc);
    const index = (Array.isArray(a.versionIndex) ? a.versionIndex : []).concat([entry]);
    const agrRef = db.collection('quotes').doc(currentId).collection('agreements').doc(a.id);
    const batch = db.batch();
    batch.update(agrRef, {
      contractDocument: doc,
      documentSchemaVersion: D.SCHEMA_VERSION,
      currentVersionNumber: n,
      versionIndex: index,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    batch.set(agrRef.collection('versions').doc('v' + n), Object.assign({}, payload, {
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: user.email,
    }));
    await batch.commit();
    a.contractDocument = JSON.parse(JSON.stringify(doc));
    a.documentSchemaVersion = D.SCHEMA_VERSION;
    a.currentVersionNumber = n;
    a.versionIndex = index;
    agrDocVersionCache[a.id + '/' + n] = Object.assign({}, payload, { createdAtMs: entry.atMs, createdBy: user.email });
    agrDoc.baseline = agrDocJson(doc);
    agrDoc.note = '';
    showToast(`✓ 已建立第 ${n} 版`);
  } catch (err) {
    console.error(err);
    showToast(`⚠ 建立版本失敗（可能已有其他分頁建立了同一版本，請重新整理後再試）：${err.message || err}`);
  } finally {
    agrDoc && (agrDoc.busy = false);
    renderAgreementUI();
  }
}

// ── 版本讀取與檢視 ──
async function agrDocLoadVersion(n) {
  const a = agrDocAgreement();
  if (!a) return null;
  const key = a.id + '/' + n;
  if (agrDocVersionCache[key]) return agrDocVersionCache[key];
  const snap = await db.collection('quotes').doc(currentId).collection('agreements').doc(a.id).collection('versions').doc('v' + n).get();
  if (!snap.exists) return null;
  const v = snap.data();
  v.createdAtMs = agrDocTsMs(v.createdAt);
  agrDocVersionCache[key] = v;
  return v;
}
async function agrDocViewVersion(n) {
  if (!agrDoc) return;
  try {
    const v = await agrDocLoadVersion(n);
    if (!v) { showToast(`⚠ 找不到第 ${n} 版`); return; }
    agrDoc.viewingVersion = n;
    agrDocSetView('version');
  } catch (err) { console.error(err); showToast(`⚠ 讀取版本失敗：${err.message || err}`); }
}
// left/right：版本號或 'draft'（目前草稿，含未儲存修改）
async function agrDocDiff(left, right) {
  if (!agrDoc) return;
  try {
    for (const x of [left, right]) if (x !== 'draft' && !(await agrDocLoadVersion(x))) { showToast(`⚠ 找不到第 ${x} 版`); return; }
    agrDoc.diffPair = { left, right };
    agrDocSetView('diff');
  } catch (err) { console.error(err); showToast(`⚠ 讀取版本失敗：${err.message || err}`); }
}
function agrDocDiffSide(x) {
  const a = agrDocAgreement();
  const D = NicocoAgreementDoc;
  if (x === 'draft') {
    const doc = D.normalizeDocument(agrDoc.doc);
    return { label: '目前草稿' + (agrDocIsDirty() ? '（含未儲存修改）' : ''), sections: D.renderSections(a, doc), rules: doc.revisionRules };
  }
  const v = agrDocVersionCache[a.id + '/' + x];
  return { label: '第 ' + x + ' 版', sections: v.renderedSections, rules: (v.document || {}).revisionRules };
}

// ── 標記「已備妥」前的提醒（由 agrMarkReady 呼叫，只提醒不阻擋）──
function agrDocReadyWarning(a) {
  if (!agrDocReady() || !a || !a.contractDocument) return '';
  const D = NicocoAgreementDoc;
  const notes = [];
  const idx = Array.isArray(a.versionIndex) ? a.versionIndex : [];
  if (!idx.length) notes.push('完整合約文件尚未建立任何版本');
  else if (idx[idx.length - 1].docFp !== D.fingerprint(a.contractDocument)) notes.push(`完整合約文件在第 ${idx[idx.length - 1].n} 版之後有修改，尚未建立版本`);
  const req = D.collectWarnings(a, a.contractDocument).filter(w => w.level === 'required').length;
  if (req) notes.push(`完整合約文件仍有 ${req} 項必要內容未填寫或未確認`);
  return notes.length ? `\n\n完整合約文件：\n・${notes.join('\n・')}` : '';
}

// ══════════════════════════════════════════════════
//  畫面
// ══════════════════════════════════════════════════
function agrDocRender() {
  const a = agrDocAgreement();
  if (!a) { agrDoc = null; return ''; }
  const D = NicocoAgreementDoc;
  const st = agrDocState();
  const idx = Array.isArray(a.versionIndex) ? a.versionIndex : [];
  const saveTag = agrDoc.readOnly ? '<span class="agv-save-state">唯讀</span>'
    : st === 'unsaved_new' ? '<span class="agv-save-state agv-unsaved">● 初稿尚未儲存</span>'
    : st === 'unsaved' ? '<span class="agv-save-state agv-unsaved">● 有尚未儲存的修改</span>'
    : agrDoc.doc ? '<span class="agv-save-state agv-saved">已儲存草稿</span>' : '';
  const tab = (v, label) => `<button class="agd-tab${agrDoc.view === v ? ' agd-tab-on' : ''}" ${agrDoc.view === v ? 'aria-current="page"' : ''} onclick="agrDocSetView('${v}')">${label}</button>`;
  const tabs = agrDoc.doc ? `<div class="agd-tabs">
      ${agrDoc.readOnly ? '' : tab('edit', '編輯')}
      ${tab('preview', '預覽完整合約')}
      ${tab('versions', `版本紀錄（${idx.length}）`)}
    </div>` : (idx.length ? `<div class="agd-tabs">${tab('versions', `版本紀錄（${idx.length}）`)}</div>` : '');

  let body;
  if (!agrDoc.doc && agrDoc.view !== 'versions' && agrDoc.view !== 'version' && agrDoc.view !== 'diff') {
    body = agrDoc.readOnly
      ? `<div class="agv-note">此合約建立於 v2.2 之前，沒有完整合約文件。合約已${escapeHtml(AGREEMENT_STATUS_LABELS[a.status] || a.status)}，不會補產生，以免改動已定案內容。原有合約內容可在「合約資料預覽」與「查看詳細」中查看。</div>`
      : `<div class="agv-muted" style="margin-bottom:10px">尚未建立完整合約文件。按下後會依目前的合約資料（客戶、金額、付款計畫、條款欄位、合約需求明細）產生「主契約＋附件」初稿；條款文字為範本草稿，需逐條確認。</div>
         ${a.contractData ? '' : '<div class="agv-alert">此合約尚未帶入合約資料（v2.1），附件一至附件五會顯示「未填寫」。建議先在合約「編輯」畫面按「帶入合約資料」並儲存。</div>'}
         <button class="btn-save" style="padding:9px 18px" onclick="agrDocGenerate()">產生合約初稿</button>`;
  } else if (agrDoc.view === 'edit') body = agrDocRenderEdit(a);
  else if (agrDoc.view === 'preview') body = `<div class="agd-preview">${D.renderFullHtml(a, agrDoc.doc, { state: st })}</div>`;
  else if (agrDoc.view === 'versions') body = agrDocRenderVersions(a, idx);
  else if (agrDoc.view === 'version') body = agrDocRenderVersion(a);
  else if (agrDoc.view === 'diff') body = agrDocRenderDiff();
  else body = '';

  const canSave = !agrDoc.readOnly && agrDoc.doc;
  return `
    <div class="card agd-card">
      <div class="agd-head">
        <div>
          <div class="card-title" style="margin-bottom:2px">完整合約文件　${escapeHtml(a.agreementNumber || '')}</div>
          <div class="agv-muted">${escapeHtml(a.projectName || '')}・合約狀態：${escapeHtml(AGREEMENT_STATUS_LABELS[a.status] || a.status)}・${idx.length ? `最新版本：第 ${idx[idx.length - 1].n} 版（${escapeHtml(agrDocFmtTime(idx[idx.length - 1].atMs))}）` : '尚未建立版本'}</div>
        </div>
        ${saveTag}
      </div>
      ${tabs}
      ${body}
      <div class="agd-actions">
        <button class="btn-copy-link" onclick="agrDocClose()">返回合約列表</button>
        ${canSave ? `<button class="btn-copy-link" ${agrDoc.busy ? 'disabled' : ''} onclick="agrDocSave()">儲存草稿</button>` : ''}
        ${canSave ? `<input class="field-input agd-note-input" type="text" maxlength="120" placeholder="版本說明（選填，例如：客戶確認付款條件）" value="${escapeHtml(agrDoc.note)}" oninput="agrDocSetNote(this.value)" aria-label="版本說明">
          <button class="btn-save" style="padding:9px 18px" ${agrDoc.busy ? 'disabled' : ''} onclick="agrDocCreateVersion()">建立第 ${(Number(a.currentVersionNumber) || 0) + 1} 版</button>` : ''}
        ${saveTag}
      </div>
    </div>`;
}

function agrDocRenderEdit(a) {
  const D = NicocoAgreementDoc;
  const doc = agrDoc.doc;
  const rr = doc.revisionRules;
  const warnings = D.collectWarnings(a, doc);
  const errs = D.validateRevisionRules(rr);
  const num = (group, field, label, lim) => `
    <label class="agd-num"><span>${label}</span>
      <input class="field-input" type="number" inputmode="numeric" min="${lim[0]}" max="${lim[1]}" step="1" value="${rr[group][field] == null ? '' : rr[group][field]}" onchange="agrDocSetRule('${group}','${field}',this.value)">
    </label>`;
  const L = D.LIMITS;
  const tokenHelp = Object.keys(D.TOKEN_LABELS).map(k => `<code>{{${k}}}</code> ${escapeHtml(D.TOKEN_LABELS[k])}`).join('　');
  return `
    ${warnings.length ? `<div class="agd-warnings"><div class="agd-warnings-title">尚未填寫或尚未確認的內容（${warnings.length}）</div><ul>
      ${warnings.map(w => `<li class="agd-lv-${w.level}"><span class="agv-tag">${w.level === 'required' ? '必要' : '待確認'}</span>${w.where ? `<span class="agv-muted">${escapeHtml(w.where)}｜</span>` : ''}${escapeHtml(w.text)}</li>`).join('')}
    </ul></div>` : '<div class="agv-note">所有必要內容都已填寫並確認。</div>'}

    <label class="agd-confirm"><input type="checkbox" ${doc.termsConfirmed ? 'checked' : ''} onchange="agrDocSetConfirmed(this.checked)">
      <span>我已逐條檢查並確認條款內容（條款預設文字為 Claude 擬定的草稿，未經法律專業審閱）</span></label>

    <div class="agv-sub">修改與驗收設定</div>
    <div class="agv-muted">預設：開發與驗收期間各免費修改 2 批次、每批次最多 5 項，驗收期限 14 個日曆日；可依個別合約調整。</div>
    <div class="agd-grid">
      ${num('development', 'freeBatches', '開發期間免費修改（批次）', L.freeBatches)}
      ${num('development', 'itemsPerBatch', '開發期間每批次上限（項）', L.itemsPerBatch)}
      ${num('acceptance', 'freeBatches', '驗收期間免費修改（批次）', L.freeBatches)}
      ${num('acceptance', 'itemsPerBatch', '驗收期間每批次上限（項）', L.itemsPerBatch)}
      ${num('acceptance', 'periodDays', '驗收期限（日曆日）', L.periodDays)}
    </div>
    <label class="agd-confirm"><input type="checkbox" ${rr.carryOver ? 'checked' : ''} onchange="agrDocSetCarryOver(this.checked)">
      <span>開發期間未使用的額度可轉入驗收期間（預設不轉移）</span></label>
    ${errs.length ? `<div class="agv-alert">${errs.map(escapeHtml).join('<br>')}</div>` : ''}

    <div class="agv-sub">免費修改範圍（每批次項目數未達上限，不代表任何調整都免費）</div>
    <div class="agd-types">
      ${D.FREE_SCOPE_TYPES.map(t => `<label class="agd-check"><input type="checkbox" ${rr.freeScope.types.includes(t.key) ? 'checked' : ''} onchange="agrDocToggleType('${t.key}', this.checked)"> ${escapeHtml(t.label)}</label>`).join('')}
    </div>
    <div class="field"><label class="field-label">調整程度</label>
      <select class="field-select" onchange="agrDocSetScope('level', this.value)">
        <option value="" ${!rr.freeScope.level ? 'selected' : ''}>請選擇</option>
        ${D.FREE_SCOPE_LEVELS.map(l => `<option value="${l.key}" ${rr.freeScope.level === l.key ? 'selected' : ''}>${escapeHtml(l.label)}</option>`).join('')}
      </select></div>
    <div class="field"><label class="field-label">適用頁面</label>
      <textarea class="field-textarea agd-ta-s" onchange="agrDocSetScope('pages', this.value)">${escapeHtml(rr.freeScope.pages)}</textarea></div>
    <div class="field"><label class="field-label">工作範圍</label>
      <textarea class="field-textarea agd-ta-s" onchange="agrDocSetScope('workScope', this.value)">${escapeHtml(rr.freeScope.workScope)}</textarea></div>
    <div class="field"><label class="field-label">其他說明（選填）</label>
      <textarea class="field-textarea agd-ta-s" onchange="agrDocSetScope('notes', this.value)">${escapeHtml(rr.freeScope.notes)}</textarea></div>
    <div class="field"><label class="field-label">超出免費額度的計費方式</label>
      <textarea class="field-textarea agd-ta-s" onchange="agrDocSetExtraFee(this.value)">${escapeHtml(rr.extraChangeFeeText)}</textarea></div>

    <div class="agv-sub">主契約條款</div>
    <details class="agd-tokens"><summary>可用的資料欄位（條款中的 {{欄位}} 會在預覽時自動代入）</summary><div class="agv-muted">${tokenHelp}</div></details>
    ${doc.sections.map(s => `
      <div class="agd-edit-sec">
        <div class="agd-edit-sec-head"><strong>${escapeHtml(s.title)}</strong>
          <button class="btn-copy-link" onclick="agrDocResetSection('${s.key}')">恢復範本</button></div>
        <textarea class="field-textarea agd-ta" aria-label="${escapeHtml(s.title)}" onchange="agrDocSetSection('${s.key}', this.value)">${escapeHtml(s.text)}</textarea>
      </div>`).join('')}

    <div class="agv-sub">補充條款</div>
    <textarea class="field-textarea agd-ta" aria-label="補充條款" placeholder="（選填）" onchange="agrDocSetSupplementary(this.value)">${escapeHtml(doc.supplementary)}</textarea>

    <div class="agv-sub">附件說明</div>
    <div class="agv-muted">附件內容由合約資料自動產生；這裡可為每個附件加上說明文字（選填）。</div>
    ${D.ANNEXES.map(x => `
      <div class="field"><label class="field-label">${escapeHtml(x.title)}</label>
        <textarea class="field-textarea agd-ta-s" onchange="agrDocSetAnnexNote('${x.key}', this.value)">${escapeHtml(doc.annexNotes[x.key] || '')}</textarea></div>`).join('')}`;
}

function agrDocRenderVersions(a, idx) {
  if (!idx.length) return `<div class="agv-muted" style="margin:10px 0">尚未建立任何版本。${agrDoc.readOnly ? '' : '在「編輯」或「預覽」確認內容後，按下方「建立第 1 版」。'}</div>`;
  const rows = idx.slice().reverse().map(e => `
    <div class="agd-ver">
      <div class="agd-ver-main"><strong>第 ${e.n} 版</strong>　<span class="agv-muted">${escapeHtml(agrDocFmtTime(e.atMs))}・${escapeHtml(e.by || '')}</span>
        ${e.note ? `<div>${escapeHtml(e.note)}</div>` : ''}</div>
      <div class="agd-ver-actions">
        <button class="btn-copy-link" onclick="agrDocViewVersion(${e.n})">查看</button>
        ${e.n > 1 ? `<button class="btn-copy-link" onclick="agrDocDiff(${e.n - 1}, ${e.n})">與第 ${e.n - 1} 版比較</button>` : ''}
        ${agrDoc.doc ? `<button class="btn-copy-link" onclick="agrDocDiff(${e.n}, 'draft')">與目前草稿比較</button>` : ''}
      </div>
    </div>`).join('');
  return `<div class="agv-muted" style="margin:6px 0">版本建立後永久保留，任何人（含管理員）都不能修改或刪除。</div>${rows}`;
}

function agrDocRenderVersion(a) {
  const D = NicocoAgreementDoc;
  const n = agrDoc.viewingVersion;
  const v = agrDocVersionCache[a.id + '/' + n];
  if (!v) return '<div class="agv-alert">找不到此版本。</div>';
  const label = `第 ${n} 版・${agrDocFmtTime(v.createdAtMs)}・${v.createdBy || ''}`;
  return `
    <div class="agd-sub-actions"><button class="btn-copy-link" onclick="agrDocSetView('versions')">返回版本紀錄</button>
      ${n > 1 ? `<button class="btn-copy-link" onclick="agrDocDiff(${n - 1}, ${n})">與第 ${n - 1} 版比較</button>` : ''}</div>
    ${v.note ? `<div class="agv-muted">版本說明：${escapeHtml(v.note)}</div>` : ''}
    <div class="agd-preview">${D.renderFullHtml(D.agrFromVersion(v), v.document, { rendered: v.renderedSections, state: 'version', versionLabel: label })}</div>`;
}

function agrDocRenderDiff() {
  const D = NicocoAgreementDoc;
  const p = agrDoc.diffPair;
  if (!p) return '';
  const diff = D.diffDocuments(agrDocDiffSide(p.left), agrDocDiffSide(p.right));
  return `<div class="agd-sub-actions"><button class="btn-copy-link" onclick="agrDocSetView('versions')">返回版本紀錄</button></div>
    <div class="agd-diff">${D.renderDiffHtml(diff)}</div>`;
}
