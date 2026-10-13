/** Group updates cannot safely use the host's pull-and-restart flow with compiled modules. */
export async function explainCompiledPluginUpdate(event) {
  if (!event?.isMaster) return false
  await event.reply("当前版本已启用 TypeScript 编译发布，群内自动更新暂不可用。请维护者在项目目录执行 bash scripts/deploy.sh，先构建并校验完整产物再发布。此次未拉取代码、未重启服务；强制更新也不能绕过编译校验。")
  return true
}
