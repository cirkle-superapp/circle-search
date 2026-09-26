/**
 * JsonLd.tsx
 * Renders schema.org structured data (JSON-LD) for SEO.
 */
interface JsonLdProps {
  data: Record<string, unknown> | Record<string, unknown>[]
}

export function JsonLd({ data }: JsonLdProps) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(data),
      }}
    />
  )
}

export function homePageJsonLd(baseUrl: string = 'https://cirkle-search.vercel.app') {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'Cirkle Search Engine',
    alternateName: 'Cirkle',
    url: `${baseUrl}/`,
    description: 'Independent, privacy-first web search engine.',
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${baseUrl}/?q={search_term_string}`,
      },
      'query-input': 'required name=search_term_string',
    },
    publisher: {
      '@type': 'Organization',
      name: 'Cirkle',
      logo: { '@type': 'ImageObject', url: `${baseUrl}/favicon.ico` },
    },
  }
}

export function searchResultsJsonLd(
  query: string,
  results: { url: string; title: string }[],
  baseUrl: string = 'https://cirkle-search.vercel.app',
) {
  return {
    '@context': 'https://schema.org',
    '@type': 'SearchResultsPage',
    name: `${query} — Cirkle Search`,
    url: `${baseUrl}/?q=${encodeURIComponent(query)}`,
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: results.length,
      itemListElement: results.slice(0, 10).map((r, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        url: r.url,
        name: r.title,
      })),
    },
  }
}
