import { describe, expect, it } from 'vitest';
import {
  appendSnippetToDraft,
  buildBuiltinSnippetCoverage,
  getMissingBuiltinSnippetCategories
} from './snippetWorkflow';

describe('snippet workflow regression', () => {
  it('keeps builtin snippet coverage for all system categories', () => {
    const missing = getMissingBuiltinSnippetCategories();
    expect(missing).toEqual([]);
    const coverage = buildBuiltinSnippetCoverage();
    expect(coverage.ubuntu).toBeGreaterThan(0);
    expect(coverage.debian).toBeGreaterThan(0);
    expect(coverage.alpine).toBeGreaterThan(0);
    expect(coverage.huawei).toBeGreaterThan(0);
  });

  it('appends selected snippet into pre-input draft instead of auto-executing', () => {
    const emptyResult = appendSnippetToDraft('', 'sudo systemctl status nginx --no-pager');
    expect(emptyResult).toBe('sudo systemctl status nginx --no-pager');

    const chainedResult = appendSnippetToDraft(
      'pwd',
      'sudo systemctl status nginx --no-pager'
    );
    expect(chainedResult).toBe('pwd\nsudo systemctl status nginx --no-pager');
  });

  it('ignores blank snippet command input', () => {
    expect(appendSnippetToDraft('ls -la', ' \n ')).toBe('ls -la');
  });
});
