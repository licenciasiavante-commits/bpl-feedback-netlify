const MODEL = "qwen/qwen3-coder-480b-a35b-instruct";
const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

const SYSTEM_PROMPTS = {
  "T1-IA": `
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
`.trim(),

  "T2-IA": `
Actúas como docente experto en Buenas Prácticas de Laboratorio, inspecciones BPL, preclínica regulatoria y calidad GMP.

Evalúa la respuesta del alumno de forma formativa, breve y precisa.
El tema es: Inspecciones y verificación de las BPL.

Criterios:
1. Comprueba si el alumno identifica un área, actividad, documento, equipo, muestra, sistema informatizado o archivo concreto para revisar.
2. Comprueba si indica qué evidencia documental buscaría: PNT, registros, datos primarios, formación, mantenimiento, calibración, archivo, control de versiones, informe, protocolo o trazabilidad.
3. Comprueba si detecta un posible riesgo o hallazgo: falta de registro, versión no vigente, formación no documentada, dato no trazable, equipo sin calibración, archivo incompleto o sistema no controlado.
4. Comprueba si propone una acción de mejora concreta, proporcionada y verificable.
5. Comprueba si distingue entre una autoinspección interna o formativa y una inspección oficial de cumplimiento BPL.
6. No afirmes nunca que el laboratorio, proceso, centro o estudio cumple BPL.
7. No inventes normativa ni requisitos específicos no mencionados.
8. No solicites datos confidenciales.
9. Si el alumno incluye información sensible, advierte que no debe compartirla.

Devuelve exclusivamente JSON válido con esta estructura exacta:
{
  "summary": "valoración global breve",
  "strengths": ["punto fuerte 1", "punto fuerte 2"],
  "improvements": ["mejora 1", "mejora 2"],
  "warning": "advertencia breve"
}

No uses Markdown.
No incluyas texto fuera del JSON.
`.trim()
};

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(JSON.stringify({ status: "ok", preflight: true }), {
      status: 200,
      headers: corsHeaders
    });
  }

  if (request.method === "GET") {
    return jsonResponse({
      status: "ok",
      service: "BPL feedback IA",
      token: "disabled",
      supported_activities: ["T1-IA", "T2-IA"]
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
    payload = await readPayload(request);
  } catch {
    return jsonResponse({ error: "El cuerpo de la petición no es JSON válido." }, 400);
  }

  const learnerResponse = String(payload.learner_response || "").trim();
  const activity = String(payload.activity || "T1-IA").trim();
  const theme = String(payload.theme || "Tema BPL").trim();

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

  const systemPrompt = SYSTEM_PROMPTS[activity] || SYSTEM_PROMPTS["T1-IA"];

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
          { role: "system", content: systemPrompt },
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

async function readPayload(request) {
  const text = await request.text();

  if (!text) {
    return {};
  }

  return JSON.parse(text);
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
