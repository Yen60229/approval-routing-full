/**
 * 角色定義表 — 編輯／新增頁版面美化
 *
 * 【功能】
 *   1. 解除 kintone 預設 748px 寬度限制
 *   2. 注入分區標題，讓 HR 一眼看出欄位分組
 *      ▌ 簽核者設定（before holder_type）
 *      ▌ 簽核鏈 & 下一關設定（before chain_preview space）
 *
 * 【不動原生欄位】
 *   所有 kintone 原生欄位保持原位，只新增視覺標題與樣式
 *
 * 【依賴】
 *   - core/01-config.js（Config）
 *   - core/04-utils.js（Utils.safeHandler）
 *
 * 【變更履歷】
 *   2026-04-19  Jimmy/Claude  初版建立
 */
(() => {
  'use strict';

  const { safeHandler } = window.ApprovalRouting.Utils;

  // --- 版面寬度解封 ---
  const overrideWidth = () => {
    if (document.getElementById('ar-edit-width-override')) return;
    const style = document.createElement('style');
    style.id = 'ar-edit-width-override';
    style.innerHTML = `
      .layout-gaia.editlayout-gaia {
        width: auto !important;
        max-width: 1100px !important;
        margin: 0 auto !important;
        padding: 0 24px !important;
      }
    `;
    document.head.appendChild(style);
  };

  // --- 分區標題 DOM ---
  const makeSectionEl = (text) => {
    const el = document.createElement('div');
    el.dataset.arSection = '1';
    el.style.cssText = [
      'font-size:12px',
      'font-weight:700',
      'color:#1a73e8',
      'letter-spacing:2px',
      'padding:20px 0 6px',
      'border-top:2px solid #e8f0fe',
      'margin-top:4px',
    ].join(';');
    el.textContent = text;
    return el;
  };

  const injectSectionHeaders = () => {
    // 避免重複注入
    if (document.querySelector('[data-ar-section]')) return;

    // ① 簽核者設定：插在第一個 radio_button 欄位（holder_type）前
    const holderTypeEl = document.querySelector('[class*="radio_button-field-gaia"]');
    if (holderTypeEl) {
      holderTypeEl.insertAdjacentElement('beforebegin', makeSectionEl('簽核者設定'));
    }

    // ② 簽核鏈 & 下一關設定：插在 chain_preview space 的外層容器前
    const spaceEl = kintone.app.record.getSpaceElement('chain_preview');
    if (spaceEl) {
      // 往上找到可插入的層級（space 本身的 parent 通常是 row/cell level）
      const rowEl = spaceEl.parentElement;
      if (rowEl) {
        rowEl.insertAdjacentElement('beforebegin', makeSectionEl('簽核鏈 & 下一關設定'));
      }
    }
  };

  kintone.events.on(
    ['app.record.edit.show', 'app.record.create.show'],
    safeHandler(async (event) => {
      overrideWidth();
      // setTimeout 確保 kintone DOM 完全渲染後再注入標題
      setTimeout(injectSectionHeaders, 0);
      return event;
    }),
  );
})();
