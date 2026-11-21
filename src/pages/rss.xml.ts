import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import type { APIRoute } from 'astro';
import { publicArticles } from '@/lib/articles';

export const GET: APIRoute = async (context) => {
  const articles = publicArticles(await getCollection('articles'));
  return rss({
    title: 'AI Pulse',
    description: 'Independent coverage of artificial intelligence.',
    site: context.site ?? 'https://aipulse.news',
    items: articles.map((article) => ({
      title: article.data.title,
      description: article.data.introduction,
      pubDate: article.data.publishedAt,
      link: `/news/${article.data.slug}/`,
      content: article.body,
    })),
  });
};
