/**
 * 对外契约类型（技术设计 §5 数据模型 + §4.1 段落类型）。
 * apps 与 adapters 共享；字段与 SQLite 表一一对应。
 */

/** 子风格标签：config/library 下的文件夹名（如 "game-bgm"、"cafe"） */
export type SubStyle = string;

/** 曲库中的一首歌（tracks 表） */
export interface Track {
  id: string;
  /** 曲库内相对路径 */
  path: string;
  title: string;
  artist: string | null;
  durationMs: number;
  styles: SubStyle[];
  enabled: boolean;
  addedAt: number;
}

/** 播放历史（plays 表）；listenerCount 供「节目真实发生过」判定 */
export interface PlayRecord {
  id: string;
  trackId: string;
  startedAt: number;
  endedAt: number | null;
  listenerCount: number;
}

/** 段落类型（§4.1）：VOICE 状态机的五种开口 */
export type SegmentKind =
  | 'station_id' // 台呼：非个人化，开台后首个自然节点
  | 'interlude' // 常规串场，10~25s
  | 'topic' // 小主题，1~2min，冷却 ≥40min
  | 'reply' // 回应留言，15~45s
  | 'request_ack'; // 点歌受理 / 婉拒 / 预告，10~20s

export type SegmentStatus = 'planned' | 'generating' | 'ready' | 'aired' | 'dropped'; // 来不及则放弃，沉默保底

/** 主播播出的一段话（segments 表） */
export interface Segment {
  id: string;
  kind: SegmentKind;
  text: string;
  audioPath: string | null;
  /** 语音时长（TTS 完成后回填；引擎 VOICE 状态机的时长依据） */
  durationMs: number | null;
  plannedAt: number;
  airedAt: number | null;
  status: SegmentStatus;
}

/** 原始留言（messages 表，7 天自动清理；永不自动进入长期记忆） */
export interface ListenerMessage {
  id: string;
  body: string;
  receivedAt: number;
  expiresAt: number;
}

/** L1 节目记忆分类 */
export type MemoryKind = 'topic' | 'promise' | 'meme' | 'event';

/** L1 节目记忆（memories 表）：只收经核实的匿名策展记录 */
export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  text: string;
  importance: number;
  createdAt: number;
  lastUsedAt: number | null;
  status: 'active' | 'archived' | 'deleted';
}
