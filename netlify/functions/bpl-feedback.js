const MODEL = "qwen/qwen3-coder-480b-a35b-instruct";
const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Content-Type": "application/json"
};

const SYSTEM_PROMPT = `
Actúas como docente experto en Buenas Prácticas de Laboratorio, preclínica regulatoria y calidad GMP.

Evalúa la respuesta del alumno de forma formativa, breve y precisa.
El tema es: Introducción a las BPL.

Criterios:
1. Comprueba si describe una actividad concreta.
2. Comprueba si identifica elementos que requieren trazabilidad: datos primarios, muestras, reactivos, lotes, equipos, versiones, responsables, fechas o registros.
3. Comprueba si propone una mejora documental o de control: PNT, registro, control de versiones, archivo, identificación, revisión o registro de desviaciones.
4. Comprueba si distingue entre aplicar principios BPL de forma voluntaria y afirmar cumplimiento oficial BPL.
5. No afirmes nunca que el laboratorio o el estudio cumple BPL.
6. No inventes normativa ni requisitos específicos no mencionados.
7. No solicites datos confidenciales.
8. Si el alumno incluye información sensible, advierte que no debe compartirla.

Devuelve exclusivamente JSON válido con esta estructura exacta:
{
  "summary": "valoración global breve",
  "strengths": ["punto fuerte 1", "punto fuerte 2"],
  "improvements": ["mejora 1", "mejora 2"],
  "warning": "advertencia breve"
}

No uses Markdown.
No incluyas texto fuera del JSON.
`.trim();

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }

  if (request.method === "GET") {
    return jsonResponse({
      status: "ok",
      service: "BPL feedback IA",
      token: "disabled"
    });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Método no permitido." }, 405);
  }

  const apiKey = process.env.NVIDIA_API_KEY;

  if (!apiKey) {
    return jsonResponse({ error: "Falta NVIDIA_API_KEY en Netlify." }, 500);
  }

  let payload;

  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "El cuerpo de la petición no es JSON válido." }, 400);
  }

  const learnerResponse = String(payload.learner_response || "").trim();
  const activity = String(payload.activity || "T1-IA");
  const theme = String(payload.theme || "Tema 1. Introducción a las BPL");

  if (learnerResponse.length < 100) {
    return jsonResponse({
      error: "La respuesta es demasiado breve para generar feedback útil."
    }, 400);
  }

  if (learnerResponse.length > 1800) {
    return jsonResponse({
      error: "La respuesta es demasiado larga. Reduce el texto a menos de 1800 caracteres."
    }, 400);
  }

  const userPrompt = `
Actividad: ${activity}
Tema: ${theme}

Respuesta del alumno:
"""
${learnerResponse}
"""

Evalúa la respuesta con la rúbrica indicada y devuelve solo JSON válido.
`.trim();

  try {
    const nvidiaResponse = await fetch(NVIDIA_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.2,
        top_p: 0.8,
        max_tokens: 900,
        stream: false
      })
    });

    if (!nvidiaResponse.ok) {
      const errorText = await nvidiaResponse.text();
      return jsonResponse({
        error: "Error al llamar a NVIDIA.",
        details: errorText.slice(0, 500)
      }, 502);
    }

    const data = await nvidiaResponse.json();
    const rawText = data?.choices?.[0]?.message?.content || "";

    const parsed = extractJson(rawText);
    const normalized = normalizeFeedback(parsed);

    return jsonResponse(normalized);

  } catch (error) {
    return jsonResponse({
      error: "No se pudo generar el feedback.",
      details: String(error.message || error)
    }, 500);
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders
  });
}

function extractJson(text) {
  let cleaned = String(text || "").trim();

  cleaned = cleaned
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
  }

  throw new Error("La IA no devolvió JSON válido.");
}

function normalizeFeedback(data) {
  const summary = String(data.summary || "Respuesta revisada.").trim();

  const strengths = Array.isArray(data.strengths)
    ? data.strengths.map(String).map(x => x.trim()).filter(Boolean)
    : [];

  const improvements = Array.isArray(data.improvements)
    ? data.improvements.map(String).map(x => x.trim()).filter(Boolean)
    : [];

  const warning = String(
    data.warning ||
    "Este feedback es formativo. No constituye una evaluación oficial de cumplimiento BPL."
  ).trim();

  return {
    summary,
    strengths,
    improvements,
    warning
  };
}
