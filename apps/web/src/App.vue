<script setup lang="ts">
// 收音机面板：调频进入（D5）—— 开台即跳进正在进行的节目。
// 控制只有开台/关台 + 总音量（FR-001）；无进度条、无切歌、无回放（PRD §8.2）。

import { planTuneIn, type ServerEvent, type StationState } from '@mock-radio/shared';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  applyKeys as apiApplyKeys,
  applyVoiceSettings as apiApplyVoiceSettings,
  type CadencePreset,
  calibrate,
  connectWs,
  fetchConfig,
  fetchKeyStatus,
  fetchState,
  fetchVoiceSettings,
  type KeyStatus,
  type StationInfo,
  type VoiceSettings,
  type WsHandle,
} from './api';
import { RadioAudio } from './audio';
// biome-ignore lint/correctness/noUnusedImports: used in template
import GradientBackground from './GradientBackground.vue';
// biome-ignore lint/correctness/noUnusedImports: used in template
import LibrarySettings from './LibrarySettings.vue';
// biome-ignore lint/correctness/noUnusedImports: used in template
import { initialScheme, ORB_SCHEMES, type OrbScheme, persistScheme, schemeById } from './palettes';

const info = ref<StationInfo | null>(null);
const state = ref<StationState | null>(null);
const live = ref(false);
const volume = ref(0.8);
const connecting = ref(false);
const hostTalking = ref(false);
let hostTalkTimer: ReturnType<typeof setTimeout> | undefined;
const offAir = ref(false);
// P2 留言（FR-052：本次收听窗口内保留自己发送的留言；关台即清 FR-057）
const messages = ref<Array<{ id: string; body: string }>>([]);
const draft = ref('');
const sending = ref(false);
// D4 氛围层配色：设置弹窗「主题」页手动切换，localStorage 记忆，切换 2s 颜色滑变
const scheme = ref<OrbScheme>(initialScheme());
// PyCharm 式设置弹窗：<dialog> 模态；主题改动先预览，「确定/应用」才落库，「取消」回退
const settingsOpen = ref(false);
const settingsDialogEl = ref<HTMLDialogElement | null>(null);
const activeSection = ref<'theme' | 'voice' | 'library' | 'api'>('theme');
const pendingSchemeId = ref(scheme.value.id);

/** 主题改动只记在 pendingSchemeId：点「应用/确定」才落到 scheme（背景不即时变化） */

function openSettings(): void {
  settingsOpen.value = true;
  pendingSchemeId.value = scheme.value.id;
  activeSection.value = 'theme';
  keysError.value = '';
  voiceError.value = '';
  voiceDraft.value = {};
  settingsDialogEl.value?.showModal();
  // 每次打开都重取：.env 手改/网页应用后掩码点数都是最新的
  void loadKeys();
  void loadVoice();
}
// ---- 设置弹窗「API 管理」：模型密钥（豆包 / MiniMax）----
// 安全模型：真实值永不出服务器；面板只拿「是否已配置」。
// 已配置的密钥：框内显示按真实长度生成的掩码（点数=长度，改完一眼可见），
// 只读 + 禁复制/选择/右键；聚焦即全选掩码，直接打字/粘贴整体覆盖；pristine 标记防 • 混进新值。
const keyStatuses = ref<KeyStatus[]>([]);
const keysLoading = ref(false);
const keysLoaded = ref(false);
const keyDrafts = ref<Record<string, string>>({});
const keyEditing = ref<Record<string, boolean>>({});
const keyPristine = ref<Record<string, boolean>>({});
const keysApplying = ref(false);
const keysError = ref('');

const keysSaved = ref(false);
let keysSavedTimer: ReturnType<typeof setTimeout> | undefined;
// ---- 设置弹窗「语音」：总开关 / 语速 / 主播音量 / 发言频率 ----
// 草稿模型与密钥一致：改动先进 voiceDraft，点「应用/确定」才 POST 落盘 + 热生效。
const voiceSettings = ref<VoiceSettings | null>(null);
const cadences = ref<CadencePreset[]>([]);
const voiceLoading = ref(false);
const voiceLoaded = ref(false);
const voiceDraft = ref<Partial<VoiceSettings>>({});
const voiceApplying = ref(false);
const voiceError = ref('');
const voiceSaved = ref(false);
let voiceSavedTimer: ReturnType<typeof setTimeout> | undefined;

/** 面板生效值：草稿优先，否则服务端当前值 */
function voiceVal<K extends keyof VoiceSettings>(key: K): VoiceSettings[K] | undefined {
  const draft = voiceDraft.value[key];
  if (draft !== undefined) return draft as VoiceSettings[K];
  return voiceSettings.value?.[key];
}

const hasVoiceDrafts = computed(() => Object.keys(voiceDraft.value).length > 0);

async function loadVoice(): Promise<void> {
  if (voiceLoading.value) return;
  voiceLoading.value = true;
  voiceError.value = '';
  try {
    const res = await fetchVoiceSettings();
    voiceSettings.value = res.settings;
    cadences.value = res.cadences;
    voiceLoaded.value = true;
  } catch {
    voiceError.value = '语音设置读取失败：电台服务未连接';
  } finally {
    voiceLoading.value = false;
  }
}

function setVoice<K extends keyof VoiceSettings>(key: K, value: VoiceSettings[K]): void {
  if (voiceSettings.value?.[key] === value) {
    const rest = { ...voiceDraft.value };
    delete rest[key];
    voiceDraft.value = rest;
  } else {
    voiceDraft.value = { ...voiceDraft.value, [key]: value };
  }
}

async function applyVoiceUpdates(): Promise<boolean> {
  if (!hasVoiceDrafts.value) return true;
  voiceApplying.value = true;
  voiceError.value = '';
  try {
    const next = await apiApplyVoiceSettings(voiceDraft.value);
    voiceSettings.value = next;
    voiceDraft.value = {};
    // 音量即时生效（服务端也会广播，这里本地先应用，不等往返）
    audio.setSpeechVolume(next.speechVolume);
    voiceSaved.value = true;
    clearTimeout(voiceSavedTimer);
    voiceSavedTimer = setTimeout(() => {
      voiceSaved.value = false;
    }, 2500);
    return true;
  } catch (err) {
    voiceError.value = err instanceof Error ? err.message : '语音设置应用失败';
    return false;
  } finally {
    voiceApplying.value = false;
  }
}

function onVoiceEnabledChange(e: Event): void {
  setVoice('enabled', (e.target as HTMLInputElement).checked);
}

function onVoiceRange(key: 'speechRate' | 'speechVolume', e: Event): void {
  const v = Number((e.target as HTMLInputElement).value);
  if (Number.isFinite(v)) setVoice(key, v);
}

const hasKeyDrafts = computed(() =>
  Object.values(keyDrafts.value).some((v) => v.trim().length > 0),
);
/** 按厂商分组（火山引擎一组、MiniMax 一组），保持服务端声明顺序 */
const keyGroups = computed(() => {
  const groups: Array<{ group: string; keys: KeyStatus[] }> = [];
  for (const k of keyStatuses.value) {
    const last = groups[groups.length - 1];
    if (last && last.group === k.group) last.keys.push(k);
    else groups.push({ group: k.group, keys: [k] });
  }
  return groups;
});

/** 有未保存改动才允许确定/应用（PyCharm：Apply 只在 dirty 时可用） */
const canApply = computed(
  () => pendingSchemeId.value !== scheme.value.id || hasKeyDrafts.value || hasVoiceDrafts.value,
);
async function applySettings(closeAfter: boolean): Promise<void> {
  const next = schemeById(pendingSchemeId.value);
  if (next.id !== scheme.value.id) {
    scheme.value = next;
    persistScheme(next.id);
  }
  if (hasVoiceDrafts.value) {
    const ok = await applyVoiceUpdates();
    if (!ok && closeAfter) return; // 语音设置写入失败：弹窗留在原地报错，不关
  }
  if (hasKeyDrafts.value) {
    const ok = await applyKeyUpdates();
    if (!ok && closeAfter) return; // 密钥写入失败：弹窗留在原地报错，不关
  }
  if (closeAfter) settingsDialogEl.value?.close();
}

function onSettingsClose(): void {
  settingsOpen.value = false;
  // 取消 / ESC / 点遮罩：丢弃未应用的密钥/语音草稿与待选主题（scheme 本就未变）
  keyDrafts.value = {};
  keyEditing.value = {};
  voiceDraft.value = {};
}

async function loadKeys(): Promise<void> {
  if (keysLoading.value) return;
  keysLoading.value = true;
  keysError.value = '';
  try {
    keyStatuses.value = await fetchKeyStatus();
    keysLoaded.value = true;
  } catch {
    keysError.value = '密钥状态读取失败：电台服务未连接';
  } finally {
    keysLoading.value = false;
  }
}

function startEditKey(env: string, el: EventTarget | null): void {
  const configured = keyStatuses.value.some((k) => k.env === env);
  const hasDraft = (keyDrafts.value[env] ?? '').length > 0;
  keyEditing.value = { ...keyEditing.value, [env]: true };
  keyPristine.value = { ...keyPristine.value, [env]: configured && !hasDraft };
  nextTick(() => {
    if (!(el instanceof HTMLInputElement)) return;
    if (keyPristine.value[env]) {
      // 掩码原样留在框里：聚焦即全选，一打字/粘贴整体替换
      el.select();
    } else {
      const end = el.value.length;
      el.setSelectionRange(end, end);
    }
  });
}

function onKeyKeydown(env: string, e: KeyboardEvent): void {
  // 掩码未触碰时按方向键会取消全选；下一个可打印键先重新全选
  if (keyPristine.value[env] && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    (e.target as HTMLInputElement).select();
  }
}

function onKeyInput(env: string, el: EventTarget | null): void {
  if (el instanceof HTMLInputElement) {
    // 兜底：漏进来的前导掩码不进草稿（服务端还有一道 ASCII 防线）
    const value = keyPristine.value[env] ? el.value.replace(/^•+/, '') : el.value;
    keyPristine.value = { ...keyPristine.value, [env]: false };
    keyDrafts.value = { ...keyDrafts.value, [env]: value };
  }
}

function onKeyBlur(env: string): void {
  // 没输入过新值（或输入后又清空）：丢弃草稿，退回掩码只读态
  if (!(keyDrafts.value[env] ?? '').trim()) {
    const rest = { ...keyDrafts.value };
    delete rest[env];
    keyDrafts.value = rest;
    keyEditing.value = { ...keyEditing.value, [env]: false };
    keyPristine.value = { ...keyPristine.value, [env]: false };
  }
}
async function applyKeyUpdates(): Promise<boolean> {
  const updates: Record<string, string> = {};
  for (const [env, value] of Object.entries(keyDrafts.value)) {
    const trimmed = value.trim();
    if (trimmed) updates[env] = trimmed;
  }
  if (Object.keys(updates).length === 0) return true;
  keysApplying.value = true;
  keysError.value = '';
  try {
    const res = await apiApplyKeys(updates);
    keyStatuses.value = res.status;
    keyDrafts.value = {};
    keyEditing.value = {};
    keysSaved.value = true;
    clearTimeout(keysSavedTimer);
    keysSavedTimer = setTimeout(() => {
      keysSaved.value = false;
    }, 2500);
    return true;
  } catch (err) {
    keysError.value = err instanceof Error ? err.message : '应用失败';
    return false;
  } finally {
    keysApplying.value = false;
  }
}

const audio = new RadioAudio();
let ws: WsHandle | null = null;
let clockOffset = 0;
let statePollTimer: ReturnType<typeof setInterval> | null = null;
// ER-004：解码失败上报电台跳过该曲
audio.onTrackFailed = (trackId) => {
  if (ws && live.value) {
    ws.sendRaw(JSON.stringify({ type: 'track-failed', trackId }));
  }
};

async function refreshState(): Promise<void> {
  const s = await fetchState().catch(() => null);
  if (!s) return;
  clockOffset = calibrate(s);
  state.value = s;
}

function applyTuneIn(s: StationState): void {
  const plan = planTuneIn(s);
  if (plan.trackId) void audio.play(plan.trackId, plan.startedAt, clockOffset, true);
  if (plan.speechSegmentId) {
    void audio.playSpeech(plan.speechSegmentId);
    hostTalking.value = true;
  }
}

function handleEvent(event: ServerEvent): void {
  if (event.type === 'off-air') {
    offAir.value = true;
    audio.suspend();
  } else if (event.type === 'sync') {
    state.value = event.state;
    if (live.value) applyTuneIn(event.state);
  } else if (event.type === 'track') {
    state.value = {
      trackId: event.trackId,
      title: event.title,
      startedAt: event.startedAt,
      durationMs: event.durationMs,
      positionMs: Math.max(0, Date.now() + clockOffset - event.startedAt),
      hostTalking: false,
      hostSegmentId: null,
      serverTime: Date.now() + clockOffset,
    };
    if (live.value) {
      void audio.play(event.trackId, event.startedAt, clockOffset, false);
    }
  } else if (event.type === 'voice') {
    if (live.value) {
      void audio.playSpeech(event.segmentId);
      hostTalking.value = true;
      clearTimeout(hostTalkTimer);
      hostTalkTimer = setTimeout(() => {
        hostTalking.value = false;
      }, event.durationMs + 200);
    }
  } else if (event.type === 'voice-settings') {
    // 设置面板热更新：主播音量即时生效（关闭时引擎不再发 voice 事件，在播段自然播完）
    audio.setSpeechVolume(event.speechVolume);
  } else if (event.type === 'received') {
    const pending = messages.value.find((m) => m.id.startsWith('pending-'));
    if (pending) pending.id = event.id;
  }
}

async function openStation(): Promise<void> {
  connecting.value = true;
  try {
    await audio.unlock(info.value?.audio.ducking, info.value?.audio.crossfadeMs);
    await refreshState();
    if (state.value) applyTuneIn(state.value);
    ws = connectWs(handleEvent);
    live.value = true;
  } finally {
    connecting.value = false;
  }
}

function closeStation(): void {
  live.value = false;
  ws?.close();
  ws = null;
  audio.suspend();
  messages.value = []; // FR-057：关台后上一轮留言不再显示
}

function sendMessage(): void {
  const body = draft.value.trim();
  if (!body || !ws) return;
  ws.sendMessage(body);
  // 本地乐观记录（FR-052）；回执由 received 事件确认去重
  messages.value.push({ id: `pending-${Date.now()}`, body });
  draft.value = '';
}

watch(volume, (v) => audio.setVolume(v));

onMounted(async () => {
  info.value = await fetchConfig().catch(() => null);
  // 主播音量初值：开台前先落到 audio（unlock 时读取），后续由 voice-settings 事件热更新
  if (info.value?.voice) audio.setSpeechVolume(info.value.voice.speechVolume);
  await refreshState();
  // WS 之外的低频校时兜底（防本地时钟漂移）
  statePollTimer = setInterval(() => {
    if (!live.value) void refreshState();
  }, 60_000);
});

onUnmounted(() => {
  ws?.close();
  if (statePollTimer !== null) clearInterval(statePollTimer);
});
</script>
<template>
  <main class="shell">
    <GradientBackground :scheme="scheme" :talking="hostTalking" :off-air="offAir" />
    <div class="veil" :class="{ talking: hostTalking, lost: offAir }" aria-hidden="true" />

    <button
      class="gear ui-icon-button"
      :class="{ open: settingsOpen }"
      :aria-expanded="settingsOpen"
      aria-controls="settings-dialog"
      aria-label="设置"
      @click="openSettings"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
      </svg>
    </button>

    <!-- PyCharm 式设置弹窗：原生 <dialog>（焦点圈定 / ESC / 遮罩全免费） -->
    <dialog
      id="settings-dialog"
      ref="settingsDialogEl"
      class="settings-modal ui-panel"
      aria-labelledby="settings-dialog-title"
      @close="onSettingsClose"
      @cancel="onSettingsClose"
    >
      <header class="settings-head">
        <h2 id="settings-dialog-title" class="ui-label settings-title">设置</h2>
        <button class="ui-icon-button settings-close" aria-label="关闭设置" @click="settingsDialogEl?.close()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </header>

      <div class="settings-body">
        <nav class="settings-nav" aria-label="设置分类">
          <button
            class="settings-nav-item"
            :class="{ active: activeSection === 'theme' }"
            :aria-current="activeSection === 'theme' ? 'page' : undefined"
            @click="activeSection = 'theme'"
          >
            主题
          </button>
          <button
            class="settings-nav-item"
            :class="{ active: activeSection === 'voice' }"
            :aria-current="activeSection === 'voice' ? 'page' : undefined"
            @click="activeSection = 'voice'"
          >
            语音
          </button>
          <button
            class="settings-nav-item"
            :class="{ active: activeSection === 'library' }"
            :aria-current="activeSection === 'library' ? 'page' : undefined"
            @click="activeSection = 'library'"
          >
            曲库
          </button>
          <button
            class="settings-nav-item"
            :class="{ active: activeSection === 'api' }"
            :aria-current="activeSection === 'api' ? 'page' : undefined"
            @click="activeSection = 'api'"
          >
            API 管理
          </button>
        </nav>

        <div class="settings-content">
          <section v-show="activeSection === 'theme'" class="theme-section" aria-label="氛围配色">
            <h3 class="ui-label settings-section">氛围配色</h3>
            <div class="swatches">
              <label
                v-for="s in ORB_SCHEMES"
                :key="s.id"
                class="ui-theme-card"
                :style="{ '--c1': s.colors[0], '--c2': s.colors[1], '--c3': s.colors[2] }"
              >
                <input
                  class="ui-swatch-input"
                  type="radio"
                  name="scheme"
                  :value="s.id"
                  :checked="pendingSchemeId === s.id"
                  @change="pendingSchemeId = s.id"
                />
                <span class="ui-theme-preview" aria-hidden="true">
                  <span class="ui-theme-orb ui-theme-orb--bl" />
                  <span class="ui-theme-orb ui-theme-orb--tr" />
                  <span class="grain" />
                </span>
                <span class="ui-theme-badge" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                </span>
                <span class="ui-theme-meta">
                  <span class="ui-theme-name">{{ s.name }}</span>
                  <span class="ui-theme-dots" aria-hidden="true">
                    <i :style="{ background: s.colors[0] }" />
                    <i :style="{ background: s.colors[1] }" />
                    <i :style="{ background: s.colors[2] }" />
                  </span>
                </span>
              </label>
            </div>
          </section>

          <section v-show="activeSection === 'voice'" aria-label="语音设置">
            <h3 class="ui-label settings-section">语音</h3>
            <p v-if="voiceLoading" class="key-note">读取中…</p>
            <p v-else-if="!voiceLoaded" class="key-note">电台服务未连接，无法读取语音设置</p>
            <div v-else class="voice-form">
              <label class="voice-switch">
                <input
                  type="checkbox"
                  role="switch"
                  class="ui-swatch-input"
                  :checked="voiceVal('enabled') !== false"
                  @change="onVoiceEnabledChange"
                />
                <span class="voice-switch-track" aria-hidden="true"><span class="voice-switch-thumb" /></span>
                <span class="voice-switch-text">
                  <span class="voice-switch-title">语音功能</span>
                  <span class="key-note">开启时梦可按节奏串场说话；关闭后文字模型与语音合成都不再工作——只放音乐，不产生调用费用。</span>
                </span>
              </label>

              <template v-if="voiceVal('enabled') !== false">
                <div class="key-row">
                  <label class="key-label" for="voice-rate">
                    语速
                    <span class="voice-value">{{ (voiceVal('speechRate') ?? 1).toFixed(2) }}×</span>
                  </label>
                  <input
                    id="voice-rate"
                    class="ui-slider voice-slider"
                    type="range"
                    min="0.5"
                    max="1.5"
                    step="0.05"
                    :value="voiceVal('speechRate') ?? 1"
                    @input="onVoiceRange('speechRate', $event)"
                  />
                </div>
                <div class="key-row">
                  <label class="key-label" for="voice-vol">
                    主播音量
                    <span class="voice-value">{{ Math.round((voiceVal('speechVolume') ?? 1) * 100) }}%</span>
                  </label>
                  <input
                    id="voice-vol"
                    class="ui-slider voice-slider"
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    :value="voiceVal('speechVolume') ?? 1"
                    @input="onVoiceRange('speechVolume', $event)"
                  />
                </div>
                <fieldset class="voice-cadence">
                  <legend class="voice-cadence-title">发言频率</legend>
                  <div class="cadence-cards">
                    <label v-for="p in cadences" :key="p.id" class="cadence-card">
                      <input
                        class="ui-swatch-input"
                        type="radio"
                        name="voice-cadence"
                        :value="p.id"
                        :checked="voiceVal('cadence') === p.id"
                        @change="setVoice('cadence', p.id)"
                      />
                      <span class="cadence-head">
                        <span class="cadence-name">{{ p.label }}</span>
                        <span class="cadence-rate">{{ p.perHour }}</span>
                      </span>
                      <span class="cadence-hint">{{ p.hint }}</span>
                    </label>
                  </div>
                </fieldset>
              </template>
            </div>
          </section>

          <LibrarySettings v-show="activeSection === 'library'" :active="activeSection === 'library'" />

          <section v-show="activeSection === 'api'" aria-label="模型密钥">
            <h3 class="ui-label settings-section">模型密钥</h3>
            <p v-if="keysLoading" class="key-note">读取中…</p>
            <p v-else-if="!keysLoaded" class="key-note">电台服务未连接，无法读取密钥状态</p>
            <div v-else class="keys-form">
              <fieldset v-for="g in keyGroups" :key="g.group" class="key-group">
                <legend class="key-group-title">{{ g.group }}</legend>
                <div v-for="k in g.keys" :key="k.env" class="key-row">
                  <label class="key-label" :for="`key-${k.env}`">
                    <span class="ui-dot" :class="{ configured: k.configured }" aria-hidden="true" />
                    {{ k.label }}
                  </label>
                  <input
                    :id="`key-${k.env}`"
                    class="ui-field ui-field--secret"
                    autocomplete="off"
                    autocapitalize="off"
                    type="text"
                    :readonly="k.configured && !keyEditing[k.env]"
                    :aria-label="
                      k.configured ? `${k.label}（已配置，聚焦输入新值覆盖）` : k.label
                    "
                    :placeholder="k.configured ? '' : '尚未配置，粘贴 API Key'"
                    :value="keyDrafts[k.env] ?? k.masked"
                    @focus="startEditKey(k.env, $event.target)"
                    @blur="onKeyBlur(k.env)"
                    @input="onKeyInput(k.env, $event.target)"
                    @keydown="onKeyKeydown(k.env, $event)"
                    @copy.prevent
                    @cut.prevent
                    @contextmenu.prevent
                  />
                </div>
              </fieldset>
            </div>
          </section>
        </div>
      </div>

      <footer class="settings-foot">
        <p v-if="keysError || voiceError" class="key-error" role="alert">{{ keysError || voiceError }}</p>
        <p v-else-if="keysSaved || voiceSaved" class="key-saved" role="status">已保存，即刻生效</p>
        <div class="settings-buttons">
          <button class="ui-button ui-button--primary" :disabled="!canApply || keysApplying || voiceApplying" @click="applySettings(true)">
            确定
          </button>
          <button class="ui-button" @click="settingsDialogEl?.close()">取消</button>
          <button
            class="ui-button"
            :disabled="!canApply || keysApplying || voiceApplying"
            :aria-busy="keysApplying || voiceApplying"
            @click="applySettings(false)"
          >
            {{ keysApplying || voiceApplying ? '应用中' : '应用' }}
          </button>
        </div>
      </footer>
    </dialog>

    <section class="hero">
      <p class="on-air" :class="{ active: live, talking: hostTalking }">
        <span class="ui-dot" aria-hidden="true" />
        ON AIR
      </p>

      <h1 class="title ui-display">Mock Radio</h1>

      <p class="sr-only" aria-live="polite">{{ hostTalking ? '梦可正在说话' : '' }}</p>

      <p class="now-playing" :class="{ silent: !live || !state?.title }" aria-live="polite">
        <template v-if="offAir">
          <span class="np-label">信号丢失</span>
          <span class="np-title">曲库暂时无法播放，维护者处理中</span>
        </template>
        <template v-else-if="live && state?.title">
          <span class="np-label">正在播放</span>
          <span class="np-title-slot">
            <Transition name="np-fade">
              <span :key="state.trackId ?? state.title" class="np-title">{{ state.title }}</span>
            </Transition>
          </span>
        </template>
        <template v-else-if="state?.title">
          <span class="np-label">此刻电波里</span>
          <span class="np-title-slot">
            <Transition name="np-fade">
              <span :key="state.trackId ?? state.title" class="np-title">{{ state.title }}</span>
            </Transition>
          </span>
        </template>
        <template v-else>
          <span class="np-label">频率调谐中</span>
        </template>
      </p>

      <button
        class="power ui-button"
        :disabled="connecting"
        :aria-pressed="live"
        :aria-busy="connecting"
        @click="live ? closeStation() : openStation()"
      >
        {{ connecting ? '调频中' : live ? '关台' : '开台' }}
      </button>
    </section>

    <div class="dock">
      <div v-if="live" class="chat">
        <div class="chat-list">
          <p v-for="m in messages" :key="m.id" class="chat-item">{{ m.body }}</p>
        </div>
        <form class="chat-form" @submit.prevent="sendMessage">
          <label class="sr-only" for="msg">留言</label>
          <input
            id="msg"
            v-model="draft"
            class="ui-field"
            type="text"
            maxlength="200"
            placeholder="说点什么"
            autocomplete="off"
          />
          <button class="ui-button ui-button--ghost" type="submit" :disabled="sending || !draft.trim()">发送</button>
        </form>
      </div>
      <div class="volume">
        <label for="vol">音量</label>
        <input
          id="vol"
          v-model.number="volume"
          class="ui-slider"
          type="range"
          min="0"
          max="1"
          step="0.01"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="Math.round(volume * 100)"
        />
      </div>
    </div>
  </main>
</template>
