/**
 * tools/05-coverage-check.js 的純函式單元測試
 *
 * 載入策略：import IIFE → 掛上 window.ApprovalRouting.CoverageInternals
 * UI 與 API 呼叫不在此測試範圍，只測分組與配對這兩段純邏輯。
 */
import { describe, it, expect } from 'vitest';

await import('../tools/05-coverage-check.js');

const Internals = () => window.ApprovalRouting.CoverageInternals;

describe('tools/05 載入', () => {
  it('IIFE 執行後掛上 CoverageInternals', () => {
    expect(Internals()).toBeDefined();
  });
});
