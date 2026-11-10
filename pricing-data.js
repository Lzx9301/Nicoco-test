// ══════════════════════════════════════════════════════════════════════
//  Nicoco — 價格資料（唯一來源）
//
//  內容原封不動搬自 index.html，沒有修改任何價格、名稱或說明。
//  載入頁面：
//    index.html        公開估價／需求書（calcPrice 直接使用這裡的全域常數）
//    quote-detail.html 需求審核（只讀取估價區間作為審核參考，不重新計價）
//
//  注意：FEATURES 的中文 name 是後台 Scope 對應的 key，不可任意改名。
// ══════════════════════════════════════════════════════════════════════

// 基礎建置費 (已含：RWD、基礎SEO、SSL、部署、DNS)
const TYPE_CONFIG = {
  brand: {
    name:'形象網站', priceMin:35000, priceMax:50000, days:20,
    // included：方案價格已含這些項目，勾選後顯示「已包含」但不加費
    included: {
      pages: ['home','about','contact'],
    },
  },
  cms: {
    name:'內容管理網站', priceMin:55000, priceMax:85000, days:30,
    // CMS 的核心價值是「內容管理能力」本身，不綁定特定頁面（例如 FAQ 不寫死為必含）
    included: {
      pages: ['home','about','contact'],
      cms:   ['admin','content-mgmt'],
    },
  },
  ecom: {
    name:'小型電商網站', priceMin:90000, priceMax:120000, days:50,
    included: {
      pages:  ['home','contact'],
      ecom:   ['ecom-base'],
      member: ['register','profile','orders'],
      // 文章／內容 CMS 不含在小型電商基礎方案，改列為額外加購（見 FEATURES.cms.content-mgmt）
      cms:    ['admin','product-mgmt','order-mgmt'],
    },
  },
  custom: {
    name:'客製需求評估', priceMin:null, priceMax:null, days:null,
    included: {},
  },
};

// 功能資料：free → 不計費；evaluate → 需評估不計費
// price = 參考低價；priceHigh = 參考高價（若省略，預設用 isModule?1.55x:1.3x 當高價，見 calcPrice()）
const FEATURES = {
  // ── 頁面 ──
  pages: [
    { id:'home',    name:'首頁',         price:6000,  badge:'must', desc:'Hero Banner、品牌主張、CTA，整站最核心的頁面。' },
    { id:'about',   name:'關於我們',     price:3500,  badge:'rec',  desc:'品牌故事、團隊介紹、核心價值，建立信任感。' },
    { id:'contact', name:'聯絡我們',     price:2500,  badge:'must', desc:'聯絡表單、地圖、電話 Email，基本必備。' },
    { id:'faq',     name:'FAQ',          price:2500,  badge:'rec',  desc:'整理常見問題，減少客服負擔，也有助 SEO。' },
    { id:'blog',    name:'部落格',       price:6000,  badge:'rec',  desc:'長期內容經營，支援標籤分類，有助自然搜尋流量。' },
    { id:'multilang',name:'多語系（基礎）', price:8000, priceHigh:20000, badge:'opt',  desc:'固定頁面的多語言切換與不同語言內容顯示（例如 zh/en），含基本版面支援，依頁面數量調整。不包含專業翻譯、校稿，以及商品／文章等 CMS 內容的多語管理；翻譯文字原則上由客戶提供。若需要 CMS 多語、商品多語或 SEO 多語 slug，請勾選「需評估」區塊的「完整多語系 CMS」。' },
    { id:'seo-adv', name:'SEO 進階設定', price:5000,  badge:'rec',  desc:'Schema 結構化資料、進階 OG、Sitemap 完整配置（基礎版已含於建置費）。' },
  ],
  // ── 電商功能 ──
  ecom: [
    { id:'ecom-base',  name:'基礎電商模組',   price:60000, priceHigh:90000, badge:'must', isModule:true,
      desc:'商品管理、商品列表、商品詳細頁、基本商品分類、購物車、基本 Checkout 流程、Email／密碼會員登入、基本會員資料、基本訂單建立與查詢、商品管理後台、訂單管理後台、基本部署。<br><strong>適用範圍：單一語系、基本商品規格（顏色/尺寸各一層）、商品數量 50 項以內。</strong>超出此範圍請於補充說明中說明，將另行評估。<br><strong>不包含：</strong>第三方正式金流串接、文章／內容 CMS、Dashboard、會員管理後台、Email 自動通知、物流串接、電子發票、優惠券、進階庫存、進階商品多規格、客製 UI／UX，以上皆為額外加購項目。<br>選擇「小型電商網站」時，此模組已含於方案基礎費，不另計費；僅在其他網站類型額外加入完整電商功能時，才以此價格計算。' },
    { id:'coupon',     name:'優惠券 / 折扣碼',   price:5000, priceHigh:10000, badge:'opt',
      desc:'折扣碼、滿額折、限時優惠等促銷機制。' },
    { id:'variants',   name:'進階商品多規格',       price:8000, priceHigh:18000, badge:'rec',
      desc:'基礎方案僅含簡易單層規格選項；此項目適用於多維度規格組合（例如顏色 × 尺寸），且各組合需獨立 SKU、價格或庫存管理。基本範圍：規格組合、前台規格選擇、後台基本管理與基本測試。三維以上規格、大量組合或特殊定價邏輯不屬於基本範圍，需另行評估。' },
    { id:'inventory-adv', name:'進階庫存管理', price:8000, priceHigh:20000, badge:'opt',
      desc:'基本進階庫存：安全庫存設定、低庫存提醒與基本庫存管理強化（基本進出貨已含於基礎電商模組）。多倉庫、跨倉庫存分配、自動補貨流程、複雜庫存同步、ERP／POS 庫存同步不屬於此項目，需另行評估。' },
    { id:'reviews',    name:'商品評價',          price:6000, priceHigh:10000, badge:'opt',
      desc:'購買後留星等評分與文字評價，並於前台商品頁顯示。圖片評論、審核／檢舉機制、商家回覆等不屬於基本範圍，需另行評估。' },
  ],
  // ── 會員 ──
  member: [
    { id:'register',  name:'會員註冊 / 登入',  price:8000,  badge:'must', desc:'Email 帳號註冊與登入，含信箱驗證。' },
    { id:'oauth-google', name:'Google 登入',  price:4000, priceHigh:8000, badge:'opt',  desc:'使用 Google 帳號快速登入，降低註冊門檻。基本範圍：單一第三方登入、與網站既有會員建立基本登入關係、必要的 callback／token 流程與基本測試。複雜帳號合併、多身份綁定、跨平台資料同步不屬於基本範圍。' },
    { id:'oauth-line',   name:'LINE 登入',    price:5000, priceHigh:10000, badge:'opt',  desc:'使用 LINE 帳號快速登入，適合台灣使用者習慣。基本範圍：單一第三方登入、與網站既有會員建立基本登入關係、必要的 callback／token 流程與基本測試。複雜帳號合併、多身份綁定、跨平台資料同步不屬於基本範圍。第三方平台帳號或相關費用不包含於網站開發費中。' },
    { id:'oauth-apple',  name:'Apple 登入',   price:6000, priceHigh:12000, badge:'opt',  desc:'使用 Apple ID 登入。基本範圍：單一第三方登入、與網站既有會員建立基本登入關係、必要的 callback／token 流程與基本測試。複雜帳號合併、多身份綁定、跨平台資料同步不屬於基本範圍。Apple Developer Program 等第三方帳號費用不包含於網站開發費中。' },
    { id:'profile',   name:'基本個人資料管理',      price:3500,  badge:'rec',  desc:'修改姓名、電話、Email、基本地址等會員基本資料。小型電商方案已包含；若需要多地址簿、公司資料、會員偏好等進階欄位，需另行評估。' },
    { id:'wishlist',  name:'收藏 / 願望清單',   price:3000,  badge:'opt',  desc:'讓使用者收藏喜歡的商品，提升回訪率。' },
    { id:'orders',    name:'訂單查詢',           price:4000,  badge:'rec',  desc:'查看歷史訂單狀態，必要的購物體驗。' },
    { id:'member-adv', name:'進階會員權限 / 等級', price:8000, priceHigh:15000, badge:'opt', desc:'基本會員分級：後台人工設定會員等級、基本會員等級資料與基本等級權益。依消費金額或訂單次數自動升降級、複雜等級規則，以及點數制度（取得、折抵、兌換、到期、倍率、歷程等）不屬於此項目，需另行評估。' },
  ],
  // ── 後台 CMS ──
  cms: [
    { id:'admin',       name:'後台管理入口',    price:0,     badge:'must', free:true,  desc:'後台登入與基礎架構，已含於基礎建置費中。' },
    { id:'content-mgmt',name:'文章 / 內容 CMS', price:6000, priceHigh:12000,  badge:'must', desc:'Banner、文章、最新消息、FAQ、聯絡表單收件，後台自行編輯與分類。' },
    { id:'product-mgmt',name:'商品 / 服務管理', price:6000,  badge:'opt',  desc:'商品 CRUD、庫存調整、上下架控制。' },
    { id:'order-mgmt',  name:'訂單管理',         price:6000,  badge:'opt',  desc:'查看、搜尋、更新訂單狀態。' },
    { id:'member-mgmt', name:'會員管理',         price:5000, priceHigh:10000,  badge:'opt',  desc:'查詢會員資料、消費記錄、停用帳號。' },
    { id:'dashboard',   name:'數據 Dashboard',   price:6000, priceHigh:12000, badge:'opt',  desc:'流量、訂單、會員成長一眼掌握。' },
    { id:'permission',  name:'管理員權限分級（基本角色）', price:5000, priceHigh:12000, badge:'ent',  desc:'基本角色權限，例如管理員／編輯者兩三種固定角色，各自可操作的功能範圍。若需要複雜的多層級權限矩陣（RBAC），請改選下方「需評估」區塊的「複雜權限矩陣 RBAC」。' },
  ],
  // ── 串接 ──
  integrations: [
    { id:'ga',           name:'Google Analytics 4',   price:0,    badge:'must', free:true, desc:'流量來源、使用者行為、轉換追蹤，已含於基礎建置費中。' },
    { id:'gsc',          name:'Google Search Console', price:0,    badge:'must', free:true, desc:'Google 搜尋排名監控與爬蟲狀態，已含於基礎建置費中。' },
    { id:'firebase-base',name:'Firebase 基礎架構',    price:0,    badge:'must', free:true, desc:'Firestore 資料庫、Authentication 會員驗證、Cloud Storage 基礎用量，已含於基礎建置費中（限標準用量，Firebase 付費用量費用由客戶自行負擔，詳見「第三方服務費」說明）。' },
    { id:'payment-3rd',  name:'第三方金流串接',       price:12000, priceHigh:25000, badge:'opt', desc:'單一金流服務商（例如綠界 ECPay／藍新 NewebPay）的標準一次性付款流程：測試與正式環境基本串接、付款請求、付款結果處理與必要驗證、基本成功／失敗流程、基本正式環境測試。<strong>小型電商方案僅包含基本 Checkout 流程（下單、結帳頁面與訂單建立），不包含第三方正式金流串接</strong>，因此不論選擇何種網站類型，只要需要線上收款都需要此加購項目。訂閱／定期扣款、分潤、多金流商、退款自動化、特殊分期或複雜付款流程不屬於基本範圍，需另行評估。金流交易手續費、平台費與帳號申請費由客戶自行負擔，不包含於本開發估價。' },
    { id:'gtm',          name:'Google Tag Manager',    price:2500, badge:'rec',  desc:'追蹤碼統一管理，不需改程式碼即可部署 Pixel 等。' },
    { id:'fb-pixel',     name:'Facebook Pixel',         price:2500, badge:'rec',  desc:'追蹤廣告轉換、建立再行銷受眾，Facebook/Instagram 廣告必備。' },
    { id:'line-notify',  name:'LINE 訂單通知',          price:5000, priceHigh:8000, badge:'opt',  desc:'網站產生新訂單後，透過 LINE 官方提供的 Messaging API，將基本訂單通知發送給指定管理者或群組。基本範圍：Messaging API 基本串接、新訂單成立時的基本通知、指定一個主要通知對象或群組、基本設定與串接測試。多群組分流、依訂單狀態發送不同通知、複雜訊息模板、顧客端通知、LINE Bot 等進階需求另行評估及報價。LINE 官方帳號方案、訊息費及其他第三方平台費用不包含於網站開發費中。' },
    { id:'email-auto',   name:'Email 自動通知',         price:5000, priceHigh:10000, badge:'opt', desc:'依本專案確認的有限通知事件（例如下單確認、店家新訂單、訂單狀態更新、出貨通知）自動寄送 Email，含基本 Email 樣板與單一寄信服務基本串接。大量 lifecycle email、複雜排程、行銷自動化與進階分群不屬於基本範圍，需另行評估。寄信服務本身費用由客戶自行負擔。' },
    { id:'newsletter',   name:'電子報系統',              price:5000, priceHigh:12000, badge:'opt', desc:'基本包含：訂閱、退訂、基本名單、單一 Email 服務基本串接與基本電子報發送功能。複雜分眾（segmentation）、行銷自動化、行為觸發流程、A/B 測試與 CRM 級行銷流程不屬於基本範圍。第三方寄信費／平台費由客戶自行負擔。' },
    { id:'logistics',    name:'物流串接',                price:12000, priceHigh:30000, badge:'opt', desc:'單一標準物流服務／平台的基本串接（需商家資格申請與 API 測試）。多家物流商、溫層、多倉、複雜運費規則、特殊配送、自動物流分流與複雜追蹤不屬於基本範圍，需另行評估。物流平台費用由客戶自行負擔。' },
    { id:'invoice',      name:'電子發票串接',            price:10000, priceHigh:20000, badge:'opt', desc:'單一電子發票服務商的標準串接（需配合稅籍設定與 API 測試）。複雜發票流程、多平台、多公司／多統編、特殊折讓／作廢流程不屬於基本範圍，需另行評估。第三方平台費用由客戶自行負擔。' },
    { id:'maps',         name:'Google Maps 嵌入',       price:2500, badge:'opt',  desc:'Google Maps 基本嵌入，於網站頁面顯示指定的店家／公司位置。地址自動完成（Places Autocomplete）、地址 API、複雜地圖搜尋與多店據點系統不屬於此項目，需另行評估。' },
    { id:'recaptcha',    name:'reCAPTCHA',              price:1500, badge:'rec',  desc:'防止機器人垃圾表單送出，保護聯絡頁與登入頁。' },
    { id:'firebase-adv', name:'Firebase 進階功能',     price:8000, priceHigh:25000, badge:'opt',  desc:'Cloud Functions 自動化流程、FCM 推播通知、進階 Storage 規則或多環境設定，依複雜度落在 NT$8,000～25,000+ 區間。超出基礎架構範圍時適用。大量 Cloud Functions、複雜背景工作、大型資料同步、高流量架構與特殊安全規則需另行評估。Firebase 使用量與付費方案等第三方費用由客戶自行負擔。' },
  ],
  // ── 設計 / 服務 ──
  services: [
    { id:'ui-design',    name:'客製 UI／UX 設計', price:15000, priceHigh:40000, badge:'rec', desc:'一般網站介面與 RWD 設計已包含於基礎建置，不另收費。此加購適用於完整設計稿、高度品牌化視覺、特殊互動或較深入的 UX 規劃。' },
    { id:'logo',         name:'LOGO 設計',       price:15000, badge:'opt', desc:'品牌識別設計，含黑白稿與應用規範。' },
    { id:'copywriting',  name:'文案撰寫',         price:8000,  badge:'opt', desc:'協助撰寫品牌介紹、頁面文字或其他網站文案；頁面數／篇數、內容類型與大致範圍需於正式報價時確認，並非全站文字無限制撰寫。大量商品描述、SEO 長文與專業產業內容需另行評估。' },
    { id:'seo-consult',  name:'SEO 顧問',         price:12000, badge:'rec', desc:'關鍵字研究、競品分析、頁面優化建議。' },
    { id:'training',     name:'教育訓練',          price:6000,  badge:'rec', desc:'一次基本後台操作教學，原則約 60–90 分鐘。額外場次、現場教學或不同人員重複培訓另行報價。' },
    { id:'manual',       name:'操作手冊',          price:5000,  badge:'opt', desc:'本專案客製後台主要功能的基本圖文操作說明。不包含完整公司 SOP、無限制頁數或第三方平台的完整教學文件。' },
    { id:'launch-adv',   name:'進階正式環境設定', price:6000, priceHigh:15000, badge:'opt', desc:'基本部署與基本 DNS 指向已含於方案內。此項目適用於整體正式環境整理：多環境 Production 部署、Production Environment Variables、正式環境設定、Email DNS（SPF/DKIM/DMARC）、較複雜的 DNS 調整、正式管理員帳號建立、Production Checklist 與正式環境測試。金流正式環境切換屬於「第三方金流串接」範圍，不在此重複計費。' },
    { id:'hosting',      name:'主機代管建議',      price:5000,  badge:'rec', desc:'主機／雲端環境規劃與初始設定：依需求協助選擇適合的 hosting／cloud 方案，並提供基本初始設定建議（主機本身費用由客戶自行負擔）。不代表長期代管、24/7 維運、大型 AWS／GCP 架構、複雜 IAM／網路設定、完整 DevOps pipeline 或長期監控，以上需另行評估。' },
  ],
  // ── 需評估（不自動計費，複雜度差異過大無法列固定區間） ──
  evaluate: [
    { id:'permission-adv', name:'複雜權限矩陣 RBAC', badge:'eval', evaluate:true, desc:'多層級、多維度的角色與權限矩陣（例如依部門、資源、動作分別授權），複雜度差異大，不列固定價格，需依實際規則評估。' },
    { id:'erp',          name:'ERP 系統串接',      badge:'eval', evaluate:true, desc:'與現有 ERP 雙向同步庫存、訂單、財務資料。複雜度差異大，需評估。' },
    { id:'crm',          name:'CRM 整合',           badge:'eval', evaluate:true, desc:'串接 HubSpot、Salesforce 等 CRM 平台。' },
    { id:'pos',          name:'POS 串接',           badge:'eval', evaluate:true, desc:'線上線下訂單統一，整合實體收銀機。' },
    { id:'ai',           name:'AI 功能整合',         badge:'eval', evaluate:true, desc:'客服機器人、智慧推薦、文案生成等 AI API 應用。' },
    { id:'b2b',          name:'B2B 平台 / 詢報價',  badge:'eval', evaluate:true, desc:'客戶分級報價、批量訂單、業務管理流程。' },
    { id:'booking',      name:'預約 / 排程系統',    badge:'eval', evaluate:true, desc:'多資源預約、行事曆整合、通知提醒。參考行情 NT$12,000～30,000，實際依預約邏輯複雜程度評估。' },
    { id:'payment-adv',  name:'進階金流',            badge:'eval', evaluate:true, desc:'分期付款、境外收款、訂閱制定期扣款。' },
    { id:'api-3rd',      name:'第三方 API 串接',     badge:'eval', evaluate:true, desc:'串接指定的第三方服務 API。不同 API 的工作量差異過大，不列固定價格，需依實際串接內容評估。' },
    { id:'photography',  name:'產品拍攝',             badge:'eval', evaluate:true, desc:'商品或品牌形象照片拍攝。費用受商品數量、拍攝地點、棚拍／外拍、模特兒、道具、成品張數、修圖與交通等因素影響，不列固定價格，需另行評估。' },
    { id:'multilang-full',name:'完整多語系 CMS',    badge:'eval', evaluate:true, desc:'CMS 內容、商品資料、SEO slug 全部多語系，複雜度因系統規模差異顯著，需評估。' },
  ],
};

// 取得單一功能項目的高價：優先用明確設定的 priceHigh，
// 其次模組類 (isModule) 用 ×1.55，一般項目用 ×1.3，皆為估算倍率，方便日後調整。
function itemHigh(item) {
  if (item.priceHigh) return item.priceHigh;
  return Math.round(item.price * (item.isModule ? 1.55 : 1.3));
}

// 後台讀取用（不改變上面的全域常數）
window.NicocoPricing = {
  TYPE_CONFIG: TYPE_CONFIG,
  FEATURES: FEATURES,
  itemHigh: itemHigh,
  // 以 group + id 取得功能項目
  find: function (group, id) {
    return (FEATURES[group] || []).find(function (i) { return i.id === id; }) || null;
  },
  // 以中文原名取得功能項目（舊資料只有名稱時使用）
  findByName: function (name) {
    var groups = Object.keys(FEATURES);
    for (var g = 0; g < groups.length; g++) {
      var hit = FEATURES[groups[g]].find(function (i) { return i.name === name; });
      if (hit) return { group: groups[g], item: hit };
    }
    return null;
  },
};
