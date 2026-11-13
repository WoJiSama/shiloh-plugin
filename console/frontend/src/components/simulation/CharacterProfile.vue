<script setup lang="ts">
import { AlarmClock, BookOpen, Heart, Lightbulb, MessageCircle } from 'lucide-vue-next'
import { NTag } from 'naive-ui'
import type { CharacterProfile } from '../../../../../src/contracts/characterProfile'
import CharacterEvidence from './CharacterEvidence.vue'

defineProps<{ profile: CharacterProfile }>()
const certainty: Record<string, string> = { reported: '他人提及', observed: '实际行动', inferred: '当前判断', desired: '有意尝试' }
const hour = (value: number) => `${String(value).padStart(2, '0')}:00`
const date = (at: number) => new Date(at).toLocaleDateString('zh-CN')
</script>

<template>
  <div class="profile-grid">
    <section class="profile-panel profile-identity" aria-label="生效人设">
      <h3><MessageCircle :size="17" aria-hidden="true" /> 生效人设</h3>
      <p v-if="profile.persona.identity" class="identity">{{ profile.persona.identity }}</p>
      <p v-if="profile.persona.tone">{{ profile.persona.tone }}</p>
      <dl v-if="profile.persona.preferences.length || profile.persona.speechStyle.length">
        <template v-if="profile.persona.preferences.length">
          <dt>设定偏好</dt>
          <dd v-for="item in profile.persona.preferences" :key="item">{{ item }}</dd>
        </template>
        <template v-if="profile.persona.speechStyle.length">
          <dt>说话习惯</dt>
          <dd v-for="item in profile.persona.speechStyle" :key="item">{{ item }}</dd>
        </template>
      </dl>
      <RouterLink to="/persona">管理人设与绑定</RouterLink>
    </section>

    <section class="profile-panel" aria-label="状态与作息">
      <h3><Heart :size="17" aria-hidden="true" /> 状态与作息</h3>
      <dl>
        <dt>模拟情绪</dt>
        <dd>{{ profile.mood.status === 'disabled' ? '未启用' : profile.mood.summary || '还没有情绪记录' }}</dd>
        <dd v-if="profile.mood.updatedAt"><small>上次变化 {{ date(profile.mood.updatedAt) }}</small></dd>
        <dt><AlarmClock :size="14" aria-hidden="true" /> 北京时间</dt>
        <dd v-if="profile.rhythm.enabled">{{ profile.rhythm.sleeping ? '休息时段' : '日常时段' }} · {{ hour(profile.rhythm.sleepFrom) }}–{{ hour(profile.rhythm.sleepTo) }} 休息</dd>
        <dd v-else>作息未启用</dd>
      </dl>
      <RouterLink to="/life">查看作息与生活</RouterLink>
    </section>

    <section class="profile-panel" aria-label="兴趣与观点">
      <h3><Lightbulb :size="17" aria-hidden="true" /> 兴趣与观点</h3>
      <div v-for="section in [{ label: '感兴趣的事', items: profile.interests }, { label: '现在怎么看', items: profile.opinions }]" :key="section.label" class="profile-section">
        <h4>{{ section.label }}</h4>
        <p v-if="!section.items.length" class="profile-empty">还没有留下记录。</p>
        <article v-for="item in section.items" :key="item.id" class="profile-entry">
          <p>{{ item.content }}</p>
          <small>{{ certainty[item.epistemic] }} · {{ date(item.updatedAt) }}<template v-if="item.supersedes"> · 已修订</template></small>
          <CharacterEvidence :refs="item.evidenceRefs" :evidence="profile.evidence" />
        </article>
      </div>
    </section>

    <section class="profile-panel" aria-label="小习惯与在关注的作品">
      <h3><BookOpen :size="17" aria-hidden="true" /> 小习惯与近况</h3>
      <h4>她记下的本群习惯</h4>
      <p v-if="!profile.habits.length" class="profile-empty">还没有小习惯记录。</p>
      <article v-for="habit in profile.habits" :key="habit.id" class="profile-entry">
        <p>{{ habit.content }}</p>
        <small>{{ date(habit.updatedAt) }}<template v-if="!habit.evidenceRefs?.length"> · 自我笔记</template></small>
        <CharacterEvidence v-if="habit.evidenceRefs" :refs="habit.evidenceRefs" :evidence="profile.evidence" />
      </article>
      <h4>在关注的作品</h4>
      <p v-if="!profile.life.length" class="profile-empty">还没有生活线记录。</p>
      <article v-for="item in profile.life" :key="item.id" class="profile-entry">
        <div class="profile-work"><b>{{ item.title }}</b><NTag size="small" round>{{ item.status === 'dropped' ? '已停止' : '关注中' }}</NTag></div>
        <small v-if="item.lastEpisode || item.lastSyncAt"><template v-if="item.lastEpisode">第 {{ item.lastEpisode }} 集</template><template v-if="item.lastEpisode && item.lastSyncAt"> · </template><template v-if="item.lastSyncAt">{{ date(item.lastSyncAt) }} 同步</template></small>
        <p v-if="item.notes[0]">{{ item.notes[0] }}</p>
      </article>
    </section>
  </div>
</template>

<style scoped>
.profile-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.profile-panel { padding: 18px; border: 1px solid var(--c-border, #8884); border-radius: 12px; background: var(--c-panel); min-width: 0; overflow-wrap: anywhere; }
.profile-panel h3 { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; font-size: 16px; }
.profile-panel h4 { margin: 14px 0 8px; font-size: 13px; }
.profile-panel p { margin: 0 0 9px; white-space: pre-wrap; }
.identity { font-weight: 600; }
.profile-panel dl { margin: 12px 0; }
.profile-panel dt { margin: 10px 0 4px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
.profile-panel dd { margin: 3px 0; }
.profile-panel small, .profile-empty { opacity: .7; }
.profile-entry { border-top: 1px solid var(--c-border, #8883); padding: 10px 0; }
.profile-entry p { margin-bottom: 4px; }
.profile-work { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
@media (max-width: 700px) {
  .profile-grid { grid-template-columns: minmax(0, 1fr); gap: 10px; }
  .profile-panel { padding: 13px; }
}
</style>
