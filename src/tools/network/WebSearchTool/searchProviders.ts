import { parse } from 'node-html-parser'

export interface SearchResult {
  title: string
  snippet: string
  link: string
}

export interface SearchOptions {
  signal?: AbortSignal
}

export interface SearchProvider {
  search: (
    query: string,
    apiKey?: string,
    options?: SearchOptions,
  ) => Promise<SearchResult[]>
  isEnabled: (apiKey?: string) => boolean
}

const DEFAULT_SEARCH_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

function normalizeGoogleResultLink(rawHref: string | null): string | null {
  if (!rawHref) return null
  const href = rawHref.trim()
  if (!href) return null

  if (href.startsWith('http://') || href.startsWith('https://')) {
    return href
  }

  if (href.startsWith('/url?')) {
    try {
      const url = new URL(`https://www.google.com${href}`)
      const q = url.searchParams.get('q') || url.searchParams.get('url')
      if (!q) return null
      return decodeURIComponent(q)
    } catch {
      return null
    }
  }

  return null
}

function isUsableSearchResultUrl(link: string): boolean {
  try {
    const url = new URL(link)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
    const host = url.hostname.toLowerCase()
    if (
      host === 'google.com' ||
      host.endsWith('.google.com') ||
      host === 'webcache.googleusercontent.com'
    ) {
      return false
    }
    return true
  } catch {
    return false
  }
}

const googleSearchProvider: SearchProvider = {
  isEnabled: () => true,
  search: async (
    query: string,
    _apiKey?: string,
    options?: SearchOptions,
  ): Promise<SearchResult[]> => {
    const response = await fetch(
      `https://www.google.com/search?hl=en&num=10&pws=0&q=${encodeURIComponent(query)}`,
      {
        headers: {
          'User-Agent': DEFAULT_SEARCH_USER_AGENT,
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: options?.signal,
      },
    )

    if (!response.ok) {
      throw new Error(`Google search failed with status: ${response.status}`)
    }

    const html = await response.text()
    const root = parse(html)
    const results: SearchResult[] = []
    const seenLinks = new Set<string>()

    // Primary extraction path: standard result cards
    const resultCards = root.querySelectorAll('div.g')
    for (const card of resultCards) {
      const titleNode = card.querySelector('h3')
      const anchorNode = card.querySelector('a[href]')
      const snippetNode =
        card.querySelector('div.VwiC3b') ||
        card.querySelector('span.aCOpRe') ||
        card.querySelector('div[data-sncf]')

      const title = titleNode?.text?.trim() || ''
      const rawHref = anchorNode?.getAttribute('href') || ''
      const link = normalizeGoogleResultLink(rawHref)
      const snippet = snippetNode?.text?.trim() || ''

      if (!title || !link || !snippet || !isUsableSearchResultUrl(link)) {
        continue
      }
      if (seenLinks.has(link)) continue
      seenLinks.add(link)
      results.push({ title, snippet, link })
    }

    // Fallback extraction path for layout variations
    if (results.length === 0) {
      const anchors = root.querySelectorAll('a[href]')
      for (const anchor of anchors) {
        const rawHref = anchor.getAttribute('href') || ''
        const link = normalizeGoogleResultLink(rawHref)
        if (!link || !isUsableSearchResultUrl(link) || seenLinks.has(link)) {
          continue
        }
        const title = anchor.text?.trim() || ''
        if (!title || title.length < 6) continue
        seenLinks.add(link)
        results.push({
          title,
          snippet: '',
          link,
        })
        if (results.length >= 20) break
      }
    }

    return results
  },
}

const duckDuckGoSearchProvider: SearchProvider = {
  isEnabled: () => true,
  search: async (
    query: string,
    _apiKey?: string,
    options?: SearchOptions,
  ): Promise<SearchResult[]> => {
    const response = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      {
        headers: {
          'User-Agent': DEFAULT_SEARCH_USER_AGENT,
        },
        signal: options?.signal,
      },
    )

    if (!response.ok) {
      throw new Error(
        `DuckDuckGo search failed with status: ${response.status}`,
      )
    }

    const html = await response.text()
    const root = parse(html)
    const results: SearchResult[] = []

    const resultNodes = root.querySelectorAll('.result.web-result')

    for (const node of resultNodes) {
      const titleNode = node.querySelector('.result__a')
      const snippetNode = node.querySelector('.result__snippet')

      if (titleNode && snippetNode) {
        const title = titleNode.text
        const link = titleNode.getAttribute('href')
        const snippet = snippetNode.text

        if (title && link && snippet) {
          let cleanLink = link
          if (link.startsWith('https://duckduckgo.com/l/?uddg=')) {
            try {
              const url = new URL(link)
              cleanLink = url.searchParams.get('uddg') || link
            } catch {
              cleanLink = link
            }
          }
          results.push({
            title: title.trim(),
            snippet: snippet.trim(),
            link: cleanLink,
          })
        }
      }
    }

    return results
  },
}

export const searchProviders = {
  google: googleSearchProvider,
  duckduckgo: duckDuckGoSearchProvider,
}
