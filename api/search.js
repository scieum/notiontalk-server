// Vercel Serverless Function - NotionTalk 검색 API
// POST /api/search  { keyword: "검색어" }

const NOTION_API = 'https://www.notion.so/api/v3';
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';

const DEFAULT_PAGE_ID = 'a0eaef35-e34f-4fb4-b4f7-c3108537f74f';
const DEFAULT_VIEW_ID = '1a9dd1dc-d644-8040-9476-000c632c8c5f';

let cachedCollectionId = null;

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { keyword } = req.body;
  if (!keyword) return res.status(400).json({ error: '검색어를 입력해 주세요' });

  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) return res.status(500).json({ error: 'Server config error' });

  try {
    // 1. Notion 공개 DB 검색
    const pages = await searchNotionDB(keyword);
    if (pages.length === 0) {
      return res.json({ summary: null, results: [], count: 0 });
    }

    // 2. 상위 5개 페이지 본문
    const topPages = pages.slice(0, 5);
    const pagesWithContent = await Promise.all(
      topPages.map(async (page) => {
        try {
          let content = await getPageContent(page.id);
          return { ...page, content: content.substring(0, 800) };
        } catch {
          return { ...page, content: '' };
        }
      })
    );

    // 3. Gemini 요약
    let summary = null;
    try {
      summary = await summarizeWithGemini(geminiKey, keyword, pagesWithContent);
    } catch (err) {
      summary = '요약을 생성하지 못했습니다.';
    }

    // 4. 결과 반환
    const results = pages.map(page => {
      const full = pagesWithContent.find(p => p.id === page.id);
      return {
        ...page,
        preview: full?.content ? full.content.substring(0, 150) + '...' : ''
      };
    });

    return res.json({ summary, results, count: pages.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// --- Notion 공개 DB 함수 ---

async function getCollectionId(pageId) {
  if (cachedCollectionId) return cachedCollectionId;

  const resp = await fetch(`${NOTION_API}/loadPageChunk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pageId, limit: 1, cursor: { stack: [] }, chunkNumber: 0, verticalColumns: false
    })
  });
  if (!resp.ok) throw new Error('Notion 페이지 로드 실패');

  const data = await resp.json();
  for (const block of Object.values(data.recordMap?.block || {})) {
    if (block.value?.type === 'collection_view_page' || block.value?.type === 'collection_view') {
      if (block.value.collection_id) {
        cachedCollectionId = block.value.collection_id;
        return cachedCollectionId;
      }
    }
  }
  throw new Error('Collection ID를 찾을 수 없습니다');
}

async function searchNotionDB(keyword) {
  const collectionId = await getCollectionId(DEFAULT_PAGE_ID);

  const resp = await fetch(`${NOTION_API}/queryCollection`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collection: { id: collectionId },
      collectionView: { id: DEFAULT_VIEW_ID },
      loader: { type: 'table', limit: 20, searchQuery: keyword, loadContentCover: false }
    })
  });
  if (!resp.ok) throw new Error('DB 검색 실패');

  const data = await resp.json();
  const blockIds = data.result?.blockIds || [];
  const blocks = data.recordMap?.block || {};

  return blockIds.map(id => {
    const block = blocks[id]?.value;
    if (!block) return null;
    return {
      id,
      title: extractTitle(block),
      tags: extractTags(block, data.recordMap),
      url: `https://www.notion.so/${id.replace(/-/g, '')}`
    };
  }).filter(Boolean);
}

async function getPageContent(pageId) {
  const resp = await fetch(`${NOTION_API}/loadPageChunk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pageId, limit: 50, cursor: { stack: [] }, chunkNumber: 0, verticalColumns: false
    })
  });
  if (!resp.ok) throw new Error('페이지 본문 로드 실패');

  const data = await resp.json();
  const texts = [];
  for (const block of Object.values(data.recordMap?.block || {})) {
    const val = block.value;
    if (!val || val.id === pageId) continue;
    if (['text', 'header', 'sub_header', 'sub_sub_header', 'bulleted_list',
         'numbered_list', 'toggle', 'quote', 'callout', 'to_do'].includes(val.type)) {
      const titleArr = val.properties?.title;
      if (titleArr) {
        const text = titleArr.map(t => t[0]).join('');
        if (text.trim()) texts.push(text.trim());
      }
    }
  }
  return texts.join('\n');
}

function extractTitle(block) {
  const titleArr = block.properties?.title;
  if (!titleArr) return '제목 없음';
  return titleArr.map(t => t[0]).join('');
}

function extractTags(block, recordMap) {
  const collection = recordMap?.collection?.[block.parent_id]?.value;
  const schema = collection?.schema;
  if (!schema || !block.properties) return [];

  const tags = [];
  for (const [key, prop] of Object.entries(schema)) {
    if (prop.type === 'multi_select' && block.properties[key]) {
      const values = block.properties[key][0][0];
      if (values) tags.push(...values.split(','));
    }
  }
  return tags;
}

// --- Gemini 함수 ---

async function summarizeWithGemini(apiKey, keyword, pages) {
  const context = pages.map((p, i) =>
    `[${i + 1}] ${p.title}\n태그: ${p.tags.join(', ')}\n${p.content || '(본문 없음)'}`
  ).join('\n---\n');

  const resp = await fetch(
    `${GEMINI_API}/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `노션 사용법 전문가로서 "${keyword}"에 대해 아래 문서를 기반으로 200자 이내로 핵심만 요약해줘. 한국어로.\n\n${context}` }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 512 }
      })
    }
  );

  if (!resp.ok) throw new Error('Gemini API 실패');
  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '요약 생성 실패';
}
