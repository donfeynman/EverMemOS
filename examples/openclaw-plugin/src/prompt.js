export const CONTEXT_BOUNDARY = "user\u200boriginal\u200bquery\u200b:\u200b\u200b\u200b\u200b";

function timestampToLabel(ts) {
  if (ts == null || ts === "") return "";

  if (typeof ts === "number") {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return "";
    const p = (n) => `${n}`.padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  if (typeof ts === "string") {
    const s = ts.trim();
    if (!s) return "";
    // Unix epoch as string
    if (/^\d{10,13}$/.test(s)) return timestampToLabel(Number(s));
    // ISO 8601: extract date and HH:MM
    const dateEnd = s.indexOf("T");
    if (dateEnd === 10 && s.length > 15) return `${s.slice(0, 10)} ${s.slice(11, 16)}`;
    return s;
  }

  return "";
}

export function parseSearchResponse(raw) {
  if (raw?.status !== "ok" || !raw?.result) return null;

  const allMemories = raw.result.memories ?? [];

  // episodic memories
  const episodic = allMemories
    .filter((m) => m.memory_type === "episodic_memory" && (m.score ?? 0) >= 0.1)
    .map((m) => {
      const body = m.summary || m.episode || m.content || "";
      const subject = m.subject || "";
      return {
        text: subject ? `${subject}: ${body}` : body,
        timestamp: m.timestamp ?? null,
      };
    });

  // Parse profile traits from either search-style or fetch-style responses.
  // Search-style: profiles is array of {category, description, item_type, score}
  // Fetch-style: profiles is array of ProfileModel with explicit_info[] and implicit_traits[]
  const traits = [];
  for (const p of raw.result.profiles ?? []) {
    // Fetch-style ProfileModel: has explicit_info / implicit_traits arrays
    if (p.explicit_info || p.implicit_traits) {
      for (const info of p.explicit_info ?? []) {
        const label = info.category || "";
        const desc = info.description || "";
        if (desc) traits.push({ text: label ? `[${label}] ${desc}` : desc, kind: "explicit" });
      }
      for (const trait of p.implicit_traits ?? []) {
        const label = trait.category || trait.trait_name || "";
        const desc = trait.description || "";
        if (desc) traits.push({ text: label ? `[${label}] ${desc}` : desc, kind: "implicit" });
      }
    } else {
      // Search-style: individual scored items
      if ((p.score ?? 0) < 0.1) continue;
      const label = p.category || p.trait_name || "";
      let kind = p.item_type || "";
      if (kind === "explicit_info") kind = "explicit";
      else if (kind === "implicit_trait") kind = "implicit";
      traits.push({
        text: label ? `[${label}] ${p.description || ""}` : (p.description || ""),
        kind,
      });
    }
  }

  // pending_messages: recent messages not yet extracted into memories
  const pending = (raw.result.pending_messages ?? [])
    .filter((m) => m.content)
    .map((m) => {
      const who = m.sender_name || m.sender || m.user_id || "";
      const body = m.content || "";
      return {
        text: who ? `${who}: ${body}` : body,
        timestamp: m.message_create_time ?? m.created_at ?? null,
      };
    });

  return { episodic, traits, pending, case: null, skill: null };
}

function oneLiner(text) {
  return text == null ? "" : String(text).replace(/[\r\n]+/g, " ").trim();
}

function factLine(fact) {
  const t = oneLiner(fact.text);
  if (!t) return "";
  const when = timestampToLabel(fact.timestamp);
  return when ? `  - [${when}] ${t}` : `  - ${t}`;
}

function traitLine(trait) {
  const t = oneLiner(trait.text);
  if (!t) return "";
  const k = trait.kind?.toLowerCase() ?? "";
  const badge = k.includes("explicit") ? " [Explicit]"
    : k.includes("implicit") ? " [Implicit]"
    : trait.kind ? ` [${trait.kind.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}]`
    : "";
  return `  -${badge} ${t}`;
}

function caseBlock(c) {
  if (!c) return [];
  const intent = oneLiner(c.task_intent || "");
  const approach = c.approach || "";
  if (!intent && !approach) return [];
  const when = timestampToLabel(c.timestamp ?? c.created_at ?? null);
  return [
    "  <case>",
    ...(when ? [`    - time: ${when}`] : []),
    ...(intent ? [`    - intent: ${intent}`] : []),
    ...(approach ? [`    - approach: ${approach}`] : []),
    "  </case>",
  ];
}

function skillBlock(s) {
  if (!s) return [];
  const name = oneLiner(s.name || "");
  const desc = oneLiner(s.description || "");
  const content = s.content || "";
  if (!name && !content) return [];
  return [
    "  <skill>",
    ...(name ? [`    - name: ${name}`] : []),
    ...(desc ? [`    - description: ${desc}`] : []),
    ...(content ? [`    - content: ${content}`] : []),
    "  </skill>",
  ];
}

export function buildMemoryPrompt(parsed, opts = {}) {
  if (!parsed) return "";

  const episodicLines = parsed.episodic.map(factLine).filter(Boolean);
  const traitLines = parsed.traits.map(traitLine).filter(Boolean);
  const caseLines = caseBlock(parsed.case);
  const skillLines = skillBlock(parsed.skill);

  const pendingLines = (parsed.pending ?? []).map(factLine).filter(Boolean);

  if (!episodicLines.length && !traitLines.length && !caseLines.length && !skillLines.length && !pendingLines.length) return "";

  const xmlBlock = [
    "<memory>",
    ...(episodicLines.length ? ["  <episodic>", ...episodicLines, "  </episodic>"] : []),
    ...(pendingLines.length ? ["  <recent_context>", "  <!-- Recent conversation not yet consolidated into memory. -->", ...pendingLines, "  </recent_context>"] : []),
    ...(traitLines.length ? ["  <trait>", ...traitLines, "  </trait>"] : []),
    ...(caseLines.length ? ["  <!-- Similar past case. Use as reference if applicable to the current task. -->", ...caseLines] : []),
    ...(skillLines.length ? ["  <!-- Relevant skill. Use as reference if applicable to the current task. -->", ...skillLines] : []),
    "</memory>",
  ];

  const memSection = opts.wrapInCodeBlock ? ["```text", ...xmlBlock, "```"] : xmlBlock;
  const nowLabel = timestampToLabel(Date.now());

  return [
    "Note: Reference memory below. Build on past successes; avoid repeating failed approaches.",
    ...(nowLabel ? [`- Time: ${nowLabel}`] : []),
    "",
    ...memSection,
    "",
    "**Note**: for memory, please not read from or write to local `MEMORY.md` or `memory/*` files as they are provided above.",
    "",
    CONTEXT_BOUNDARY,
  ].join("\n");
}
