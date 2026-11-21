export interface AgentConfig {
  googleApiKey: string | undefined;
  agentName: string;
  modelLive: string;
  geminiVoice: string;
  language: string;
  avatar: string;
  vision: boolean;
  visionFrameMs: number;
}

function parseBoolEnv(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const norm = raw.trim().toLowerCase();
  if (norm === 'on' || norm === 'true' || norm === '1' || norm === 'yes') return true;
  if (norm === 'off' || norm === 'false' || norm === '0' || norm === 'no') return false;
  return defaultValue;
}

function parsePositiveIntEnv(raw: string | undefined, defaultValue: number): number {
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const agentName = env.ALICE_AGENT_NAME?.trim() || 'alice';
  const modelLive = env.ALICE_MODEL_LIVE?.trim() || 'gemini-3.8-live';
  const geminiVoice = env.GEMINI_VOICE?.trim() || 'Aoede';
  const avatar = env.AVATAR?.trim().toLowerCase() || 'none';
  const vision = parseBoolEnv(env.VISION, true);
  const visionFrameMs = parsePositiveIntEnv(env.VISION_FRAME_MS, 1000);
  const googleApiKey = env.GOOGLE_API_KEY?.trim() || undefined;

  return {
    googleApiKey,
    agentName,
    modelLive,
    geminiVoice,
    language: 'en-US',
    avatar,
    vision,
    visionFrameMs,
  };
}
