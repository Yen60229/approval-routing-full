/**
 * 角色定義表 — role_name 可搜尋選單
 *
 * 【影響的欄位】
 *   - unit_name:   隱藏原生下拉，注入可搜尋 input+datalist
 *   - title_level: 隱藏原生下拉，注入可搜尋 input+datalist（固定六選項）
 *   - role_name:   計算欄位，JS 不碰
 *
 * 【依賴】
 *   - core/01-config.js（Config.ROLE_FIELDS, Config.TITLE_LEVEL_OPTIONS）
 *   - core/04-utils.js（Utils.safeHandler）
 *
 * 【變更履歷】
 *   2026-04-27  Jimmy/Claude  初版建立
 */
(() => {
  'use strict';

  const { ROLE_FIELDS: F, TITLE_LEVEL_OPTIONS, APP_ID } = window.ApprovalRouting.Config;
  const { safeHandler } = window.ApprovalRouting.Utils;

  const CONFIG = Object.freeze({
    UNIT_INPUT_ID:  'ar-unit-search',
    TITLE_INPUT_ID: 'ar-title-search',
    INPUT_STYLE: [
      'width:100%',
      'padding:10px 14px',
      'font-size:15px',
      'border:2px solid #b0bec5',
      'border-radius:6px',
      'box-sizing:border-box',
      'background:#fff',
    ].join(';'),
  });

  // ─── 工具函式 ───────────────────────────────────────────────────────────────

  /** unit_name 選項快取（避免重複 API 請求） */
  let _cachedUnitOptions = null;

  /**
   * 透過 REST API 讀取 unit_name 欄位的下拉選項清單
   * kintone 下拉欄位沒有標準 <select> DOM，必須從 form/fields API 取得
   * @returns {Promise<string[]>}
   */
  const fetchUnitOptions = async () => {
    if (_cachedUnitOptions) return _cachedUnitOptions;
    try {
      const resp = await kintone.api(
        kintone.api.url('/k/v1/app/form/fields', true),
        'GET',
        { app: APP_ID.ROLE_DEFINITION },
      );
      const field = resp.properties[F.UNIT_NAME];
      if (!field?.options) {
        console.warn('[AR-07] unit_name 欄位找不到選項，請確認後台欄位設定');
        return [];
      }
      _cachedUnitOptions = Object.values(field.options)
        .sort((a, b) => Number(a.index) - Number(b.index))
        .map((o) => o.label);
      return _cachedUnitOptions;
    } catch (err) {
      console.error('[AR-07] 讀取 unit_name 選項失敗', err);
      return [];
    }
  };

  /**
   * 隱藏原生欄位，並在其前方插入可搜尋 input+datalist
   * @param {string}   fieldCode    - kintone 欄位代碼
   * @param {string}   inputId      - 注入 input 的 DOM id
   * @param {string[]} options      - 下拉選項清單
   * @param {string}   currentValue - 預填值（編輯頁用，空字串則空白）
   * @param {string}   placeholder  - 輸入框提示文字
   */
  const injectSearchInput = (fieldCode, inputId, options, currentValue, placeholder) => {
    if (document.getElementById(inputId)) return; // 避免重複注入

    const fieldEl = kintone.app.record.getFieldElement(fieldCode);
    if (!fieldEl) {
      console.warn(`[AR-07] 找不到欄位 ${fieldCode}，請確認 kintone 後台已新增此欄位`);
      return;
    }

    kintone.app.record.setFieldShown(fieldCode, false);

    const listId = `${inputId}-list`;

    const input = document.createElement('input');
    input.type        = 'text';
    input.id          = inputId;
    input.placeholder = placeholder;
    input.value       = currentValue || '';
    input.setAttribute('list', listId);
    input.style.cssText = CONFIG.INPUT_STYLE;

    const datalist = document.createElement('datalist');
    datalist.id = listId;
    options.forEach((opt) => {
      const option = document.createElement('option');
      option.value = opt;
      datalist.appendChild(option);
    });

    // 使用者選定後寫回 kintone 欄位（只有在選項清單內才接受）
    input.addEventListener('change', () => {
      if (!options.includes(input.value)) return;
      kintone.app.record.set({
        record: { [fieldCode]: { value: input.value } },
      });
    });

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'margin-bottom:8px;';
    wrapper.appendChild(input);
    wrapper.appendChild(datalist);

    fieldEl.parentElement.insertBefore(wrapper, fieldEl);
  };

  // ─── 主要邏輯 ───────────────────────────────────────────────────────────────

  const mountSelectorUI = async (record) => {
    // unit_name：透過 REST API 從後台欄位設定讀取選項（IT 維護）
    const unitOptions  = await fetchUnitOptions();
    const currentUnit  = record[F.UNIT_NAME]?.value  || '';

    // title_level：固定清單，直接使用 Config 常數
    const titleOptions = [...TITLE_LEVEL_OPTIONS];
    const currentTitle = record[F.TITLE_LEVEL]?.value || '';

    injectSearchInput(
      F.UNIT_NAME,
      CONFIG.UNIT_INPUT_ID,
      unitOptions,
      currentUnit,
      '輸入單位名稱（如 MIS、HR…）',
    );

    injectSearchInput(
      F.TITLE_LEVEL,
      CONFIG.TITLE_INPUT_ID,
      titleOptions,
      currentTitle,
      '輸入職級（如 課長、部長…）',
    );
  };

  // ─── 事件綁定 ───────────────────────────────────────────────────────────────

  // 新增 / 編輯頁：注入可搜尋 UI
  kintone.events.on(
    ['app.record.create.show', 'app.record.edit.show'],
    safeHandler(async (event) => {
      await mountSelectorUI(event.record);
      return event;
    }),
  );

  // 送出前驗證：unit_name + title_level 均不可為空
  kintone.events.on(
    ['app.record.create.submit', 'app.record.edit.submit'],
    safeHandler(async (event) => {
      const record   = event.record;
      const unitVal  = record[F.UNIT_NAME]?.value  || '';
      const titleVal = record[F.TITLE_LEVEL]?.value || '';

      if (unitVal && titleVal) return event;

      const missing = [];
      if (!unitVal)  missing.push('單位名稱');
      if (!titleVal) missing.push('職級');

      await Swal.fire({
        icon:              'warning',
        title:             '必填欄位未填寫',
        html:              `請填寫：<strong>${missing.join('、')}</strong>`,
        confirmButtonText: '確定',
      });

      return null; // null = 中止儲存
    }),
  );
})();
