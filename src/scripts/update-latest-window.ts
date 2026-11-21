import { archiveBucket } from '@/lib/article-rules';

document.querySelectorAll<HTMLElement>('[data-latest-window][data-published-at]').forEach((card) => {
  const publishedAt = new Date(card.dataset.publishedAt ?? '');
  if (Number.isNaN(publishedAt.valueOf()) || archiveBucket(publishedAt) !== 'LATEST') card.remove();
});

document.querySelectorAll<HTMLElement>('[data-latest-window-section]').forEach((section) => {
  if (section.querySelector('[data-latest-window]')) return;
  const grid = section.querySelector<HTMLElement>('.news-grid');
  if (grid) grid.hidden = true;
  const empty = section.querySelector<HTMLElement>('[data-latest-empty]');
  if (empty) empty.hidden = false;
});
