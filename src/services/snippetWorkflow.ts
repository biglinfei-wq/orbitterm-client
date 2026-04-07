import { builtinSnippetTemplates } from './snippetLibrary';

export const BUILTIN_SNIPPET_CATEGORIES = ['ubuntu', 'debian', 'alpine', 'huawei'] as const;

export type BuiltinSnippetCategoryId = (typeof BUILTIN_SNIPPET_CATEGORIES)[number];

export const buildBuiltinSnippetCoverage = (): Record<BuiltinSnippetCategoryId, number> => {
  const counts: Record<BuiltinSnippetCategoryId, number> = {
    ubuntu: 0,
    debian: 0,
    alpine: 0,
    huawei: 0
  };
  for (const item of builtinSnippetTemplates) {
    if (item.category in counts) {
      counts[item.category as BuiltinSnippetCategoryId] += 1;
    }
  }
  return counts;
};

export const getMissingBuiltinSnippetCategories = (): BuiltinSnippetCategoryId[] => {
  const coverage = buildBuiltinSnippetCoverage();
  return BUILTIN_SNIPPET_CATEGORIES.filter((category) => coverage[category] <= 0);
};

export const appendSnippetToDraft = (previousDraft: string, snippetCommand: string): string => {
  const nextCommand = snippetCommand.replace(/\r\n/g, '\n').trim();
  if (!nextCommand) {
    return previousDraft;
  }
  if (!previousDraft.trim()) {
    return nextCommand;
  }
  return `${previousDraft.replace(/\s+$/g, '')}\n${nextCommand}`;
};
