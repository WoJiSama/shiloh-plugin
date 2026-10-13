<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { NButton, NCheckbox, NTag } from 'naive-ui'
import { accountStatus, type Account, useOpsResource } from '../lib/operations'
import IdentityLabel from './IdentityLabel.vue'
import { botLabel } from '../lib/identities'
import { imageUrl } from '../lib/api'
const props = defineProps<{
  account: Account
  selected?: boolean
  busy?: boolean
  selectable?: boolean
  detail?: boolean
}>()
const emit = defineEmits<{
  select: [value: boolean]
  action: [action: 'start' | 'stop' | 'restart']
}>()
const status = computed(() => accountStatus(props.account))
const qrFailed = ref(false)
const qrTime = useOpsResource(async () => {
  qrFailed.value = false
  return Date.now()
}, 60000)
const qrSrc = computed(() => {
  const base = imageUrl(`/img/qrcode/${encodeURIComponent(props.account.container)}`)
  return `${base}${base.includes('?') ? '&' : '?'}t=${qrTime.data.value || Date.now()}`
})
</script>

<template>
  <article class="panel account-card">
    <div class="account-heading">
      <div class="account-avatar" aria-hidden="true">{{ (account.account || 'BT').slice(-2) }}</div>
      <div class="account-title">
        <RouterLink v-if="account.account && !detail" :to="`/bot/${account.account}`"
          ><IdentityLabel kind="bot" :id="account.account" :name="account.nickname" /></RouterLink
        ><strong v-else
          ><IdentityLabel
            v-if="account.account"
            kind="bot"
            :id="account.account"
            :name="account.nickname"
          /><span v-else>{{ account.container }}</span></strong
        ><span class="muted">{{ account.container }}</span>
      </div>
      <NCheckbox
        v-if="selectable"
        :checked="selected"
        :disabled="busy"
        :aria-label="`选择机器人 ${account.account ? botLabel(account.account, account.nickname) : account.container}`"
        @update:checked="emit('select', $event)"
      />
    </div>
    <div class="account-status">
      <NTag :type="status.type" size="small" round>{{ status.label }}</NTag
      ><NTag v-if="account.fingerprint && !account.fingerprint.stable" type="warning" size="small"
        >设备指纹变化 {{ account.fingerprint.changes }} 次</NTag
      >
    </div>
    <dl class="account-facts">
      <div>
        <dt>内存</dt>
        <dd>{{ account.memory || '未采集' }}</dd>
      </div>
      <div>
        <dt>出口 IP</dt>
        <dd>{{ account.exitIp || '未采集' }}</dd>
      </div>
      <template v-if="detail"
        ><div>
          <dt>登录状态</dt>
          <dd>{{ account.loginState || '未知' }}</dd>
        </div>
        <div>
          <dt>出口服务</dt>
          <dd>{{ account.sidecar || '未隔离' }}</dd>
        </div>
        <div>
          <dt>设备指纹</dt>
          <dd>
            {{
              account.fingerprint
                ? account.fingerprint.stable
                  ? '稳定'
                  : `变化 ${account.fingerprint.changes} 次`
                : '未采集'
            }}
          </dd>
        </div>
        <div>
          <dt>指纹首见</dt>
          <dd>{{ account.fingerprint?.firstSeen?.slice(0, 10) || '—' }}</dd>
        </div></template
      >
    </dl>
    <div v-if="account.qrAvailable" class="qr-section">
      <div class="qr-image">
        <img
          v-if="!qrFailed"
          :src="qrSrc"
          :alt="`机器人 ${botLabel(account.account, account.nickname)} 登录二维码`"
          @error="qrFailed = true"
        /><span v-else class="muted">二维码暂不可用</span>
      </div>
      <div class="qr-content">
        <strong>扫码登录</strong>
        <p class="field-help">请使用对应 QQ 扫码。二维码每分钟自动更新。</p>
        <NButton size="small" secondary @click="qrTime.refresh()">刷新二维码</NButton>
      </div>
    </div>
    <div class="account-actions">
      <NButton
        v-if="!account.running"
        size="small"
        type="primary"
        :disabled="busy"
        @click="emit('action', 'start')"
        >启动</NButton
      ><template v-else
        ><NButton size="small" secondary :disabled="busy" @click="emit('action', 'restart')"
          >重启</NButton
        ><NButton
          size="small"
          quaternary
          type="error"
          :disabled="busy"
          @click="emit('action', 'stop')"
          >停止</NButton
        ></template
      ><NButton
        v-if="account.webui"
        tag="a"
        :href="account.webui"
        target="_blank"
        rel="noopener noreferrer"
        size="small"
        quaternary
        >登录入口 ↗</NButton
      ><RouterLink
        v-if="account.account && !detail"
        :to="`/bot/${account.account}`"
        class="account-detail"
        >查看详情 →</RouterLink
      >
    </div>
  </article>
</template>

<style scoped>
.account-card {
  min-width: 0;
  padding: 22px;
}
.account-heading {
  display: flex;
  align-items: center;
  gap: 12px;
}
.account-avatar {
  width: 42px;
  height: 42px;
  border-radius: 12px;
  display: grid;
  place-items: center;
  color: var(--c-accent);
  background: rgba(83, 128, 210, 0.14);
  font-weight: 700;
  font-size: 16px;
  flex-shrink: 0;
}
.account-title {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.account-title a,
.account-title strong {
  color: var(--c-text);
  font-size: 17px;
  font-weight: 650;
  text-decoration: none;
}
.account-title .muted {
  font-size: 12px;
  overflow-wrap: anywhere;
}
.account-status {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 16px 0;
}
.account-facts {
  margin: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.account-facts dt {
  color: var(--c-muted);
  font-size: 12px;
  margin-bottom: 5px;
}
.account-facts dd {
  margin: 0;
  font-size: 13px;
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
}
.account-actions {
  border-top: 1px solid var(--c-border);
  margin-top: 20px;
  padding-top: 16px;
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.account-detail {
  margin-left: auto;
  font-size: 12px;
  color: var(--c-accent);
  text-decoration: none;
}
.qr-section {
  display: flex;
  gap: 14px;
  align-items: center;
  background: rgba(255, 255, 255, 0.025);
  border-radius: 10px;
  padding: 12px;
  margin-top: 18px;
}
.qr-image {
  width: 116px;
  height: 116px;
  flex-shrink: 0;
  background: #fff;
  display: grid;
  place-items: center;
  border-radius: 6px;
}
.qr-image img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  border-radius: 6px;
}
.qr-image .muted {
  color: #637084;
  font-size: 12px;
}
.qr-content {
  min-width: 0;
}
.qr-content strong {
  font-size: 13px;
}
.qr-content p {
  margin: 6px 0 10px;
}
@media (max-width: 480px) {
  .account-card {
    padding: 18px;
  }
  .qr-image {
    width: 92px;
    height: 92px;
  }
}
</style>
