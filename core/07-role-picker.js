/**
 * 共用元件 — 可搜尋分組下拉（Role Picker）
 *
 * 以 input + 浮動清單取代原生 select：打字過濾、依「群組」分段（組間插標題）、
 * 滑鼠點選、↑↓ 鍵移動、Enter 確認、Esc 取消、失焦還原最後有效選取。
 *
 * 純 UI，不認得 kintone 欄位。呼叫端給選項與 onSelect callback，
 * 由呼叫端決定選到之後要寫哪個欄位、要不要刷新別的區塊。
 *
 * 使用者：
 *   - apps/role-definition/03-next-role-dropdown.js（next_role_id）
 *   - apps/form-route/01-route-form.js（route_steps 子表格的 role_id）
 *   - 之後 docs/07 代理人設定表
 *
 * 【依賴】
 *   - 無（純 DOM）。掛在 core 是因為多個 App 共用。
 *
 * 【變更履歷】
 *   2026-09-01  Jimmy/Claude  由 03-next-role-dropdown.js 的 buildDropdownUI 抽出，
 *                              補上 ↑↓／Enter／Esc 鍵盤操作
 */
(() => {
  'use strict';

  const DEFAULTS = Object.freeze({
    placeholder:    '輸入名稱搜尋…',
    emptyText:      '找不到符合的項目',
    ungroupedLabel: '（未分類）',
    minWidth:       280,
    blurDelayMs:    200,   // 讓 mousedown 選取先於 blur 收起
  });

  /**
   * 建立一個可搜尋分組下拉
   *
   * @param {Object} opts
   * @param {Array<{id: string, name: string, group?: string}>} opts.options
   *        選項清單，**必須已依 group 排序**（同 group 連續），本元件只負責在 group 切換處插標題
   * @param {string} [opts.initialId='']    初始選中的 id（僅記錄用，顯示以 initialName 為準）
   * @param {string} [opts.initialName='']  初始顯示文字（id 可能不在 options 內，例如同名去重）
   * @param {(option: {id: string, name: string, group?: string}) => (void|Promise<void>)} opts.onSelect
   *        選到一個選項時呼叫
   * @param {string} [opts.labelText]       有值才渲染 <label>
   * @param {string} [opts.placeholder]
   * @param {string} [opts.emptyText]
   * @param {string} [opts.ungroupedLabel]  group 空白時顯示的標題
   * @param {number} [opts.minWidth]
   * @param {string} [opts.inputId]         需要時給 input 一個固定 id
   * @returns {{
   *   el: HTMLElement,                     // 外層容器，呼叫端自行 mount
   *   getValue: () => {id: string, name: string},
   *   setSelection: (id: string, name: string) => void,
   *   open: () => void,
   *   close: () => void,
   *   destroy: () => void,
   * }}
   */
  const create = (opts) => {
    const cfg = { ...DEFAULTS, ...opts };
    const options = Array.isArray(opts.options) ? opts.options : [];
    const onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : () => {};

    let selectedId = opts.initialId || '';
    let selectedName = opts.initialName || '';
    let activeIndex = -1;        // 目前鍵盤高亮的「選項」索引（對 filteredItems，不含標題）
    let filteredItems = [];      // 目前面板上可選的選項（過濾後）

    // --- DOM ---
    const container = document.createElement('div');
    container.style.cssText = 'padding: 8px 0;';

    if (cfg.labelText) {
      const label = document.createElement('label');
      label.textContent = cfg.labelText;
      label.style.cssText =
        'font-weight: bold; font-size: 14px; display: block; margin-bottom: 6px;';
      container.appendChild(label);
    }

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position: relative; display: inline-block;';

    const input = document.createElement('input');
    input.type = 'text';
    if (cfg.inputId) input.id = cfg.inputId;
    input.placeholder = cfg.placeholder;
    input.autocomplete = 'off';
    input.value = selectedName;
    input.style.cssText =
      `font-size: 14px; padding: 6px 12px; min-width: ${cfg.minWidth}px; ` +
      'border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box;';

    const panel = document.createElement('div');
    panel.style.cssText =
      `position: absolute; top: calc(100% + 2px); left: 0; min-width: ${cfg.minWidth}px; ` +
      'max-height: 240px; overflow-y: auto; background: #fff; ' +
      'border: 1px solid #ccc; border-radius: 4px; ' +
      'box-shadow: 0 4px 12px rgba(0,0,0,.12); z-index: 9999; display: none;';

    // --- 繪製 ---

    /** 依 activeIndex 更新每個選項列的高亮 */
    const paintActive = () => {
      const rows = panel.querySelectorAll('[data-opt-index]');
      rows.forEach((row) => {
        const i = Number(row.dataset.optIndex);
        const isActive = i === activeIndex;
        const isSelected = filteredItems[i]?.name === selectedName;
        row.style.background = isActive ? '#f0f4ff' : (isSelected ? '#e0e7ff' : '');
        row.style.fontWeight = isSelected ? '600' : '';
        if (isActive) row.scrollIntoView?.({ block: 'nearest' });
      });
    };

    /** 依關鍵字重繪清單 */
    const renderItems = (keyword) => {
      const kw = (keyword || '').trim();
      filteredItems = kw ? options.filter((o) => o.name.includes(kw)) : options.slice();
      activeIndex = filteredItems.length ? 0 : -1;

      panel.innerHTML = '';

      if (filteredItems.length === 0) {
        const empty = document.createElement('div');
        empty.textContent = cfg.emptyText;
        empty.style.cssText = 'padding: 10px 12px; color: #999; font-size: 14px;';
        panel.appendChild(empty);
        return;
      }

      let currentGroup = null;
      filteredItems.forEach((opt, i) => {
        const group = opt.group || cfg.ungroupedLabel;
        if (group !== currentGroup) {
          currentGroup = group;
          const header = document.createElement('div');
          header.textContent = group;
          header.dataset.groupHeader = '1';
          header.style.cssText =
            'padding: 6px 12px; font-size: 12px; font-weight: 700; color: #555; ' +
            'background: #f5f5f5; position: sticky; top: 0; z-index: 1;';
          panel.appendChild(header);
        }

        const row = document.createElement('div');
        row.textContent = opt.name;
        row.dataset.optIndex = String(i);
        row.style.cssText = 'padding: 8px 12px 8px 20px; font-size: 14px; cursor: pointer;';

        row.addEventListener('mouseenter', () => { activeIndex = i; paintActive(); });
        // mousedown 先於 blur，preventDefault 確保選取在收起之前完成
        row.addEventListener('mousedown', (e) => {
          e.preventDefault();
          commit(filteredItems[i]);
        });

        panel.appendChild(row);
      });

      paintActive();
    };

    // --- 行為 ---

    const open = () => { renderItems(input.value === selectedName ? '' : input.value); panel.style.display = 'block'; };
    const close = () => { panel.style.display = 'none'; };

    /** 確定選取某選項 */
    const commit = (opt) => {
      if (!opt) return;
      selectedId = opt.id;
      selectedName = opt.name;
      input.value = opt.name;
      close();
      onSelect(opt);
    };

    /** 還原成最後一次有效選取（輸入了無效字串時） */
    const restore = () => {
      const matched = options.find((o) => o.name === input.value);
      if (!matched) input.value = selectedName || '';
    };

    input.addEventListener('focus', open);
    input.addEventListener('input', () => { renderItems(input.value); panel.style.display = 'block'; });
    input.addEventListener('blur', () => {
      setTimeout(() => { close(); restore(); }, cfg.blurDelayMs);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (panel.style.display === 'none') { open(); return; }
        if (!filteredItems.length) return;
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        activeIndex = (activeIndex + dir + filteredItems.length) % filteredItems.length;
        paintActive();
      } else if (e.key === 'Enter') {
        if (panel.style.display !== 'none' && activeIndex >= 0) {
          e.preventDefault();
          commit(filteredItems[activeIndex]);
        }
      } else if (e.key === 'Escape') {
        close();
        restore();
      }
    });

    wrapper.appendChild(input);
    wrapper.appendChild(panel);
    container.appendChild(wrapper);

    return {
      el: container,
      getValue: () => ({ id: selectedId, name: selectedName }),
      setSelection: (id, name) => {
        selectedId = id || '';
        selectedName = name || '';
        input.value = selectedName;
      },
      open,
      close,
      destroy: () => { container.remove(); },
    };
  };

  window.ApprovalRouting = window.ApprovalRouting || {};
  window.ApprovalRouting.RolePicker = Object.freeze({ create });
})();
