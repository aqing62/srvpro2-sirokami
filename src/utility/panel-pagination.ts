export type PanelPageLayout = {
  pageStarts: number[];
  pageIndex: number;
  pageStart: number;
  isFirstPage: boolean;
  isLastPage: boolean;
};

function resolvePageIndex(pageStarts: number[], requestedStart: number) {
  if (!pageStarts.length) {
    return 0;
  }
  if (requestedStart <= pageStarts[0]) {
    return 0;
  }
  for (let i = pageStarts.length - 1; i >= 0; i--) {
    if (requestedStart >= pageStarts[i]) {
      return i;
    }
  }
  return 0;
}

export function buildPanelPageStarts(totalEntries: number) {
  if (totalEntries <= 4) {
    return [0];
  }

  const pageStarts = [0];
  const lastPageStart = totalEntries - 3;
  let cursor = 3;

  while (cursor < lastPageStart) {
    pageStarts.push(cursor);
    cursor += 2;
  }
  if (pageStarts[pageStarts.length - 1] !== lastPageStart) {
    pageStarts.push(lastPageStart);
  }

  return pageStarts;
}

export function resolvePanelPageLayout(
  totalEntries: number,
  requestedStart: number,
): PanelPageLayout {
  const pageStarts = buildPanelPageStarts(totalEntries);
  const pageIndex = resolvePageIndex(pageStarts, requestedStart);
  const pageStart = pageStarts[pageIndex] || 0;

  return {
    pageStarts,
    pageIndex,
    pageStart,
    isFirstPage: pageIndex === 0,
    isLastPage: pageIndex === pageStarts.length - 1,
  };
}
