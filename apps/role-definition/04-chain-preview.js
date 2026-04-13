/**
 * 角色定義表 — 簽核鏈視覺化預覽
 *
 * 在詳情頁 / 編輯頁的空白欄位（chain_preview）中，
 * 從當前角色沿著 next_role_id 走到終點，繪製視覺化卡片。
 *
 * 【影響的欄位】
 *   - chain_preview（空白欄位）：插入視覺化 DOM
 *
 * 【依賴】
 *   - core/01-config.js（Config）
 *   - core/04-utils.js（Utils）
 *
 * 【變更履歷】
 *   2026-04-14  Jimmy/Claude  初版建立
 */
(() => {
  'use strict';

  const { APP_ID, ROLE_FIELDS: F, CHECKBOX } = window.ApprovalRouting.Config;
  const { safeHandler, kintoneApi } = window.ApprovalRouting.Utils;

  const PREVIEW_CONTAINER_ID = 'ar-chain-preview-content';
  const MAX_DEPTH = 20; // 防無限迴圈

  /**
   * 取得所有啟用角色，建成 Map（roleId → record）
   * @returns {Promise<Map<string, {roleId: string, roleName: string, nextRoleId: string, isChainEnd: boolean}>>}
   */
  const fetchRoleMap = async () => {
    const resp = await kintoneApi('/k/v1/records', 'GET', {
      app: APP_ID.ROLE_DEFINITION,
      fields: [F.ROLE_ID, F.ROLE_NAME, F.NEXT_ROLE_ID, F.IS_CHAIN_END],
      query: `${F.IS_ACTIVE} in ("${CHECKBOX.ACTIVE}") limit 500`,
    });

    const map = new Map();
    for (const rec of resp.records) {
      const isEnd = Array.isArray(rec[F.IS_CHAIN_END].value) &&
                    rec[F.IS_CHAIN_END].value.includes(CHECKBOX.CHAIN_END);
      map.set(rec[F.ROLE_ID].value, {
        roleId: rec[F.ROLE_ID].value,
        roleName: rec[F.ROLE_NAME].value,
        nextRoleId: rec[F.NEXT_ROLE_ID].value || '',
        isChainEnd: isEnd,
      });
    }
    return map;
  };

  /**
   * 從指定角色沿鏈走到終點
   * @param {Map} roleMap
   * @param {string} startRoleId
   * @returns {{chain: Array, error: string|null}}
   */
  const walkChain = (roleMap, startRoleId) => {
    const chain = [];
    const visited = new Set();
    let currentId = startRoleId;

    for (let i = 0; i < MAX_DEPTH; i++) {
      if (!currentId) break;

      if (visited.has(currentId)) {
        return { chain, error: `偵測到循環！${currentId} 重複出現` };
      }

      const role = roleMap.get(currentId);
      if (!role) {
        chain.push({ roleId: currentId, roleName: `（找不到: ${currentId}）`, isChainEnd: false, isBroken: true });
        return { chain, error: `角色 ${currentId} 不存在或未啟用` };
      }

      visited.add(currentId);
      chain.push(role);

      if (role.isChainEnd) break;
      currentId = role.nextRoleId;
    }

    if (chain.length >= MAX_DEPTH) {
      return { chain, error: `鏈深度超過 ${MAX_DEPTH}，可能有循環` };
    }

    return { chain, error: null };
  };

  /**
   * 產生視覺化 HTML
   * @param {Array} chain
   * @param {string|null} error
   * @param {string} currentRoleId - 目前正在看的角色（高亮用）
   * @returns {string}
   */
  const renderChainHtml = (chain, error, currentRoleId) => {
    if (chain.length === 0) {
      return '<div style="color: #999; padding: 12px;">尚無簽核鏈資料</div>';
    }

    const cards = chain.map((role, idx) => {
      const isCurrent = role.roleId === currentRoleId;
      const isEnd = role.isChainEnd;
      const isBroken = role.isBroken;

      let bgColor = '#f8f9fa';
      let borderColor = '#dee2e6';
      let badge = '';

      if (isCurrent) {
        bgColor = '#e3f2fd';
        borderColor = '#2196f3';
        badge = '<span style="background:#2196f3; color:#fff; font-size:11px; padding:2px 6px; border-radius:3px; margin-left:6px;">目前</span>';
      }
      if (isEnd) {
        bgColor = '#e8f5e9';
        borderColor = '#4caf50';
        badge += '<span style="background:#4caf50; color:#fff; font-size:11px; padding:2px 6px; border-radius:3px; margin-left:6px;">終點</span>';
      }
      if (isBroken) {
        bgColor = '#ffebee';
        borderColor = '#f44336';
        badge = '<span style="background:#f44336; color:#fff; font-size:11px; padding:2px 6px; border-radius:3px; margin-left:6px;">斷鏈</span>';
      }

      const card = `
        <div style="display:inline-flex; align-items:center; background:${bgColor}; border:2px solid ${borderColor}; border-radius:8px; padding:10px 16px; min-width:120px;">
          <div>
            <div style="font-size:15px; font-weight:bold;">${role.roleName}${badge}</div>
            <div style="font-size:11px; color:#999; margin-top:2px;">${role.roleId}</div>
          </div>
        </div>
      `;

      const arrow = idx < chain.length - 1
        ? '<span style="display:inline-flex; align-items:center; margin:0 6px; font-size:20px; color:#aaa;">→</span>'
        : '';

      return card + arrow;
    }).join('');

    const errorHtml = error
      ? `<div style="margin-top:8px; padding:8px 12px; background:#fff3cd; border-radius:4px; color:#856404; font-size:13px;">⚠ ${error}</div>`
      : '';

    return `
      <div style="padding: 12px 0;">
        <div style="font-size:13px; color:#666; margin-bottom:8px;">簽核鏈預覽（從此角色開始）：</div>
        <div style="display:flex; flex-wrap:wrap; align-items:center; gap:4px;">
          ${cards}
        </div>
        ${errorHtml}
      </div>
    `;
  };

  /**
   * 將預覽插入空白欄位
   */
  const mountPreview = (html) => {
    // 移除舊的
    const old = document.getElementById(PREVIEW_CONTAINER_ID);
    if (old) old.remove();

    const container = document.createElement('div');
    container.id = PREVIEW_CONTAINER_ID;
    container.innerHTML = html;

    // 嘗試插入到 chain_preview 空白欄位
    const previewEl = document.getElementById('chain_preview');
    if (previewEl) {
      previewEl.innerHTML = '';
      previewEl.appendChild(container);
      return;
    }

    // fallback: 表單底部
    const formEl = document.querySelector('.gaia-argoui-app-edit-record') ||
                   document.querySelector('.gaia-argoui-app-show-detail') ||
                   document.querySelector('#record-gaia');
    if (formEl) formEl.appendChild(container);
  };

  /**
   * 主流程：取資料 → 走鏈 → 渲染
   */
  const renderChainPreview = async (currentRoleId) => {
    if (!currentRoleId) {
      mountPreview('<div style="color:#999; padding:12px;">儲存後即可預覽簽核鏈</div>');
      return;
    }

    const roleMap = await fetchRoleMap();
    const { chain, error } = walkChain(roleMap, currentRoleId);
    const html = renderChainHtml(chain, error, currentRoleId);
    mountPreview(html);
  };

  // --- 事件綁定 ---

  // 詳情頁：顯示預覽
  kintone.events.on(
    ['app.record.detail.show'],
    safeHandler(async (event) => {
      const roleId = event.record[F.ROLE_ID].value;
      await renderChainPreview(roleId);
      return event;
    })
  );

  // 編輯頁：顯示預覽（即時）
  kintone.events.on(
    ['app.record.edit.show'],
    safeHandler(async (event) => {
      const roleId = event.record[F.ROLE_ID].value;
      await renderChainPreview(roleId);
      return event;
    })
  );

  // 新增頁：尚未儲存，顯示提示文字
  kintone.events.on(
    ['app.record.create.show'],
    safeHandler(async (event) => {
      setTimeout(() => {
        mountPreview('<div style="color:#999; padding:12px;">儲存後即可預覽簽核鏈</div>');
      }, 0);
      return event;
    })
  );

  // next_role_id 或 is_chain_end 變更時，重新渲染（編輯頁即時預覽）
  kintone.events.on(
    [
      `app.record.edit.change.${F.IS_CHAIN_END}`,
      `app.record.edit.change.${F.NEXT_ROLE_ID}`,
    ],
    safeHandler(async (event) => {
      const roleId = event.record[F.ROLE_ID].value;
      await renderChainPreview(roleId);
      return event;
    })
  );
})();
