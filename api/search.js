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
    const result = await askGemini(geminiKey, keyword);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function askGemini(apiKey, keyword) {
  const prompt = `당신은 Notion(노션) 사용법 전문가입니다.

사용자가 "${keyword}"에 대해 질문했습니다.

반드시 아래 JSON 형식으로만 답변하세요. 다른 텍스트 없이 JSON만 출력하세요:

{
  "summary": "핵심 요약 설명 (200자 이내, 간결하게)",
  "steps": "구체적인 사용 방법이나 만드는 과정 (단계별로 번호 매겨서, 300자 이내)",
  "shortcuts": "관련 단축키 목록 (Mac: Cmd+X / Windows: Ctrl+X 형식, 없으면 빈 문자열)"
}

규칙:
- 한국어로 답변
- 마크다운 없이 일반 텍스트
- shortcuts가 없으면 빈 문자열 ""
- steps는 항상 포함`;

  const resp = await fetch(
    `${GEMINI_API}/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 1024, responseMimeType: 'application/json' }
      })
    }
  );

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || 'AI 응답 생성 실패');
  }

  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) throw new Error('AI 응답을 생성하지 못했습니다.');

  try {
    return JSON.parse(text);
  } catch {
    return { summary: text, steps: '', shortcuts: '' };
  }
}
