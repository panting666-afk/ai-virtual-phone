import { loadChatAppSettings, saveChatAppSettings } from "./chat-storage";
import { deleteMediaRef, isMediaStoreRef, loadMediaBlob, storeMediaBlob } from "./media-cache-storage";

const MAX_MESSAGE_SOUND_BYTES = 5 * 1024 * 1024;
const AUDIO_EXTENSION_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  wav: "audio/wav",
  webm: "audio/webm",
  flac: "audio/flac",
};

let activeAudio: HTMLAudioElement | null = null;
let activeUrl: string | null = null;

function normalizedVolume(value: unknown): number {
  const volume = typeof value === "number" ? value : Number(value);
  return Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0.75;
}

function disposeActiveAudio(): void {
  if (activeAudio) {
    try { activeAudio.pause(); activeAudio.currentTime = 0; } catch { /* ignore */ }
    activeAudio = null;
  }
  if (activeUrl) {
    URL.revokeObjectURL(activeUrl);
    activeUrl = null;
  }
}

/** Store a short custom alert in the shared local media database. */
export async function saveChatMessageSound(file: File): Promise<void> {
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  const mimeType = file.type.startsWith("audio/") ? file.type : AUDIO_EXTENSION_MIME[extension];
  if (!mimeType) throw new Error("请选择 MP3、M4A、AAC、OGG、WAV、WebM 或 FLAC 音频文件。");
  if (file.size === 0) throw new Error("音频文件为空。");
  if (file.size > MAX_MESSAGE_SOUND_BYTES) throw new Error("提示音请控制在 5 MB 以内。");

  const current = loadChatAppSettings();
  const ref = await storeMediaBlob(file, mimeType, "audio");
  // Write the new reference first. If the old blob deletion fails, it only
  // leaves a recoverable orphan; never risk losing the user's selected sound.
  saveChatAppSettings({
    ...current,
    messageSoundEnabled: true,
    messageSoundRef: ref,
    messageSoundName: file.name || "自定义提示音",
    messageSoundVolume: normalizedVolume(current.messageSoundVolume),
  });
  if (current.messageSoundRef && current.messageSoundRef !== ref) {
    void deleteMediaRef(current.messageSoundRef);
  }
}

export async function clearChatMessageSound(): Promise<void> {
  const current = loadChatAppSettings();
  saveChatAppSettings({
    ...current,
    messageSoundEnabled: false,
    messageSoundRef: undefined,
    messageSoundName: undefined,
  });
  disposeActiveAudio();
  if (current.messageSoundRef) await deleteMediaRef(current.messageSoundRef);
}

/**
 * Plays only while the PWA is visible. iOS does not permit web apps to play a
 * custom file for a locked/background Web Push notification; those continue to
 * use the system notification sound selected in iOS Settings.
 */
export async function playChatMessageSound(options?: { force?: boolean }): Promise<boolean> {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  if (!options?.force && document.visibilityState !== "visible") return false;
  const settings = loadChatAppSettings();
  if (!options?.force && settings.messageSoundEnabled !== true) return false;
  if (!settings.messageSoundRef || !isMediaStoreRef(settings.messageSoundRef)) return false;

  const media = await loadMediaBlob(settings.messageSoundRef);
  if (!media || media.category !== "audio") return false;

  disposeActiveAudio();
  const url = URL.createObjectURL(media.blob);
  const audio = new Audio(url);
  audio.preload = "auto";
  audio.volume = normalizedVolume(settings.messageSoundVolume);
  activeAudio = audio;
  activeUrl = url;
  const disposeIfCurrent = () => {
    if (activeAudio !== audio) return;
    activeAudio = null;
    if (activeUrl === url) {
      URL.revokeObjectURL(url);
      activeUrl = null;
    }
  };
  audio.onended = disposeIfCurrent;
  audio.onerror = disposeIfCurrent;
  try {
    await audio.play();
    return true;
  } catch {
    disposeIfCurrent();
    return false;
  }
}

export function getChatMessageSoundVolume(): number {
  return normalizedVolume(loadChatAppSettings().messageSoundVolume);
}

export function setChatMessageSoundVolume(volume: number): void {
  const settings = loadChatAppSettings();
  const nextVolume = normalizedVolume(volume);
  saveChatAppSettings({ ...settings, messageSoundVolume: nextVolume });
  if (activeAudio) activeAudio.volume = nextVolume;
}
