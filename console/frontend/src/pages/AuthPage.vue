<script setup lang="ts">
import { ref } from 'vue'
import { NButton, NInput, NAlert } from 'naive-ui'
import { MessagesSquare, ArrowRight, LockKeyhole } from 'lucide-vue-next'
import { api, clearToken } from '../lib/api'
const props = defineProps<{ setup?: boolean }>()
const emit = defineEmits<{ authenticated: [] }>()
const username = ref(''),
  password = ref(''),
  repeat = ref(''),
  busy = ref(false),
  error = ref('')
async function submit() {
  if (busy.value) return
  error.value = ''
  if (!username.value.trim() || !password.value) {
    error.value = '请填写用户名和密码'
    return
  }
  if (props.setup && (password.value.length < 8 || password.value !== repeat.value)) {
    error.value = '密码至少 8 位，且两次输入需一致'
    return
  }
  busy.value = true
  try {
    clearToken()
    await api(`/api/auth/${props.setup ? 'setup' : 'login'}`, {
      method: 'POST',
      body: JSON.stringify({ username: username.value.trim(), password: password.value })
    })
    password.value = ''
    repeat.value = ''
    emit('authenticated')
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <main class="auth-page">
    <section class="auth-intro">
      <div class="auth-brand"><MessagesSquare :size="30" />bl-chat</div>
      <div>
        <div class="eyebrow">ROBOT OPERATIONS</div>
        <h1>让每一个机器人，<br />都在掌握之中。</h1>
        <p>账号、人设、模型与消息，在一个工作空间里管理。</p>
      </div>
      <span class="muted">bl-chat 控制台</span>
    </section>
    <section class="auth-card">
      <div class="auth-icon"><LockKeyhole :size="22" /></div>
      <h2>{{ setup ? '设置管理员' : '欢迎回来' }}</h2>
      <p class="muted">
        {{ setup ? '创建管理员账号，开始管理你的机器人。' : '登录你的控制台，继续管理机器人。' }}
      </p>
      <form @submit.prevent="submit">
        <label class="form-field"
          ><span>用户名</span
          ><NInput
            v-model:value="username"
            autocomplete="username"
            placeholder="输入用户名" /></label
        ><label class="form-field"
          ><span>密码</span
          ><NInput
            v-model:value="password"
            type="password"
            show-password-on="click"
            :autocomplete="setup ? 'new-password' : 'current-password'"
            :placeholder="setup ? '至少 8 位' : '输入密码'" /></label
        ><label v-if="setup" class="form-field"
          ><span>确认密码</span
          ><NInput
            v-model:value="repeat"
            type="password"
            autocomplete="new-password"
            placeholder="再次输入密码" /></label
        ><NAlert v-if="error" type="error" :show-icon="false" role="alert">{{ error }}</NAlert
        ><NButton type="primary" attr-type="submit" block size="large" :loading="busy"
          >{{ setup ? '创建账号' : '登录控制台'
          }}<template #icon><ArrowRight :size="17" /></template
        ></NButton>
      </form>
    </section>
  </main>
</template>
