import dotenv from 'dotenv';
import { prisma } from '../config/db';

dotenv.config();

export type AiHintBundle = {
  hint_1: string;
  hint_2: string;
  hint_3: string;
};

const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim();
const GEMINI_HINT_MODELS = [
  'gemini-3-pro-preview',
  'gemini-3-flash-preview'
] as const;
const SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/?q=';

const normalizeText = (value: string) => value.replace(/\s+/g, ' ').trim();
const getCityInitialHint = (cityName: string) => normalizeText(cityName).charAt(0).toUpperCase() || '-';
const isTasikmalayaCity = (cityName: string) => normalizeText(cityName).toLowerCase() === 'tasikmalaya';

const stripDecorators = (value: string) => normalizeText(value).replace(/^["'`]+|["'`]+$/g, '').trim();

const readHintValue = (data: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) {
      return normalizeText(value);
    }
  }

  return '';
};

const sanitizeHintValue = (value: string, kind: 'food' | 'province' | 'initial') => {
  let normalized = stripDecorators(value);
  if (!normalized) {
    return '';
  }

  normalized = normalized
    .replace(/^(makanan khas|provinsi|hint\s*1|hint\s*2|hint\s*3|ai hint)\s*[:\-]?\s*/i, '')
    .replace(/^[\s:,-]+/, '')
    .trim();

  if (!normalized) {
    return '';
  }

  if (kind === 'initial') {
    const initialMatch = normalized.match(/[A-Za-z]/);
    return initialMatch ? initialMatch[0].toUpperCase() : '';
  }

  if (isTooGenericHint(normalized, kind === 'food' ? 'hint_1' : 'hint_2')) {
    return '';
  }

  if (normalized.length <= 2) {
    return '';
  }

  return normalized;
};

const parseStoredHints = (rawHint: string | null | undefined): AiHintBundle | null => {
  if (!rawHint?.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawHint) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const hint_1 = sanitizeHintValue(readHintValue(parsed, ['hint_1', 'hint1']), 'food');
    const hint_2 = sanitizeHintValue(readHintValue(parsed, ['hint_2', 'hint2']), 'province');
    const hint_3 = sanitizeHintValue(readHintValue(parsed, ['hint_3', 'hint3']), 'initial');

    if (!hint_1 && !hint_2 && !hint_3) {
      return null;
    }

    return {
      hint_1,
      hint_2,
      hint_3
    };
  } catch {
    const hint_1 = sanitizeHintValue(rawHint, 'food');
    const hint_2 = sanitizeHintValue(rawHint, 'province');
    const hint_3 = sanitizeHintValue(rawHint, 'initial');

    if (!hint_1 && !hint_2 && !hint_3) {
      return null;
    }

    return {
      hint_1,
      hint_2,
      hint_3
    };
  }
};

const buildFallbackHints = (cityName: string): AiHintBundle => {
  return {
    hint_1: 'Makanan khas kota ini',
    hint_2: 'Provinsi tempat kota ini berada',
    hint_3: getCityInitialHint(cityName)
  };
};

const withCategoryLabel = (label: string, text: string) => {
  let normalized = normalizeText(text);
  const lowerLabel = label.toLowerCase();
  const lowerText = normalized.toLowerCase();

  if (lowerText.startsWith(`${lowerLabel}:`)) {
    normalized = normalizeText(normalized.slice(label.length + 1));
  } else if (lowerText.startsWith(`${lowerLabel} `)) {
    normalized = normalizeText(normalized.slice(label.length));
  } else if (lowerText.startsWith(lowerLabel)) {
    normalized = normalizeText(normalized.slice(label.length));
  }

  normalized = normalized.replace(/^[\s:,-]+/, '').trim();
  return `${label}: ${normalized}`;
};

const isLegacyGenericHint = (hint: string, category: 'hint_1' | 'hint_2') => {
  const normalized = hint.toLowerCase();

  if (category === 'hint_1') {
    return (
      normalized.includes('coba pikirkan') ||
      normalized.includes('hidangan yang paling identik') ||
      normalized.includes('makanan khas: belum tersedia')
    );
  }

  return (
    normalized.includes('salah satu provinsi') ||
    normalized.includes('provinsi: belum tersedia') ||
    normalized.includes('kota ini berada di')
  );
};

const isTooGenericHint = (hint: string, category: 'hint_1' | 'hint_2') => {
  const normalized = normalizeText(hint).toLowerCase();

  if (category === 'hint_1') {
    return (
      normalized.includes('kota ini') ||
      normalized.includes('makanan khas kota ini') ||
      normalized.includes('oleh-oleh paling ikonik') ||
      normalized.includes('hidangan yang paling identik') ||
      normalized.includes('belum tersedia')
    );
  }

  return (
    normalized.includes('tempat kota ini berada') ||
    normalized.includes('provinsi tempat kota ini berada') ||
    normalized.includes('salah satu provinsi') ||
    normalized.includes('belum tersedia')
  );
};

const buildSingleHintPrompt = (cityName: string, kind: 'food' | 'province') => {
  if (kind === 'food') {
    return `
Anda adalah asisten sistem pembuat hint untuk game tebak gambar kota di Indonesia.
Tugas Anda adalah mencari di web 1 makanan khas atau oleh-oleh paling ikonik untuk kota: "${cityName}".

Aturan:
- Gunakan Google Search untuk memverifikasi fakta.
- Prioritaskan hasil yang muncul saat mencari dengan kata kunci: "${cityName} makanan khas" dan "${cityName} oleh-oleh".
- Jawaban harus spesifik dan faktual.
- Jangan jawab dengan kalimat generik seperti "kota ini" atau "makanan khas kota ini".
- Kalau ada beberapa kandidat, pilih yang paling terkenal dan paling identik dengan kota tersebut.
- Jangan sebut nama kota di dalam jawaban.

ATURAN FORMAT OUTPUT:
1. Wajib JSON valid.
2. Hanya JSON, tanpa teks tambahan.
3. Gunakan blok data berikut:
{
  "value": "String"
}
`.trim();
  }

  return `
Anda adalah asisten sistem pembuat hint untuk game tebak gambar kota di Indonesia.
Tugas Anda adalah mencari di web nama provinsi resmi tempat kota: "${cityName}" berada.

Aturan:
- Gunakan Google Search untuk memverifikasi fakta.
- Prioritaskan hasil yang muncul saat mencari dengan kata kunci: "${cityName} provinsi" dan "${cityName} berada di provinsi apa".
- Jawaban harus berupa nama provinsi resmi di Indonesia.
- Jangan jawab dengan kalimat generik seperti "tempat kota ini berada" atau "salah satu provinsi".
- Jangan sebut nama kota di dalam jawaban.

ATURAN FORMAT OUTPUT:
1. Wajib JSON valid.
2. Hanya JSON, tanpa teks tambahan.
3. Gunakan blok data berikut:
{
  "value": "String"
}
`.trim();
};

const parseSingleValueResponse = (responseText: string) => {
  try {
    const cleaned = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
    const startIndex = cleaned.indexOf('{');
    const endIndex = cleaned.lastIndexOf('}');
    const jsonText = startIndex >= 0 && endIndex > startIndex ? cleaned.slice(startIndex, endIndex + 1) : cleaned;
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const value = typeof parsed.value === 'string' ? normalizeText(parsed.value) : '';

    if (!value) {
      return null;
    }

    return value;
  } catch {
    return null;
  }
};

const isHintValueGeneric = (value: string, kind: 'food' | 'province') => {
  const normalized = normalizeText(value).toLowerCase();

  if (kind === 'food') {
    return (
      normalized.includes('kota ini') ||
      normalized.includes('makanan khas kota ini') ||
      normalized.includes('oleh-oleh paling ikonik') ||
      normalized.includes('hidangan yang paling identik') ||
      normalized.includes('belum tersedia')
    );
  }

  return (
    normalized.includes('tempat kota ini berada') ||
    normalized.includes('provinsi tempat kota ini berada') ||
    normalized.includes('salah satu provinsi') ||
    normalized.includes('belum tersedia')
  );
};

type SearchResult = {
  title: string;
  snippet: string;
  url: string;
};

type SourceCandidate = SearchResult & {
  text: string;
};

const decodeHtmlEntities = (text: string) =>
  text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;/g, '/');

const stripHtml = (text: string) => normalizeText(decodeHtmlEntities(text.replace(/<[^>]*>/g, ' ')));

const resolveUrl = (href: string) => {
  try {
    return new URL(href, 'https://duckduckgo.com').toString();
  } catch {
    return href;
  }
};

const parseSearchResults = (html: string): SearchResult[] => {
  const titleMatches = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  const snippetMatches = [...html.matchAll(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)];
  const count = Math.min(titleMatches.length, snippetMatches.length, 5);
  const results: SearchResult[] = [];

  for (let index = 0; index < count; index++) {
    const title = stripHtml(titleMatches[index][2]);
    const snippet = stripHtml(snippetMatches[index][1]);
    const url = resolveUrl(titleMatches[index][1]);

    if (title || snippet) {
      results.push({ title, snippet, url });
    }
  }

  return results;
};

const searchWeb = async (query: string) => {
  try {
    const response = await fetch(`${SEARCH_ENDPOINT}${encodeURIComponent(query)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    });

    if (!response.ok) {
      return [];
    }

    const html = await response.text();
    return parseSearchResults(html);
  } catch (error) {
    console.error('Gagal search web:', error);
    return [];
  }
};

const fetchPageText = async (url: string) => {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    });

    if (!response.ok) {
      return '';
    }

    const html = await response.text();
    const withoutScripts = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
    const text = stripHtml(withoutScripts);
    return text;
  } catch {
    return '';
  }
};

const buildSearchEvidence = async (cityName: string, kind: 'food' | 'province') => {
  const queries =
    kind === 'food'
      ? [`${cityName} makanan khas`, `${cityName} oleh-oleh khas`, `${cityName} kuliner khas`]
      : [`${cityName} provinsi`, `${cityName} berada di provinsi apa`, `provinsi ${cityName}`];

  const resultSets = await Promise.all(queries.map(query => searchWeb(query)));
  const merged = resultSets.flat().filter((item, index, self) => {
    const key = `${item.title}|${item.snippet}|${item.url}`;
    return self.findIndex(other => `${other.title}|${other.snippet}|${other.url}` === key) === index;
  });

  return merged
    .slice(0, 8)
    .map((item, index) => {
      return `${index + 1}. ${item.title}\n   Snippet: ${item.snippet}\n   URL: ${item.url}`;
    })
    .join('\n');
};

const buildSourceCandidates = async (cityName: string, kind: 'food' | 'province') => {
  const queries =
    kind === 'food'
      ? [
          `${cityName} makanan khas site:go.id`,
          `${cityName} makanan khas site:id.wikipedia.org`,
          `${cityName} oleh-oleh khas site:go.id`
        ]
      : [
          `${cityName} provinsi site:id.wikipedia.org`,
          `${cityName} berada di provinsi apa site:go.id`,
          `${cityName} site:id.wikipedia.org`
        ];

  const searchResults = (await Promise.all(queries.map(query => searchWeb(query)))).flat();
  const deduped = searchResults.filter((item, index, self) => {
    const key = `${item.title}|${item.url}`;
    return self.findIndex(other => `${other.title}|${other.url}` === key) === index;
  });

  const fetched: SourceCandidate[] = [];
  for (const result of deduped.slice(0, 5)) {
    const text = await fetchPageText(result.url);
    if (text) {
      fetched.push({ ...result, text });
    }
  }

  return fetched;
};

const extractProvinceFromText = (text: string) => {
  const patterns = [
    /Provinsi\s+([A-Z][A-Za-zÀ-ÿ ]{2,40})/,
    /provinsi\s+([A-Z][A-Za-zÀ-ÿ ]{2,40})/i,
    /located in\s+([A-Z][A-Za-zÀ-ÿ ]{2,40})/i,
    /Town in\s+([A-Z][A-Za-zÀ-ÿ ]{2,40})/i,
    /city in\s+([A-Z][A-Za-zÀ-ÿ ]{2,40})/i,
    /Subdivision Name2[:\s]+([A-Z][A-Za-zÀ-ÿ ]{2,40})/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return normalizeText(match[1]);
    }
  }

  return '';
};

const normalizeProvinceName = (value: string) => {
  const normalized = normalizeText(value);
  const mapping: Record<string, string> = {
    'Aceh': 'Aceh',
    'Bali': 'Bali',
    'Bangka Belitung': 'Kepulauan Bangka Belitung',
    'Banten': 'Banten',
    'Bengkulu': 'Bengkulu',
    'Central Java': 'Jawa Tengah',
    'Central Kalimantan': 'Kalimantan Tengah',
    'Central Sulawesi': 'Sulawesi Tengah',
    'East Java': 'Jawa Timur',
    'East Kalimantan': 'Kalimantan Timur',
    'East Nusa Tenggara': 'Nusa Tenggara Timur',
    'Gorontalo': 'Gorontalo',
    'Jakarta': 'DKI Jakarta',
    'Jambi': 'Jambi',
    'Lampung': 'Lampung',
    'North Kalimantan': 'Kalimantan Utara',
    'North Maluku': 'Maluku Utara',
    'North Sulawesi': 'Sulawesi Utara',
    'North Sumatra': 'Sumatera Utara',
    'West Java': 'Jawa Barat',
    'West Kalimantan': 'Kalimantan Barat',
    'West Nusa Tenggara': 'Nusa Tenggara Barat',
    'West Papua': 'Papua Barat',
    'West Sulawesi': 'Sulawesi Barat',
    'West Sumatra': 'Sumatera Barat',
    'South Kalimantan': 'Kalimantan Selatan',
    'South Sulawesi': 'Sulawesi Selatan',
    'South Sumatra': 'Sumatera Selatan',
    'Southeast Sulawesi': 'Sulawesi Tenggara',
    'Riau': 'Riau',
    'Riau Islands': 'Kepulauan Riau',
    'Special Region of Yogyakarta': 'Daerah Istimewa Yogyakarta',
    'Papua': 'Papua',
    'Papua Highlands': 'Papua Pegunungan',
    'Papua Mountains': 'Papua Pegunungan',
    'Papua South': 'Papua Selatan',
    'Papua Central': 'Papua Tengah',
    'Papua West': 'Papua Barat'
  };

  return mapping[normalized] || normalized;
};

const extractFoodFromText = (text: string, cityName: string) => {
  const cityPattern = cityName.replace(/\s+/g, '\\s+');
  const patterns = [
    new RegExp(`\\b([A-Z][A-Za-zÀ-ÿ' ]{2,40})\\s+${cityPattern}\\b`, 'i'),
    new RegExp(`\\b(${cityPattern})\\s+([A-Z][A-Za-zÀ-ÿ' ]{2,40})\\b`, 'i'),
    /Dodol\s+[A-Z][A-Za-zÀ-ÿ' ]{1,30}/i,
    /Surabi\s+[A-Z][A-Za-zÀ-ÿ' ]{1,30}/i,
    /Bika\s+Ambon/i,
    /Pempek/i,
    /Soto\s+[A-Z][A-Za-zÀ-ÿ' ]{1,30}/i,
    /Cireng/i,
    /Cilok/i,
    /Burayot/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const candidate = match[1] || match[0];
      const cleaned = normalizeText(candidate);
      if (cleaned && !cleaned.toLowerCase().includes(cityName.toLowerCase())) {
        return cleaned;
      }
    }
  }

  const lines = text
    .split(/\n+/)
    .map(line => normalizeText(line))
    .filter(Boolean);

  for (const line of lines) {
    if (line.toLowerCase().includes('makanan khas') || line.toLowerCase().includes('oleh-oleh')) {
      const afterColon = line.split(':').slice(1).join(':').trim();
      if (afterColon) {
        return afterColon.split(/[,.]/)[0].trim();
      }
    }
  }

  return '';
};

const buildExtractionPrompt = (cityName: string, kind: 'food' | 'province', evidence: string, strictMode: boolean) => {
  const targetLabel = kind === 'food' ? 'makanan khas atau oleh-oleh paling ikonik' : 'nama provinsi resmi';
  const genericWarning =
    kind === 'food'
      ? 'Jangan jawab dengan frasa generik seperti "kota ini" atau "makanan khas kota ini".'
      : 'Jangan jawab dengan frasa generik seperti "tempat kota ini berada" atau "salah satu provinsi".';

  return `
Anda adalah extractor fakta untuk game tebak gambar kota di Indonesia.

Kota target: "${cityName}"
Kategori jawaban: ${targetLabel}

Gunakan HANYA bukti pencarian web di bawah ini:
${evidence}

Aturan:
- Pilih jawaban paling tepat dari bukti di atas.
- Jawaban harus spesifik, faktual, dan singkat.
- ${genericWarning}
- Jangan sebut nama kota di dalam jawaban.
- Jika bukti tidak cukup jelas, isi value dengan string kosong.
${strictMode ? '- Mode ketat: prioritaskan hasil yang paling sering muncul dan paling meyakinkan.' : ''}

ATURAN OUTPUT:
1. Wajib JSON valid.
2. Hanya JSON, tanpa teks tambahan.
3. Format:
{
  "value": "String"
}
`.trim();
};

const callGeminiExtraction = async (prompt: string, kind: 'food' | 'province') => {
  if (!GEMINI_API_KEY) {
    return null;
  }

  for (const modelName of GEMINI_HINT_MODELS) {
    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: prompt
                }
              ]
            }
          ],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json',
            responseJsonSchema: {
              type: 'object',
              properties: {
                value: { type: 'string' }
              },
              required: ['value']
            }
          }
        })
      });

      if (!response.ok) {
        continue;
      }

      const payload = await response.json() as {
        candidates?: Array<{
          content?: {
            parts?: Array<{ text?: string }>;
          };
        }>;
      };

      const responseText = payload.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
      const value = responseText ? parseSingleValueResponse(responseText) : null;

      if (!value || isHintValueGeneric(value, kind)) {
        continue;
      }

      return value;
    } catch (error) {
      console.error(`Gagal generate hint AI dengan model ${modelName}:`, error);
      continue;
    }
  }

  return null;
};

const generateSingleStructuredHint = async (cityName: string, kind: 'food' | 'province', strictMode = false) => {
  const sources = await buildSourceCandidates(cityName, kind);
  for (const source of sources) {
    const extractedRaw = kind === 'food' ? extractFoodFromText(source.text, cityName) : normalizeProvinceName(extractProvinceFromText(source.text));
    const extracted = normalizeText(extractedRaw);
    if (extracted && !isHintValueGeneric(extracted, kind)) {
      return extracted;
    }
  }

  if (!GEMINI_API_KEY) {
    return null;
  }

  const evidence = sources
    .map((item, index) => `${index + 1}. ${item.title}\n   Snippet: ${item.snippet}\n   URL: ${item.url}\n   Text: ${item.text.slice(0, 1200)}`)
    .join('\n');

  if (!evidence) {
    return null;
  }

  const prompt = buildExtractionPrompt(cityName, kind, evidence, strictMode);

  for (const modelName of GEMINI_HINT_MODELS) {
    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: prompt
                }
              ]
            }
          ],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json',
            responseJsonSchema: {
              type: 'object',
              properties: {
                value: { type: 'string' }
              },
              required: ['value']
            }
          }
        })
      });

      if (!response.ok) {
        continue;
      }

      const payload = await response.json() as {
        candidates?: Array<{
          content?: {
            parts?: Array<{ text?: string }>;
          };
        }>;
      };

      const responseText = payload.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
      const value = responseText ? parseSingleValueResponse(responseText) : null;

      if (!value || isHintValueGeneric(value, kind)) {
        continue;
      }

      return kind === 'province' ? normalizeProvinceName(value) : value;
    } catch (error) {
      console.error(`Gagal generate hint AI dengan model ${modelName}:`, error);
      continue;
    }
  }

  return null;
};

export const generateHintsForCity = async (cityName: string): Promise<AiHintBundle> => {
  const isTasikmalaya = isTasikmalayaCity(cityName);
  const hint_1 =
    (isTasikmalaya ? 'Nasi TO' : '') ||
    sanitizeHintValue((await generateSingleStructuredHint(cityName, 'food')) || '', 'food') ||
    sanitizeHintValue((await generateSingleStructuredHint(cityName, 'food', true)) || '', 'food');
  const hint_2 =
    sanitizeHintValue((await generateSingleStructuredHint(cityName, 'province')) || '', 'province') ||
    sanitizeHintValue((await generateSingleStructuredHint(cityName, 'province', true)) || '', 'province');

  return {
    hint_1: hint_1 || buildFallbackHints(cityName).hint_1,
    hint_2: hint_2 || buildFallbackHints(cityName).hint_2,
    hint_3: getCityInitialHint(cityName)
  };
};

const serializeHints = (hints: AiHintBundle) => JSON.stringify(hints);

export const persistQuestionAiHints = async (questionId: number, hints: AiHintBundle) => {
  const serializedHints = serializeHints(hints);

  await prisma.question.update({
    where: { id: questionId },
    data: { ai_hint: serializedHints }
  });

  return serializedHints;
};

export const ensureQuestionAiHints = async (questionId: number, cityName: string): Promise<AiHintBundle> => {
  const question = await prisma.question.findUnique({
    where: { id: questionId }
  });

  const cityInitialHint = getCityInitialHint(cityName);
  const isTasikmalaya = isTasikmalayaCity(cityName);
  if (!question) {
    return buildFallbackHints(cityName);
  }

  const storedHints = parseStoredHints(question?.ai_hint);
  const generatedHints = await generateHintsForCity(cityName);
  const storedHint1 = storedHints ? sanitizeHintValue(storedHints.hint_1, 'food') : '';
  const storedHint2 = storedHints ? sanitizeHintValue(storedHints.hint_2, 'province') : '';
  const storedHint3 = storedHints ? sanitizeHintValue(storedHints.hint_3, 'initial') : '';
  const rawHint = question?.ai_hint?.trim() || '';
  const mergedHints: AiHintBundle = {
    hint_1: isTasikmalaya ? 'Nasi TO' : storedHint1 || (rawHint && !rawHint.startsWith('{') ? sanitizeHintValue(rawHint, 'food') : '') || generatedHints.hint_1,
    hint_2: storedHint2 || generatedHints.hint_2,
    hint_3: storedHint3 || cityInitialHint
  };

  await persistQuestionAiHints(questionId, mergedHints);

  return mergedHints;
};

export const getHintForLevel = async (questionId: number, cityName: string, level: 1 | 2 | 3) => {
  const hints = await ensureQuestionAiHints(questionId, cityName);
  return hints[`hint_${level}`];
};

export const getSmartHint = async (questionId: number, cityName: string) => {
  return getHintForLevel(questionId, cityName, 1);
};
