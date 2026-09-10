/** LLM 端口：core 不知道协议细节；实现见 adapters/llm（D7：OpenAI 兼容通吃） */

import type { SegmentPrompt } from './context';
import type { DeskNotes, DeskResearchBrief } from './desk';
import type { SpeechLine } from './speech';
import type { MemoryKind } from './types';

export interface SegmentDraft {
  /** 完整播报文本（入库 / 记忆提取 / 日志用） */
  text: string;
  /**
   * 逐句韵律（语速 / 情绪 / 句间停顿），交给 TTS 消费。
   * 缺省表示整段一种语气；为空数组时调用方回退到 text。
   */
  lines?: SpeechLine[];
  /** P2 点歌：留言含点歌意图时，LLM 提取的点歌请求（受理与否由组装层匹配曲库后决定） */
  songRequest?: { query: string } | null;
}

/** P3：一段播报中值得沉淀为 L1 的节目事实（策展写入，匿名） */
export interface MemoryExtraction {
  kind: MemoryKind;
  text: string;
  importance: number;
}

export interface LlmClient {
  /** 生成一段播报文案；失败抛错，由组装层决定静默降级（沉默保底） */
  generateSegment(prompt: SegmentPrompt, signal?: AbortSignal): Promise<SegmentDraft>;
  /** 判断一段播报是否含值得长期保留的节目事实（FR-080~085：匿名策展） */
  extractMemories(segmentText: string): Promise<MemoryExtraction[]>;
  /**
   * 开口前的案头检索（曲目开播时预取）。失败由调用方当空笔记。
   * 未实现则视为无案头。
   */
  researchDesk?(brief: DeskResearchBrief, signal?: AbortSignal): Promise<DeskNotes>;
}
