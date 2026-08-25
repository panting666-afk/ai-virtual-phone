"use client";

import { chatDb } from "./chat-db";
import { hydrateChatStorage, type ChatContact, type ChatMessage, type ChatSession } from "./chat-storage";
import { loadCharacters, saveCharacters } from "./character-storage";
import type { Character } from "./character-types";
import { loadBindingConfig, loadUserIdentities, saveBindingConfig, saveUserIdentities, setCharacterBinding } from "./settings-storage";
import type { UserIdentity } from "@/components/settings/user-identity";
import type { MemoryEntry } from "./memory-types";
import { saveMemoryEntries } from "./memory-storage";

const LEGACY_PREFIX = "legacy_iphone_simulator";
const MESSAGE_CHUNK_SIZE = 500;

type UnknownRecord = Record<string, unknown>;

type LegacyFriend = {
  id: string;
  name: string;
  avatar?: string;
  isGroup?: boolean;
  members?: string[];
};

type LegacyPersona = {
  id: string;
  name: string;
  setting?: string;
  avatar?: string;
};

type LegacyMessage = {
  id?: string | number;
  text?: unknown;
  meaning?: unknown;
  isMine?: boolean;
  senderName?: unknown;
  isEmoticon?: boolean;
  type?: unknown;
  extra?: unknown;
  time?: unknown;
  translation?: unknown;
};

type LegacyMemory = {
  id?: string | number;
  text?: unknown;
  time?: unknown;
  isCore?: boolean;
  source?: unknown;
  fuzzyTimeAnchor?: unknown;
};

type LegacySnapshot = {
  friends: LegacyFriend[];
  personas: LegacyPersona[];
  myProfile: UnknownRecord | null;
  chatPersonas: Record<string, string>;
  messagesBySourceId: Map<string, LegacyMessage[]>;
  memoriesBySourceId: Map<string, LegacyMemory[]>;
  sharedMemoriesBySourceId: Map<string, string[]>;
};

export type IPhoneSimulatorImportPreview = {
  characters: number;
  groups: number;
  identities: number;
  messages: number;
  coreMemories: number;
  longTermMemories: number;
  sharedMemories: number;
};

export type IPhoneSimulatorImportProgress = {
  phase: "reading" | "preparing" | "messages" | "memories" | "complete";
  completed: number;
  total: number;
  detail: string;
};

export type IPhoneSimulatorImportResult = IPhoneSimulatorImportPreview & {
  importedCharacters: number;
  importedGroups: number;
};

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : value === null || value === undefined ? "" : String(value).trim();
}

function parseStoredJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseArray<T>(value: unknown): T[] {
  const parsed = parseStoredJson(value);
  return Array.isArray(parsed) ? parsed as T[] : [];
}

function parseRecord(value: unknown): UnknownRecord {
  return asRecord(parseStoredJson(value)) ?? {};
}

function safeAvatar(value: unknown): string | undefined {
  const avatar = asString(value);
  return avatar.startsWith("data:") || avatar.startsWith("https://") || avatar.startsWith("http://") ? avatar : undefined;
}

function sourceCanonicalId(sourceId: string): string {
  return sourceId.replace(/_alt_[^_]+$/, "");
}

function characterIdFor(sourceId: string): string {
  return `${LEGACY_PREFIX}_character_${sourceCanonicalId(sourceId)}`;
}

function groupMemoryCharacterId(sourceId: string): string {
  return `${LEGACY_PREFIX}_group_memory_${sourceId}`;
}

function privateSessionId(sourceId: string): string {
  return `${LEGACY_PREFIX}_session_private_${sourceCanonicalId(sourceId)}`;
}

function groupSessionId(sourceId: string): string {
  return `${LEGACY_PREFIX}_session_group_${sourceId}`;
}

function toIso(value: unknown): string {
  const raw = typeof value === "number" ? value : Number(value);
  const date = Number.isFinite(raw) ? new Date(raw) : new Date(asString(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function getMessageText(message: LegacyMessage): string {
  const text = typeof message.text === "string" ? message.text : "";
  const meaning = typeof message.meaning === "string" ? message.meaning : "";
  return text || meaning || "[旧项目消息]";
}

function isImageUrl(value: string): boolean {
  return value.startsWith("data:image/") || /^https?:\/\/.+\.(?:png|jpe?g|gif|webp)(?:[?#].*)?$/i.test(value);
}

function extraString(extra: unknown, key: string): string {
  const record = asRecord(extra);
  return record ? asString(record[key]) : "";
}

function messageContentAndMedia(message: LegacyMessage): Pick<ChatMessage, "content" | "mediaType" | "mediaUrl" | "mediaData"> {
  const type = asString(message.type).toLowerCase();
  const text = getMessageText(message);
  const meaning = asString(message.meaning);

  if ((type === "image" || message.isEmoticon) && isImageUrl(text)) {
    return {
      content: meaning || (message.isEmoticon ? "[表情]" : "[图片]"),
      mediaType: message.isEmoticon ? "sticker" : "image",
      mediaUrl: text,
      mediaData: message.isEmoticon ? { stickerUrl: text, label: meaning || "表情" } : { label: meaning || "图片" },
    };
  }

  if (type === "voice") {
    const transcript = text || extraString(message.extra, "showText");
    return { content: transcript ? `[语音] ${transcript}` : "[语音消息]" };
  }
  if (type === "location") {
    return { content: text || "[位置]", mediaType: "location", mediaData: { label: text || "位置" } };
  }
  if (type === "transfer" || type === "group_transfer") {
    const amount = Number(asRecord(message.extra)?.amount);
    return {
      content: text || "[转账]",
      mediaType: "transfer",
      mediaData: {
        ...(Number.isFinite(amount) ? { amount } : {}),
        label: extraString(message.extra, "note") || text || "转账",
        status: "received",
      },
    };
  }
  if (type === "music_share" || type === "playlist_share") {
    return { content: text || "[音乐分享]", mediaType: "music_share", mediaData: { label: extraString(message.extra, "title") || text } };
  }
  if (type === "image" || type === "camera_text_image") {
    return { content: meaning || (isImageUrl(text) ? "[图片]" : text || "[图片]") };
  }
  if (type === "system") return { content: text || "[系统消息]" };
  if (type && type !== "text") return { content: `${text || meaning || "[消息]"}\n[旧项目类型：${type}]` };
  return { content: text };
}

function parseSnapshot(text: string): LegacySnapshot {
  const root = asRecord(JSON.parse(text));
  if (!root) throw new Error("这不是可识别的旧 iPhone 模拟器备份。");

  const friends = parseArray<LegacyFriend>(root.friends)
    .filter((item) => Boolean(item && asString(item.id) && asString(item.name)))
    .map((item) => ({
      id: asString(item.id),
      name: asString(item.name),
      avatar: safeAvatar(item.avatar),
      isGroup: item.isGroup === true,
      members: Array.isArray(item.members) ? item.members.map(asString).filter(Boolean) : [],
    }));
  const personas = parseArray<LegacyPersona>(root.personas)
    .filter((item) => Boolean(item && asString(item.id) && asString(item.name)))
    .map((item) => ({ id: asString(item.id), name: asString(item.name), setting: asString(item.setting), avatar: safeAvatar(item.avatar) }));

  const chatPersonasRaw = parseRecord(root.chat_personas);
  const chatPersonas: Record<string, string> = {};
  for (const [sourceId, personaId] of Object.entries(chatPersonasRaw)) {
    const value = asString(personaId);
    if (value) chatPersonas[sourceId] = value;
  }

  const messagesBySourceId = new Map<string, LegacyMessage[]>();
  for (const [key, value] of Object.entries(root)) {
    if (!key.startsWith("msgs_")) continue;
    const messages = parseArray<LegacyMessage>(value);
    if (messages.length > 0) messagesBySourceId.set(key.slice(5), messages);
  }

  const memoriesBySourceId = new Map<string, LegacyMemory[]>();
  for (const [sourceId, container] of Object.entries(parseRecord(root.chat_memories))) {
    const memories = asRecord(container)?.memories;
    const parsed = Array.isArray(memories) ? memories as LegacyMemory[] : [];
    if (parsed.length > 0) memoriesBySourceId.set(sourceId, parsed);
  }

  const sharedMemoriesBySourceId = new Map<string, string[]>();
  for (const [sourceId, values] of Object.entries(parseRecord(root.shared_memories))) {
    const parsed = parseArray<unknown>(values).map(asString).filter(Boolean);
    if (parsed.length > 0) sharedMemoriesBySourceId.set(sourceId, parsed);
  }

  return { friends, personas, myProfile: asRecord(parseStoredJson(root.my_profile)), chatPersonas, messagesBySourceId, memoriesBySourceId, sharedMemoriesBySourceId };
}

function previewFrom(snapshot: LegacySnapshot): IPhoneSimulatorImportPreview {
  let messages = 0;
  for (const list of snapshot.messagesBySourceId.values()) messages += list.length;
  let coreMemories = 0;
  let longTermMemories = 0;
  for (const list of snapshot.memoriesBySourceId.values()) {
    for (const memory of list) memory.isCore ? coreMemories++ : longTermMemories++;
  }
  let sharedMemories = 0;
  for (const list of snapshot.sharedMemoriesBySourceId.values()) sharedMemories += list.length;
  return {
    characters: new Set(snapshot.friends.filter((friend) => !friend.isGroup).map((friend) => sourceCanonicalId(friend.id))).size,
    groups: snapshot.friends.filter((friend) => friend.isGroup).length,
    identities: snapshot.personas.length,
    messages,
    coreMemories,
    longTermMemories,
    sharedMemories,
  };
}

export async function inspectIPhoneSimulatorBackup(file: File): Promise<IPhoneSimulatorImportPreview> {
  return previewFrom(parseSnapshot(await file.text()));
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function chooseCharacterNames(snapshot: LegacySnapshot): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const [sourceId, messages] of snapshot.messagesBySourceId) {
    if (sourceId.startsWith("group_")) continue;
    const canonical = sourceCanonicalId(sourceId);
    const names = counts.get(canonical) ?? new Map<string, number>();
    for (const message of messages) {
      if (message.isMine) continue;
      const name = asString(message.senderName);
      if (name) names.set(name, (names.get(name) ?? 0) + 1);
    }
    counts.set(canonical, names);
  }
  const result = new Map<string, string>();
  for (const friend of snapshot.friends.filter((item) => !item.isGroup)) {
    const canonical = sourceCanonicalId(friend.id);
    const candidates = counts.get(canonical);
    const best = candidates ? [...candidates.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] : undefined;
    result.set(canonical, best || friend.name);
  }
  return result;
}

function mergeById<T extends { id: string }>(existing: T[], imported: T[]): T[] {
  const merged = new Map(existing.map((item) => [item.id, item]));
  for (const item of imported) merged.set(item.id, item);
  return [...merged.values()];
}

export async function importIPhoneSimulatorBackup(
  file: File,
  onProgress?: (progress: IPhoneSimulatorImportProgress) => void,
): Promise<IPhoneSimulatorImportResult> {
  onProgress?.({ phase: "reading", completed: 0, total: 1, detail: "正在读取旧备份…" });
  const snapshot = parseSnapshot(await file.text());
  const preview = previewFrom(snapshot);
  onProgress?.({ phase: "preparing", completed: 0, total: 1, detail: "正在整理角色、身份和会话…" });

  const characterNames = chooseCharacterNames(snapshot);
  const friendsByCanonical = new Map<string, LegacyFriend>();
  for (const friend of snapshot.friends.filter((item) => !item.isGroup)) {
    const canonical = sourceCanonicalId(friend.id);
    if (!friendsByCanonical.has(canonical) || !friend.id.includes("_alt_")) friendsByCanonical.set(canonical, friend);
  }
  const profileName = asString(snapshot.myProfile?.name);
  const profileAvatar = safeAvatar(snapshot.myProfile?.avatar);

  const identities: UserIdentity[] = snapshot.personas.map((persona) => ({
    id: `${LEGACY_PREFIX}_identity_${persona.id}`,
    name: persona.name,
    avatarUrl: persona.name === profileName ? profileAvatar || persona.avatar : persona.avatar,
    bio: persona.setting || "",
    gender: "",
    age: "",
    occupation: "",
    customSettings: persona.setting || "",
  }));
  const personaById = new Map(snapshot.personas.map((persona) => [persona.id, persona]));

  const importedCharacters: Character[] = [];
  const nameToCharacterId = new Map<string, string>();
  for (const [canonical, friend] of friendsByCanonical) {
    const characterName = characterNames.get(canonical) || friend.name;
    const character: Character = {
      id: characterIdFor(canonical),
      name: characterName,
      avatar: friend.avatar ?? null,
      // Old `personas` are the user's own identities, not the counterpart's
      // character cards. They are imported below as UserIdentity records and
      // bound per chat, so never copy them into a character's persona field.
      persona: friend.name !== characterName ? `旧项目昵称：${friend.name}` : "由旧 iPhone 模拟器备份导入。",
      tags: ["旧 iPhone 模拟器导入"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    importedCharacters.push(character);
    nameToCharacterId.set(characterName, character.id);
    nameToCharacterId.set(friend.name, character.id);
  }

  // Some backups retain memories for a deleted contact even after its friend
  // card is gone. Give that archive a real character record so its memories
  // remain discoverable in the Memory app instead of becoming orphan rows.
  const orphanMemorySourceIds = new Set<string>();
  for (const sourceId of [...snapshot.memoriesBySourceId.keys(), ...snapshot.sharedMemoriesBySourceId.keys()]) {
    if (!sourceId.startsWith("group_") && !friendsByCanonical.has(sourceCanonicalId(sourceId))) {
      orphanMemorySourceIds.add(sourceCanonicalId(sourceId));
    }
  }
  for (const sourceId of orphanMemorySourceIds) {
    importedCharacters.push({
      id: characterIdFor(sourceId),
      name: `旧角色归档 ${sourceId.slice(-4)}`,
      avatar: null,
      persona: "旧 iPhone 模拟器中已删除联系人留下的记忆归档。",
      tags: ["旧 iPhone 模拟器导入", "记忆归档"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  const importedGroupMemoryCharacters: Character[] = snapshot.friends.filter((friend) => friend.isGroup && (snapshot.memoriesBySourceId.has(friend.id) || snapshot.sharedMemoriesBySourceId.has(friend.id))).map((group) => ({
    id: groupMemoryCharacterId(group.id),
    name: `群聊记忆 · ${group.name}`,
    avatar: group.avatar ?? null,
    persona: `旧 iPhone 模拟器群聊「${group.name}」的记忆归档。`,
    tags: ["旧 iPhone 模拟器导入", "群聊记忆"],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
  saveCharacters(mergeById(loadCharacters(), [...importedCharacters, ...importedGroupMemoryCharacters]));
  saveUserIdentities(mergeById(loadUserIdentities(), identities));

  const preferredIdentity = identities.find((identity) => identity.name === profileName) || identities[0];
  if (preferredIdentity) {
    let bindings = loadBindingConfig();
    bindings = { ...bindings, globalDefaults: { ...bindings.globalDefaults, userIdentityId: bindings.globalDefaults.userIdentityId || preferredIdentity.id } };
    for (const [canonical, friend] of friendsByCanonical) {
      const personaId = snapshot.chatPersonas[friend.id] || snapshot.chatPersonas[canonical];
      if (!personaId || !personaById.has(personaId)) continue;
      const characterId = characterIdFor(canonical);
      const current = bindings.characterBindings.find((binding) => binding.characterId === characterId) ?? { characterId, defaults: {}, appOverrides: {} };
      bindings = setCharacterBinding(bindings, { ...current, defaults: { ...current.defaults, userIdentityId: `${LEGACY_PREFIX}_identity_${personaId}` } });
    }
    saveBindingConfig(bindings);
  }

  const contacts: ChatContact[] = [...friendsByCanonical.keys()].map((canonical) => ({
    id: `${LEGACY_PREFIX}_contact_${canonical}`,
    characterId: characterIdFor(canonical),
    addedAt: new Date().toISOString(),
  }));
  const sessions: ChatSession[] = [];
  const messagesBySession = new Map<string, ChatMessage[]>();
  const sessionForSource = (sourceId: string) => sourceId.startsWith("group_") ? groupSessionId(sourceId) : privateSessionId(sourceId);
  const knownGroupIds = new Set(snapshot.friends.filter((friend) => friend.isGroup).map((friend) => friend.id));

  for (const [sourceId, sourceMessages] of snapshot.messagesBySourceId) {
    const sessionId = sessionForSource(sourceId);
    const list = messagesBySession.get(sessionId) ?? [];
    const isGroup = sourceId.startsWith("group_");
    for (let index = 0; index < sourceMessages.length; index++) {
      const sourceMessage = sourceMessages[index];
      const mapped = messageContentAndMedia(sourceMessage);
      const sourceType = asString(sourceMessage.type).toLowerCase();
      const senderName = asString(sourceMessage.senderName);
      const role: ChatMessage["role"] = sourceType === "system" ? "system" : sourceMessage.isMine ? "user" : "assistant";
      const messageId = asString(sourceMessage.id) || String(index);
      list.push({
        id: `${LEGACY_PREFIX}_message_${sourceId}_${messageId}`.replace(/[^a-zA-Z0-9_-]/g, "_"),
        sessionId,
        role,
        status: "read",
        createdAt: toIso(sourceMessage.time),
        content: mapped.content,
        ...(mapped.mediaType ? { mediaType: mapped.mediaType } : {}),
        ...(mapped.mediaUrl ? { mediaUrl: mapped.mediaUrl } : {}),
        ...(mapped.mediaData ? { mediaData: mapped.mediaData } : {}),
        ...(isGroup && !sourceMessage.isMine ? { senderName: senderName || "群成员", senderCharacterId: nameToCharacterId.get(senderName) } : {}),
      });
    }
    messagesBySession.set(sessionId, list);
  }

  for (const [canonical] of friendsByCanonical) {
    const sessionId = privateSessionId(canonical);
    sessions.push({ id: sessionId, contactId: characterIdFor(canonical), unreadCount: 0, updatedAt: new Date().toISOString(), isPinned: false, bilingualTranslationEnabled: true, collapseBilingualTranslation: true, visionImagePromptLimit: 1 });
  }
  for (const group of snapshot.friends.filter((friend) => friend.isGroup)) {
    const sessionId = groupSessionId(group.id);
    sessions.push({
      id: sessionId,
      contactId: `${LEGACY_PREFIX}_group_contact_${group.id}`,
      unreadCount: 0,
      updatedAt: new Date().toISOString(),
      isPinned: false,
      bilingualTranslationEnabled: true,
      collapseBilingualTranslation: true,
      visionImagePromptLimit: 1,
      isGroup: true,
      groupName: group.name,
      participantIds: (group.members || []).map(characterIdFor).filter((id) => importedCharacters.some((character) => character.id === id)),
      groupOwnerId: "self",
    });
  }
  // A few old backups contain a message collection that no longer has a friend
  // record. Keep it as a group/private archive instead of silently dropping it.
  for (const sourceId of snapshot.messagesBySourceId.keys()) {
    const sessionId = sessionForSource(sourceId);
    if (sessions.some((session) => session.id === sessionId)) continue;
    if (knownGroupIds.has(sourceId) || sourceId.startsWith("group_")) {
      sessions.push({ id: sessionId, contactId: `${LEGACY_PREFIX}_group_contact_${sourceId}`, unreadCount: 0, updatedAt: new Date().toISOString(), isPinned: false, isGroup: true, groupName: `旧群聊 ${sourceId}`, participantIds: [] });
    }
  }

  const allMessages: ChatMessage[] = [];
  for (const [sessionId, messages] of messagesBySession) {
    messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    messages.forEach((message, order) => { message.order = order; });
    const session = sessions.find((item) => item.id === sessionId);
    const last = messages[messages.length - 1];
    if (session && last) {
      session.lastMessageId = last.id;
      session.lastMessagePreview = last.content.replace(/\s+/g, " ").slice(0, 80);
      session.updatedAt = last.createdAt;
    }
    allMessages.push(...messages);
  }

  await hydrateChatStorage();
  await chatDb.contacts.bulkPut(contacts);
  await chatDb.sessions.bulkPut(sessions);
  for (let offset = 0; offset < allMessages.length; offset += MESSAGE_CHUNK_SIZE) {
    await chatDb.messages.bulkPut(allMessages.slice(offset, offset + MESSAGE_CHUNK_SIZE));
    onProgress?.({ phase: "messages", completed: Math.min(offset + MESSAGE_CHUNK_SIZE, allMessages.length), total: allMessages.length, detail: "正在写入聊天记录…" });
    await tick();
  }

  const memoryEntries: MemoryEntry[] = [];
  const memoryCharacterId = (sourceId: string) => sourceId.startsWith("group_") ? groupMemoryCharacterId(sourceId) : characterIdFor(sourceId);
  for (const [sourceId, memories] of snapshot.memoriesBySourceId) {
    for (let index = 0; index < memories.length; index++) {
      const memory = memories[index];
      const content = asString(memory.text);
      if (!content) continue;
      const sourceMemoryId = asString(memory.id) || String(index);
      memoryEntries.push({
        id: `${LEGACY_PREFIX}_memory_${sourceId}_${sourceMemoryId}`.replace(/[^a-zA-Z0-9_-]/g, "_"),
        characterId: memoryCharacterId(sourceId),
        sourceApp: sourceId.startsWith("group_") ? "group_chat" : "chat",
        type: memory.isCore ? "core" : "long_term",
        content,
        importance: memory.isCore ? 1 : 0.7,
        createdAt: toIso(memory.time),
        updatedAt: toIso(memory.time),
        metadata: { importedFrom: "iphone-simulator", legacySource: asString(memory.source), fuzzyTimeAnchor: asString(memory.fuzzyTimeAnchor) },
      });
    }
  }
  for (const [sourceId, memories] of snapshot.sharedMemoriesBySourceId) {
    memories.forEach((content, index) => memoryEntries.push({
      id: `${LEGACY_PREFIX}_shared_memory_${sourceId}_${index}`.replace(/[^a-zA-Z0-9_-]/g, "_"),
      characterId: memoryCharacterId(sourceId),
      sourceApp: sourceId.startsWith("group_") ? "group_chat" : "chat",
      type: "long_term",
      content,
      importance: 0.8,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: { importedFrom: "iphone-simulator", sharedMemory: true },
    }));
  }
  onProgress?.({ phase: "memories", completed: 0, total: memoryEntries.length, detail: "正在写入核心与长期记忆…" });
  await saveMemoryEntries(memoryEntries);
  onProgress?.({ phase: "complete", completed: 1, total: 1, detail: "本地迁移完成。" });

  return { ...preview, importedCharacters: importedCharacters.length, importedGroups: sessions.filter((session) => session.isGroup).length };
}
