// Vercel Serverless Function - NotionTalk AI 검색 API
// POST /api/search  { keyword: "검색어" }

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';

export default async function handler(req, res) {
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
    const summary = await askGemini(geminiKey, keyword);
    return res.json({ summary, count: 1 });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function askGemini(apiKey, keyword) {
  const prompt = `당신은 Notion(노션) 사용법 전문가입니다.

사용자가 "${keyword}"에 대해 질문했습니다.

다음 규칙을 따라 답변해 주세요:
- 노션에서 "${keyword}"을(를) 활용하는 방법을 구체적이고 실용적으로 설명
- 단계별 방법이 있다면 번호를 매겨 설명
- 관련 단축키가 있다면 포함 (Mac/Windows 모두)
- 한국어로 답변
- 500자 이내로 간결하게
- 마크다운 없이 일반 텍스트로`;

  const resp = await fetch(
    `${GEMINI_API}/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 1024 }
      })
    }
  );

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || 'AI 응답 생성 실패');
  }

  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || 'AI 응답을 생성하지 못했습니다.';
}
