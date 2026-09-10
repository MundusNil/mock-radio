/** TTS 端口：文案 → 语音文件；实现见 adapters/tts（D8：候选池随时换） */
import type { SpeechLine } from './speech';

export interface SynthesizedSpeech {
  filePath: string;
  durationMs: number;
  /** 命中缓存（文本与韵律哈希相同） */
  cached: boolean;
}

export interface TtsClient {
  /**
   * 合成一段口播。
   * 传 string：整段一种语气（老路径）。
   * 传 SpeechLine[]：每句自带语速 / 情绪 / 停顿，供应商按需消费——
   * 不支持韵律的供应商（如 edge-tts）自动降级为纯文本拼接，不会报错。
   */
  synthesize(input: string | SpeechLine[], signal?: AbortSignal): Promise<SynthesizedSpeech>;
}
