import { createHash } from "node:crypto";
import { request } from "./http.js";

const noop = { info() {}, warn() {} };
const TAG = "[evermind-ai-everos]";

/** Generate a deterministic message ID scoped by idSeed.
 *  Same seed + role + content always produces the same ID.
 *  Different seeds (different turns/sessions) produce different IDs,
 *  so repeated short messages like "ok" won't collide across turns. */
function messageId(idSeed, role, content) {
  const hash = createHash("sha256").update(`${idSeed}:${role}:${content}`).digest("hex").slice(0, 24);
  return `em_${hash}`;
}

export async function searchMemories(cfg, params, log = noop) {
  const { memory_types, ...baseParams } = params;

  // Backend only supports these types in hybrid/vector search.
  // "profile" is handled separately by the backend (fetched from MongoDB, not ES/Milvus).
  // "agent_case" / "agent_skill" do not exist in the backend MemoryType enum.
  const SEARCHABLE_TYPES = new Set(["episodic_memory", "foresight", "event_log"]);

  const searchTypes = (memory_types ?? []).filter((t) => SEARCHABLE_TYPES.has(t));
  // profile is passed alongside a searchable type so the backend can attach it via its own path
  const wantProfile = (memory_types ?? []).includes("profile");

  if (!searchTypes.length && !wantProfile) {
    return { status: "ok", result: { profiles: [], memories: [], pending_messages: [] } };
  }

  // Single search request with only valid searchable types.
  // The backend's retrieve_mem always fetches pending_messages and (when profile is requested)
  // attaches profile data automatically based on user_id/group_id.
  const types = searchTypes.length ? searchTypes : ["episodic_memory"];
  const p = { ...baseParams, memory_types: types };
  log.info(`${TAG} GET /api/v1/memories/search`, JSON.stringify(p));
  const searchResult = await request(cfg, "GET", "/api/v1/memories/search", p);
  log.info(`${TAG} GET response`, JSON.stringify(searchResult));

  // If profile was requested, fetch it separately via the fetch endpoint
  let profiles = [];
  if (wantProfile) {
    try {
      const profileParams = {
        user_id: baseParams.user_id,
        group_id: baseParams.group_id,
        memory_type: "profile",
        limit: 1,
      };
      log.info(`${TAG} GET /api/v1/memories (profile)`, JSON.stringify(profileParams));
      const profileResult = await request(cfg, "GET", "/api/v1/memories", profileParams);
      log.info(`${TAG} GET response (profile)`, JSON.stringify(profileResult));
      if (profileResult?.result?.memories?.length) {
        profiles = profileResult.result.memories;
      }
    } catch (err) {
      log.warn(`${TAG} profile fetch failed: ${err.message}`);
    }
  }

  const merged = {
    status: "ok",
    result: {
      profiles,
      memories: searchResult?.result?.memories ?? [],
      pending_messages: searchResult?.result?.pending_messages ?? [],
    },
  };
  return merged;
}

export async function saveMemories(cfg, { userId, groupId, messages = [], flush = false, idSeed = "" }, log = noop) {
  if (!messages.length) return;
  const stamp = Date.now();

  const payloads = messages.map((msg, i) => {
    const { role = "user", content = "" } = msg;
    const sender = role === "assistant" ? role : userId;
    const isLast = i === messages.length - 1;

    return {
      message_id: messageId(idSeed, role, content),
      create_time: new Date(stamp + i).toISOString(),
      role,
      sender,
      sender_name: sender,
      content,
      group_id: groupId,
      group_name: groupId,
      scene: "assistant",
      raw_data_type: "AgentConversation",
      ...(flush && isLast && { flush: true }),
    };
  });

  // Send sequentially to preserve message order on the backend
  for (const payload of payloads) {
    log.info(`${TAG} POST /api/v1/memories`, JSON.stringify(payload));
    const result = await request(cfg, "POST", "/api/v1/memories", payload);
    log.info(`${TAG} POST response`, JSON.stringify(result));
  }
}
