<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  deleteLibrary,
  fetchLibrary,
  type LibraryListing,
  mkdirLibrary,
  moveLibrary,
  scanLibrary,
  setTrackEnabled,
  uploadLibrary,
} from './api';

const props = defineProps<{ active: boolean }>();

const listing = ref<LibraryListing | null>(null);
const loading = ref(false);
const error = ref('');
const mkdirName = ref('');
const fileInput = ref<HTMLInputElement | null>(null);
const dragging = ref(false);
/** 网易云「添加到歌单」/ foobar「Move to」：弹出目标列表，不离开当前目录 */
const moving = ref<{ path: string; label: string } | null>(null);
const pickerDirs = ref<string[]>([]);
const pickerLoading = ref(false);

const cwd = computed(() => listing.value?.dir ?? '');

const crumbs = computed(() => {
  if (!listing.value) return [];
  const parts = listing.value.dir.split('/').filter(Boolean);
  const out: Array<{ label: string; dir: string }> = [{ label: '曲库', dir: '' }];
  let acc = '';
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    out.push({ label: part, dir: acc });
  }
  return out;
});

const pickerRows = computed(() => {
  const job = moving.value;
  if (!job) return [];
  const here = parentOf(job.path) ?? '';
  return pickerDirs.value.map((dir) => {
    const depth = dir === '' ? 0 : dir.split('/').length;
    const intoSelf = dir === job.path || dir.startsWith(`${job.path}/`);
    const current = dir === here;
    return {
      dir,
      name: dir === '' ? '曲库' : baseName(dir),
      depth,
      current,
      disabled: intoSelf || current,
    };
  });
});

function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

function parentOf(rel: string): string | null {
  if (!rel) return null;
  const i = rel.lastIndexOf('/');
  return i === -1 ? '' : rel.slice(0, i);
}

function baseName(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i === -1 ? rel : rel.slice(i + 1);
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

async function load(dir = cwd.value): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    listing.value = await fetchLibrary(dir);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function run(op: () => Promise<LibraryListing>): Promise<void> {
  error.value = '';
  try {
    listing.value = await op();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

watch(
  () => props.active,
  (on) => {
    if (on && !listing.value) void load('');
    if (!on) closePicker();
  },
  { immediate: true },
);

function openDir(dir: string): void {
  closePicker();
  void load(dir);
}

function closePicker(): void {
  moving.value = null;
  pickerDirs.value = [];
}

async function collectDirs(dir: string, acc: string[]): Promise<void> {
  const snap = await fetchLibrary(dir);
  for (const name of snap.dirs) {
    const child = joinRel(dir, name);
    acc.push(child);
    await collectDirs(child, acc);
  }
}

async function startMove(path: string, label: string): Promise<void> {
  error.value = '';
  moving.value = { path, label };
  pickerLoading.value = true;
  pickerDirs.value = [''];
  try {
    await collectDirs('', pickerDirs.value);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    closePicker();
  } finally {
    pickerLoading.value = false;
  }
}

async function pickDest(toDir: string): Promise<void> {
  const job = moving.value;
  if (!job) return;
  const stay = cwd.value;
  error.value = '';
  try {
    await moveLibrary(job.path, toDir);
    closePicker();
    await load(stay);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function onEnabled(id: string, enabled: boolean): Promise<void> {
  await run(() => setTrackEnabled(id, enabled));
}

async function onMkdir(): Promise<void> {
  const name = mkdirName.value.trim();
  if (!name) return;
  await run(() => mkdirLibrary(cwd.value, name));
  mkdirName.value = '';
}

async function onFiles(files: FileList | File[] | null): Promise<void> {
  if (!files) return;
  for (const file of files) {
    await run(() => uploadLibrary(cwd.value, file));
  }
}

async function onScan(): Promise<void> {
  await run(() => scanLibrary(cwd.value));
}

async function onDelete(path: string, label: string): Promise<void> {
  if (!window.confirm(`删除「${label}」？`)) return;
  if (moving.value?.path === path) closePicker();
  await run(() => deleteLibrary(path));
}
async function dropMove(from: string, toDir: string): Promise<void> {
  if (!listing.value?.files.some((f) => f.path === from)) return;
  if (parentOf(from) === toDir) return;
  const stay = cwd.value;
  error.value = '';
  try {
    await moveLibrary(from, toDir);
    closePicker();
    await load(stay);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

function onDrop(ev: DragEvent): void {
  dragging.value = false;
  const from = ev.dataTransfer?.getData('text/plain');
  if (from) {
    void dropMove(from, cwd.value);
    return;
  }
  void onFiles(ev.dataTransfer?.files ?? null);
}

function onDropFolder(name: string, ev: DragEvent): void {
  dragging.value = false;
  const from = ev.dataTransfer?.getData('text/plain');
  if (!from) {
    void onFiles(ev.dataTransfer?.files ?? null);
    return;
  }
  void dropMove(from, joinRel(cwd.value, name));
}

function onDropUp(ev: DragEvent): void {
  dragging.value = false;
  const from = ev.dataTransfer?.getData('text/plain');
  const parent = listing.value?.parent;
  if (!from || parent === null || parent === undefined) return;
  void dropMove(from, parent);
}
</script>

<template>
  <section class="library-form" aria-label="曲库">
    <h3 class="ui-label settings-section">曲库</h3>
    <p class="library-stat">随机池 {{ listing?.poolSize ?? '…' }} 首 · 只播勾选的本地文件</p>

    <nav class="library-crumbs" aria-label="当前位置">
      <button
        v-for="(c, i) in crumbs"
        :key="c.dir"
        type="button"
        class="library-crumb"
        :disabled="i === crumbs.length - 1"
        @click="openDir(c.dir)"
      >
        {{ c.label }}
      </button>
    </nav>

    <div class="library-toolbar">
      <button type="button" class="ui-button" :disabled="loading" @click="fileInput?.click()">
        上传
      </button>
      <input
        ref="fileInput"
        class="library-file"
        type="file"
        accept=".mp3,.flac,.ogg,.m4a,.wav,.opus,.aac,audio/*"
        multiple
        @change="onFiles(($event.target as HTMLInputElement).files); ($event.target as HTMLInputElement).value = ''"
      />
      <form class="library-mkdir" @submit.prevent="onMkdir">
        <input
          v-model="mkdirName"
          class="ui-field"
          type="text"
          placeholder="新文件夹名"
          maxlength="80"
        />
        <button type="submit" class="ui-button" :disabled="!mkdirName.trim()">新建</button>
      </form>
      <button type="button" class="ui-button ui-button--ghost" :disabled="loading" @click="onScan">
        刷新
      </button>
    </div>

    <p v-if="error" class="key-note">{{ error }}</p>
    <p v-else-if="loading && !listing" class="key-note">读取中…</p>

    <div v-if="moving" class="library-picker" role="dialog" aria-label="移动到文件夹">
      <p class="library-picker-title">把「{{ moving.label }}」移动到</p>
      <p v-if="pickerLoading" class="key-note">读取文件夹…</p>
      <button
        v-for="row in pickerRows"
        :key="row.dir || 'root'"
        type="button"
        class="library-picker-row"
        :class="{ current: row.current }"
        :disabled="row.disabled || pickerLoading"
        :style="{ paddingInlineStart: `${8 + row.depth * 14}px` }"
        @click="pickDest(row.dir)"
      >
        <span class="library-name">{{ row.name }}</span>
        <span v-if="row.current" class="track-meta">当前</span>
      </button>
      <button type="button" class="ui-button library-action" @click="closePicker">取消</button>
    </div>

    <div
      v-else
      class="library-pane"
      :class="{ dragging }"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="onDrop"
    >
      <div v-if="listing && listing.parent !== null" class="library-sticky">
        <button
          type="button"
          class="library-up"
          @dragover.prevent
          @drop.prevent="onDropUp"
          @click="openDir(listing.parent)"
        >
          <span class="library-ico" aria-hidden="true">↑</span>
          <span class="library-name">上一级</span>
        </button>
      </div>

      <div
        v-for="name in listing?.dirs ?? []"
        :key="`d:${name}`"
        class="library-row library-row-dir"
        @dragover.prevent
        @drop.prevent="onDropFolder(name, $event)"
      >
        <button type="button" class="library-open" @click="openDir(joinRel(cwd, name))">
          <span class="library-ico" aria-hidden="true">▸</span>
          <span class="library-name">{{ name }}</span>
        </button>
        <button
          type="button"
          class="ui-button library-action"
          @click="onDelete(joinRel(cwd, name), name)"
        >
          删除
        </button>
      </div>

      <div
        v-for="f in listing?.files ?? []"
        :key="f.id"
        class="library-row"
        draggable="true"
        @dragstart="($event as DragEvent).dataTransfer?.setData('text/plain', f.path)"
      >
        <label class="track-enable">
          <input
            class="track-check"
            type="checkbox"
            :checked="f.enabled"
            @change="onEnabled(f.id, ($event.target as HTMLInputElement).checked)"
          />
          <span class="library-name">{{ f.name }}</span>
        </label>
        <span class="track-meta">{{ fmtDuration(f.durationMs) }}</span>
        <button type="button" class="ui-button library-action" @click="startMove(f.path, f.name)">
          移动到
        </button>
        <button type="button" class="ui-button library-action" @click="onDelete(f.path, f.name)">
          删除
        </button>
      </div>

      <p
        v-if="listing && listing.dirs.length === 0 && listing.files.length === 0"
        class="key-note"
      >
        这个文件夹是空的。把音频拖进来，或点上传。
      </p>
    </div>
  </section>
</template>
