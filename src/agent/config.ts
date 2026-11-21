export type AvatarMode = 'tavus' | 'none';
export type NoiseCancelMode = 'bvc' | 'nc' | 'off';
export type RoomMode = 'noisy' | 'quiet';
export type VadStartSensitivity =
  | 'START_SENSITIVITY_LOW'
  | 'START_SENSITIVITY_HIGH'
  | 'START_SENSITIVITY_UNSPECIFIED';
export type VadEndSensitivity =
  | 'END_SENSITIVITY_LOW'
  | 'END_SENSITIVITY_HIGH'
  | 'END_SENSITIVITY_UNSPECIFIED';

export interface VadConfig {
  room: RoomMode;
  startOfSpeechSensitivity: VadStartSensitivity;
  endOfSpeechSensitivity: VadEndSensitivity;
  silenceDurationMs: number;
  prefixPaddingMs: number | undefined;
}

export interface AgentConfig {
  googleApiKey: string | undefined;
  agentName: string;
  modelLive: string;
  geminiVoice: string;
  language: string;
  avatar: AvatarMode;
  tavusApiKey: string | undefined;
  tavusFaceId: string | undefined;
  tavusPersonaId: string | undefined;
  vision: boolean;
  visionFrameMs: number;
  noiseCancel: NoiseCancelMode;
  roomMode: RoomMode;
  vad: VadConfig;
}

export interface ResolvedTavusConfig {
  enabled: boolean;
  requested: boolean;
  missingReason?: string;
  apiKey?: string;
  faceId?: string;
  personaId?: string;
}

export const ROOM_VAD_PRESETS: Record<RoomMode, Omit<VadConfig, 'room'>> = {
  noisy: {
    startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
    endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
    silenceDurationMs: 500,
    prefixPaddingMs: 150,
  },
  quiet: {
    startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
    endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
    silenceDurationMs: 500,
    prefixPaddingMs: undefined,
  },
};

function parseBoolEnv(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const norm = raw.trim().toLowerCase();
  if (norm === 'on' || norm === 'true' || norm === '1' || norm === 'yes') return true;
  if (norm === 'off' || norm === 'false' || norm === '0' || norm === 'no') return false;
  return defaultValue;
}

function parsePositiveIntEnv(raw: string | undefined, defaultValue: number): number {
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return defaultValue;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : defaultValue;
}

function parseOptionalNonNegativeIntEnv(
  raw: string | undefined,
  defaultValue: number | undefined,
): number | undefined {
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'off' || trimmed === 'none') return undefined;
  if (!/^\d+$/.test(trimmed)) return defaultValue;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : defaultValue;
}

function parseAvatarMode(raw: string | undefined): AvatarMode {
  if (raw === undefined || raw.trim() === '') return 'none';
  const norm = raw.trim().toLowerCase();
  if (norm === 'tavus' || norm === 'none') return norm;
  return 'none';
}

function parseNoiseCancelMode(raw: string | undefined): NoiseCancelMode {
  if (raw === undefined || raw.trim() === '') return 'bvc';
  const norm = raw.trim().toLowerCase();
  if (norm === 'bvc' || norm === 'nc' || norm === 'off') return norm;
  return 'bvc';
}

function parseRoomMode(raw: string | undefined): RoomMode {
  if (raw === undefined || raw.trim() === '') return 'noisy';
  const norm = raw.trim().toLowerCase();
  if (norm === 'noisy' || norm === 'quiet') return norm;
  return 'noisy';
}

function parseVadStartSensitivity(
  raw: string | undefined,
  defaultValue: VadStartSensitivity,
): VadStartSensitivity {
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const norm = raw.trim().toUpperCase();
  if (norm === 'LOW' || norm === 'START_SENSITIVITY_LOW') return 'START_SENSITIVITY_LOW';
  if (norm === 'HIGH' || norm === 'START_SENSITIVITY_HIGH') return 'START_SENSITIVITY_HIGH';
  if (norm === 'UNSPECIFIED' || norm === 'START_SENSITIVITY_UNSPECIFIED') {
    return 'START_SENSITIVITY_UNSPECIFIED';
  }
  return defaultValue;
}

function parseVadEndSensitivity(
  raw: string | undefined,
  defaultValue: VadEndSensitivity,
): VadEndSensitivity {
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const norm = raw.trim().toUpperCase();
  if (norm === 'LOW' || norm === 'END_SENSITIVITY_LOW') return 'END_SENSITIVITY_LOW';
  if (norm === 'HIGH' || norm === 'END_SENSITIVITY_HIGH') return 'END_SENSITIVITY_HIGH';
  if (norm === 'UNSPECIFIED' || norm === 'END_SENSITIVITY_UNSPECIFIED') {
    return 'END_SENSITIVITY_UNSPECIFIED';
  }
  return defaultValue;
}

export function buildAutomaticActivityDetection(vad: VadConfig): {
  disabled: false;
  startOfSpeechSensitivity: VadStartSensitivity;
  endOfSpeechSensitivity: VadEndSensitivity;
  silenceDurationMs: number;
  prefixPaddingMs?: number;
} {
  return {
    disabled: false,
    startOfSpeechSensitivity: vad.startOfSpeechSensitivity,
    endOfSpeechSensitivity: vad.endOfSpeechSensitivity,
    silenceDurationMs: vad.silenceDurationMs,
    ...(vad.prefixPaddingMs !== undefined ? { prefixPaddingMs: vad.prefixPaddingMs } : {}),
  };
}

export function resolveTavusConfig(
  config: Pick<AgentConfig, 'avatar' | 'tavusApiKey' | 'tavusFaceId' | 'tavusPersonaId'>,
): ResolvedTavusConfig {
  if (config.avatar !== 'tavus') {
    return { enabled: false, requested: false };
  }
  const apiKey = config.tavusApiKey?.trim() || undefined;
  const faceId = config.tavusFaceId?.trim() || undefined;
  const personaId = config.tavusPersonaId?.trim() || undefined;

  if (!apiKey && !faceId) {
    return {
      enabled: false,
      requested: true,
      missingReason: 'missing TAVUS_API_KEY and TAVUS_FACE_ID',
    };
  }
  if (!apiKey) {
    return {
      enabled: false,
      requested: true,
      missingReason: 'missing TAVUS_API_KEY',
    };
  }
  if (!faceId) {
    return {
      enabled: false,
      requested: true,
      missingReason: 'missing TAVUS_FACE_ID',
    };
  }
  return {
    enabled: true,
    requested: true,
    apiKey,
    faceId,
    ...(personaId ? { personaId } : {}),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const agentName = env.ALICE_AGENT_NAME?.trim() || 'alice';
  const modelLive = env.ALICE_MODEL_LIVE?.trim() || 'gemini-3.8-live';
  const geminiVoice = env.GEMINI_VOICE?.trim() || 'Aoede';
  const avatar = parseAvatarMode(env.AVATAR);
  const tavusApiKey = env.TAVUS_API_KEY?.trim() || undefined;
  const tavusFaceId = env.TAVUS_FACE_ID?.trim() || undefined;
  const tavusPersonaId = env.TAVUS_PERSONA_ID?.trim() || undefined;
  const vision = parseBoolEnv(env.VISION, true);
  const visionFrameMs = parsePositiveIntEnv(env.VISION_FRAME_MS, 1000);
  const googleApiKey = env.GOOGLE_API_KEY?.trim() || undefined;
  const noiseCancel = parseNoiseCancelMode(env.ALICE_NOISE_CANCEL);
  const roomMode = parseRoomMode(env.ALICE_ROOM);
  const preset = ROOM_VAD_PRESETS[roomMode];
  const vad: VadConfig = {
    room: roomMode,
    startOfSpeechSensitivity: parseVadStartSensitivity(
      env.ALICE_VAD_START,
      preset.startOfSpeechSensitivity,
    ),
    endOfSpeechSensitivity: parseVadEndSensitivity(
      env.ALICE_VAD_END,
      preset.endOfSpeechSensitivity,
    ),
    silenceDurationMs: parsePositiveIntEnv(env.ALICE_VAD_SILENCE_MS, preset.silenceDurationMs),
    prefixPaddingMs: parseOptionalNonNegativeIntEnv(
      env.ALICE_VAD_PREFIX_MS,
      preset.prefixPaddingMs,
    ),
  };

  return {
    googleApiKey,
    agentName,
    modelLive,
    geminiVoice,
    language: 'en-US',
    avatar,
    tavusApiKey,
    tavusFaceId,
    tavusPersonaId,
    vision,
    visionFrameMs,
    noiseCancel,
    roomMode,
    vad,
  };
}
