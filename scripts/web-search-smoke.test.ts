import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  formatWebSearchHits,
  formatWebSearchSkipped,
  isWebSearchSkippedContent,
  looksLikeNetworkError,
  mergeHits,
  parseBingHtml,
  parseDuckDuckGoHtml,
  parseHnAlgoliaJson,
  parseSearxHtml,
  parseSearxJson,
  parseStackOverflowJson,
  parseWikipediaOpenSearch,
  parseWikipediaSearch,
  unwrapBingRedirect,
  unwrapDdgRedirect
} from '../src/main/agent/WebSearch'

describe('unwrapDdgRedirect', () => {
  it('unwraps duckduckgo /l/?uddg= links', () => {
    const wrapped =
      '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&rut=abc'
    assert.equal(unwrapDdgRedirect(wrapped), 'https://example.com/docs')
  })

  it('passes through normal https urls', () => {
    assert.equal(
      unwrapDdgRedirect('https://developer.mozilla.org/en-US/'),
      'https://developer.mozilla.org/en-US/'
    )
  })
})

describe('unwrapBingRedirect', () => {
  it('decodes bing /ck/a u=a1 base64 urls', () => {
    const target = 'https://www.typescriptlang.org/'
    const b64 = Buffer.from(target, 'utf8').toString('base64')
    const href = `https://www.bing.com/ck/a?!&&p=abc&u=a1${b64}&ntb=1`
    assert.equal(unwrapBingRedirect(href), target)
  })
})

describe('parseDuckDuckGoHtml', () => {
  it('extracts title url snippet from classic markup', () => {
    const html = `
      <body>
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freact.dev%2Flearn">
          React Learn
        </a>
        <a class="result__snippet" href="#">Official React docs for getting started.</a>
        <a class="result__a" href="https://nodejs.org/en">Node.js</a>
        <div class="result__snippet">JavaScript runtime.</div>
      </body>
    `
    const hits = parseDuckDuckGoHtml(html, 5)
    assert.ok(hits.length >= 1)
    assert.equal(hits[0]!.title, 'React Learn')
    assert.equal(hits[0]!.url, 'https://react.dev/learn')
    assert.match(hits[0]!.snippet, /Official React/)
  })
})

describe('parseBingHtml', () => {
  it('extracts b_algo results and unwraps redirects', () => {
    const target = 'https://react.dev/learn'
    const b64 = Buffer.from(target, 'utf8').toString('base64')
    const html = `
      <ol id="b_results">
        <li class="b_algo">
          <h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=x&amp;u=a1${b64}&amp;ntb=1">React Learn</a></h2>
          <div class="b_caption"><p>Official React docs.</p></div>
        </li>
      </ol>
    `
    const hits = parseBingHtml(html, 5)
    assert.equal(hits.length, 1)
    assert.equal(hits[0]!.title, 'React Learn')
    assert.equal(hits[0]!.url, target)
    assert.match(hits[0]!.snippet, /Official React/)
  })
})

describe('parseSearxJson', () => {
  it('reads results array', () => {
    const hits = parseSearxJson(
      {
        results: [
          {
            title: 'MDN fetch',
            url: 'https://developer.mozilla.org/docs/Web/API/fetch',
            content: 'The Fetch API'
          },
          { title: 'bad', url: 'not-a-url', content: 'x' }
        ]
      },
      5
    )
    assert.equal(hits.length, 1)
    assert.equal(hits[0]!.source, 'searx')
    assert.match(hits[0]!.url, /mozilla/)
  })
})

describe('parseSearxHtml', () => {
  it('extracts article.result cards', () => {
    const html = `
      <article class="result result-default">
        <h3><a href="https://example.com/doc">Example Docs</a></h3>
        <p class="content">A short snippet about docs.</p>
      </article>
    `
    const hits = parseSearxHtml(html, 5)
    assert.equal(hits.length, 1)
    assert.equal(hits[0]!.title, 'Example Docs')
  })
})

describe('parseWikipediaOpenSearch', () => {
  it('parses opensearch tuple', () => {
    const hits = parseWikipediaOpenSearch(
      [
        'typescript',
        ['TypeScript', 'TypeScript Handbook'],
        ['A language', 'Docs'],
        [
          'https://en.wikipedia.org/wiki/TypeScript',
          'https://en.wikipedia.org/wiki/TypeScript_Handbook'
        ]
      ],
      5
    )
    assert.equal(hits.length, 2)
    assert.equal(hits[0]!.title, 'TypeScript')
    assert.match(hits[0]!.url, /wikipedia/)
  })
})

describe('parseWikipediaSearch', () => {
  it('parses list=search query results', () => {
    const hits = parseWikipediaSearch(
      {
        query: {
          search: [
            {
              title: 'TypeScript',
              snippet: 'A <span class="searchmatch">typed</span> JS superset'
            }
          ]
        }
      },
      5,
      'en'
    )
    assert.equal(hits.length, 1)
    assert.equal(hits[0]!.title, 'TypeScript')
    assert.match(hits[0]!.url, /en\.wikipedia\.org\/wiki\/TypeScript/)
    assert.match(hits[0]!.snippet, /typed/)
  })
})

describe('parseStackOverflowJson', () => {
  it('reads items with title and link', () => {
    const hits = parseStackOverflowJson(
      {
        items: [
          {
            title: 'How does satisfies work?',
            link: 'https://stackoverflow.com/q/1',
            excerpt: 'I am confused about <b>satisfies</b>.'
          }
        ]
      },
      5
    )
    assert.equal(hits.length, 1)
    assert.equal(hits[0]!.source, 'stackoverflow')
    assert.match(hits[0]!.snippet, /satisfies/)
  })
})

describe('parseHnAlgoliaJson', () => {
  it('reads story hits', () => {
    const hits = parseHnAlgoliaJson(
      {
        hits: [
          {
            title: 'Show HN: AFKLLM',
            url: 'https://example.com/afk',
            objectID: '1',
            story_text: 'Local Electron IDE'
          }
        ]
      },
      5
    )
    assert.equal(hits.length, 1)
    assert.equal(hits[0]!.source, 'hackernews')
    assert.equal(hits[0]!.url, 'https://example.com/afk')
  })
})

describe('mergeHits', () => {
  it('dedupes by url', () => {
    const merged = mergeHits(
      [
        [{ title: 'A', url: 'https://x.com/a/', snippet: '', source: 'duckduckgo' }],
        [
          { title: 'A2', url: 'https://x.com/a', snippet: '', source: 'bing' },
          { title: 'B', url: 'https://x.com/b', snippet: '', source: 'wikipedia' }
        ]
      ],
      8
    )
    assert.equal(merged.length, 2)
    assert.equal(merged[0]!.title, 'A')
    assert.equal(merged[1]!.title, 'B')
  })

  it('round-robins so second provider is not starved', () => {
    const ddg = Array.from({ length: 8 }, (_, i) => ({
      title: `D${i}`,
      url: `https://d.com/${i}`,
      snippet: '',
      source: 'duckduckgo'
    }))
    const wiki = [
      { title: 'W', url: 'https://w.com/1', snippet: '', source: 'wikipedia' }
    ]
    const merged = mergeHits([ddg, wiki], 4)
    assert.equal(merged.length, 4)
    assert.ok(merged.some((h) => h.source === 'wikipedia'))
    assert.equal(merged[0]!.source, 'duckduckgo')
    assert.equal(merged[1]!.source, 'wikipedia')
  })
})

describe('formatWebSearchHits', () => {
  it('formats numbered results with sources', () => {
    const text = formatWebSearchHits(
      'react hooks',
      [{ title: 'Hooks', url: 'https://react.dev/hooks', snippet: 'Intro', source: 'bing' }],
      ['duckduckgo', 'bing']
    )
    assert.match(text, /Web search: react hooks \(via duckduckgo \+ bing\)/)
    assert.match(text, /1\. Hooks \[bing\]/)
    assert.match(text, /https:\/\/react\.dev\/hooks/)
  })
})

describe('offline skip helpers', () => {
  it('detects network-looking errors', () => {
    assert.equal(looksLikeNetworkError('fetch failed'), true)
    assert.equal(looksLikeNetworkError('getaddrinfo ENOTFOUND'), true)
    assert.equal(looksLikeNetworkError('bing: empty'), false)
  })

  it('formats skip message for agent', () => {
    const text = formatWebSearchSkipped('foo', 'ENOTFOUND')
    assert.ok(isWebSearchSkippedContent(text))
    assert.match(text, /Query was: foo/)
    assert.match(text, /do not invent URLs/i)
  })
})
