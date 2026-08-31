/**
 * 表單路由設定表（App 736 form_route_config）— 新增／編輯頁
 *
 * 1. route_steps 子表格逐列：依「段類型」淡化不相關的欄位（子表格內欄位無法用
 *    setFieldShown，改以 DOM 淡化 + pointer-events 停用）
 * 2. 「指定角色」格子掛 core/07-role-picker.js 的可搜尋下拉（畫面顯示 role_name，寫入 role_id）
 * 3. submit 驗證：段類型與欄位配對、「全員會簽」僅限指定角色段、指定角色須存在、至少一列
 * 4. 載入時比對 stop_at_title_level／skip_title_levels 選項與 685 title_level 是否同步（不一致警告）
 *
 * 【子表格 DOM 定位】不寫死欄位 ID。每個 <tr> 內的儲存格用 `control-<型別>-field-gaia`
 *   class 分類；兩個 single_check（段類型／簽核模式）再用 radio 的 value 區分。
 *   欄位重建 ID 會變、但型別與選項不會，故此法比寫死 ID 穩。
 *
 * 【影響的欄位】
 *   - route_steps.role_id：由 RolePicker 寫入
 *
 * 【依賴】
 *   - core/01-config.js（Config）
 *   - core/02-api-client.js（ApiClient.getAllRoles，共用角色快取）
 *   - core/04-utils.js（Utils）
 *   - core/07-role-picker.js（RolePicker）← 需排在本檔之前載入
 *
 * 【變更履歷】
 *   2026-09-01  Jimmy/Claude  初版（P8 Phase B）
 *   2026-09-01  Jimmy/Claude  段類型切換時，一併清掉不屬於新段類型的欄位值
 *                              （員工鏈段→清 role_id / 全員會簽；指定角色段→清 stop_at / skip），
 *                              只淡化不清值 submit 會被 validateRouteSteps 擋
 */
(() => {
  'use strict';

  const {
    APP_ID,
    ROLE_FIELDS: RF,
    ROUTE_FIELDS: RTF,
    ROUTE_STEP_FIELDS: RSF,
    SEGMENT_TYPE_OPTIONS: SEG,
    STEP_SIGNING_MODE_OPTIONS: SSM,
  } = window.ApprovalRouting.Config;

  const { getAllRoles } = window.ApprovalRouting.ApiClient;
  const { safeHandler, kintoneApi, showWarning, pushSubmitError, flushSubmitErrors } =
    window.ApprovalRouting.Utils;

  const UNGROUPED_LABEL = '（未分類）';
  const WIRED_ATTR = 'arRouteWired';

  // 依 show 時載入，wireRows / submit 共用
  let roleOptions = [];        // [{ id, name, group }] 已去重
  let roleNameById = new Map();  // role_id → role_name（未去重，初始值顯示用）
  let knownRoleIds = new Set();  // 所有啟用中角色 role_id

  // -------------------------------------------------------------------
  // 角色清單（複用 core 的角色快取，不另開查詢）
  // -------------------------------------------------------------------

  const loadRoleOptions = async () => {
    const map = await getAllRoles(); // Map<roleId, record>，已快取（TTL + singleton）

    const recs = [...map.values()].sort((a, b) => {
      const ua = a[RF.UNIT_NAME]?.value || '';
      const ub = b[RF.UNIT_NAME]?.value || '';
      return (
        ua.localeCompare(ub, 'zh-Hant') ||
        a[RF.ROLE_NAME].value.localeCompare(b[RF.ROLE_NAME].value, 'zh-Hant')
      );
    });

    const nameById = new Map();
    const seen = new Set();
    const options = [];

    for (const r of recs) {
      const id = r[RF.ROLE_ID].value;
      const name = r[RF.ROLE_NAME].value;
      nameById.set(id, name);
      if (seen.has(name)) continue; // 完整 role_name 去重（同名＝同一關，見對話脈絡 §9.2）
      seen.add(name);
      options.push({ id, name, group: r[RF.UNIT_NAME]?.value || UNGROUPED_LABEL });
    }

    roleOptions = options;
    roleNameById = nameById;
    knownRoleIds = new Set(map.keys());
  };

  // -------------------------------------------------------------------
  // 子表格 DOM
  // -------------------------------------------------------------------

  /** 目前編輯中的 route_steps 子表格 <table>（736 只有這一個子表格） */
  const getSubtable = () => document.querySelector('table.edit-subtable-gaia');

  /** 取某列已勾選的 radio 值 */
  const checkedRadio = (cell) =>
    cell?.querySelector('input[type="radio"]:checked')?.value || '';

  /**
   * 把一個 <tr> 的六個儲存格依型別分類
   * @param {HTMLElement} tr
   * @returns {{stepNo, segType, stopAt, skip, roleId, signMode} | null}
   */
  const classifyCells = (tr) => {
    const out = {};
    tr.querySelectorAll('td > div.control-gaia').forEach((ctrl) => {
      const c = ctrl.className;
      if (c.includes('control-decimal-field-gaia')) out.stepNo = ctrl;
      else if (c.includes('control-single_select-field-gaia')) out.stopAt = ctrl;
      else if (c.includes('control-multiple_select-field-gaia')) out.skip = ctrl;
      else if (c.includes('control-single_line_text-field-gaia')) out.roleId = ctrl;
      else if (c.includes('control-single_check-field-gaia')) {
        const vals = [...ctrl.querySelectorAll('input[type="radio"]')].map((r) => r.value);
        if (vals.includes(SEG.EMPLOYEE_CHAIN)) out.segType = ctrl;
        else out.signMode = ctrl;
      }
    });
    return out.roleId && out.segType ? out : null;
  };

  /** 淡化 / 還原一個儲存格 */
  const setDimmed = (cell, dim) => {
    if (!cell) return;
    cell.style.opacity = dim ? '0.35' : '';
    cell.style.pointerEvents = dim ? 'none' : '';
  };

  /** 依該列段類型，淡化不相關的欄位 */
  const applyRowVisibility = (cells) => {
    const seg = checkedRadio(cells.segType);
    const isEmp = seg === SEG.EMPLOYEE_CHAIN;
    const isFix = seg === SEG.FIXED_ROLE;
    setDimmed(cells.stopAt, !isEmp);
    setDimmed(cells.skip, !isEmp);
    setDimmed(cells.roleId, !isFix);
  };

  /** 目前 <tr> 在 tbody 中的索引（對應 record.route_steps.value 的順序） */
  const rowIndex = (tr) => [...tr.parentElement.children].indexOf(tr);

  /**
   * 段類型切換後，清掉不屬於新段類型的欄位值。
   * 只淡化不夠——值留著 submit 會被 validateRouteSteps 擋（「員工鏈段不需要指定角色」等）。
   * stop_at（下拉）、skip（複選）是 kintone 原生小工具，用 get()/set() 清最可靠；
   * 只有真的有殘值時才 set()（避免每次切換都重繪）。
   */
  const clearIrrelevantCells = (tr) => {
    const cells = classifyCells(tr);
    if (!cells) return;
    const seg = checkedRadio(cells.segType);

    const rec = kintone.app.record.get();
    const v = rec.record[RTF.ROUTE_STEPS].value[rowIndex(tr)]?.value;
    if (!v) return;

    let dirty = false;
    if (seg === SEG.EMPLOYEE_CHAIN) {
      if (v[RSF.ROLE_ID].value) { v[RSF.ROLE_ID].value = ''; dirty = true; }
      if (v[RSF.STEP_SIGNING_MODE].value === SSM.ALL) {
        v[RSF.STEP_SIGNING_MODE].value = SSM.INHERIT; // 全員會簽只能配指定角色段
        dirty = true;
      }
    } else if (seg === SEG.FIXED_ROLE) {
      if (v[RSF.STOP_AT_TITLE_LEVEL].value) { v[RSF.STOP_AT_TITLE_LEVEL].value = ''; dirty = true; }
      if ((v[RSF.SKIP_TITLE_LEVELS].value || []).length) { v[RSF.SKIP_TITLE_LEVELS].value = []; dirty = true; }
    }

    if (dirty) kintone.app.record.set(rec); // 會重繪 → observer 重掛
  };

  /** 在「指定角色」格子掛上 RolePicker，隱藏原生輸入框 */
  const mountRolePicker = (tr, cells) => {
    const nativeInput = cells.roleId.querySelector('input.input-text-cybozu');
    if (!nativeInput) return;
    nativeInput.style.display = 'none';

    const picker = window.ApprovalRouting.RolePicker.create({
      options: roleOptions,
      initialId: nativeInput.value,
      initialName: roleNameById.get(nativeInput.value) || '',
      placeholder: '輸入角色名稱搜尋…',
      emptyText: '找不到符合的角色',
      ungroupedLabel: UNGROUPED_LABEL,
      minWidth: 200,
      onSelect: (opt) => {
        const rec = kintone.app.record.get();
        const rows = rec.record[RTF.ROUTE_STEPS].value;
        const i = rowIndex(tr);
        if (rows[i]) {
          rows[i].value[RSF.ROLE_ID].value = opt.id;
          kintone.app.record.set(rec); // 會重繪子表格 → observer 會重掛 picker（顯示新值）
        }
      },
    });

    picker.el.style.padding = '2px 0';
    (cells.roleId.querySelector('.control-value-gaia') || cells.roleId).appendChild(picker.el);
  };

  /** 掃描所有子表格列，替尚未處理的列掛 picker + 淡化 + 綁段類型切換 */
  const wireRows = () => {
    const table = getSubtable();
    if (!table) return;

    table.querySelectorAll('tbody > tr').forEach((tr) => {
      if (tr.dataset[WIRED_ATTR]) return;
      const cells = classifyCells(tr);
      if (!cells) return; // DOM 還沒渲染完
      tr.dataset[WIRED_ATTR] = '1';

      mountRolePicker(tr, cells);

      cells.segType.querySelectorAll('input[type="radio"]').forEach((r) =>
        r.addEventListener('change', () => {
          applyRowVisibility(cells);   // 立即淡化（在 set() 重繪前先給回饋）
          clearIrrelevantCells(tr);    // 清掉不屬於新段類型的殘值
        })
      );
      applyRowVisibility(cells);
    });
  };

  /**
   * 監看整個編輯表單：子表格列增刪、kintone.app.record.set() 重繪都會動到 DOM，
   * 統一用一個 debounced observer 重跑 wireRows（已處理的列有 WIRED_ATTR，不會重掛）
   */
  let observer = null;
  const startObserver = () => {
    const formEl =
      document.querySelector('.gaia-argoui-app-edit-record') ||
      document.querySelector('#record-gaia');
    if (!formEl || observer) return;

    let timer = null;
    observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        observer.disconnect();
        // set() 重繪後舊 <tr> 整批換新（沒有 WIRED_ATTR），會重新掛一次
        wireRows();
        observer.observe(formEl, { childList: true, subtree: true });
      }, 80);
    });
    observer.observe(formEl, { childList: true, subtree: true });
  };

  // -------------------------------------------------------------------
  // 選項一致性檢查（stop_at_title_level / skip_title_levels vs 685 title_level）
  // -------------------------------------------------------------------

  const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

  const checkTitleLevelSync = async () => {
    try {
      const [f736, f685] = await Promise.all([
        kintoneApi('/k/v1/app/form/fields', 'GET', { app: kintone.app.getId() }),
        kintoneApi('/k/v1/app/form/fields', 'GET', { app: APP_ID.ROLE_DEFINITION }),
      ]);

      const stepFields = f736.properties[RTF.ROUTE_STEPS].fields;
      const opt685 = new Set(Object.keys(f685.properties[RF.TITLE_LEVEL].options || {}));
      const optStop = new Set(Object.keys(stepFields[RSF.STOP_AT_TITLE_LEVEL].options || {}));
      const optSkip = new Set(Object.keys(stepFields[RSF.SKIP_TITLE_LEVELS].options || {}));

      const bad = [];
      if (!setEq(optStop, opt685)) bad.push('「簽到職稱為止」');
      if (!setEq(optSkip, opt685)) bad.push('「跳過的職稱」');
      if (bad.length) {
        await showWarning(
          '職稱選項與角色定義表不同步',
          `${bad.join('、')}的選項和角色定義表（685）的「職稱」不一致。<br>` +
            '請把選項調整成與 685 相同，否則員工鏈段的截止／跳關會比對不到。'
        );
      }
    } catch (err) {
      console.warn('[ApprovalRouting] 職稱選項一致性檢查略過：', err?.message || err);
    }
  };

  // -------------------------------------------------------------------
  // submit 驗證（純函式，供測試）
  // -------------------------------------------------------------------

  /**
   * @param {Array} rows - event.record.route_steps.value
   * @param {Set<string>|null} known - 所有啟用中角色 role_id；null 時略過存在性檢查
   * @returns {string[]} 錯誤訊息（空陣列＝通過）
   */
  const validateRouteSteps = (rows, known) => {
    const errs = [];
    if (!rows || rows.length === 0) {
      errs.push('「路由關卡」至少要有一列。');
      return errs;
    }

    rows.forEach((row, idx) => {
      const n = idx + 1;
      const v = row.value || {};
      const seg = v[RSF.SEGMENT_TYPE]?.value || '';
      const roleId = (v[RSF.ROLE_ID]?.value || '').trim();
      const stopAt = v[RSF.STOP_AT_TITLE_LEVEL]?.value || '';
      const skip = v[RSF.SKIP_TITLE_LEVELS]?.value || [];
      const mode = v[RSF.STEP_SIGNING_MODE]?.value || '';

      if (seg === SEG.EMPLOYEE_CHAIN) {
        if (roleId) errs.push(`第 ${n} 列：員工鏈段不需要「指定角色」，請清空。`);
        if (mode === SSM.ALL) errs.push(`第 ${n} 列：「全員會簽」僅限指定角色段。`);
      } else if (seg === SEG.FIXED_ROLE) {
        if (!roleId) {
          errs.push(`第 ${n} 列：指定角色段必須選一個角色。`);
        } else if (known && !known.has(roleId)) {
          errs.push(`第 ${n} 列：找不到啟用中的角色（${roleId}）。`);
        }
        if (stopAt) errs.push(`第 ${n} 列：指定角色段不需要「簽到職稱為止」，請清空。`);
        if (skip.length) errs.push(`第 ${n} 列：指定角色段不需要「跳過的職稱」，請清空。`);
      } else {
        errs.push(`第 ${n} 列：請選擇「段類型」。`);
      }
    });

    return errs;
  };

  // -------------------------------------------------------------------
  // 事件綁定
  // -------------------------------------------------------------------

  kintone.events.on(
    ['app.record.create.show', 'app.record.edit.show'],
    safeHandler(async (event) => {
      await loadRoleOptions();
      setTimeout(() => {
        wireRows();
        startObserver();
      }, 0);
      checkTitleLevelSync(); // fire-and-forget
      return event;
    })
  );

  kintone.events.on(
    ['app.record.create.submit', 'app.record.edit.submit'],
    safeHandler(async (event) => {
      let known = null;
      try {
        await loadRoleOptions();
        known = knownRoleIds;
      } catch (_) {
        /* 查詢失敗 → 只驗結構、不驗存在性 */
      }

      for (const msg of validateRouteSteps(event.record[RTF.ROUTE_STEPS].value, known)) {
        pushSubmitError(event, msg);
      }
      return flushSubmitErrors(event);
    })
  );

  // 供測試
  window.ApprovalRouting = window.ApprovalRouting || {};
  window.ApprovalRouting.RouteFormInternals = Object.freeze({ validateRouteSteps });
})();
