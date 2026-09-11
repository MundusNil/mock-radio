/** 前端 API/WS 客户端：调频进入（对时）、事件流、断线重连、上行留言 */
import type { ClientEvent, ServerEvent, StationState } from '@mock-radio/shared';

export interface StationInfo {
  station: { name: string; host: string };
  audio: {
    ducking: {
      speechGain: number;
      attackTauMs: number;
      releaseDelayMs: number;
      releaseTauMs: number;
    };
    /** 切歌交叠淡变时长（ms）；0 = 硬切 */
    crossfadeMs: number;
  };
  /** 语音设置（开台时读取：总开关 + 主播音量） */
  voice?: { enabled: boolean; speechVolume: number };
}

export async function fetchConfig(): Promise<StationInfo> {
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error(`/api/config ${res.status}`);
  return (await res.json()) as StationInfo;
}

export async function fetchState(): Promise<StationState> {
  const res = await fetch('/api/state');
  if (!res.ok) throw new Error(`/api/state ${res.status}`);
  return (await res.json()) as StationState;
}

/** 服务器-本地时钟偏移：本地时间 + offset ≈ 服务器时间 */
export function calibrate(state: StationState): number {
  return state.serverTime - Date.now();
}

export interface WsHandle {
  close(): void;
  /** 上行留言（P2） */
  sendMessage(body: string): void;
  /** 上行任意原始消息（ER-004 track-failed 等） */
  sendRaw(payload: string): void;
}

/** 连接电台事件流；断线自动重连（收音机掉线自动重新调频）：指数退避 1s→30s + 抖动，连上即复位。 */
export function connectWs(onEvent: (event: ServerEvent) => void, onOpen?: () => void): WsHandle {
  let closed = false;
  let ws: WebSocket | null = null;
  let attempt = 0;

  function connect(): void {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.onopen = () => {
      attempt = 0;
      onOpen?.();
    };
    ws.onmessage = (msg) => {
      try {
        onEvent(JSON.parse(msg.data as string) as ServerEvent);
      } catch {
        // 无效消息忽略，事件流不断
      }
    };
    ws.onclose = () => {
      if (closed) return;
      // 重启窗口内别同步轰炸：base×2^n 封顶 30s，半幅随机打散各标签页重试时刻
      const base = Math.min(1_000 * 2 ** attempt, 30_000);
      attempt++;
      setTimeout(connect, base / 2 + Math.random() * (base / 2));
    };
  }

  connect();
  return {
    close() {
      closed = true;
      ws?.close();
    },
    sendMessage(body: string) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'message', body } satisfies ClientEvent));
      }
    },
    sendRaw(payload: string) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    },
  };
}

// ---- 设置面板：密钥配置（GET 只回「是否已配置」；POST 写入 .env 并热生效） ----

export interface KeyStatus {
  env: string;
  label: string;
  /** 面板分组（同厂商放一组） */
  group: string;
  configured: boolean;
  /** 按真实值长度生成的掩码（点数=长度，改完一眼可见） */
  masked: string;
}

export async function fetchKeyStatus(): Promise<KeyStatus[]> {
  const res = await fetch('/api/admin/keys');
  if (!res.ok) throw new Error(`/api/admin/keys ${res.status}`);
  const data = (await res.json()) as { keys: KeyStatus[] };
  return data.keys;
}

export async function applyKeys(
  updates: Record<string, string>,
): Promise<{ ok: true; status: KeyStatus[] }> {
  const res = await fetch('/api/admin/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ updates }),
  });
  const data = (await res.json()) as { ok?: true; status?: KeyStatus[]; error?: string };
  if (!res.ok || !data.ok) throw new Error(data.error ?? `POST /api/admin/keys ${res.status}`);
  return { ok: true, status: data.status ?? [] };
}

// ---- 设置面板：语音设置（GET 回当前值 + 频率档位；POST 写 station.config.json 并热生效） ----

export interface VoiceSettings {
  enabled: boolean;
  /** 语速基准 0.5~1.5 */
  speechRate: number;
  /** 主播音量 0~1 */
  speechVolume: number;
  /** 发言频率档位 id */
  cadence: string;
}

export interface CadencePreset {
  id: string;
  label: string;
  hint: string;
  perHour: string;
}

export async function fetchVoiceSettings(): Promise<{
  settings: VoiceSettings;
  cadences: CadencePreset[];
}> {
  const res = await fetch('/api/admin/voice');
  if (!res.ok) throw new Error(`/api/admin/voice ${res.status}`);
  return (await res.json()) as { settings: VoiceSettings; cadences: CadencePreset[] };
}

export async function applyVoiceSettings(patch: Partial<VoiceSettings>): Promise<VoiceSettings> {
  const res = await fetch('/api/admin/voice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: patch }),
  });
  const data = (await res.json()) as { ok?: true; settings?: VoiceSettings; error?: string };
  if (!res.ok || !data.ok) throw new Error(data.error ?? `POST /api/admin/voice ${res.status}`);
  return data.settings as VoiceSettings;
}
