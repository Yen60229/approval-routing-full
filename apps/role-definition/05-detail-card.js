/**
 * 角色定義表 — 詳情頁自訂卡片 UI
 *
 * 【影響的欄位】
 *   - 隱藏所有原生欄位（detail.show）
 *   - chain_preview（space 欄位）：注入自訂卡片
 *   - #ar-chain-preview-slot：由 04-chain-preview.js 填入鏈預覽
 *
 * 【依賴】
 *   - core/01-config.js（Config）
 *   - core/04-utils.js（Utils.safeHandler）
 *   - apps/role-definition/04-chain-preview.js（渲染鏈預覽至 slot）
 *
 * 【變更履歷】
 *   2026-04-18  Jimmy/Claude  初版建立
 *   2026-04-19  Jimmy/Claude  終點角色隱藏鏈預覽；加入 CONFIG.CARD_MIN_WIDTH；加 box-shadow 對比灰底
 *   2026-04-19  Jimmy/Claude  改為 mountNativeUserField：將原生 holder_user DOM 移入卡片，保留原生 popup
 */
(() => {
  'use strict';

  const {
    ROLE_FIELDS: F,
    HOLDER_TYPE_OPTIONS: HT,
    CHECKBOX,
  } = window.ApprovalRouting.Config;
  const { safeHandler } = window.ApprovalRouting.Utils;

  const CONFIG = Object.freeze({
    CARD_MIN_WIDTH: '680px', // ← 卡片最小寬度，依需求調整
  });

  const ALL_FIELDS = [
    F.ROLE_NAME,
    F.ROLE_ID,
    F.HOLDER_TYPE,
    F.HOLDER_GROUP,
    F.HOLDER_USER,
    F.SIGNING_MODE,
    F.IS_CHAIN_END,
    F.IS_ACTIVE,
    F.NEXT_ROLE_ID,
  ];

  const hideAllFields = () => {
    ALL_FIELDS.forEach((code) => kintone.app.record.setFieldShown(code, false));
  };

  const row = (label, valueHtml) => `
    <div style="display:flex;align-items:flex-start;padding:14px 0;border-bottom:1px solid #ebebeb;">
      <div style="width:130px;font-size:16px;color:#555;font-weight:600;flex-shrink:0;padding-top:1px;">${label}</div>
      <div style="font-size:17px;color:#1a1a1a;line-height:1.6;">${valueHtml}</div>
    </div>`;

  const badge = (on, labelOn, labelOff) =>
    on
      ? `<span style="background:#e6f4ea;color:#137333;padding:5px 18px;border-radius:14px;font-size:15px;font-weight:700;">✅ ${labelOn}</span>`
      : `<span style="background:#f1f3f4;color:#80868b;padding:5px 18px;border-radius:14px;font-size:15px;">— ${labelOff}</span>`;

  const sectionTitle = (text) =>
    `<div style="font-size:13px;font-weight:700;color:#999;letter-spacing:1.5px;padding:22px 0 2px;border-top:2px solid #f4f4f4;margin-top:4px;">${text}</div>`;

  const fetchGroupMembersMap = async (groups) => {
    const map = {};
    await Promise.all(
      groups.map(async (g) => {
        try {
          // 【修正重點】User API 的路徑是 /v1/group/users，沒有 /k
          const resp = await kintone.api('/v1/group/users', 'GET', {
            code: g.code,
          });
          const users = resp.users || [];

          map[g.code] = users;
        } catch (error) {
          console.warn(
            `[AR-05] 無法取得群組 ${g.name || g.code} 的成員:`,
            error,
          );
          map[g.code] = []; // 發生例外時，確保後續 UI 渲染不會報錯
        }
      }),
    );
    return map;
  };
  const buildCardHtml = (record, groupMembersMap = {}) => {
    const roleName = record[F.ROLE_NAME].value || '（未命名）';
    const roleId = record[F.ROLE_ID].value || '';
    const holderType = record[F.HOLDER_TYPE].value || '';
    const isGroup = holderType === HT.GROUP;
    const signingMode = record[F.SIGNING_MODE].value || '—';
    const isEnd = (record[F.IS_CHAIN_END].value ?? []).includes(
      CHECKBOX.CHAIN_END,
    );
    const isActive = (record[F.IS_ACTIVE].value ?? []).includes(
      CHECKBOX.ACTIVE,
    );

    // 簽核者 chip
    let holderHtml = '<span style="color:#bbb;">（未設定）</span>';
    if (isGroup) {
      const arr = record[F.HOLDER_GROUP].value ?? [];
      if (arr.length) {
        holderHtml = arr
          .map((g) => {
            const members = groupMembersMap[g.code] || [];

            // 將成員轉化為可點擊的連結「Chip」
            const membersHtml = members.length
              ? members
                  .map(
                    (m) => `
                <a href="/users/${m.code}"
                   target="_blank"
                   title="點擊查看 ${m.name} 的個人資料"
                   style="color: #1a73e8; text-decoration: none; display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 4px; border: 1px solid transparent; transition: all 0.2s;"
                   onmouseover="this.style.background='#f1f3f4'; this.style.borderColor='#dcdfe6';"
                   onmouseout="this.style.background='transparent'; this.style.borderColor='transparent';">
                  <span style="font-size: 14px; font-weight: 500;">${m.name}</span>
                </a>
              `,
                  )
                  .join('') // 這裡不用間隔符號，改用 Flex 容器的 gap
              : '<span style="color:#999; font-size: 14px; padding-left: 8px;">（此群組暫無成員）</span>';

            return `
            <div style="display: flex; align-items: center; flex-wrap: wrap; margin-bottom: 12px; gap: 8px;">
              <div style="display:inline-flex;align-items:center;gap:5px;background:#e8f0fe;border:1px solid #c5d3f0;border-radius:6px;padding:4px 12px;font-size:15px;flex-shrink:0;">
                <img src="https://static.cybozu.com/contents/k/image/argo/form/userselect/group16.png" width="15" height="15">
                <span style="font-weight:600;color:#1967d2;">${g.name}</span>
              </div>

              <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 4px;">
                ${membersHtml}
              </div>
            </div>`;
          })
          .join('');
      }
    } else {
      const arr = record[F.HOLDER_USER].value ?? [];
      // 有值：用 slot 讓 mountNativeUserField() 把原生欄位移入；無值：顯示提示文字
      holderHtml = arr.length
        ? `<span id="ar-holder-user-native" style="display:inline-block;"></span>`
        : '<span style="color:#bbb;">（未設定）</span>';
    }

    const editUrl = `/k/${kintone.app.getId()}/show#record=${kintone.app.record.getId()}&mode=edit`;

    // 終點角色：不顯示簽核鏈預覽區塊，但保留隱藏 slot 供 04-chain-preview.js 掛載（避免覆蓋卡片）
    const chainSection = isEnd
      ? `<div id="ar-chain-preview-slot" style="display:none;"></div>`
      : `${sectionTitle('簽核流程預覽')}
          <div id="ar-chain-preview-slot" style="min-height:60px;padding:4px 0 8px;"></div>`;

    return `
      <div style="font-family:'Noto Sans TC',Arial,sans-serif;min-width:${CONFIG.CARD_MIN_WIDTH};margin:8px 0 28px;border-radius:12px;box-shadow:0 2px 16px rgba(0,0,0,0.13);">

        <!-- 標題列 -->
        <div style="background:linear-gradient(135deg,#1a73e8 0%,#0d5bba 100%);border-radius:12px 12px 0 0;padding:22px 28px;display:flex;justify-content:space-between;align-items:center;">
          <div>
            <div style="color:#fff;font-size:24px;font-weight:700;letter-spacing:0.5px;">${roleName}</div>
            <div style="color:rgba(255,255,255,0.65);font-size:13px;margin-top:5px;letter-spacing:1px;">${roleId}</div>
          </div>
          <a href="${editUrl}"
             style="display:inline-block;background:#fff;color:#1a73e8;border-radius:8px;padding:12px 26px;font-size:16px;font-weight:700;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,0.18);letter-spacing:0.5px;">
            ✏️&nbsp;編輯
          </a>
        </div>

        <!-- 內容區 -->
        <div style="background:#fff;border:1px solid #d0d0d0;border-top:none;border-radius:0 0 12px 12px;padding:0 28px 24px;">

          ${sectionTitle('簽核者設定')}
          ${row(
            '簽核者類型',
            `<span style="background:${isGroup ? '#e8f0fe' : '#fce8e6'};color:${isGroup ? '#1967d2' : '#c5221f'};padding:4px 16px;border-radius:14px;font-size:15px;font-weight:600;">
              ${holderType || '—'}
            </span>`,
          )}
          ${row('簽核者', holderHtml)}
          ${row('簽核模式', `<span style="font-size:16px;">${signingMode}</span>`)}

          ${sectionTitle('狀態')}
          ${row('是否終點', badge(isEnd, '是終點', '非終點'))}
          ${row('使用情況', badge(isActive, '啟用中', '停用'))}

          ${chainSection}

        </div>
      </div>`;
  };

  const findUserValueEl = () => {
    const fieldEl = document.querySelector(
      '[class*="control-user_select-field-gaia"]',
    );
    if (!fieldEl) return null;
    return (
      fieldEl.querySelector('[class*="control-value-gaia"]') ||
      fieldEl.querySelector('.entity-list-cybozu')
    );
  };

  const mountNativeUserField = () => {
    const slot = document.getElementById('ar-holder-user-native');
    if (!slot) {
      console.log('[AR-05] slot not found, skip');
      return;
    }

    const valueEl = findUserValueEl();
    if (!valueEl) {
      console.log('[AR-05] control-value-gaia not found in DOM');
      return;
    }

    const originalParent = valueEl.parentElement;
    slot.appendChild(valueEl);
    if (originalParent) originalParent.style.display = 'none';

    console.log('[AR-05] moved successfully. slot:', slot, 'valueEl:', valueEl);
  };

  // 動態注入 CSS 來解除 Kintone 原生版面的寬度封印
  const overrideKintoneLayoutWidth = () => {
    // 避免重複注入
    if (document.getElementById('ar-layout-override')) return;

    const style = document.createElement('style');
    style.id = 'ar-layout-override';
    style.innerHTML = `
      /* 針對詳情頁的外層容器解除 748px 限制 */
      .layout-gaia.showlayout-gaia {
        width: auto !important;
        /* 加上 max-width 保護，避免在大螢幕拉伸過度；margin: 0 auto 讓版面優雅置中 */
        max-width: 1100px !important;
        margin: 0 auto !important;
        padding: 0 24px; /* 兩側留一點呼吸空間 */
      }
    `;
    document.head.appendChild(style);
  };

  kintone.events.on(
    ['app.record.detail.show'],
    safeHandler(async (event) => {
      // 1. 解除版面寬度限制
      overrideKintoneLayoutWidth();
      document.getElementById('ar-next-role-container')?.remove();

      const isGroup = event.record[F.HOLDER_TYPE].value === HT.GROUP;
      const hasUsers = (event.record[F.HOLDER_USER].value ?? []).length > 0;
      const groupArr = event.record[F.HOLDER_GROUP].value ?? [];

      hideAllFields();

      const spaceEl = kintone.app.record.getSpaceElement('chain_preview');
      if (!spaceEl) return event;

      let groupMembersMap = {};

      // 若為群組模式且有選群組，則進行非同步 API 請求
      if (isGroup && groupArr.length > 0) {
        // [UX優化] 避免 API 延遲導致畫面空白，先顯示骨架或提示
        spaceEl.innerHTML = `
          <div style="font-family:'Noto Sans TC',Arial;padding:20px;color:#888;font-size:15px;text-align:center;">
            載入群組成員資料中...
          </div>`;

        groupMembersMap = await fetchGroupMembersMap(groupArr);
      }

      // 資料準備好後，正式渲染 UI
      spaceEl.innerHTML = buildCardHtml(event.record, groupMembersMap);

      if (!isGroup && hasUsers) {
        setTimeout(() => mountNativeUserField(), 0);
      }

      return event;
    }),
  );
})();
