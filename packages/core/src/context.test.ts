import { describe, expect, it } from 'vitest';
import { buildSegmentPrompt } from './context';
import { getDayPartContext } from './time';

const PERSONA = '# 梦可\n温柔、安静、细腻、克制。';

const ctx = {
  kind: 'interlude' as const,
  persona: PERSONA,
  stationName: '梦可电台',
  hostName: '梦可',
  dayPart: getDayPartContext(new Date(2026, 7, 19, 20, 0)),
  currentTrack: { title: '月光小径', artist: null, styles: ['cafe'] },
  recentTracks: [{ title: '晨雾', artist: null, styles: ['game-bgm'] }],
};

/** 2026-09-02 已播失败样例：糖水铺连续剧。护栏必须看见它并禁止续写。 */
const SUGAR_SHOP_SERIAL = [
  '风里飘来点姜糖的甜。是对面糖水铺刚开锅吧。扎马尾的姑娘掀了帘子进去。',
  '它在门槛边蹲住了。尾巴盘成个小毛圈。没敢往里蹭。铜铃又轻响了一声。',
];

describe('buildSegmentPrompt', () => {
  it('system 注入人格全文与直播规则', () => {
    const p = buildSegmentPrompt(ctx);
    expect(p.system).toContain(PERSONA);
    expect(p.system).toContain('你是梦可。你在做直播，不是在聊天窗口里当助手');
    expect(p.system).not.toContain('{PERSONA}');
  });

  it('system 注入配置的电台名，台呼不用自报「氛围电台」', () => {
    const p = buildSegmentPrompt({ ...ctx, kind: 'station_id' });
    expect(p.system).toContain('你的电台叫「梦可电台」');
    expect(p.system).not.toContain('{STATION_NAME}');
  });

  it('常规串场把曲目当听感来源，开口不再叫模型现场搜', () => {
    const p = buildSegmentPrompt(ctx);
    expect(p.user).toContain('《月光小径》');
    expect(p.user).toContain('歌名别当报幕念出来');
    expect(p.user).toContain('开口这一次不要搜');
    expect(p.user).not.toContain('《晨雾》');
    expect(p.user).not.toContain('周三');
    expect(p.user).not.toContain('渐暗');
    expect(p.user).not.toContain('此刻');
    expect(p.system).toContain('不报时式开场');
  });

  it('reply 用「正在播放」点曲名，便于回应点歌或问歌', () => {
    const p = buildSegmentPrompt({
      ...ctx,
      kind: 'reply',
      replyTo: [{ id: 'm1', body: '这首是什么' }],
    });
    expect(p.user).toContain('正在放《月光小径》');
    expect(p.user).toContain('这首是什么');
  });

  it('台呼约束明确禁止点名与「欢迎回来」（FR-005）', () => {
    const p = buildSegmentPrompt({ ...ctx, kind: 'station_id' });
    expect(p.user).toContain('不得点名');
    expect(p.user).toContain('欢迎回来');
    expect(p.user).toContain('不必搜索');
    expect(p.user).not.toContain('《月光小径》');
  });

  it('串场只约束意图不设字数门禁（FR-032/033），但不再教具体意象', () => {
    const interlude = buildSegmentPrompt({ ...ctx, kind: 'interlude' });
    const topic = buildSegmentPrompt({ ...ctx, kind: 'topic' });
    const stationId = buildSegmentPrompt({ ...ctx, kind: 'station_id' });
    expect(interlude.user).toContain('常规串场');
    expect(topic.user).toContain('小主题');
    for (const p of [interlude, topic, stationId]) {
      expect(p.user).not.toContain('40~90 字');
      expect(p.user).not.toContain('200~450 字');
      expect(p.user).not.toContain('15~35 字');
    }
    expect(interlude.user).toContain('有话才开口');
    expect(interlude.user).toContain('不要无来由的体感一句');
    expect(interlude.user).toContain('不要谜语');
    expect(interlude.user).toContain('不要写成作品介绍短篇');
    expect(interlude.system).toContain('不要描写房间');
  });

  it('开口须有事由：把一件具体的事讲清楚再停，不留半句给下次', () => {
    const p = buildSegmentPrompt(ctx);
    expect(p.system).toContain('有一件具体的事要讲完');
    expect(p.system).toContain('把这件事讲清楚再停');
    expect(p.system).toContain('不要留半句等下次接');
    expect(p.system).toContain('宁可多说两句让人听懂');
    expect(p.system).toContain('也不是把整部作品讲一遍');
    expect(p.user).toContain('说完再停');
  });

  it('搜索是案头准备：开口不再搜，禁止交代「我查了」', () => {
    const p = buildSegmentPrompt(ctx);
    expect(p.system).toContain('你是主持人，不是检索助手');
    expect(p.system).toContain('开口这一次不要再搜');
    expect(p.system).toContain('从笔记里只挑一条具体的事');
    expect(p.system).toContain('我刚才查了');
    expect(p.system).toContain('我搜了一下');
    expect(p.system).toContain('听众应觉得你懂这档节目');
  });

  it('系统给冻结口吻样本，学劲儿不学情节', () => {
    const p = buildSegmentPrompt(ctx);
    expect(p.system).toContain('像这样说');
    expect(p.system).toContain('不要这样说');
    expect(p.system).toContain('想说的就是这个');
    expect(p.system).toContain('不谜语');
    expect(p.system).toContain('灯拧暗了一格');
    expect(p.system).toContain('肩膀就松下来了');
    expect(p.system).toContain('温温的合成器');
    expect(p.user).not.toContain('像这样说');
  });

  it('文案与韵律解耦：直接开口纯文本，不要 JSON 合同或逐句 emotion/pause', () => {
    const p = buildSegmentPrompt(ctx);
    expect(p.system).toContain('直接开口');
    expect(p.system).toContain('不要 JSON');
    expect(p.system).not.toContain('只输出 JSON');
    expect(p.system).not.toContain('songRequest');
    expect(p.system).not.toContain('"lines"');
    expect(p.system).not.toContain('emotion');
    expect(p.system).not.toContain('pause');
    expect(p.system).toContain('不要写分镜');
  });

  it('克制规则：禁固定街景连续剧、报时开场、逐首报幕与客套收尾', () => {
    const p = buildSegmentPrompt(ctx);
    expect(p.system).toContain('不要凭空搭房间、街景、店');
    expect(p.system).toContain('不报时式开场');
    expect(p.system).toContain('不逐首报幕');
    expect(p.system).toContain('希望你');
    expect(p.system).toContain('肩膀就松下来了');
  });

  it('换曲间隙的常规串场也不出现曲名', () => {
    const p = buildSegmentPrompt({ ...ctx, kind: 'interlude', currentTrack: null });
    expect(p.user).not.toContain('《月光小径》');
    expect(p.user).not.toContain('换曲的间隙');
  });

  it('导播钟写入 user，精确到秒，禁止念给听众', () => {
    const p = buildSegmentPrompt({
      ...ctx,
      trackRemainingMs: 87_400,
      trackDurationMs: 240_000,
      nextTrackDurationMs: 181_000,
    });
    expect(p.user).toContain('导播钟：这首还剩 87 秒（全长 240 秒）。');
    expect(p.user).toContain('下一首全长 181 秒。');
    expect(p.user).toContain('不要把秒数念给听众');
    expect(p.system).not.toContain('导播钟');
  });

  it('有案头笔记时写入 user，只当开口材料', () => {
    const p = buildSegmentPrompt({
      ...ctx,
      deskNotes: {
        trackId: 't-moon',
        queries: [],
        notes: [{ lane: 'community', text: 'Steam 有人挂标题画面一整晚' }],
      },
    });
    expect(p.user).toContain('[玩家社区] Steam 有人挂标题画面一整晚');
    expect(p.user).toContain('只挑一条具体的事来说这首');
    expect(p.user).not.toContain('开口这一次不要搜');
  });
});

describe('buildSegmentPrompt · P2 互动（reply / request_ack）', () => {
  it('reply 提示词包含听众留言（合并多条，FR-054）', () => {
    const p = buildSegmentPrompt({
      ...ctx,
      kind: 'reply',
      replyTo: [
        { id: 'm1', body: '今晚的歌好好听' },
        { id: 'm2', body: '主播晚安' },
      ],
    });
    expect(p.user).toContain('今晚的歌好好听');
    expect(p.user).toContain('主播晚安');
  });

  it('request_ack 提示词包含被受理的曲名', () => {
    const p = buildSegmentPrompt({ ...ctx, kind: 'request_ack', ackTitle: '月光小径' });
    expect(p.user).toContain('月光小径');
  });

  it('reply 提示词明确要求不点名（FR-005 延伸）', () => {
    const p = buildSegmentPrompt({ ...ctx, kind: 'reply', replyTo: [{ id: 'm1', body: '嗨' }] });
    expect(p.user).toContain('泛称');
  });
});

describe('buildSegmentPrompt · P3 记忆（FR-071/072）', () => {
  it('L1 记忆进入提示词，标注只可引用真实发生过的事（FR-074）', () => {
    const p = buildSegmentPrompt({
      ...ctx,
      kind: 'interlude',
      memories: [
        { kind: 'promise', text: '答应过听众下次放一首安静的歌', importance: 0.8 },
        { kind: 'meme', text: '「暖色调」成了节目内部梗', importance: 0.6 },
      ],
    });
    expect(p.user).toContain('答应过听众下次放一首安静的歌');
    expect(p.user).toContain('「暖色调」成了节目内部梗');
    expect(p.user).toContain('只可引用这些真实发生过的');
  });

  it('记忆引用点到为止，不扩写成场景描写', () => {
    const p = buildSegmentPrompt({
      ...ctx,
      kind: 'interlude',
      memories: [{ kind: 'topic', text: '聊过亮着灯的小店', importance: 0.5 }],
    });
    expect(p.user).toContain('点到为止');
  });

  it('没有记忆时不出现记忆段落', () => {
    const p = buildSegmentPrompt({ ...ctx, kind: 'interlude' });
    expect(p.user).not.toContain('你记得的节目事');
  });
});

describe('buildSegmentPrompt · 非酒馆装配', () => {
  it('没有上一段口播时不注入续聊燃料', () => {
    const p = buildSegmentPrompt(ctx);
    expect(p.user).not.toContain('你刚才说');
    expect(p.user).not.toContain('刚才播出过');
    expect(p.user).not.toContain('口吻参考');
    expect(p.user).not.toContain('口吻样本');
  });

  it('上一段口播只作禁止续写的护栏，不当续聊', () => {
    const p = buildSegmentPrompt({
      ...ctx,
      recentAired: SUGAR_SHOP_SERIAL.map((text) => ({ kind: 'interlude' as const, text })),
    });
    expect(p.user).toContain('不要续写其中的情节、角色或场景');
    expect(p.user).toContain('糖水铺');
    expect(p.user).toContain('门槛');
    expect(p.user).not.toContain('接着说就好');
    expect(p.user).not.toContain('你刚才说');
  });

  it('收尾是导播口令，不是续聊式「接着说就好」', () => {
    const p = buildSegmentPrompt(ctx);
    expect(p.user).toContain('导播：轮到你了');
    expect(p.user).toContain('把话说明白，不是填表');
    expect(p.user).not.toContain('接着说就好');
    expect(p.user).not.toContain('请播一段');
    expect(p.system).not.toContain('写你的下一句');
  });
});
