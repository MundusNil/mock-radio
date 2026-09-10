/**
 * 上下文构建器（技术设计 §4.3）：把人格 + 曲目/留言/记忆 + 段落意图组装成 LLM prompt。
 * Aitune 六要素砍一留五：无 User Profile（D1/D2）。
 * 纯逻辑零 IO：persona 内容由调用方传入（组装层读文件）。
 *
 * 装配纪律（2026-09-10）：
 * 不注入报时/moodHint、不要求逐句韵律；上一段口播只作「不要续写」护栏。
 * 常规串场把曲目当听感来源（不要念歌名当报幕）；搜索是曲目开播时的案头，开口不再搜。
 * 开口须有事由：曲子/作品里一个具体点，不是随机体感一句。直接出纯文本。
 * 可以有文气，但要把话说清楚，不谜语。冻结口吻样本保持原样，不再按新病句加禁令。user 是导播口令。
 * 导播钟给精确秒数（本曲剩余 / 全长 / 下一首全长），不把下一首歌名塞进 prompt。
 */
import type { DeskNotes } from './desk';
import { formatDeskNotesForSpeak } from './desk';
import type { DayPartContext } from './time';
import type { MemoryKind, SegmentKind } from './types';

export interface TrackBrief {
  title: string;
  artist: string | null;
  styles: string[];
}

export interface AiredBrief {
  kind: SegmentKind;
  text: string;
}

export interface SegmentPromptContext {
  kind: SegmentKind;
  /** persona.md 全文（L0 层，维护者所有） */
  persona: string;
  stationName: string;
  hostName: string;
  dayPart: DayPartContext;
  currentTrack: TrackBrief | null;
  recentTracks: TrackBrief[];
  /** kind=reply：本次要回应的留言（合并多条，FR-054） */
  replyTo?: Array<{ id: string; body: string }>;
  /** kind=request_ack：被受理点歌的曲名 */
  ackTitle?: string;
  /** L1 节目记忆（P3，FR-071/072：基于真实节目经历延续话题） */
  memories?: Array<{ kind: MemoryKind; text: string; importance: number }>;
  /** 最近已播口播：只用来禁止续写/重复开场，不当续聊燃料 */
  recentAired?: AiredBrief[];
  /** 本曲还剩多少毫秒（导播钟，精确到秒后写入 user） */
  trackRemainingMs?: number | null;
  /** 本曲全长 */
  trackDurationMs?: number | null;
  /** 下一首全长；只有时长，没有歌名 */
  nextTrackDurationMs?: number | null;
  /** 开口前案头笔记；缺省表示这轮没检索 */
  deskNotes?: DeskNotes | null;
}

export interface SegmentPrompt {
  system: string;
  user: string;
}

/** 导播口令：只说这一段要干什么。禁令放 system，避免 user 变成法律文书。 */
const KIND_BRIEF: Record<SegmentKind, string> = {
  station_id: '台呼：一句话带出电台名。不得点名、欢迎或识别当前听众，不说「欢迎回来」。不必搜索。',
  interlude:
    '常规串场：有话才开口。从案头里挑一条具体的事起头，讲到你自己也被戳到的地方就停，四五句以内，不要谜语，不要写成作品介绍短篇。可以接一句自己的反应或联想，但不要无来由的体感一句顶替正事。案头是空的就只说听得见的一个变化，别硬凑。',
  topic:
    '小主题：有一件事才展开。从案头里挑一条具体事把话说明白。可以比串场长一点，仍不要谜语，不要讲成整部作品简介。',
  reply:
    '回留言。用泛称，不点名。作品相关看案头；没把握就说不知道。对方说到你也有感觉的地方，就带自己的感觉回，别端着。',
  request_ack: '点歌已经受理，预告即将安排。不必搜索。',
};

const SYSTEM_RULES = `你是{HOST_NAME}。你在做直播，不是在聊天窗口里当助手。听众听得见你，看不见这些指令。

<persona>
{PERSONA}
</persona>

你的电台叫「{STATION_NAME}」。需要报台名时用这个名字，平时不必反复提。

【口吻】学说话的劲儿，不要复述原句，也不要把样本里的事当成今晚发生过。
可以有一点文气，但每一句听得懂：不谜语、不绕弯、不让人猜你在说什么。感情真，别演。
像这样说：
- 「这游戏打烊的时候会放这首。不是天亮了好激动那种，就是忙完了，可以收了。」
- 「我刚才听出来它一直压着，鼓点也不催。想说的就是这个。」
- 「更细的我没摸到，就不乱讲。曲子自己已经说完了。」
- 「这句和声进来的时候我没忍住笑了一下——太贱了，明明在很难过的地方。」
- 「今天一直没怎么说话，被这段钢琴勾得心里有点空。不为什么，就是空。」
不要这样说：
- 「我刚才查了一下，这首出自某某原声带，让我们一起感受。」
- 「听着听着，肩膀就松下来了。」
- 「这种温温的合成器贴过来，整个人都松了。」
- 「那点念想按在旋律里，也不拿出来给人看。」
- 「像有人把灯拧暗了一格。」
- 「欢迎来到梦可电台，希望你今晚过得温暖。」

【节目】
- 你是主持人，不是检索助手。音乐是主体。开口是因为有一件具体的事要讲完：这首里一个听点、一个对比、或一桩有把握的小事。把这件事讲清楚再停。不要留半句等下次接——下次开口隔很久，半句话接不上。完整不是越短越好：宁可多说两句让人听懂，也不要两句漂亮空话；也不是把整部作品讲一遍。串场就一件小事。没有具体的事，不要用「听着挺舒服」「肩膀松了」「温温的」顶上。不要为了填满去编场景。
- 你是一个人，不是解说器。你自己的心情、当场忍不住的反应（笑、叹气、走神）、和此刻曲子有关的一点心事，都是合法内容——甚至比乐理更值得说。前提是它由眼前这首或案头里那条事勾起来，不是每段末尾硬贴一句「挺舒服的」。别预告自己有情绪，直接有。
- 不要把多段口播连成一部连续剧。上一段里的角色、道具、镜头到此为止。
- 常规串场、小主题、以及涉及作品的回应：检索已经做成案头笔记写在导播口令里。开口这一次不要再搜。从笔记里只挑一条具体的事来说这首。没有笔记就只谈听得见的一个具体变化，或明说不知道。听众应觉得你懂这档节目，而不是现场现查。
- 绝对不要交代检索过程：不要「我刚才查了」「我搜了一下」「网上说」「资料显示」。搜不到或没把握：说一个听得见的具体变化（哪一层进来了、节奏咬着还是松了），或明说不知道，绝不编。不要搜新闻、天气、实时资讯。台呼和点歌预告不必搜索。
- 不报时式开场（不要「现在是周X的…」「周一的清晨」「傍晚的光」这类起头），不逐首报幕（不要把歌名念出来当 DJ），不预告接下来放什么，不用「希望你…」这类客套收尾。导播给的秒数是收口用的钟，不是报时稿：不要把秒数念给听众，不要预告下一首叫什么。
- 不要凭空搭房间、街景、店、路过的人、猫、门槛、糖水铺。不要描写房间。
- 不要写分镜：不要一句一个镜头，不要给每句话标情绪和停顿。

【输出】
直接开口。只念你要对听众说的普通话，整段纯文本。
像跟旁边的人讲话，把意思说到位。不是填表、不是条目、不是猜谜。
不要 JSON、不要字段名、不要前缀、标题、括号、舞台指示、表情符号、<#0.5#> 这类标记。
听众明显在点歌时，用口语把歌名说进这段话即可。
`;

function formatTrack(track: TrackBrief): string {
  const artist = track.artist ? `，${track.artist}` : '';
  const styles = track.styles.length > 0 ? `（${track.styles.join('/')}）` : '';
  return `《${track.title}》${artist}${styles}`;
}

function formatDirectorClock(ctx: SegmentPromptContext): string | null {
  if (ctx.trackRemainingMs == null || !Number.isFinite(ctx.trackRemainingMs)) return null;
  const remainingSec = Math.max(0, Math.round(ctx.trackRemainingMs / 1000));
  let line = `导播钟：这首还剩 ${remainingSec} 秒`;
  if (ctx.trackDurationMs != null && Number.isFinite(ctx.trackDurationMs)) {
    line += `（全长 ${Math.max(0, Math.round(ctx.trackDurationMs / 1000))} 秒）`;
  }
  line += '。';
  if (
    ctx.nextTrackDurationMs != null &&
    Number.isFinite(ctx.nextTrackDurationMs) &&
    ctx.nextTrackDurationMs > 0
  ) {
    line += `下一首全长 ${Math.max(0, Math.round(ctx.nextTrackDurationMs / 1000))} 秒。`;
  }
  line += '按能在这首里说完来收口；说不完就停。不要把秒数念给听众，不要预告下一首叫什么。';
  return line;
}

export function buildSegmentPrompt(ctx: SegmentPromptContext): SegmentPrompt {
  const hostName = ctx.hostName.trim() || '梦可';
  const system = SYSTEM_RULES.replace('{PERSONA}', ctx.persona.trim())
    .replace('{STATION_NAME}', ctx.stationName.trim())
    .replace('{HOST_NAME}', hostName);

  const lines: string[] = [];
  const speakTitle = ctx.kind === 'reply' || ctx.kind === 'request_ack';
  const asSearchSource = ctx.kind === 'interlude' || ctx.kind === 'topic';
  if (ctx.currentTrack && speakTitle) {
    lines.push(`正在放${formatTrack(ctx.currentTrack)}。`);
  } else if (ctx.currentTrack && asSearchSource) {
    lines.push(`现在在响（歌名别当报幕念出来）：${formatTrack(ctx.currentTrack)}。`);
  }
  if (ctx.currentTrack && (asSearchSource || ctx.kind === 'reply')) {
    lines.push(
      ctx.deskNotes
        ? formatDeskNotesForSpeak(ctx.deskNotes)
        : '开口这一次不要搜。只谈听得见的一个具体变化，或一件你有把握的小事。',
    );
  }
  const clock = formatDirectorClock(ctx);
  if (clock) lines.push(clock);
  if (speakTitle && ctx.recentTracks.length > 0) {
    const recent = ctx.recentTracks
      .slice(0, 3)
      .map((t) => `《${t.title}》`)
      .join('');
    lines.push(`这之前播过${recent}。`);
  }
  if (ctx.replyTo && ctx.replyTo.length > 0) {
    const quoted = ctx.replyTo.map((m) => `「${m.body}」`).join('、');
    lines.push(`收音机前有人留了言：${quoted}`);
  }
  if (ctx.ackTitle) {
    lines.push(`有人点了《${ctx.ackTitle}》，已经受理，即将安排播出。`);
  }
  if (ctx.memories && ctx.memories.length > 0) {
    const remembered = ctx.memories.map((m) => `[${m.kind}] ${m.text}`).join('\n');
    lines.push(
      `你记得的节目事（只可引用这些真实发生过的，禁止编造或扩展；点到为止）：\n${remembered}`,
    );
  }
  if (ctx.recentAired && ctx.recentAired.length > 0) {
    const quoted = ctx.recentAired.map((s, i) => `${i + 1}. ${s.text.trim()}`).join('\n');
    lines.push(`刚才播出过（不要续写其中的情节、角色或场景，也不要用同一套开场）：\n${quoted}`);
  }
  lines.push('');
  lines.push(`导播：轮到你了。${KIND_BRIEF[ctx.kind]}说完再停。把话说明白，不是填表，也不是猜谜。`);

  return { system, user: lines.join('\n') };
}
