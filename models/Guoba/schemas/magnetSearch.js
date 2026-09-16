export default [
  {
    component: "SOFT_GROUP_BEGIN",
    label: "磁力搜索"
  },
  {
    field: "magnetSearchSystem.enabled",
    label: "启用磁力搜索",
    component: "Switch",
    bottomHelpMessage: "开启后可使用 .磁力 <关键词> 搜索公开磁力索引，只返回清单，不会自动下载"
  },
  {
    field: "magnetSearchSystem.searchUrl",
    label: "直连搜索接口",
    component: "Input",
    bottomHelpMessage: "默认 https://torrents-csv.com/service/search ；直连，不走 VPN"
  },
  {
    field: "magnetSearchSystem.proxyUrl",
    label: "VPN / HTTP 代理",
    component: "Input",
    bottomHelpMessage: "默认 http://127.0.0.1:7890 。BitSearch / SolidTorrents 走这个代理；留空则只搜直连源"
  },
  {
    field: "magnetSearchSystem.timeoutMs",
    label: "请求超时（毫秒）",
    component: "InputNumber",
    bottomHelpMessage: "默认 10000",
    componentProps: { min: 1000, max: 60000, step: 1000, placeholder: "10000" }
  }
]
