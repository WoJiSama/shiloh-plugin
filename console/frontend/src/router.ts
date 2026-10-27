import { createRouter, createWebHashHistory } from 'vue-router'
import { confirmLeave } from './composables/useUnsavedGuard'
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', component: () => import('./pages/BotsPage.vue') },
    {
      path: '/bot/:qq(\\d{4,12})',
      component: () => import('./pages/BotDetailPage.vue'),
      props: true
    },
    { path: '/groups', component: () => import('./pages/GroupsPage.vue') },
    { path: '/group-admin', component: () => import('./pages/GroupAdminPage.vue') },
    { path: '/persona', component: () => import('./pages/PersonaPage.vue') },
    { path: '/conversation', component: () => import('./pages/ConversationPage.vue') },
    { path: '/ai', component: () => import('./pages/AiPage.vue') },
    { path: '/pipeline', component: () => import('./pages/PipelinePage.vue') },
    {
      path: '/risk',
      component: () => import('./pages/SchemaPage.vue'),
      props: { kind: 'riskControl' }
    },
    { path: '/games', component: () => import('./pages/GamesPage.vue') },
    { path: '/draw', component: () => import('./pages/DrawPage.vue') },
    { path: '/observe', component: () => import('./pages/ObservePage.vue') },
    { path: '/simulation', component: () => import('./pages/SimulationPage.vue') },
    { path: '/tokens', component: () => import('./pages/TokensPage.vue') },
    { path: '/style', component: () => import('./pages/StylePage.vue') },
    {
      path: '/observe/details',
      component: () => import('./pages/EmbeddedPage.vue'),
      props: { kind: 'observe' }
    },
    { path: '/commands', component: () => import('./pages/CommandsPage.vue') },
    { path: '/semantic', component: () => import('./pages/SemanticPage.vue') },
    { path: '/qzone', redirect: '/' },
    { path: '/:pathMatch(.*)*', redirect: '/' }
  ],
  scrollBehavior: () => ({ top: 0 })
})
router.beforeEach((to, from) => to.path === from.path || confirmLeave())
